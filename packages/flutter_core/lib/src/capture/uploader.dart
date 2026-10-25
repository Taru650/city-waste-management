import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';

import '../api/api_client.dart';
import '../api/api_exception.dart';
import '../security/device_registry.dart';
import '../security/device_signer.dart';
import 'captured_media.dart';

class MediaRejected implements Exception {
  MediaRejected(this.reason);
  final String reason;
  @override
  String toString() => 'MediaRejected: $reason';
}

class UploadedMedia {
  UploadedMedia(this.id, this.status);
  final String id;
  final String status;
}

/// Implements docs/MEDIA_CAPTURE_CONTRACT.md: upload-url → PUT to storage → signed confirm.
class MediaUploader {
  MediaUploader(this.api, this.signer, this.registry, {this.retryDelay = const Duration(seconds: 2)});

  final ApiClient api;
  final DeviceSigner signer;
  final DeviceRegistry registry;
  final Duration retryDelay;

  Future<UploadedMedia> upload(CapturedMedia media) async {
    final bytes = await File(media.path).readAsBytes();
    return uploadBytes(media, bytes);
  }

  Future<UploadedMedia> uploadBytes(CapturedMedia media, Uint8List bytes) async {
    if (media.expired) throw MediaRejected('Capture is older than 24 hours');
    final sha = sha256.convert(bytes).toString();
    var deviceId = await registry.deviceId();

    Future<Map<String, dynamic>> requestUrl() => api.post<Map<String, dynamic>>('/media/upload-url', {
          'deviceId': deviceId, 'kind': media.apiKind, 'contentType': media.contentType, 'bytes': bytes.length, 'sha256': sha,
        });

    Map<String, dynamic> slot;
    try {
      slot = await requestUrl();
    } on ApiException catch (e) {
      // Device keys are revoked by logout-all / password reset: register again once.
      if (e.status != 400 || !e.message.toLowerCase().contains('device')) rethrow;
      deviceId = await registry.register();
      slot = await requestUrl();
    }

    final headers = Map<String, String>.from(slot['headers'] as Map);
    try {
      await api.uploadDio.put<void>(
        slot['uploadUrl'] as String,
        data: Stream.fromIterable([bytes]),
        options: Options(headers: headers, contentType: media.contentType),
      );
    } on DioException catch (e) {
      throw ApiException(e.response?.statusCode ?? 0, 'Upload to storage failed');
    }

    final manifestBytes = utf8.encode(jsonEncode({
      'v': 1,
      'mediaId': slot['mediaId'],
      'deviceId': deviceId,
      'kind': media.apiKind,
      'sha256': sha,
      'capturedAt': media.capturedAt.toUtc().toIso8601String(),
      'lat': media.fix.lat,
      'lng': media.fix.lng,
      'accuracyM': media.fix.accuracyM,
      'isMockLocation': media.fix.isMocked,
    }));
    final signed = SignedManifest(base64UrlNoPad(manifestBytes), await signer.signBase64(Uint8List.fromList(manifestBytes)));

    for (var attempt = 1;; attempt++) {
      try {
        final r = await api.post<Map<String, dynamic>>('/media/${slot['mediaId']}/confirm', {'manifest': signed.manifest, 'signature': signed.signature});
        return UploadedMedia(r['id'] as String, r['status'] as String);
      } on ApiException catch (e) {
        if (e.status == 422) throw MediaRejected(e.message);
        // 503: malware scanner busy, the server kept the upload; retry the confirm.
        if (e.status == 503 && attempt < 3) {
          await Future<void>.delayed(retryDelay * attempt);
          continue;
        }
        rethrow;
      }
    }
  }
}
