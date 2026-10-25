import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class Tokens {
  const Tokens(this.accessToken, this.refreshToken);
  final String accessToken;
  final String refreshToken;
}

/// Where the session lives. Production: [SecureTokenStore] (Android Keystore / iOS Keychain).
abstract class TokenStore {
  Future<Tokens?> read();
  Future<void> write(Tokens tokens);
  Future<void> clear();
  Future<String?> readValue(String key);
  Future<void> writeValue(String key, String? value);
}

class SecureTokenStore implements TokenStore {
  SecureTokenStore([FlutterSecureStorage? storage])
      : _s = storage ??
            const FlutterSecureStorage(
              // Not restored onto another device from a backup; locked when the device is locked.
              iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
            );

  final FlutterSecureStorage _s;
  static const _access = 'cwm.access';
  static const _refresh = 'cwm.refresh';

  @override
  Future<Tokens?> read() async {
    final a = await _s.read(key: _access);
    final r = await _s.read(key: _refresh);
    return a != null && r != null ? Tokens(a, r) : null;
  }

  @override
  Future<void> write(Tokens tokens) async {
    await _s.write(key: _access, value: tokens.accessToken);
    await _s.write(key: _refresh, value: tokens.refreshToken);
  }

  @override
  Future<void> clear() async {
    await _s.delete(key: _access);
    await _s.delete(key: _refresh);
  }

  @override
  Future<String?> readValue(String key) => _s.read(key: key);

  @override
  Future<void> writeValue(String key, String? value) => value == null ? _s.delete(key: key) : _s.write(key: key, value: value);
}

/// For tests.
class MemoryTokenStore implements TokenStore {
  Tokens? tokens;
  final Map<String, String> values = {};

  @override
  Future<Tokens?> read() async => tokens;
  @override
  Future<void> write(Tokens t) async => tokens = t;
  @override
  Future<void> clear() async => tokens = null;
  @override
  Future<String?> readValue(String key) async => values[key];
  @override
  Future<void> writeValue(String key, String? value) async => value == null ? values.remove(key) : values[key] = value;
}
