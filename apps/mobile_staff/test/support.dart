import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_core/testing.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image/image.dart' as img;

Map<String, dynamic> complaintJson({String id = 'c1', String status = 'ASSIGNED', String? worker = 'Sunita', String? zone}) => {
      'id': id, 'complaintNo': '0446-800123-26-000457', 'status': status, 'description': 'Kachra ka dher', 'landmark': 'Near Shiv Mandir',
      'location': {'lat': 25.005, 'lng': 80.005}, 'ulb': {'id': 'u1', 'name': 'Nagar Nigam Alpha'}, 'ward': {'id': 'w1', 'number': 1},
      'type': {'id': 't1', 'code': 'GARBAGE_HEAP', 'nameEn': 'Garbage heap', 'nameHi': 'कचरे का ढेर'},
      'worker': worker == null ? null : {'id': 'wk1', 'name': worker},
      'slaDueAt': DateTime.now().add(const Duration(hours: 20)).toUtc().toIso8601String(), 'slaBreached': false,
      'createdAt': DateTime.now().subtract(const Duration(hours: 4)).toUtc().toIso8601String(),
      'resolvedAt': null, 'resolutionRemark': null, 'reopenCount': 0, 'eventZone': zone == null ? null : {'id': 'z1', 'name': zone},
      'events': [{'action': 'CREATE', 'toStatus': 'PENDING', 'at': DateTime.now().toUtc().toIso8601String()}], 'feedback': [],
    };

Map<String, dynamic> meJson({String role = 'WORKER', bool mustChange = false}) =>
    {'id': 'me', 'role': role, 'name': 'Sunita', 'mobile': '9876500001', 'email': null, 'preferredLanguage': 'en', 'mustChangePassword': mustChange};

/// Fake API for the staff app. [role] / [mustChange] shape /auth/me; the /devices route enforces
/// the real guard (refused while a temporary password is set).
class StaffBackend extends FakeBackend {
  StaffBackend({this.role = 'WORKER', this.mustChange = false, this.status = 'ASSIGNED', this.zone}) {
    on('POST /auth/login', (_, body) => (body as Map)['password'] == 'Swachh#2026'
        ? (200, {'status': 'OK', 'accessToken': 'a', 'refreshToken': 'r', 'expiresIn': 900})
        : (body['password'] == 'admin' ? (200, {'status': 'MFA_REQUIRED', 'mfaToken': 'x'}) : (401, {'message': 'Invalid credentials'})));
    on('GET /auth/me', (_, _) => (200, meJson(role: role, mustChange: mustChange)));
    on('POST /auth/change-password', (_, _) {
      mustChange = false;
      return (201, {'accessToken': 'a2', 'refreshToken': 'r2', 'expiresIn': 900});
    });
    on('POST /auth/logout', (_, _) => (204, null));
    on('POST /devices', (_, _) => mustChange ? (403, {'message': 'Password change required'}) : (201, {'id': 'dev-1'}));
    on('GET /complaints', (o, _) {
      queries.add(Map.of(o.queryParameters));
      return (200, {'total': 1, 'items': [complaintJson(status: status)]});
    });
    on('GET /complaints/c1', (_, _) => (200, complaintJson(status: status, zone: zone)));
    on('GET /complaints/c1/media', (_, _) => (200, []));
    on('GET /notifications', (_, _) => (200, {'total': 0, 'items': []}));
    on('GET /users/workers', (_, _) => (200, [
          {'id': 'wk1', 'name': 'Sunita', 'areaName': 'Area 1', 'openTasks': 3},
          {'id': 'wk2', 'name': 'Ramesh', 'areaName': 'Area 1', 'openTasks': 0},
        ]));
    on('POST /complaints/c1/assign', (_, _) => (201, complaintJson()));
    on('POST /complaints/c1/reject', (_, _) {
      status = 'REJECTED';
      return (201, complaintJson(status: status));
    });
    on('POST /complaints/c1/start', (_, _) {
      status = 'WORK_IN_PROGRESS';
      return (201, complaintJson(status: status));
    });
    on('POST /complaints/c1/resolve', (_, _) {
      status = 'RESOLVED';
      return (201, complaintJson(status: status));
    });
    on('POST /media/upload-url', (_, body) => (201, {'mediaId': 'm${bodiesOf('POST /media/upload-url').length}', 'uploadUrl': 'https://storage.test/x', 'headers': {'Content-Type': (body as Map)['contentType']}}));
    on('PUT STORAGE', (_, _) => (200, null));
    on('POST /media/m\\d+/confirm', (o, _) => (200, {'id': o.path.split('/')[2], 'status': 'READY'}));
  }

  String role;
  bool mustChange;
  String status;
  final String? zone;
  final List<Map<String, dynamic>> queries = [];
}

class TestEnv {
  TestEnv(this.backend, {bool signedIn = false, this.rooted = false}) : dir = Directory.systemTemp.createTempSync('staff') {
    if (signedIn) store.tokens = const Tokens('a', 'r');
  }
  final StaffBackend backend;
  final bool rooted;
  final Directory dir;
  final store = MemoryTokenStore();
  final outboxStorage = MemoryOutboxStorage();
  final List<(double, double)> navigations = [];
  int captures = 0;

  Future<CapturedMedia> fakeCapture() async {
    captures++;
    final f = File('${dir.path}/cap$captures.jpg')..writeAsBytesSync(img.encodeJpg(img.Image(width: 64, height: 48)));
    return CapturedMedia(kind: MediaKind.photo, path: f.path, capturedAt: DateTime.now(), fix: GeoFix(lat: 25.0051, lng: 80.0052, accuracyM: 7, isMocked: false));
  }

  Widget app(Widget child) {
    final api = ApiClient(const CoreConfig(apiBaseUrl: 'https://api.test'), store,
        dio: Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = backend, uploadDio: Dio()..httpClientAdapter = backend);
    return ProviderScope(
      overrides: [
        tokenStoreProvider.overrideWithValue(store),
        apiClientProvider.overrideWithValue(api),
        signerProvider.overrideWithValue(SoftwareSigner.generate()),
        captureDirProvider.overrideWith((_) async => dir),
        outboxStorageProvider.overrideWith((_) async => outboxStorage),
        captureLauncherProvider.overrideWithValue((context, {allowVideo = true}) => fakeCapture()),
        deviceIntegrityProvider.overrideWithValue(_FixedIntegrity(rooted)),
        mapLauncherProvider.overrideWithValue((lat, lng) async {
          navigations.add((lat, lng));
          return true;
        }),
      ],
      child: child,
    );
  }
}

class _FixedIntegrity implements DeviceIntegrity {
  _FixedIntegrity(this.rooted);
  final bool rooted;
  @override
  Future<IntegrityReport> check() async => IntegrityReport(compromised: rooted, reasons: rooted ? ['found /system/xbin/su'] : []);
}
