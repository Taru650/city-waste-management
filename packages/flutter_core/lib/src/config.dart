/// Build-time configuration, passed with `--dart-define`:
///
/// ```
/// flutter build apk --dart-define=API_BASE_URL=https://api.example.gov.in/api/v1 \
///   --dart-define=CERT_PINS=PRIMARY_PIN,BACKUP_PIN --dart-define=PLAY_CLOUD_PROJECT_NUMBER=123456789012
/// ```
/// (pins are base64 SHA-256 of the certificate's SubjectPublicKeyInfo)
class CoreConfig {
  const CoreConfig({required this.apiBaseUrl, this.certPins = const [], this.appName = 'Swachh Seva', this.cloudProjectNumber = 0});

  final String apiBaseUrl;

  /// Base64 SHA-256 hashes of the server certificate's SubjectPublicKeyInfo. Empty = no pinning
  /// (development only; release builds refuse to start without pins, see [assertReleaseReady]).
  final List<String> certPins;
  final String appName;

  /// Google Cloud project number linked to the app in Play Console (Play Integrity). 0 = not set.
  final int cloudProjectNumber;

  factory CoreConfig.fromEnvironment() {
    const url = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000/api/v1');
    const pins = String.fromEnvironment('CERT_PINS');
    const project = int.fromEnvironment('PLAY_CLOUD_PROJECT_NUMBER');
    return CoreConfig(
      apiBaseUrl: url,
      cloudProjectNumber: project,
      certPins: pins.isEmpty ? const [] : pins.split(',').map((p) => p.trim()).where((p) => p.isNotEmpty).toList(),
    );
  }

  /// Release builds must talk HTTPS to a pinned certificate.
  void assertReleaseReady() {
    const isRelease = bool.fromEnvironment('dart.vm.product');
    if (!isRelease) return;
    if (!apiBaseUrl.startsWith('https://')) throw StateError('Release builds require an https API_BASE_URL');
    if (certPins.isEmpty) throw StateError('Release builds require CERT_PINS');
    if (cloudProjectNumber == 0) throw StateError('Release builds require PLAY_CLOUD_PROJECT_NUMBER (Play Integrity)');
  }
}
