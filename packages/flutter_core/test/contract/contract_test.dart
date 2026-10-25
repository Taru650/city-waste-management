// End-to-end contract: the real Dart client (signing, upload, outbox) against the real API.
// Run via tool/contract_test.sh; skipped when CONTRACT_API is not defined.
@Tags(['contract'])
library;

import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_core/testing.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;

const apiUrl = String.fromEnvironment('CONTRACT_API');
const fixturesPath = String.fromEnvironment('CONTRACT_FIXTURES');

/// One app install: its own session store, device key and repositories.
class Install {
  Install() : store = MemoryTokenStore(), signer = SoftwareSigner.generate() {
    api = ApiClient(const CoreConfig(apiBaseUrl: apiUrl), store);
    registry = DeviceRegistry(api, signer);
    uploader = MediaUploader(api, signer, registry, retryDelay: const Duration(milliseconds: 200));
  }
  final MemoryTokenStore store;
  final SoftwareSigner signer;
  late final ApiClient api;
  late final DeviceRegistry registry;
  late final MediaUploader uploader;
  AuthRepository get auth => AuthRepository(api);
  ComplaintsRepository get complaints => ComplaintsRepository(api);
  MastersRepository get masters => MastersRepository(api);
}

/// A real JPEG with some texture (unique per call so the server's one-capture-once rule holds).
Uint8List photo() {
  final r = Random();
  final im = img.Image(width: 800, height: 600);
  for (final p in im) {
    p.setRgb(90 + r.nextInt(60), 110 + r.nextInt(50), 60 + r.nextInt(40));
  }
  return Uint8List.fromList(img.encodeJpg(im, quality: 80));
}

CapturedMedia at(double lat, double lng, {bool mocked = false, Duration age = Duration.zero}) =>
    CapturedMedia(kind: MediaKind.photo, path: '', fix: GeoFix(lat: lat, lng: lng, accuracyM: 6, isMocked: mocked), capturedAt: DateTime.now().subtract(age));

