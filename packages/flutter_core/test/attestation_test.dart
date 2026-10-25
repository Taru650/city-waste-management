import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_core/testing.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_http.dart';

void main() {
  late FakeAdapter http;
  late ApiClient api;
  bool enabled = true;

  setUp(() {
    enabled = true;
    http = FakeAdapter((req, body) {
      if (req.path == '/attestation/challenge') {
        return FakeResponse(200, enabled ? {'enabled': true, 'challenge': '${(body as Map)['purpose']}.123.abc.mac'} : {'enabled': false});
      }
      if (req.path == '/devices') {
        final b = body as Map;
        if (b['integrityToken'] == null && b['attestationError'] == null) return FakeResponse(428, {'message': 'Device attestation required', 'challenge': 'device.999.xyz.mac'});
        return FakeResponse(201, {'id': 'dev-9'});
      }
      if (req.path == '/auth/register') return FakeResponse(201, {'accessToken': 'a', 'refreshToken': 'r'});
      if (req.path == '/auth/forgot-password') return FakeResponse(202, {});
      return FakeResponse(404);
    });
    api = ApiClient(const CoreConfig(apiBaseUrl: 'https://api.test'), MemoryTokenStore()..tokens = const Tokens('a', 'r'),
        dio: Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = http);
  });

  Map bodyOf(String path) => http.bodies[http.requests.lastIndexWhere((r) => r.path == path)] as Map;

  test('nonce derivation matches the API: base64url(sha256(challenge|binding)) without padding', () {
    final expected = base64Url.encode(sha256.convert(utf8.encode('device.1.x.m|KEY')).bytes).replaceAll('=', '');
    expect(integrityNonce('device.1.x.m', 'KEY'), expected);
    expect(integrityNonce('c'), isNot(contains('=')));
    expect(integrityNonce('c').length, 43);
  });

  test('registration carries a Play Integrity proof for the register challenge', () async {
    final source = FakeIntegritySource('org.citywaste.cwm_citizen');
    final auth = AuthRepository(api, attestor: Attestor(api, source));
    await auth.registerCitizen(homeWardId: 'w', name: 'A', mobile: '9876543210', email: 'a@x.in', password: 'Swachh#2026', consentNoticeVersion: 'v1');
    final body = bodyOf('/auth/register');
    expect(body['attestationChallenge'], 'register.123.abc.mac');
    expect(source.nonces.single, integrityNonce('register.123.abc.mac'));
    expect((body['integrityToken'] as String).startsWith('fake.'), isTrue);
  });

  test('when the server has attestation off, nothing extra is sent', () async {
    enabled = false;
    final source = FakeIntegritySource('org.citywaste.cwm_citizen');
    await AuthRepository(api, attestor: Attestor(api, source)).forgotPassword('a@x.in');
    expect(bodyOf('/auth/forgot-password'), {'identifier': 'a@x.in'});
    expect(source.nonces, isEmpty);
  });

  test('a phone without Play services sends the error code instead of a token', () async {
    final auth = AuthRepository(api, attestor: Attestor(api, FakeIntegritySource('x', failWith: 'PLAY_INTEGRITY_-1')));
    await auth.forgotPassword('a@x.in');
    expect(bodyOf('/auth/forgot-password'), {'attestationError': 'PLAY_INTEGRITY_-1', 'identifier': 'a@x.in'});
  });

  test('device registration answers a 428 challenge with a token bound to the public key', () async {
    final signer = SoftwareSigner.generate();
    final source = FakeIntegritySource('org.citywaste.cwm_staff');
    final registry = DeviceRegistry(api, signer, attestor: Attestor(api, source));
    expect(await registry.register(), 'dev-9');
    final key = await signer.publicKeySpkiBase64();
    expect(source.nonces.single, integrityNonce('device.999.xyz.mac', key));
    expect(bodyOf('/devices')['attestationChallenge'], 'device.999.xyz.mac');
    expect(http.requests.where((r) => r.path == '/devices'), hasLength(2));
  });

  test('without an attestor a 428 is surfaced, not swallowed', () async {
    final registry = DeviceRegistry(api, SoftwareSigner.generate());
    await expectLater(registry.register(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 428)));
  });

  test('native source: unconfigured project number and missing plugin become error codes', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await expectLater(const NativeIntegrity(0).token('n'), throwsA(isA<IntegrityUnavailable>().having((e) => e.code, 'code', 'NOT_CONFIGURED')));
    await expectLater(const NativeIntegrity(123).token('n'), throwsA(isA<IntegrityUnavailable>().having((e) => e.code, 'code', 'UNSUPPORTED_PLATFORM')));
  });
}
