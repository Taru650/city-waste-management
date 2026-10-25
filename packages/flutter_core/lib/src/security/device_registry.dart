import '../api/api_client.dart';
import '../api/api_exception.dart';
import 'attestation.dart';
import 'device_signer.dart';

/// Registers this install's public key with the server (idempotent; re-run after every login,
/// because logout-all and password resets revoke device keys).
class DeviceRegistry {
  DeviceRegistry(this.api, this.signer, {this.platform = 'ANDROID', this.appVersion, this.attestor});

  final ApiClient api;
  final DeviceSigner signer;
  final String platform;
  final String? appVersion;
  final Attestor? attestor;
  static const _key = 'cwm.deviceId';

  /// When the server wants proof that this is the genuine app on a genuine phone it answers 428
  /// with a challenge; the Play Integrity token is then bound to this key and the call repeated.
  Future<String> register() async {
    final key = await signer.publicKeySpkiBase64();
    final body = {'publicKey': key, 'platform': platform, if (appVersion != null) 'appVersion': appVersion};
    Map<String, dynamic> r;
    try {
      r = await api.post<Map<String, dynamic>>('/devices', body);
    } on ApiException catch (e) {
      final challenge = e.body is Map ? (e.body as Map)['challenge'] : null;
      if (e.status != 428 || challenge is! String || attestor == null) rethrow;
      r = await api.post<Map<String, dynamic>>('/devices', {...body, ...await attestor!.answer(challenge, binding: key)});
    }
    final id = r['id'] as String;
    await api.store.writeValue(_key, id);
    return id;
  }

  Future<String> deviceId() async => await api.store.readValue(_key) ?? await register();

  Future<void> forget() => api.store.writeValue(_key, null);
}