void main() {
  if (apiUrl.isEmpty) {
    test('contract tests need CONTRACT_API (run tool/contract_test.sh)', () {}, skip: 'CONTRACT_API not set');
    return;
  }
  final fixtures = jsonDecode(File(fixturesPath).readAsStringSync()) as Map<String, dynamic>;
  final users = fixtures['users'] as Map<String, dynamic>;
  String pw(String key) => users[key]['password'] as String;
  String mobile(String key) => users[key]['mobile'] as String;
  const siteLat = 25.0052, siteLng = 80.0047; // inside Ward 1 of Nagar Nigam Alpha (Area North → supervisor)

  setUpAll(() => HttpOverrides.global = null);

  late Install citizen;
  late Install supervisor;
  late Install worker;
  late String complaintId;

  test('a citizen registers, the app key signs a real capture, and the server accepts it', () async {
    citizen = Install();
    final m = '93${(DateTime.now().millisecondsSinceEpoch % 100000000).toString().padLeft(8, '0')}';
    await citizen.auth.registerCitizen(
      homeWardId: fixtures['wards']['A2'], name: 'Contract Citizen', mobile: m, email: 'contract$m@example.in', password: 'Swachh#Mobile2026',
    );
    await citizen.registry.register();
    final up = await citizen.uploader.uploadBytes(at(siteLat, siteLng), photo());
    expect(up.status, 'READY'); // signature, hash, magic bytes, scan and re-encode all passed server-side

    final located = await citizen.masters.locate(siteLat, siteLng);
    expect(located!.wardNumber, 1);

    final c = await citizen.complaints.create(
      typeId: (await citizen.masters.complaintTypes()).first.id, lat: siteLat, lng: siteLng, accuracyM: 6,
      landmark: 'Near Shiv Mandir', description: 'Kachra ka dher, contract test', mediaIds: [up.id],
    );
    expect(c.status, ComplaintStatus.assigned); // routed to the area supervisor by GPS, not the home ward (A2)
    expect(c.wardNumber, 1);
    complaintId = c.id;
  });

  test('the supervisor sees it and assigns a worker from the staff app', () async {
    supervisor = Install();
    expect(await supervisor.auth.login(mobile('supervisorA'), pw('supervisorA')), LoginOutcome.ok);
    final inbox = await supervisor.complaints.list();
    expect(inbox.items.map((x) => x.id), contains(complaintId));
    final workers = await StaffRepository(supervisor.api).workers();
    final sunita = workers.firstWhere((w) => w.name == 'Sunita Worker');
    final c = await supervisor.complaints.assign(complaintId, workerId: sunita.id);
    expect(c.workerName, 'Sunita Worker');
  });

  test('the worker starts and resolves with signed camera proof, via the offline outbox', () async {
    worker = Install();
    expect(await worker.auth.login(mobile('workerA1'), pw('workerA1')), LoginOutcome.ok);
    await worker.registry.register();
    final dir = await Directory.systemTemp.createTemp('contract-outbox');
    Future<CapturedMedia> shot() async {
      final f = File('${dir.path}/${DateTime.now().microsecondsSinceEpoch}.jpg')..writeAsBytesSync(photo());
      final base = at(siteLat + 0.0001, siteLng);
      return CapturedMedia(kind: base.kind, path: f.path, fix: base.fix, capturedAt: base.capturedAt);
    }

    final outbox = Outbox(FileOutboxStorage(File('${dir.path}/outbox.json')), worker.uploader, worker.complaints);
    await outbox.enqueue(kind: OutboxKind.startWork, complaintId: complaintId, payload: {'lat': siteLat, 'lng': siteLng, 'accuracyM': 6}, captures: [await shot()]);
    await outbox.enqueue(kind: OutboxKind.resolve, complaintId: complaintId, payload: {'remark': 'Kachra uthaya, chuna dala', 'lat': siteLat, 'lng': siteLng}, captures: [await shot(), await shot()]);
    final run = await outbox.run();
    expect(run.completed, 2, reason: outbox.items.map((i) => i.lastError).join('; '));
    expect(outbox.items, isEmpty);
    await dir.delete(recursive: true);
  });

  test('the citizen sees before/after evidence and closes it with a rating', () async {
    final c = await citizen.complaints.get(complaintId);
    expect(c.status, ComplaintStatus.resolved);
    expect(c.canGiveFeedback, isTrue);
    final media = await citizen.complaints.media(complaintId);
    expect(media.map((m) => m.stage).toSet(), {MediaStage.complaint, MediaStage.workStart, MediaStage.resolution});
    expect(media.every((m) => m.ready && m.url != null), isTrue);
    final thumb = await Dio().get<List<int>>(media.first.thumbnailUrl!, options: Options(responseType: ResponseType.bytes));
    expect(thumb.data!.take(3).toList(), [0xff, 0xd8, 0xff]); // a real JPEG from storage
    final closed = await citizen.complaints.feedback(complaintId, rating: 5, remark: 'Bahut accha');
    expect(closed.status, ComplaintStatus.closed);
    final byNumber = await citizen.complaints.track(closed.complaintNo);
    expect(byNumber.id, complaintId);
  });

  test('the server refuses captures the app did not sign, mocked locations and stale captures', () async {
    final rogue = Install()..store.tokens = await citizen.store.read();
    // Same account, but a key that was never registered for this device id.
    await rogue.store.writeValue('cwm.deviceId', await citizen.store.readValue('cwm.deviceId'));
    await expectLater(rogue.uploader.uploadBytes(at(siteLat, siteLng), photo()), throwsA(isA<MediaRejected>().having((e) => e.reason, 'reason', contains('signature'))));
    await expectLater(citizen.uploader.uploadBytes(at(siteLat, siteLng, mocked: true), photo()), throwsA(isA<MediaRejected>().having((e) => e.reason, 'reason', contains('Mock'))));
    await expectLater(citizen.uploader.uploadBytes(at(siteLat, siteLng, age: const Duration(hours: 25)), photo()), throwsA(isA<MediaRejected>()));
  });

  test('an expired access token is refreshed against the real API', () async {
    final t = (await citizen.store.read())!;
    citizen.store.tokens = Tokens('${t.accessToken}x', t.refreshToken); // invalid signature → 401 → refresh
    final me = await citizen.auth.me();
    expect(me.name, 'Contract Citizen');
    expect(citizen.store.tokens!.refreshToken, isNot(t.refreshToken));
  });

  test('staff on a temporary password: device registration waits for the password change (Staff app flow)', () async {
    final temp = Install();
    expect(await temp.auth.login(mobile('tempSupervisor'), pw('tempSupervisor')), LoginOutcome.ok);
    expect((await temp.auth.me()).mustChangePassword, isTrue);
    // This is why SessionNotifier.login skips registration: the API refuses it until the change.
    await expectLater(temp.registry.register(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 403)));
    await temp.auth.changePassword(pw('tempSupervisor'), 'Nayi#Shuruaat2026');
    expect((await temp.auth.me()).mustChangePassword, isFalse);
    await temp.registry.register();
    expect(await temp.registry.deviceId(), isNotNull);
  });

  test('open=true lists only complaints still being worked on (Staff app inbox)', () async {
    final open = await supervisor.complaints.list(open: true, pageSize: 100);
    expect(open.items, isNotEmpty);
    expect(open.items.every((c) => c.status.isOpen), isTrue);
    final all = await supervisor.complaints.list(pageSize: 100);
    expect(all.total, greaterThanOrEqualTo(open.total));
  });

  test('administrators are sent to the web portal (MFA) and cannot use the mobile apps', () async {
    final admin = Install();
    expect(await admin.auth.login(mobile('subAdminA'), pw('subAdminA')), LoginOutcome.mfaRequired);
    expect(await admin.store.read(), isNull);
  });
}
