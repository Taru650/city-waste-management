import '../api/api_client.dart';
import 'device_signer.dart';

/// Registers this install's public key with the server (idempotent; re-run after every login,
/// because logout-all and password resets revoke device keys).
class DeviceRegistry {
  DeviceRegistry(this.api, this.signer, {this.platform = 'ANDROID', this.appVersion});

  final ApiClient api;
  final DeviceSigner signer;
  final String platform;
  final String? appVersion;
  static const _key = 'cwm.deviceId';

  Future<String> register() async {
    final r = await api.post<Map<String, dynamic>>('/devices', {
      'publicKey': await signer.publicKeySpkiBase64(), 'platform': platform, if (appVersion != null) 'appVersion': appVersion,
    });
    final id = r['id'] as String;
    await api.store.writeValue(_key, id);
    return id;
  }

  Future<String> deviceId() async => await api.store.readValue(_key) ?? await register();

  Future<void> forget() => api.store.writeValue(_key, null);
}
