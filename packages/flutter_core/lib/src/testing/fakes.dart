import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../offline/outbox.dart';

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
