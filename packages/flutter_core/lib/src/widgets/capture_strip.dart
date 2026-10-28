import 'dart:io';

import 'package:flutter/material.dart';

import '../capture/captured_media.dart';
import '../i18n/strings.dart';
import '../offline/outbox.dart';

/// Thumbnails of in-app captures with a remove button, plus a "take photo" tile while under the
/// per-stage limits (5 photos + 1 video, matching the API).
class CaptureStrip extends StatelessWidget {
  const CaptureStrip({super.key, required this.captures, required this.onCapture, required this.onRemove, this.maxPhotos = 5, this.maxVideos = 1});
  final List<CapturedMedia> captures;
  final VoidCallback onCapture;
  final ValueChanged<CapturedMedia> onRemove;
  final int maxPhotos;
  final int maxVideos;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final photos = captures.where((c) => c.kind == MediaKind.photo).length;
    final videos = captures.length - photos;
    return SizedBox(
      height: 104,
      child: ListView(scrollDirection: Axis.horizontal, children: [
        for (final c in captures)
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Stack(children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: c.kind == MediaKind.photo
                    ? Image.file(File(c.path), width: 100, height: 100, fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox(width: 100, height: 100, child: Icon(Icons.image)))
                    : Container(width: 100, height: 100, color: Colors.black87, child: const Icon(Icons.videocam, color: Colors.white)),
              ),
              Positioned(right: 0, top: 0, child: IconButton(
                icon: const Icon(Icons.cancel, color: Colors.white), visualDensity: VisualDensity.compact,
                onPressed: () => onRemove(c),
              )),
            ]),
          ),
        if (photos < maxPhotos || videos < maxVideos)
          InkWell(
            key: const Key('capture'),
            onTap: onCapture,
            child: Container(
              width: 100, height: 100,
              decoration: BoxDecoration(border: Border.all(color: Colors.green), borderRadius: BorderRadius.circular(8)),
              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [const Icon(Icons.add_a_photo), Text(s.t('takePhoto'), textAlign: TextAlign.center, style: const TextStyle(fontSize: 12))]),
            ),
          ),
      ]),
    );
  }
}

/// Shows queued work and why anything failed, with a way to discard it.
class OutboxBanner extends StatelessWidget {
  const OutboxBanner(this.outbox, {super.key});
  final Outbox outbox;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return StreamBuilder<List<OutboxItem>>(
      stream: outbox.changes,
      initialData: outbox.items,
      builder: (context, snap) {
        final items = snap.data ?? [];
        if (items.isEmpty) return const SizedBox.shrink();
        final pending = items.where((i) => i.state == OutboxState.pending).length;
        return Card(
          key: const Key('outbox-banner'),
          color: Colors.amber.shade50,
          margin: const EdgeInsets.all(12),
          child: Column(children: [
            if (pending > 0) ListTile(leading: const Icon(Icons.cloud_upload), title: Text(s.t('pendingUploads', {'n': pending}))),
            for (final i in items.where((i) => i.state != OutboxState.pending))
              ListTile(
                leading: const Icon(Icons.error_outline, color: Colors.red),
                title: Text(s.t('uploadFailed', {'reason': i.lastError ?? ''})),
                trailing: TextButton(onPressed: () => outbox.discard(i.id), child: Text(s.t('discard'))),
              ),
          ]),
        );
      },
    );
  }
}
