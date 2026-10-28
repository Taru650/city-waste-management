import 'package:flutter/services.dart';

/// Result of the on-device root / tamper heuristics.
class IntegrityReport {
  const IntegrityReport({required this.compromised, this.reasons = const []});
  final bool compromised;
  final List<String> reasons;
}

/// Root and tamper heuristics run natively (MainActivity, channel "org.citywaste/device_integrity").
///
/// These checks are a speed bump, not a guarantee: a determined user with Magisk DenyList can hide
/// root. The server-side control is Play Integrity attestation (see docs/SECURITY.md, gaps).
abstract class DeviceIntegrity {
  Future<IntegrityReport> check();
}

class NativeDeviceIntegrity implements DeviceIntegrity {
  const NativeDeviceIntegrity([this._channel = const MethodChannel('org.citywaste/device_integrity')]);
  final MethodChannel _channel;

  @override
  Future<IntegrityReport> check() async {
    try {
      final r = await _channel.invokeMapMethod<String, dynamic>('check');
      final reasons = List<String>.from(r?['reasons'] as List? ?? const []);
      return IntegrityReport(compromised: r?['compromised'] == true, reasons: reasons);
    } on MissingPluginException {
      // iOS / desktop builds have no native check yet: do not block, the server still verifies media.
      return const IntegrityReport(compromised: false);
    }
  }
}
