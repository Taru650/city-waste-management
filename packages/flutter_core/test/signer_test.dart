import 'dart:convert';
import 'dart:typed_data';

import 'package:asn1lib/asn1lib.dart';
import 'package:flutter_core/testing.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pointycastle/export.dart';

void main() {
  test('public key is a P-256 SubjectPublicKeyInfo (ecPublicKey + prime256v1, uncompressed point)', () async {
    final signer = SoftwareSigner.generate();
    final spki = ASN1Parser(base64.decode(await signer.publicKeySpkiBase64())).nextObject() as ASN1Sequence;
    final alg = spki.elements[0] as ASN1Sequence;
    expect((alg.elements[0] as ASN1ObjectIdentifier).identifier, '1.2.840.10045.2.1');
    expect((alg.elements[1] as ASN1ObjectIdentifier).identifier, '1.2.840.10045.3.1.7');
    final bits = spki.elements[1] as ASN1BitString;
    expect(bits.unusedbits, 0);
    final point = bits.contentBytes();
    expect(point.length, 65); // 0x04 + X(32) + Y(32)
    expect(point[0], 0x04);
  });

  test('signatures are DER ECDSA-SHA256 that verify with the public key, and change with the data', () async {
    final signer = SoftwareSigner.generate();
    final data = Uint8List.fromList(utf8.encode('{"v":1}'));
    final sigDer = base64.decode(await signer.signBase64(data));
    final seq = ASN1Parser(sigDer).nextObject() as ASN1Sequence;
    final sig = ECSignature((seq.elements[0] as ASN1Integer).valueAsBigInteger, (seq.elements[1] as ASN1Integer).valueAsBigInteger);

    final spki = ASN1Parser(base64.decode(await signer.publicKeySpkiBase64())).nextObject() as ASN1Sequence;
    final point = (spki.elements[1] as ASN1BitString).contentBytes();
    final domain = ECDomainParameters('prime256v1');
    final pub = ECPublicKey(domain.curve.decodePoint(point), domain);
    final verifier = ECDSASigner(SHA256Digest())..init(false, PublicKeyParameter<ECPublicKey>(pub));
    expect(verifier.verifySignature(data, sig), isTrue);
    expect(verifier.verifySignature(Uint8List.fromList(utf8.encode('{"v":2}')), sig), isFalse);
  });
}
