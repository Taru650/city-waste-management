import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import '../api/api_exception.dart';
import '../api/repositories.dart';
import '../capture/captured_media.dart';
import '../capture/uploader.dart';

enum OutboxKind { createComplaint, startWork, resolve }

enum OutboxState { pending, failed, expired }

/// One queued action with its captures. Uploaded media ids are remembered, so a retry after a
/// partial failure never uploads the same capture twice.
class OutboxItem {
  OutboxItem({
    required this.id, required this.kind, this.complaintId, required this.payload, required this.captures,
    List<String>? uploadedMediaIds, DateTime? createdAt, this.attempts = 0, this.lastError, this.state = OutboxState.pending,
  })  : uploadedMediaIds = uploadedMediaIds ?? [],
        createdAt = createdAt ?? DateTime.now();

  final String id;
  final OutboxKind kind;
  final String? complaintId;
  final Map<String, dynamic> payload;
  final List<CapturedMedia> captures;
  final List<String> uploadedMediaIds;
  final DateTime createdAt;
  int attempts;
  String? lastError;
  OutboxState state;

  Map<String, dynamic> toJson() => {
        'id': id, 'kind': kind.name, 'complaintId': complaintId, 'payload': payload, 'captures': captures.map((c) => c.toJson()).toList(),
        'uploadedMediaIds': uploadedMediaIds, 'createdAt': createdAt.toIso8601String(), 'attempts': attempts, 'lastError': lastError, 'state': state.name,
      };

  factory OutboxItem.fromJson(Map<String, dynamic> j) => OutboxItem(
        id: j['id'], kind: OutboxKind.values.byName(j['kind']), complaintId: j['complaintId'], payload: Map<String, dynamic>.from(j['payload']),
        captures: (j['captures'] as List).map((c) => CapturedMedia.fromJson(Map<String, dynamic>.from(c))).toList(),
        uploadedMediaIds: List<String>.from(j['uploadedMediaIds'] ?? []), createdAt: DateTime.parse(j['createdAt']),
        attempts: j['attempts'] ?? 0, lastError: j['lastError'], state: OutboxState.values.byName(j['state'] ?? 'pending'),
      );
}

abstract class OutboxStorage {
  Future<List<OutboxItem>> load();
  Future<void> save(List<OutboxItem> items);
}

/// JSON file in the app's private support directory (written atomically via rename).
class FileOutboxStorage implements OutboxStorage {
  FileOutboxStorage(this.file);
  final File file;

  @override
  Future<List<OutboxItem>> load() async {
    if (!await file.exists()) return [];
    final list = jsonDecode(await file.readAsString()) as List;
    return list.map((e) => OutboxItem.fromJson(Map<String, dynamic>.from(e))).toList();
  }

  @override
  Future<void> save(List<OutboxItem> items) async {
    final tmp = File('${file.path}.tmp');
    await tmp.writeAsString(jsonEncode(items.map((i) => i.toJson()).toList()), flush: true);
    await tmp.rename(file.path);
  }
}

class OutboxRunResult {
  OutboxRunResult({required this.completed, required this.remaining, required this.offline});
  final int completed;
  final int remaining;
  final bool offline;
}

/// Runs queued actions in order. Network errors stop the run (retry later); a definite refusal
/// (4xx / rejected media) marks the item failed so the user can see why; captures older than
/// 23 h are marked expired because the server would refuse them.
class Outbox {
  Outbox(this.storage, this.uploader, this.complaints);

  final OutboxStorage storage;
  final MediaUploader uploader;
  final ComplaintsRepository complaints;
  final _changes = StreamController<List<OutboxItem>>.broadcast();
  List<OutboxItem> _items = [];
  bool _loaded = false;
  Future<OutboxRunResult>? _running;

  Stream<List<OutboxItem>> get changes => _changes.stream;
  List<OutboxItem> get items => List.unmodifiable(_items);

  Future<void> _ensureLoaded() async {
    if (_loaded) return;
    _items = await storage.load();
    _loaded = true;
  }

