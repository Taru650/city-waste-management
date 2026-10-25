/// An API call failed. [status] is the HTTP status (0 = network/offline).
class ApiException implements Exception {
  ApiException(this.status, this.message, {this.body});

  final int status;
  final String message;
  final Object? body;

  bool get isNetwork => status == 0;
  bool get isUnauthorized => status == 401;

  /// The API refuses service until the citizen accepts the current privacy notice (DPDP).
  bool get isConsentRequired => status == 403 && body is Map && (body as Map)['code'] == 'CONSENT_REQUIRED';

  @override
  String toString() => 'ApiException($status): $message';

  static String messageFrom(Object? body, String fallback) {
    if (body is Map) {
      final m = body['message'];
      if (m is String) return m;
      if (m is List) return m.join('; ');
    }
    return fallback;
  }
}
