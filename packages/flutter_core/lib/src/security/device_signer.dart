import 'dart:convert';
import 'package:flutter/services.dart';

/// Signs capture manifests with this install's private key. The server only accepts media
/// whose manifest is signed by a key registered for the signed-in user.
abstract class DeviceSigner {
  /// EC P-256 public key, DER SubjectPublicKeyInfo, base64.
  Future<String> publicKeySpkiBase64();

  /// ECDSA-SHA256 signature over [data], DER, base64.
  Future<String> signBase64(Uint8List data);
}

/// Hardware-backed key in Android Keystore (StrongBox when available) / iOS Secure Enclave,
/// via the platform channel implemented in each app (MainActivity.kt / AppDelegate.swift).
/// The private key never leaves the secure hardware and cannot be exported.
class KeystoreSigner implements DeviceSigner {
  const KeystoreSigner([this._channel = const MethodChannel('org.citywaste/device_key')]);
  final MethodChannel _channel;

  @override
  Future<String> publicKeySpkiBase64() async => (await _channel.invokeMethod<String>('publicKey'))!;

  @override
  Future<String> signBase64(Uint8List data) async => (await _channel.invokeMethod<String>('sign', {'data': data}))!;
}

/// The exact bytes the app signs: compact JSON, sent to the server as base64url without padding
/// (the server verifies those bytes; nothing is re-serialised).
class SignedManifest {
  SignedManifest(this.manifest, this.signature);
  final String manifest;
  final String signature;
}

String base64UrlNoPad(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');
