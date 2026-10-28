import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

typedef Handler = FutureOr<FakeResponse> Function(RequestOptions req, Object? body);

class FakeResponse {
  FakeResponse(this.status, [this.body]);
  final int status;
  final Object? body;
}

/// Records requests and answers them from [handler]; no network involved.
class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.handler);
  Handler handler;
  final List<RequestOptions> requests = [];
  final List<Object?> bodies = [];

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {
    Object? body;
    if (requestStream != null) {
      final bytes = <int>[];
      await for (final c in requestStream) {
        bytes.addAll(c);
      }
      final text = utf8.decode(bytes, allowMalformed: true);
      body = (options.contentType ?? '').contains('json') ? jsonDecode(text) : Uint8List.fromList(bytes);
    }
    requests.add(options);
    bodies.add(body);
    final r = await handler(options, body);
    return ResponseBody.fromString(r.body == null ? '' : jsonEncode(r.body), r.status, headers: {
      Headers.contentTypeHeader: ['application/json'],
    });
  }

  @override
  void close({bool force = false}) {}
}
