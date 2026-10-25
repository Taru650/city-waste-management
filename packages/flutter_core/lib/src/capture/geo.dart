import 'package:geolocator/geolocator.dart';

class GeoFix {
  GeoFix({required this.lat, required this.lng, required this.accuracyM, required this.isMocked, DateTime? at}) : at = at ?? DateTime.now();
  final double lat;
  final double lng;
  final double accuracyM;
  final bool isMocked;
  final DateTime at;

  Map<String, dynamic> toJson() => {'lat': lat, 'lng': lng, 'accuracyM': accuracyM, 'isMocked': isMocked, 'at': at.toIso8601String()};
  factory GeoFix.fromJson(Map<String, dynamic> j) =>
      GeoFix(lat: (j['lat'] as num).toDouble(), lng: (j['lng'] as num).toDouble(), accuracyM: (j['accuracyM'] as num).toDouble(), isMocked: j['isMocked'] == true, at: DateTime.parse(j['at']));
}

enum BlockReason { permissionDenied, serviceDisabled, mockLocation, inaccurate }

class CaptureBlocked implements Exception {
  CaptureBlocked(this.reason, [this.accuracyM]);
  final BlockReason reason;
  final double? accuracyM;
  @override
  String toString() => 'CaptureBlocked($reason)';
}

abstract class LocationSource {
  /// A fresh GPS fix, or throws [CaptureBlocked] for permission/service problems.
  Future<GeoFix> current();
}

/// Capture is allowed only with a real, precise GPS fix (server rejects > 100 m and mock locations).
class CaptureGate {
  const CaptureGate({this.maxAccuracyM = 50});
  final double maxAccuracyM;

  GeoFix check(GeoFix fix) {
    if (fix.isMocked) throw CaptureBlocked(BlockReason.mockLocation);
    if (fix.accuracyM > maxAccuracyM) throw CaptureBlocked(BlockReason.inaccurate, fix.accuracyM);
    return fix;
  }
}

class GeolocatorSource implements LocationSource {
  const GeolocatorSource();

  @override
  Future<GeoFix> current() async {
    if (!await Geolocator.isLocationServiceEnabled()) throw CaptureBlocked(BlockReason.serviceDisabled);
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
    if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) throw CaptureBlocked(BlockReason.permissionDenied);
    final p = await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(accuracy: LocationAccuracy.best, timeLimit: Duration(seconds: 20)),
    );
    return GeoFix(lat: p.latitude, lng: p.longitude, accuracyM: p.accuracy, isMocked: p.isMocked, at: p.timestamp);
  }
}
