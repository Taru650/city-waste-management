import 'package:dio/dio.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_core/testing.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_http.dart';

void main() {
  late FakeAdapter http;
  late NotificationsRepository repo;

  setUp(() {
    http = FakeAdapter((req, body) => FakeResponse(204));
    final api = ApiClient(const CoreConfig(apiBaseUrl: 'https://api.test'), MemoryTokenStore()..tokens = const Tokens('a', 'r'),
        dio: Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = http);
    repo = NotificationsRepository(api);
  });

  List<String> calls() => [for (var i = 0; i < http.requests.length; i++) '${http.requests[i].method} ${http.requests[i].path} ${http.bodies[i]}'];

  test('registers the FCM token after sign-in and again when FCM rotates it', () async {
    final client = FakePushClient();
    final r = PushRegistrar(client, repo);
    await r.start();
    expect(calls().single, 'POST /notifications/push-tokens {token: fcm-token-0000000000000000000001, platform: ANDROID}');
    client.refreshCtl.add('fcm-token-0000000000000000000002');
    await pumpEventQueue();
    expect(r.registeredToken, 'fcm-token-0000000000000000000002');
    expect(calls(), hasLength(2));
  });

  test('sign-out removes the token from the server and deletes it on the phone (shared phones)', () async {
    final client = FakePushClient();
    final r = PushRegistrar(client, repo);
    await r.start();
    await r.stop();
    expect(calls().last, 'DELETE /notifications/push-tokens {token: fcm-token-0000000000000000000001}');
    expect(client.deleted, isTrue);
    client.refreshCtl.add('fcm-token-after-signout-000000000000');
    await pumpEventQueue();
    expect(calls(), hasLength(2), reason: 'no registration after sign-out');
  });

  test('no permission or no Firebase settings: nothing is registered and nothing fails', () async {
    await PushRegistrar(FakePushClient(granted: false), repo).start();
    await PushRegistrar(null, repo).start();
    await PushRegistrar(null, repo).stop();
    expect(http.requests, isEmpty);
  });

  test('server unreachable at sign-out: the phone token is still deleted', () async {
    final client = FakePushClient();
    final r = PushRegistrar(client, repo);
    await r.start();
    http.handler = (req, _) => throw DioException(requestOptions: req, type: DioExceptionType.connectionError);
    await r.stop();
    expect(client.deleted, isTrue);
  });

  test('builds without Firebase settings run without push', () async {
    expect(FirebaseSettings.fromEnvironment(), isNull);
    expect(await FirebasePushClient.create(null), isNull);
  });
}
