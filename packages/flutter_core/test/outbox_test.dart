import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_core/testing.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_http.dart';

void main() {
  late Directory dir;
  late FakeAdapter http;
  late Outbox outbox;
  late FileOutboxStorage storage;
  var uploads = 0;
  bool offline = false;
  int? resolveStatus;

  Future<CapturedMedia> capture({Duration age = Duration.zero}) async {
    final f = File('${dir.path}/c${DateTime.now().microsecondsSinceEpoch}.jpg')..writeAsBytesSync(List.filled(100, uploads + 1));
    return CapturedMedia(kind: MediaKind.photo, path: f.path, capturedAt: DateTime.now().subtract(age), fix: GeoFix(lat: 21, lng: 81, accuracyM: 5, isMocked: false));
  }

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('outbox');
    uploads = 0;
    offline = false;
    resolveStatus = null;
    http = FakeAdapter((req, body) {
      if (offline) throw DioException(requestOptions: req, type: DioExceptionType.connectionError);
      if (req.path == '/devices') return FakeResponse(201, {'id': 'dev'});
      if (req.path == '/media/upload-url') {
        uploads++;
        return FakeResponse(201, {'mediaId': 'm$uploads', 'uploadUrl': 'https://storage.test/m$uploads', 'headers': {'Content-Type': 'image/jpeg'}});
      }
      if (req.path.endsWith('/confirm')) return FakeResponse(200, {'id': req.path.split('/')[2], 'status': 'READY'});
      if (req.path.endsWith('/resolve')) {
        if (resolveStatus != null) return FakeResponse(resolveStatus!, {'message': resolveStatus == 409 ? 'WORKER cannot RESOLVE a complaint that is CLOSED' : 'Server error'});
        return FakeResponse(201, complaintJson);
      }
      return FakeResponse(404);
    });
    final api = ApiClient(const CoreConfig(apiBaseUrl: 'https://api.test'), MemoryTokenStore()..tokens = const Tokens('a', 'r'),
        dio: Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = http, uploadDio: Dio()..httpClientAdapter = FakeAdapter((_, _) => FakeResponse(200)));
    final signer = SoftwareSigner.generate();
    storage = FileOutboxStorage(File('${dir.path}/outbox.json'));
    outbox = Outbox(storage, MediaUploader(api, signer, DeviceRegistry(api, signer)), ComplaintsRepository(api));
  });
  tearDown(() => dir.delete(recursive: true));

  test('uploads captures, performs the action, removes the item and deletes the local files', () async {
    final c1 = await capture();
    final c2 = await capture();
    await outbox.enqueue(kind: OutboxKind.resolve, complaintId: 'c-1', payload: {'remark': 'Cleaned the drain'}, captures: [c1, c2]);
    final r = await outbox.run();
    expect(r.completed, 1);
    expect(outbox.items, isEmpty);
    expect(File(c1.path).existsSync(), isFalse);
    final resolveBody = http.bodies[http.requests.indexWhere((q) => q.path == '/complaints/c-1/resolve')] as Map;
    expect(resolveBody['mediaIds'], ['m1', 'm2']);
  });

  test('going offline keeps the item; the retry does not upload finished captures again', () async {
    await outbox.enqueue(kind: OutboxKind.resolve, complaintId: 'c-1', payload: {'remark': 'Cleaned the drain'}, captures: [await capture(), await capture()]);
    resolveStatus = 500;
    final first = await outbox.run();
    expect(first.remaining, 1);
    expect(outbox.items.single.uploadedMediaIds, ['m1', 'm2']);
    resolveStatus = null;
    offline = true;
    expect((await outbox.run()).offline, isTrue);
    offline = false;
    expect((await outbox.run()).completed, 1);
    expect(uploads, 2); // still only two uploads in total
  });

  test('a definite refusal marks the item failed with the server\'s reason', () async {
    await outbox.enqueue(kind: OutboxKind.resolve, complaintId: 'c-1', payload: {'remark': 'Cleaned the drain'}, captures: [await capture()]);
    resolveStatus = 409;
    await outbox.run();
    expect(outbox.items.single.state, OutboxState.failed);
    expect(outbox.items.single.lastError, contains('CLOSED'));
  });

  test('captures older than 23 hours are marked expired instead of being sent', () async {
    await outbox.enqueue(kind: OutboxKind.startWork, complaintId: 'c-1', payload: {}, captures: [await capture(age: const Duration(hours: 24))]);
    await outbox.run();
    expect(outbox.items.single.state, OutboxState.expired);
    expect(uploads, 0);
  });

  test('the queue survives an app restart', () async {
    await outbox.enqueue(kind: OutboxKind.createComplaint, payload: {'typeId': 't', 'lat': 21.0, 'lng': 81.0, 'description': 'Garbage heap'}, captures: [await capture()]);
    final reloaded = await storage.load();
    expect(reloaded.single.kind, OutboxKind.createComplaint);
    expect(reloaded.single.payload['description'], 'Garbage heap');
    expect(reloaded.single.captures.single.fix.lat, 21);
  });

  test('concurrent run() calls share one run', () async {
    await outbox.enqueue(kind: OutboxKind.resolve, complaintId: 'c-1', payload: {'remark': 'Cleaned the drain'}, captures: [await capture()]);
    final results = await Future.wait([outbox.run(), outbox.run()]);
    expect(identical(results[0], results[1]), isTrue);
    expect(uploads, 1);
  });

  test('clear() drops queued work and its files, and survives a reload (sign-out)', () async {
    offline = true;
    final c1 = await capture();
    await outbox.enqueue(kind: OutboxKind.resolve, complaintId: 'c-1', payload: {'remark': 'Cleaned the drain'}, captures: [c1]);
    await outbox.run();
    expect(outbox.items, hasLength(1));
    await outbox.clear();
    expect(outbox.items, isEmpty);
    expect(File(c1.path).existsSync(), isFalse);
    expect(await storage.load(), isEmpty);
  });
}

final complaintJson = {
  'id': 'c-1', 'complaintNo': '0446-800123-26-000001', 'status': 'RESOLVED', 'description': 'x', 'location': {'lat': 21, 'lng': 81},
  'ulb': {'id': 'u', 'name': 'U'}, 'ward': {'id': 'w', 'number': 1}, 'type': {'nameEn': 'Garbage', 'nameHi': 'कचरा'},
  'slaDueAt': '2026-10-26T00:00:00Z', 'slaBreached': false, 'createdAt': '2026-10-25T00:00:00Z',
};
