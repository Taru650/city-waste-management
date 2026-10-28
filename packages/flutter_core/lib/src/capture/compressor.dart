import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:video_compress/video_compress.dart';

/// On-device compression before upload ("visually lossless"); the server re-encodes again.
abstract class MediaCompressor {
  Future<Uint8List> photo(String path);
  Future<Uint8List> video(String path);
}

class NativeCompressor implements MediaCompressor {
  const NativeCompressor();

  /// Short edge 1440 px (≈ 1920 long edge for 4:3), JPEG q80, EXIF dropped (location is sent signed, separately).
  @override
  Future<Uint8List> photo(String path) async {
    final out = await FlutterImageCompress.compressWithFile(path, minWidth: 1440, minHeight: 1440, quality: 80, keepExif: false, format: CompressFormat.jpeg);
    if (out == null) throw StateError('Photo compression failed');
    return out;
  }

  /// 720p H.264. Recording is already capped at 30 s by the camera screen.
  @override
  Future<Uint8List> video(String path) async {
    final info = await VideoCompress.compressVideo(path, quality: VideoQuality.Res1280x720Quality, includeAudio: true, deleteOrigin: false);
    final file = info?.file;
    if (file == null) throw StateError('Video compression failed');
    final bytes = await file.readAsBytes();
    await File(file.path).delete().catchError((_) => File(file.path));
    return bytes;
  }
}
