import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:dio/io.dart';

import '../config.dart';
import 'api_exception.dart';
import 'token_store.dart';

/// HTTP client for the shared API. Adds the Bearer token, refreshes it once on 401 (single
/// flight: refresh tokens are single-use and reuse revokes the whole session), and maps
/// errors to [ApiException]. Certificate pinning is applied when pins are configured.
class ApiClient {
  ApiClient(this.config, this.store, {Dio? dio, Dio? uploadDio})
      : dio = dio ?? Dio(BaseOptions(baseUrl: config.apiBaseUrl, connectTimeout: const Duration(seconds: 15), receiveTimeout: const Duration(seconds: 30))),
        uploadDio = uploadDio ?? Dio(BaseOptions(connectTimeout: const Duration(seconds: 15), sendTimeout: const Duration(minutes: 5))) {
    if (config.certPins.isNotEmpty) {
      pinCertificates(this.dio, config.certPins);
    }
  }

  final CoreConfig config;
  final TokenStore store;
  final Dio dio;

  /// For pre-signed storage URLs: no auth header, no base URL.
  final Dio uploadDio;

  final _expired = StreamController<void>.broadcast();

  /// Fires when the session cannot be refreshed (user must sign in again).
  Stream<void> get onSessionExpired => _expired.stream;

  Future<Tokens?>? _refreshing;

  Future<T> get<T>(String path, {Map<String, dynamic>? query}) => _send<T>('GET', path, query: query);
  Future<T> post<T>(String path, [Object? body]) => _send<T>('POST', path, body: body ?? const <String, dynamic>{});
  Future<T> patch<T>(String path, [Object? body]) => _send<T>('PATCH', path, body: body ?? const <String, dynamic>{});
  Future<T> delete<T>(String path, [Object? body]) => _send<T>('DELETE', path, body: body);

  /// Calls without a session (login, register, forgot password).
  Future<T> postPublic<T>(String path, Object body) => _send<T>('POST', path, body: body, auth: false);
  Future<T> getPublic<T>(String path, {Map<String, dynamic>? query}) => _send<T>('GET', path, query: query, auth: false);

  Future<T> _send<T>(String method, String path, {Object? body, Map<String, dynamic>? query, bool auth = true}) async {
    Tokens? tokens = auth ? await store.read() : null;
    if (auth && tokens == null) {
      _expired.add(null);
      throw ApiException(401, 'Not signed in');
    }
    Future<Response<dynamic>> call(String? access) => dio.request<dynamic>(
          path,
          data: body,
          queryParameters: query,
          options: Options(method: method, headers: {if (access != null) 'Authorization': 'Bearer $access'}),
        );
    try {
      final res = await call(tokens?.accessToken);
      return res.data as T;
    } on DioException catch (e) {
      if (auth && e.response?.statusCode == 401) {
        final fresh = await _refresh(tokens!);
        if (fresh == null) {
          _expired.add(null);
          throw ApiException(401, 'Session expired');
        }
        try {
          final res = await call(fresh.accessToken);
          return res.data as T;
        } on DioException catch (e2) {
          throw _map(e2);
        }
      }
      throw _map(e);
    }
  }

  Future<Tokens?> _refresh(Tokens stale) {
    return _refreshing ??= () async {
      try {
        // Another caller may already have rotated while we waited.
        final current = await store.read();
        if (current != null && current.refreshToken != stale.refreshToken) return current;
        final res = await dio.post<dynamic>('/auth/refresh', data: {'refreshToken': stale.refreshToken});
        final data = res.data as Map<String, dynamic>;
        final t = Tokens(data['accessToken'] as String, data['refreshToken'] as String);
        await store.write(t);
        return t;
      } on DioException {
        await store.clear();
        return null;
      } finally {
        scheduleMicrotask(() => _refreshing = null);
      }
    }();
  }

  ApiException _map(DioException e) {
    final status = e.response?.statusCode ?? 0;
    if (status == 0) return ApiException(0, 'No internet connection');
    final body = e.response?.data;
    return ApiException(status, ApiException.messageFrom(body, 'Request failed ($status)'), body: body);
  }

  void dispose() => _expired.close();
}

/// Rejects TLS connections whose leaf certificate public key is not in [pins]
/// (base64 SHA-256 of the DER SubjectPublicKeyInfo, as produced by `openssl ... | openssl dgst -sha256 -binary | base64`).
void pinCertificates(Dio dio, List<String> pins) {
  dio.httpClientAdapter = IOHttpClientAdapter(
    createHttpClient: () => HttpClient()..badCertificateCallback = (cert, host, port) => false,
    validateCertificate: (cert, host, port) => cert != null && pins.contains(spkiPin(cert.der)),
  );
}

/// Pin of a DER certificate: base64(SHA-256(SubjectPublicKeyInfo)).
String spkiPin(List<int> certDer) => base64.encode(sha256.convert(extractSpki(certDer)).bytes);

/// Extracts the SubjectPublicKeyInfo from an X.509 DER certificate (tbsCertificate field 6/7).
List<int> extractSpki(List<int> der) {
  int pos = 0;
  (int, int) header(int at) {
    final len0 = der[at + 1];
    if (len0 < 0x80) return (at + 2, len0);
    final n = len0 & 0x7f;
    var len = 0;
    for (var i = 0; i < n; i++) {
      len = (len << 8) | der[at + 2 + i];
    }
    return (at + 2 + n, len);
  }

  final (certBody, _) = header(pos); // Certificate SEQUENCE
  final (tbsBody, _) = header(certBody); // tbsCertificate SEQUENCE
  pos = tbsBody;
  // optional [0] version
  if (der[pos] == 0xa0) {
    final (b, l) = header(pos);
    pos = b + l;
  }
  // serialNumber, signature, issuer, validity, subject
  for (var i = 0; i < 5; i++) {
    final (b, l) = header(pos);
    pos = b + l;
  }
  final (b, l) = header(pos);
  return der.sublist(pos, b + l);
}
