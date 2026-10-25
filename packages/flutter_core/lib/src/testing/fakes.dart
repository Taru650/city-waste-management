import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../offline/outbox.dart';
import '../push/push.dart';
import '../security/attestation.dart';

typedef Route = FutureOr<(int, Object?)> Function(RequestOptions req, Object? body);

/// In-memory backend: routes "METHOD /path" (regex) to handlers and records every call.
class FakeBackend implements HttpClientAdapter {
  final Map<String, Route> routes = {};
  final List<(String, Object?)> calls = [];
  bool offline = false;

  void on(String methodAndPath, Route r) => routes[methodAndPath] = r;
  List<Object?> bodiesOf(String methodAndPath) => calls.where((c) => RegExp('^$methodAndPath\$').hasMatch(c.$1)).map((c) => c.$2).toList();

  @override
  Future<ResponseBody> fetch(RequestOptions o, Stream<Uint8List>? stream, Future<void>? cancel) async {
    Object? body;
    if (stream != null) {
      final bytes = <int>[];
      await for (final c in stream) {
        bytes.addAll(c);
      }
      body = (o.contentType ?? '').contains('json') ? jsonDecode(utf8.decode(bytes)) : bytes.length;
    }
    final key = '${o.method} ${o.uri.host == 'storage.test' ? 'STORAGE' : o.path}';
    calls.add((key, body));
    if (offline && !key.startsWith('GET /masters')) throw DioException(requestOptions: o, type: DioExceptionType.connectionError);
    for (final e in routes.entries) {
      if (RegExp('^${e.key}\$').hasMatch(key)) {
        final (status, json) = await e.value(o, body);
        return ResponseBody.fromString(json == null ? '' : jsonEncode(json), status, headers: {Headers.contentTypeHeader: ['application/json']});
      }
    }
    return ResponseBody.fromString(jsonEncode({'message': 'no route for $key'}), 404, headers: {Headers.contentTypeHeader: ['application/json']});
  }

  @override
  void close({bool force = false}) {}
}

/// In-memory outbox persistence (file persistence is covered by flutter_core's own tests).
class MemoryOutboxStorage implements OutboxStorage {
  List<Map<String, dynamic>> saved = [];
  @override
  Future<List<OutboxItem>> load() async => saved.map(OutboxItem.fromJson).toList();
  @override
  Future<void> save(List<OutboxItem> items) async => saved = items.map((i) => jsonDecode(jsonEncode(i.toJson())) as Map<String, dynamic>).toList();
}

/// Play Integrity stand-in matching the API's test double (apps/api/test/fake-play-integrity.ts):
/// a token is `fake.<base64url(verdict JSON)>` carrying the nonce it was requested for.
class FakeIntegritySource implements IntegrityTokenSource {
  FakeIntegritySource(this.packageName, {this.cert = 'cwm-release-cert-sha256', this.device = const ['MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY'], this.failWith});
  final String packageName;
  final String cert;
  final List<String> device;
  final String? failWith;
  final List<String> nonces = [];

  @override
  Future<String> token(String nonce) async {
    if (failWith != null) throw IntegrityUnavailable(failWith!);
    nonces.add(nonce);
    final payload = {
      'requestDetails': {'requestPackageName': packageName, 'nonce': nonce, 'timestampMillis': '${DateTime.now().millisecondsSinceEpoch}'},
      'appIntegrity': {'appRecognitionVerdict': 'PLAY_RECOGNIZED', 'packageName': packageName, 'certificateSha256Digest': [cert]},
      'deviceIntegrity': {'deviceRecognitionVerdict': device},
    };
    return 'fake.${base64Url.encode(utf8.encode(jsonEncode(payload))).replaceAll('=', '')}';
  }
}

/// Push transport stand-in: tests drive [foregroundCtl] / [openedCtl] and inspect the token flow.
class FakePushClient implements PushClient {
  FakePushClient({this.granted = true, this.currentToken = 'fcm-token-0000000000000000000001'});
  final bool granted;
  String? currentToken;
  bool deleted = false;
  final foregroundCtl = StreamController<PushMessage>.broadcast();
  final openedCtl = StreamController<PushMessage>.broadcast();
  final refreshCtl = StreamController<String>.broadcast();
  PushMessage? initial;

  @override
  Future<bool> requestPermission() async => granted;
  @override
  Future<String?> token() async => currentToken;
  @override
  Stream<String> get tokenRefresh => refreshCtl.stream;
  @override
  Stream<PushMessage> get foreground => foregroundCtl.stream;
  @override
  Stream<PushMessage> get opened => openedCtl.stream;
  @override
  Future<PushMessage?> initialMessage() async => initial;
  @override
  Future<void> deleteToken() async {
    deleted = true;
    currentToken = null;
  }
}
