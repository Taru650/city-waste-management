import 'geo.dart';

enum MediaKind { photo, video }

/// A compressed capture waiting in app-private storage (never the gallery) until uploaded.
class CapturedMedia {
  CapturedMedia({required this.kind, required this.path, required this.fix, required this.capturedAt});

  final MediaKind kind;
  final String path;
  final GeoFix fix;
  final DateTime capturedAt;

  String get contentType => kind == MediaKind.photo ? 'image/jpeg' : 'video/mp4';
  String get apiKind => kind == MediaKind.photo ? 'PHOTO' : 'VIDEO';

  /// The server refuses captures older than 24 h; leave a margin for the upload itself.
  bool get expired => DateTime.now().difference(capturedAt) > const Duration(hours: 23);

  Map<String, dynamic> toJson() => {'kind': kind.name, 'path': path, 'fix': fix.toJson(), 'capturedAt': capturedAt.toUtc().toIso8601String()};
  factory CapturedMedia.fromJson(Map<String, dynamic> j) => CapturedMedia(
        kind: MediaKind.values.byName(j['kind']), path: j['path'], fix: GeoFix.fromJson(j['fix']), capturedAt: DateTime.parse(j['capturedAt']),
      );
}