  Future<OutboxItem> enqueue({required OutboxKind kind, String? complaintId, required Map<String, dynamic> payload, required List<CapturedMedia> captures}) async {
    await _ensureLoaded();
    final item = OutboxItem(id: '${DateTime.now().microsecondsSinceEpoch}-${Random().nextInt(1 << 32)}', kind: kind, complaintId: complaintId, payload: payload, captures: captures);
    _items.add(item);
    await _persist();
    return item;
  }

  Future<void> discard(String id) async {
    await _ensureLoaded();
    final item = _items.where((i) => i.id == id).firstOrNull;
    if (item == null) return;
    _items.remove(item);
    await _deleteFiles(item);
    await _persist();
  }

  /// Drops everything (and the capture files). Used at sign-out: queued work belongs to the
  /// account that captured it and must never be sent under the next user's session.
  Future<void> clear() async {
    await _running?.catchError((_) => OutboxRunResult(completed: 0, remaining: 0, offline: false));
    await _ensureLoaded();
    final all = List.of(_items);
    _items.clear();
    for (final i in all) {
      await _deleteFiles(i);
    }
    await _persist();
  }

  Future<List<OutboxItem>> load() async {
    await _ensureLoaded();
    return items;
  }

  /// Single run at a time; concurrent callers share it.
  Future<OutboxRunResult> run() => _running ??= _run().whenComplete(() => _running = null);

  Future<OutboxRunResult> _run() async {
    await _ensureLoaded();
    var completed = 0;
    for (final item in List.of(_items)) {
      if (item.state != OutboxState.pending) continue;
      if (item.captures.skip(item.uploadedMediaIds.length).any((c) => c.expired)) {
        item.state = OutboxState.expired;
        item.lastError = 'Photos are older than 24 hours. Take new photos.';
        await _persist();
        continue;
      }
      try {
        item.attempts++;
        for (var i = item.uploadedMediaIds.length; i < item.captures.length; i++) {
          final up = await uploader.upload(item.captures[i]);
          item.uploadedMediaIds.add(up.id);
          await _persist();
        }
        await _perform(item);
        _items.remove(item);
        await _deleteFiles(item);
        completed++;
        await _persist();
      } on ApiException catch (e) {
        if (e.isNetwork || e.status >= 500 || e.status == 429) {
          item.lastError = e.message;
          await _persist();
          return OutboxRunResult(completed: completed, remaining: _pending, offline: e.isNetwork);
        }
        item.state = OutboxState.failed;
        item.lastError = e.message;
        await _persist();
      } on MediaRejected catch (e) {
        item.state = OutboxState.failed;
        item.lastError = e.reason;
        await _persist();
      }
    }
    return OutboxRunResult(completed: completed, remaining: _pending, offline: false);
  }

  int get _pending => _items.where((i) => i.state == OutboxState.pending).length;

  Future<void> _perform(OutboxItem item) async {
    final p = item.payload;
    final ids = item.uploadedMediaIds;
    double? d(String k) => (p[k] as num?)?.toDouble();
    switch (item.kind) {
      case OutboxKind.createComplaint:
        await complaints.create(
          typeId: p['typeId'], lat: d('lat')!, lng: d('lng')!, accuracyM: d('accuracyM'), wardId: p['wardId'],
          landmark: p['landmark'], description: p['description'], mediaIds: ids,
        );
      case OutboxKind.startWork:
        await complaints.start(item.complaintId!, mediaIds: ids, lat: d('lat'), lng: d('lng'), accuracyM: d('accuracyM'), remark: p['remark']);
      case OutboxKind.resolve:
        await complaints.resolve(item.complaintId!, remark: p['remark'], mediaIds: ids, lat: d('lat'), lng: d('lng'), accuracyM: d('accuracyM'));
    }
  }

  Future<void> _deleteFiles(OutboxItem item) async {
    for (final c in item.captures) {
      try {
        await File(c.path).delete();
      } catch (_) {}
    }
  }

  Future<void> _persist() async {
    await storage.save(_items);
    if (!_changes.isClosed) _changes.add(items);
  }

  void dispose() => _changes.close();
}
