import 'dart:async';

import 'package:flutter/material.dart';

import '../i18n/strings.dart';
import 'geo.dart';

/// Polls GPS and reports whether a capture is allowed right now. Shared by the camera screen;
/// kept separate from the camera plugin so it can be tested without hardware.
class GpsGateController extends ChangeNotifier {
  GpsGateController(this.source, {this.gate = const CaptureGate(), this.interval = const Duration(seconds: 2)});

  final LocationSource source;
  final CaptureGate gate;
  final Duration interval;
  Timer? _timer;
  GeoFix? fix;
  CaptureBlocked? blocked;
  bool get ready => fix != null && blocked == null;

  /// Starts (or restarts) polling. Restarting cancels the previous timer, so repeated calls never leak pollers.
  void start() {
    _timer?.cancel();
    _poll();
    _timer = Timer.periodic(interval, (_) => _poll());
  }

  Future<void> _poll() async {
    try {
      final f = await source.current();
      fix = f;
      try {
        gate.check(f);
        blocked = null;
      } on CaptureBlocked catch (b) {
        blocked = b;
      }
    } on CaptureBlocked catch (b) {
      blocked = b;
      fix = null;
    } catch (_) {
      blocked = null;
      fix = null;
    }
    notifyListeners();
  }

  /// A fresh, validated fix taken at shutter time (not the last polled one).
  Future<GeoFix> fixForShutter() async => gate.check(await source.current());

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}

class GpsStatusChip extends StatelessWidget {
  const GpsStatusChip(this.controller, {super.key});
  final GpsGateController controller;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final b = controller.blocked;
        final f = controller.fix;
        final (text, color) = switch ((b?.reason, f)) {
          (BlockReason.mockLocation, _) => (s.t('gpsMock'), Colors.red),
          (BlockReason.permissionDenied, _) => (s.t('gpsDenied'), Colors.red),
          (BlockReason.serviceDisabled, _) => (s.t('gpsOff'), Colors.red),
          (BlockReason.inaccurate, _) => (s.t('gpsWeak', {'m': b!.accuracyM!.round()}), Colors.orange),
          (null, final GeoFix ok) => (s.t('gpsOk', {'m': ok.accuracyM.round()}), Colors.green),
          _ => (s.t('locating'), Colors.grey),
        };
        return Container(
          key: const Key('gps-status'),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(16)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.gps_fixed, size: 16, color: color),
            const SizedBox(width: 6),
            Flexible(child: Text(text, style: const TextStyle(color: Colors.white))),
          ]),
        );
      },
    );
  }
}
