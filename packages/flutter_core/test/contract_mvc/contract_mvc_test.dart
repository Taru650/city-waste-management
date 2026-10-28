// End-to-end contract: the real Dart client (signing, upload, outbox) against the Next.js + MySQL API (apps/mvc-app).
// Run via tool/contract_mvc.sh; skipped when CONTRACT_API is not defined.
// The same flows as test/contract, minus Play Integrity and MFA (this edition has neither).
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

const citizenPackage = 'org.citywaste.cwm_citizen';
const staffPackage = 'org.citywaste.cwm_staff';

/// One app install: its own session store, device key, Play Integrity identity and repositories.
/// This API never asks for attestation, so the Play Integrity source is present but never called.
class Install {
  Install({String package = citizenPackage, List<String>? device})
      : store = MemoryTokenStore(),
        signer = SoftwareSigner.generate(),
        integrity = FakeIntegritySource(package, device: device ?? const ['MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY']) {
    api = ApiClient(const CoreConfig(apiBaseUrl: apiUrl), store);
    attestor = Attestor(api, integrity);
    registry = DeviceRegistry(api, signer, attestor: attestor);
    uploader = MediaUploader(api, signer, registry, retryDelay: const Duration(milliseconds: 200));
  }
  factory Install.staff({List<String>? device}) => Install(package: staffPackage, device: device);
  final MemoryTokenStore store;
  final SoftwareSigner signer;
  final FakeIntegritySource integrity;
  late final ApiClient api;
  late final Attestor attestor;
  late final DeviceRegistry registry;
  late final MediaUploader uploader;
  AuthRepository get auth => AuthRepository(api, attestor: attestor);
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
    test('contract tests need CONTRACT_API (run tool/contract_mvc.sh)', () {}, skip: 'CONTRACT_API not set');
    return;
  }
  final fixtures = jsonDecode(File(fixturesPath).readAsStringSync()) as Map<String, dynamic>;
  final password = fixtures['password'] as String; // every demo account
  final siteLat = (fixtures['site']['lat'] as num).toDouble(), siteLng = (fixtures['site']['lng'] as num).toDouble(); // inside a ward of the North supervisor's area

  setUpAll(() => HttpOverrides.global = null);

  late Install citizen;
  late Install supervisor;
  late Install worker;
  late String complaintId;

  test('a citizen registers, the app key signs a real capture, and the server accepts it', () async {
    citizen = Install();
    final m = '93${(DateTime.now().millisecondsSinceEpoch % 100000000).toString().padLeft(8, '0')}';
    // DPDP: the app shows the notice and sends the version the citizen accepted.
    final notice = await PrivacyRepository(citizen.api).notice('hi');
    expect(notice.sections, isNotEmpty);
    await citizen.auth.registerCitizen(
      homeWardId: fixtures['homeWardId'], name: 'Contract Citizen', mobile: m, email: 'contract$m@example.in', password: 'Swachh#Mobile2026',
      consentNoticeVersion: notice.version,
    );
    expect((await citizen.auth.me()).consentRequired, isFalse);
    await citizen.registry.register();
    final up = await citizen.uploader.uploadBytes(at(siteLat, siteLng), photo());
    expect(up.status, 'READY'); // signature, hash, magic bytes, scan and re-encode all passed server-side

    final located = await citizen.masters.locate(siteLat, siteLng);
    expect(located!.wardNumber, fixtures['site']['wardNumber']);

    final c = await citizen.complaints.create(
      typeId: (await citizen.masters.complaintTypes()).first.id, lat: siteLat, lng: siteLng, accuracyM: 6,
      landmark: 'Near Shiv Mandir', description: 'Kachra ka dher, contract test', mediaIds: [up.id],
    );
    expect(c.status, ComplaintStatus.assigned); // routed to the area supervisor by GPS, not the home ward
    expect(c.wardNumber, fixtures['site']['wardNumber']);
    complaintId = c.id;
  });

  test('the supervisor sees it and assigns a worker from the staff app', () async {
    supervisor = Install.staff();
    expect(await supervisor.auth.login(fixtures['supervisor'], password), LoginOutcome.ok);
    final inbox = await supervisor.complaints.list();
    expect(inbox.items.map((x) => x.id), contains(complaintId));
    final workers = await StaffRepository(supervisor.api).workers();
    final ramesh = workers.firstWhere((w) => w.name.startsWith('Ramesh Yadav'));
    final c = await supervisor.complaints.assign(complaintId, workerId: ramesh.id);
    expect(c.workerName, startsWith('Ramesh Yadav'));
  });

  test('the worker starts and resolves with signed camera proof, via the offline outbox', () async {
    worker = Install.staff();
    expect(await worker.auth.login(fixtures['worker'], password), LoginOutcome.ok);
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
    // A Sub Admin (through the same API, as the website does) creates a supervisor with a temporary password.
    final admin = Dio(BaseOptions(baseUrl: apiUrl));
    final token = (await admin.post<Map<String, dynamic>>('/auth/login', data: {'identifier': fixtures['subAdmin'], 'password': password})).data!['accessToken'];
    final mobile = '92${(DateTime.now().millisecondsSinceEpoch % 100000000).toString().padLeft(8, '0')}';
    final made = await admin.post<Map<String, dynamic>>('/users', data: {'role': 'SUPERVISOR', 'name': 'Temp Supervisor', 'mobile': mobile},
        options: Options(headers: {'authorization': 'Bearer $token'}));
    final temp = Install.staff();
    expect(await temp.auth.login(mobile, made.data!['tempPassword'] as String), LoginOutcome.ok);
    expect((await temp.auth.me()).mustChangePassword, isTrue);
    // This is why SessionNotifier.login skips registration: the API refuses it until the change.
    await expectLater(temp.registry.register(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 403)));
    await temp.auth.changePassword(made.data!['tempPassword'] as String, 'Nayi#Shuruaat2026');
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

  test('DPDP: a citizen exports their data, corrects their name, and erases the account', () async {
    final c = Install();
    final privacy = PrivacyRepository(c.api);
    final notice = await privacy.notice('en');
    final m = '94${(DateTime.now().millisecondsSinceEpoch % 100000000).toString().padLeft(8, '0')}';
    await c.auth.registerCitizen(
      homeWardId: fixtures['homeWardId'], name: 'Erase Me', mobile: m, email: 'erase$m@example.in', password: 'Swachh#Erase2026',
      consentNoticeVersion: notice.version, consentLanguage: 'en',
    );
    final data = await privacy.myData();
    expect((data['profile'] as Map)['mobile'], m);
    expect((data['consents'] as List).single['noticeVersion'], notice.version);
    await privacy.correct(name: 'Erase Me Please');
    expect((await c.auth.me()).name, 'Erase Me Please');
    await expectLater(privacy.erase('wrong-password-1'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 400)));
    expect(await c.store.read(), isNotNull, reason: 'a wrong password must not end the session');
    await privacy.erase('Swachh#Erase2026');
    await expectLater(Install().auth.login(m, 'Swachh#Erase2026'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)));
  });

  test('the website and the apps share one API: a cookie session sees the same complaint the app filed', () async {
    // The website signs in with session=cookie; the answer carries no token for page scripts.
    final web = Dio(BaseOptions(baseUrl: apiUrl, validateStatus: (_) => true, followRedirects: false));
    final login = await web.post<Map<String, dynamic>>('/auth/login',
        data: {'identifier': fixtures['subAdmin'], 'password': password, 'session': 'cookie'}, options: Options(headers: {'x-cwm-csrf': '1', 'origin': Uri.parse(apiUrl).origin}));
    expect(login.statusCode, 200);
    expect(login.data!.containsKey('accessToken'), isFalse);
    final cookies = login.headers['set-cookie']!.map((c) => c.split(';').first).join('; ');
    final seen = await web.get<Map<String, dynamic>>('/complaints/$complaintId', options: Options(headers: {'cookie': cookies}));
    expect(seen.statusCode, 200);
    expect(seen.data!['id'], complaintId);
    expect(seen.data!['status'], 'CLOSED');
  });
}
