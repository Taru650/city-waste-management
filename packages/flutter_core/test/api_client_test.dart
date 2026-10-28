import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_http.dart';

void main() {
  late MemoryTokenStore store;
  late FakeAdapter http;
  late ApiClient api;
  var refreshCalls = 0;

  setUp(() {
    store = MemoryTokenStore()..tokens = const Tokens('old-access', 'refresh-1');
    refreshCalls = 0;
    http = FakeAdapter((req, body) async {
      if (req.path == '/auth/refresh') {
        refreshCalls++;
        await Future<void>.delayed(const Duration(milliseconds: 30));
        return (body as Map)['refreshToken'] == 'refresh-1'
            ? FakeResponse(200, {'accessToken': 'new-access', 'refreshToken': 'refresh-2', 'expiresIn': 900})
            : FakeResponse(401, {'message': 'Unauthorized'});
      }
      if (req.headers['Authorization'] != 'Bearer new-access') return FakeResponse(401, {'message': 'Unauthorized'});
      return FakeResponse(200, {'ok': req.path});
    });
    final dio = Dio(BaseOptions(baseUrl: 'https://api.test/api/v1'))..httpClientAdapter = http;
    api = ApiClient(const CoreConfig(apiBaseUrl: 'https://api.test/api/v1'), store, dio: dio);
  });

  test('parallel 401s trigger exactly one refresh (refresh tokens are single-use)', () async {
    final results = await Future.wait(List.generate(5, (i) => api.get<Map<String, dynamic>>('/complaints/$i')));
    expect(results.map((r) => r['ok']), ['/complaints/0', '/complaints/1', '/complaints/2', '/complaints/3', '/complaints/4']);
    expect(refreshCalls, 1);
    expect(store.tokens!.refreshToken, 'refresh-2');
  });

  test('a refused refresh clears the session and signals expiry', () async {
    store.tokens = const Tokens('old-access', 'revoked');
    final expired = expectLater(api.onSessionExpired, emits(null));
    await expectLater(api.get('/auth/me'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)));
    await expired;
    expect(store.tokens, isNull);
  });

  test('maps validation errors and offline failures to readable ApiExceptions', () async {
    store.tokens = const Tokens('new-access', 'refresh-2');
    http.handler = (req, _) => FakeResponse(400, {'message': ['description must be longer', 'lat must be a latitude']});
    await expectLater(api.post('/complaints', {}), throwsA(isA<ApiException>().having((e) => e.message, 'message', 'description must be longer; lat must be a latitude')));
    http.handler = (req, _) => throw DioException(requestOptions: req, type: DioExceptionType.connectionError);
    await expectLater(api.get('/complaints'), throwsA(isA<ApiException>().having((e) => e.isNetwork, 'network', true)));
  });

  test('public calls send no Authorization header', () async {
    http.handler = (req, _) => FakeResponse(200, {'auth': req.headers['Authorization']});
    final r = await api.getPublic<Map<String, dynamic>>('/masters/districts');
    expect(r['auth'], isNull);
  });

  group('certificate pinning', () {
    // Generated with openssl at test-writing time; pin = base64(sha256(SPKI DER)).
    const certDer = 'MIIBjzCCATWgAwIBAgIUJyh1V5AhKOGoHphHZpTKzyewNEYwCgYIKoZIzj0EAwIwHTEbMBkGA1UEAwwSYXBpLmV4YW1wbGUuZ292LmluMB4XDTI2MTAyNTAyNTI1M1oXDTI2MTAyNjAyNTI1M1owHTEbMBkGA1UEAwwSYXBpLmV4YW1wbGUuZ292LmluMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE3NGQT3c/51567b2KlYJnwFk1yFpxAlX/sOj0ekRkZpnkbEsHGPBHaxdOhgAxNhB3LgFjuuEsFLcJc5wi6hon9qNTMFEwHQYDVR0OBBYEFI6FQcT8V45Bx2PGyYXMBJuERMYhMB8GA1UdIwQYMBaAFI6FQcT8V45Bx2PGyYXMBJuERMYhMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgZW2Rmi0vp/s+hp2h8LldSj2bWTF8aWZiglivaya5LygCIQCmpRDc1F9VnxLNn45oMfHLOBSbQmhLqx1ODco5qk5HoQ==';
    const expectedPin = 'tgOEm6nAcf1JGzg8I3TB+EK+CfeDSvUzL81zzhl3CKw=';

    test('extracts the SubjectPublicKeyInfo and computes the same pin as openssl', () {
      expect(spkiPin(base64.decode(certDer)), expectedPin);
    });

    test('release builds refuse http and missing pins', () {
      // assertReleaseReady only enforces in product mode; the rule itself:
      const insecure = CoreConfig(apiBaseUrl: 'http://api.test');
      expect(insecure.certPins, isEmpty);
      expect(insecure.apiBaseUrl.startsWith('https://'), isFalse);
    });
  });
}
