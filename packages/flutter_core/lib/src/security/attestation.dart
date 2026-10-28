import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';

import '../api/api_client.dart';

/// Play Integrity could not produce a token (no Play services, network, quota…). The code is sent
/// to the server, which refuses (enforce) or records it (monitor).
class IntegrityUnavailable implements Exception {
  IntegrityUnavailable(this.code);
  final String code;
  @override
  String toString() => 'IntegrityUnavailable($code)';
}

/// Produces a Play Integrity token for a nonce.
abstract class IntegrityTokenSource {
  Future<String> token(String nonce);
}

/// Classic Play Integrity request in MainActivity (channel "org.citywaste/play_integrity").
class NativeIntegrity implements IntegrityTokenSource {
  const NativeIntegrity(this.cloudProjectNumber, [this._channel = const MethodChannel('org.citywaste/play_integrity')]);
  final int cloudProjectNumber;
  final MethodChannel _channel;

  @override
  Future<String> token(String nonce) async {
    if (cloudProjectNumber == 0) throw IntegrityUnavailable('NOT_CONFIGURED');
    try {
      final t = await _channel.invokeMethod<String>('token', {'nonce': nonce, 'cloudProjectNumber': cloudProjectNumber});
      if (t == null || t.isEmpty) throw IntegrityUnavailable('EMPTY_TOKEN');
      return t;
    } on PlatformException catch (e) {
      throw IntegrityUnavailable(e.message ?? e.code);
    } on MissingPluginException {
      throw IntegrityUnavailable('UNSUPPORTED_PLATFORM');
    }
  }
}

/// Same derivation as the API (`integrityNonce`): binds the token to the server challenge and,
/// for device keys, to the public key being registered.
String integrityNonce(String challenge, [String binding = '']) =>
    base64Url.encode(sha256.convert(utf8.encode('$challenge|$binding')).bytes).replaceAll('=', '');

/// Builds the attestation fields the API expects on register / forgot-password / devices.
class Attestor {
  Attestor(this.api, this.source);
  final ApiClient api;
  final IntegrityTokenSource source;

  /// Asks the server for a challenge for [purpose]; empty when attestation is switched off.
  Future<Map<String, String>> prove(String purpose, {String binding = ''}) async {
    final r = await api.postPublic<Map<String, dynamic>>('/attestation/challenge', {'purpose': purpose});
    if (r['enabled'] != true) return const {};
    return answer(r['challenge'] as String, binding: binding);
  }

  /// Answers a challenge the server already sent (428 on device registration).
  Future<Map<String, String>> answer(String challenge, {String binding = ''}) async {
    try {
      return {'attestationChallenge': challenge, 'integrityToken': await source.token(integrityNonce(challenge, binding))};
    } on IntegrityUnavailable catch (e) {
      return {'attestationError': e.code.length > 100 ? e.code.substring(0, 100) : e.code};
    }
  }
}
