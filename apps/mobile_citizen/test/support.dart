import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_core/testing.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image/image.dart' as img;

Map<String, dynamic> complaintJson({String id = 'c1', String status = 'ASSIGNED', String? resolvedAt, int ward = 1}) => {
      'id': id, 'complaintNo': '0446-800123-26-000457', 'status': status, 'description': 'Kachra ka dher', 'landmark': 'Near Shiv Mandir',
      'location': {'lat': 25.005, 'lng': 80.005}, 'ulb': {'id': 'u1', 'name': 'Nagar Nigam Alpha'}, 'ward': {'id': 'w1', 'number': ward},
      'type': {'id': 't1', 'code': 'GARBAGE_HEAP', 'nameEn': 'Garbage heap', 'nameHi': 'कचरे का ढेर'},
      'worker': status == 'ASSIGNED' ? null : {'id': 'wk', 'name': 'Sunita'},
      'slaDueAt': DateTime.now().add(const Duration(hours: 20)).toUtc().toIso8601String(), 'slaBreached': false,
      'createdAt': DateTime.now().subtract(const Duration(hours: 4)).toUtc().toIso8601String(),
      'resolvedAt': resolvedAt, 'resolutionRemark': resolvedAt != null ? 'Cleaned' : null, 'reopenCount': 0,
      'events': [{'action': 'CREATE', 'toStatus': 'PENDING', 'at': DateTime.now().toUtc().toIso8601String()}], 'feedback': [],
    };

Map<String, dynamic> meJson({String role = 'CITIZEN'}) => {'id': 'me', 'role': role, 'name': 'Asha', 'mobile': '9876543210', 'email': 'a@x.in', 'preferredLanguage': 'en'};

/// Standard happy-path routes for the citizen app.
void citizenRoutes(FakeBackend b) {
  b.on('POST /auth/login', (_, body) => (body as Map)['password'] == 'Swachh#2026'
      ? (200, {'status': 'OK', 'accessToken': 'a', 'refreshToken': 'r', 'expiresIn': 900})
      : (401, {'message': 'Invalid credentials'}));
  b.on('GET /auth/me', (_, _) => (200, meJson()));
  b.on('POST /devices', (_, _) => (201, {'id': 'dev-1'}));
  b.on('GET /complaints', (_, _) => (200, {'total': 1, 'items': [complaintJson()]}));
  b.on('GET /notifications', (_, _) => (200, {'total': 0, 'items': []}));
  b.on('GET /masters/districts', (_, _) => (200, [{'id': 'd1', 'lgdCode': 446, 'name': 'Raipur', 'nameHi': 'रायपुर'}]));
  b.on('GET /masters/districts/d1/ulbs', (_, _) => (200, [{'id': 'u1', 'lgdCode': 800123, 'type': 'NAGAR_NIGAM', 'name': 'Nagar Nigam Alpha'}]));
  b.on('GET /masters/ulbs/u1/wards', (_, _) => (200, [{'id': 'w1', 'number': 1, 'name': 'Shanti Nagar'}, {'id': 'w2', 'number': 2, 'name': null}]));
  b.on('GET /masters/complaint-types', (_, _) => (200, [{'id': 't1', 'code': 'GARBAGE_HEAP', 'nameEn': 'Garbage heap', 'nameHi': 'कचरे का ढेर', 'slaHours': 24}]));
  b.on('GET /masters/locate', (_, _) => (200, {'wardId': 'w1', 'wardNumber': 1, 'ulbId': 'u1', 'ulbName': 'Nagar Nigam Alpha', 'districtId': 'd1', 'districtName': 'Raipur'}));
  b.on('POST /media/upload-url', (_, body) => (201, {'mediaId': 'm${b.bodiesOf('POST /media/upload-url').length}', 'uploadUrl': 'https://storage.test/x', 'headers': {'Content-Type': (body as Map)['contentType']}}));
  b.on('PUT STORAGE', (_, _) => (200, null));
  b.on('POST /media/m\\d+/confirm', (o, _) => (200, {'id': o.path.split('/')[2], 'status': 'READY'}));
  b.on('POST /complaints', (_, _) => (201, complaintJson()));
}

class TestEnv {
  TestEnv._(this.backend, this.store, this.dir);
  final FakeBackend backend;
  final MemoryTokenStore store;
  final Directory dir;
  int captures = 0;
  final outboxStorage = MemoryOutboxStorage();

  static Future<TestEnv> create({bool signedIn = false}) async {
    // Real dart:io futures never complete inside testWidgets' fake-async zone: keep setup synchronous.
    final dir = Directory.systemTemp.createTempSync('citizen');
    final store = MemoryTokenStore();
    if (signedIn) store.tokens = const Tokens('a', 'r');
    final b = FakeBackend();
    citizenRoutes(b);
    return TestEnv._(b, store, dir);
  }

  Future<CapturedMedia> fakeCapture() async {
    captures++;
    final im = img.Image(width: 64, height: 48);
    final f = File('${dir.path}/cap$captures.jpg')..writeAsBytesSync(img.encodeJpg(im));
    return CapturedMedia(kind: MediaKind.photo, path: f.path, capturedAt: DateTime.now(), fix: GeoFix(lat: 25.005, lng: 80.005, accuracyM: 6, isMocked: false));
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
      ],
      child: child,
    );
  }
}
