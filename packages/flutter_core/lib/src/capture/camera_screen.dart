import 'dart:async';
import 'dart:io';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';

import '../i18n/strings.dart';
import 'captured_media.dart';
import 'compressor.dart';
import 'geo.dart';
import 'gps_status.dart';

/// The only way media enters either app: live camera preview, GPS gate, compress on device,
/// save to app-private storage. There is no gallery or file picker anywhere in the apps.
class CameraCaptureScreen extends StatefulWidget {
  const CameraCaptureScreen({super.key, required this.location, required this.compressor, required this.saveDir, this.allowVideo = true});

  final LocationSource location;
  final MediaCompressor compressor;
  final Directory saveDir;
  final bool allowVideo;

  static Future<CapturedMedia?> open(BuildContext context, {required LocationSource location, required MediaCompressor compressor, required Directory saveDir, bool allowVideo = true}) =>
      Navigator.of(context).push<CapturedMedia>(MaterialPageRoute(builder: (_) => CameraCaptureScreen(location: location, compressor: compressor, saveDir: saveDir, allowVideo: allowVideo)));

  @override
  State<CameraCaptureScreen> createState() => _CameraCaptureScreenState();
}

class _CameraCaptureScreenState extends State<CameraCaptureScreen> {
  static const maxVideo = Duration(seconds: 30);
  CameraController? _camera;
  late final GpsGateController _gps = GpsGateController(widget.location)..start();
  bool _busy = false;
  bool _recording = false;
  GeoFix? _videoFix;
  DateTime? _videoStart;
  Timer? _videoTimer;
  String? _error;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    try {
      final cams = await availableCameras();
      final back = cams.firstWhere((c) => c.lensDirection == CameraLensDirection.back, orElse: () => cams.first);
      final c = CameraController(back, ResolutionPreset.veryHigh, enableAudio: widget.allowVideo, imageFormatGroup: ImageFormatGroup.jpeg);
      await c.initialize();
      if (!mounted) {
        await c.dispose();
        return;
      }
      setState(() => _camera = c);
    } catch (e) {
      setState(() => _error = '$e');
    }
  }

  Future<String> _save(List<int> bytes, String ext) async {
    final f = File('${widget.saveDir.path}/${DateTime.now().microsecondsSinceEpoch}.$ext');
    await f.writeAsBytes(bytes, flush: true);
    return f.path;
  }

  Future<void> _photo() async {
    if (_busy || _camera == null) return;
    setState(() => _busy = true);
    try {
      final fix = await _gps.fixForShutter();
      final capturedAt = DateTime.now();
      final shot = await _camera!.takePicture();
      final bytes = await widget.compressor.photo(shot.path);
      await File(shot.path).delete().catchError((_) => File(shot.path));
      final path = await _save(bytes, 'jpg');
      if (mounted) Navigator.of(context).pop(CapturedMedia(kind: MediaKind.photo, path: path, fix: fix, capturedAt: capturedAt));
    } on CaptureBlocked {
      // the GPS chip already explains why
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _toggleVideo() async {
    if (_camera == null || _busy) return;
    if (!_recording) {
      try {
        _videoFix = await _gps.fixForShutter();
      } on CaptureBlocked {
        return;
      }
      _videoStart = DateTime.now();
      await _camera!.startVideoRecording();
      _videoTimer = Timer(maxVideo, _stopVideo);
      setState(() => _recording = true);
    } else {
      await _stopVideo();
    }
  }

  Future<void> _stopVideo() async {
    _videoTimer?.cancel();
    if (!_recording) return;
    setState(() {
      _recording = false;
      _busy = true;
    });
    try {
      final file = await _camera!.stopVideoRecording();
      final bytes = await widget.compressor.video(file.path);
      await File(file.path).delete().catchError((_) => File(file.path));
      final path = await _save(bytes, 'mp4');
      if (mounted) Navigator.of(context).pop(CapturedMedia(kind: MediaKind.video, path: path, fix: _videoFix!, capturedAt: _videoStart!));
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _videoTimer?.cancel();
    _camera?.dispose();
    _gps.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Stack(children: [
          if (_camera != null) Center(child: CameraPreview(_camera!)) else Center(child: Text(_error ?? s.t('locating'), style: const TextStyle(color: Colors.white))),
          Positioned(top: 12, left: 12, right: 12, child: Row(children: [
            IconButton(icon: const Icon(Icons.close, color: Colors.white), onPressed: () => Navigator.of(context).pop()),
            const SizedBox(width: 8),
            Expanded(child: GpsStatusChip(_gps)),
          ])),
          Positioned(
            bottom: 24, left: 0, right: 0,
            child: ListenableBuilder(
              listenable: _gps,
              builder: (_, _) => Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                FloatingActionButton.large(
                  heroTag: 'photo',
                  onPressed: _gps.ready && !_busy && !_recording ? _photo : null,
                  backgroundColor: _gps.ready && !_recording ? Colors.white : Colors.white24,
                  tooltip: s.t('takePhoto'),
                  child: _busy ? const CircularProgressIndicator() : const Icon(Icons.camera_alt, color: Colors.black, size: 36),
                ),
                if (widget.allowVideo)
                  FloatingActionButton(
                    heroTag: 'video',
                    onPressed: (_gps.ready || _recording) && !_busy ? _toggleVideo : null,
                    backgroundColor: _recording ? Colors.red : Colors.white70,
                    tooltip: _recording ? s.t('stop') : s.t('recordVideo'),
                    child: Icon(_recording ? Icons.stop : Icons.videocam, color: Colors.black),
                  ),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}
