import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:asn1lib/asn1lib.dart';
import 'package:pointycastle/export.dart';

import 'device_signer.dart';

/// Pure-Dart P-256 signer. FOR TESTS ONLY: the key lives in memory. Real apps use
/// [KeystoreSigner]; there is deliberately no fallback to this class in release builds.
class SoftwareSigner implements DeviceSigner {
  SoftwareSigner._(this._private, this._public);

  final ECPrivateKey _private;
  final ECPublicKey _public;

  static final _domain = ECDomainParameters('prime256v1');

  factory SoftwareSigner.generate() {
    final random = FortunaRandom()..seed(KeyParameter(Uint8List.fromList(List.generate(32, (_) => Random.secure().nextInt(256)))));
    final gen = ECKeyGenerator()..init(ParametersWithRandom(ECKeyGeneratorParameters(_domain), random));
    final pair = gen.generateKeyPair();
    return SoftwareSigner._(pair.privateKey, pair.publicKey);
  }

  @override
  Future<String> publicKeySpkiBase64() async {
    Uint8List coord(BigInt v) {
      final hex = v.toRadixString(16).padLeft(64, '0');
      return Uint8List.fromList(List.generate(32, (i) => int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16)));
    }

    final point = Uint8List.fromList([0x04, ...coord(_public.Q!.x!.toBigInteger()!), ...coord(_public.Q!.y!.toBigInteger()!)]);
    final algorithm = ASN1Sequence()
      ..add(ASN1ObjectIdentifier.fromComponentString('1.2.840.10045.2.1'))
      ..add(ASN1ObjectIdentifier.fromComponentString('1.2.840.10045.3.1.7'));
    final spki = ASN1Sequence()
      ..add(algorithm)
      ..add(ASN1BitString(point));
    return base64.encode(spki.encodedBytes);
  }

  @override
  Future<String> signBase64(Uint8List data) async {
    // RFC 6979 deterministic nonces (HMAC-SHA256): no dependency on RNG quality while signing.
    final signer = ECDSASigner(SHA256Digest(), HMac(SHA256Digest(), 64))..init(true, PrivateKeyParameter<ECPrivateKey>(_private));
    final sig = signer.generateSignature(data) as ECSignature;
    final der = ASN1Sequence()
      ..add(ASN1Integer(sig.r))
      ..add(ASN1Integer(sig.s));
    return base64.encode(der.encodedBytes);
  }
}
