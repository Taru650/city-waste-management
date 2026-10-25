import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_core/testing.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_http.dart';

CapturedMedia media({DateTime? at, MediaKind kind = MediaKind.photo, bool mocked = false}) => CapturedMedia(
      kind: kind, path: '/unused', capturedAt: at ?? DateTime.now(),
      fix: GeoFix(lat: 21.2514, lng: 81.6296, accuracyM: 6.5, isMocked: mocked),
    );

void main() {
  late FakeAdapter http;
  late FakeAdapter storage;
  late MediaUploader uploader;
  late MemoryTokenStore store;
  final bytes = Uint8List.fromList(List.generate(2048, (i) => i % 251));
  int confirmFailures = 0;
  String? revokedDevice;

  setUp(() {
    store = MemoryTokenStore()..tokens = const Tokens('a', 'r');
    confirmFailures = 0;
    revokedDevice = null;
    http = FakeAdapter((req, body) {
      final b = body as Map?;
      switch (req.path) {
        case '/devices':
          return FakeResponse(201, {'id': 'device-${http.requests.where((r) => r.path == '/devices').length}'});
        case '/media/upload-url':
          if (b!['deviceId'] == revokedDevice) return FakeResponse(400, {'message': 'Unknown or revoked device; register the device again'});
          return FakeResponse(201, {'mediaId': 'm1', 'uploadUrl': 'https://storage.test/staging/m1?sig=x', 'headers': {'Content-Type': b['contentType'], 'Content-Length': '${b['bytes']}'}});
        case '/media/m1/confirm':
          if (confirmFailures-- > 0) return FakeResponse(503, {'message': 'Malware scanning is temporarily unavailable'});
          return FakeResponse(200, {'id': 'm1', 'status': 'READY'});
      }
      return FakeResponse(404);
    });
    storage = FakeAdapter((req, body) => FakeResponse(200));
    final api = ApiClient(const CoreConfig(apiBaseUrl: 'https://api.test'), store,
        dio: Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = http, uploadDio: Dio()..httpClientAdapter = storage);
    final signer = SoftwareSigner.generate();
    uploader = MediaUploader(api, signer, DeviceRegistry(api, signer), retryDelay: Duration.zero);
  });

  test('follows the capture contract: declared size+hash, PUT to storage, signed manifest bound to this upload', () async {
    final r = await uploader.uploadBytes(media(), bytes);
    expect(r.status, 'READY');
    final declared = http.bodies[http.requests.indexWhere((q) => q.path == '/media/upload-url')] as Map;
    expect(declared, {'deviceId': 'device-1', 'kind': 'PHOTO', 'contentType': 'image/jpeg', 'bytes': 2048, 'sha256': sha256.convert(bytes).toString()});
    expect(storage.requests.single.method, 'PUT');
    expect(storage.requests.single.uri.toString(), 'https://storage.test/staging/m1?sig=x');
    expect(storage.bodies.single, bytes);

    final confirm = http.bodies.last as Map;
    expect(confirm['manifest'], matches(RegExp(r'^[A-Za-z0-9_-]+$'))); // base64url, no padding (server rule)
    final manifest = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(confirm['manifest'])))) as Map;
    expect(manifest, {
      'v': 1, 'mediaId': 'm1', 'deviceId': 'device-1', 'kind': 'PHOTO', 'sha256': declared['sha256'],
      'capturedAt': matches(RegExp(r'Z$')), 'lat': 21.2514, 'lng': 81.6296, 'accuracyM': 6.5, 'isMockLocation': false,
    });
    expect(confirm['signature'], isNotEmpty);
  });

  test('retries the confirm while the malware scanner is busy (503)', () async {
    confirmFailures = 2;
    expect((await uploader.uploadBytes(media(), bytes)).status, 'READY');
    expect(http.requests.where((r) => r.path == '/media/m1/confirm').length, 3);
  });

  test('a revoked device key is registered again once, then the upload proceeds', () async {
    await store.writeValue('cwm.deviceId', 'device-old');
    revokedDevice = 'device-old';
    await uploader.uploadBytes(media(), bytes);
    expect(http.requests.where((r) => r.path == '/devices').length, 1);
    expect(await store.readValue('cwm.deviceId'), 'device-1');
  });

  test('server rejections surface as MediaRejected with the reason', () async {
    http.handler = (req, body) => switch (req.path) {
          '/devices' => FakeResponse(201, {'id': 'd'}),
          '/media/upload-url' => FakeResponse(201, {'mediaId': 'm1', 'uploadUrl': 'https://storage.test/x', 'headers': {'Content-Type': 'image/jpeg'}}),
          _ => FakeResponse(422, {'statusCode': 422, 'message': 'Mock (fake) GPS location detected', 'mediaStatus': 'REJECTED'}),
        };
    await expectLater(uploader.uploadBytes(media(mocked: true), bytes), throwsA(isA<MediaRejected>().having((e) => e.reason, 'reason', contains('Mock'))));
  });

  test('captures older than 23 h are not even attempted', () async {
    await expectLater(uploader.uploadBytes(media(at: DateTime.now().subtract(const Duration(hours: 24))), bytes), throwsA(isA<MediaRejected>()));
    expect(http.requests, isEmpty);
  });

  test('capturedAt survives a JSON round trip for the outbox', () {
    final m = media();
    final back = CapturedMedia.fromJson(jsonDecode(jsonEncode(m.toJson())));
    expect(back.capturedAt.toUtc(), m.capturedAt.toUtc().subtract(Duration(microseconds: m.capturedAt.microsecond % 1)));
    expect(back.fix.accuracyM, 6.5);
    expect(File(back.path).path, '/unused');
  });
}
