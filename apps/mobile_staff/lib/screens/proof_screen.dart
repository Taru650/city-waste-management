import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

enum ProofKind { start, resolve }

/// Camera proof for starting or finishing work. Captures carry their own GPS fix and signature;
/// the action is queued first, so it survives no signal and app restarts, then sent.
class ProofScreen extends ConsumerStatefulWidget {
  const ProofScreen({super.key, required this.complaint, required this.kind});
  final Complaint complaint;
  final ProofKind kind;
  @override
  ConsumerState<ProofScreen> createState() => _ProofScreenState();
}

class _ProofScreenState extends ConsumerState<ProofScreen> {
  final _remark = TextEditingController();
  final List<CapturedMedia> _captures = [];
  bool _busy = false;
  String? _message;

  bool get _resolve => widget.kind == ProofKind.resolve;

  Future<void> _capture() async {
    final hasVideo = _captures.any((c) => c.kind == MediaKind.video);
    final media = await ref.read(captureLauncherProvider)(context, allowVideo: _resolve && !hasVideo);
    if (media != null && mounted) setState(() => _captures.add(media));
  }

  Future<void> _submit() async {
    final s = S.of(context);
    // The API requires at least one photo from a worker; supervisors are held to the same standard here.
    if (!_captures.any((c) => c.kind == MediaKind.photo)) return setState(() => _message = s.t('proofNeeded'));
    final remark = _remark.text.trim();
    if (_resolve && remark.length < 5) return setState(() => _message = s.t('reasonMin'));
    setState(() {
      _busy = true;
      _message = null;
    });
    final fix = _captures.last.fix;
    final box = await ref.read(outboxProvider.future);
    await box.enqueue(
      kind: _resolve ? OutboxKind.resolve : OutboxKind.startWork,
      complaintId: widget.complaint.id,
      payload: {'lat': fix.lat, 'lng': fix.lng, 'accuracyM': fix.accuracyM, if (remark.isNotEmpty) 'remark': remark},
      captures: List.of(_captures),
    );
    final r = await box.run();
    if (!mounted) return;
    setState(() => _busy = false);
    final failed = box.items.where((i) => i.complaintId == widget.complaint.id && i.state != OutboxState.pending).firstOrNull;
    if (failed != null) {
      setState(() => _message = s.t('uploadFailed', {'reason': failed.lastError ?? ''}));
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.t(r.completed > 0 ? 'submitted' : 'actionQueued'))));
    Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.t(_resolve ? 'resolve' : 'startWork'))),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(16), children: [
          Text('${widget.complaint.complaintNo} · ${widget.complaint.typeName(s.lang)}', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Text(s.t('proofNeeded'), style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 8),
          CaptureStrip(captures: _captures, onCapture: _capture, onRemove: (c) => setState(() => _captures.remove(c)), maxVideos: _resolve ? 1 : 0),
          const SizedBox(height: 16),
          TextField(
            key: const Key('remark'), controller: _remark, maxLength: 500, maxLines: 3,
            decoration: InputDecoration(labelText: s.t(_resolve ? 'resolutionRemark' : 'feedbackRemark')),
          ),
          if (_message != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_message!, key: const Key('proof-message'), style: const TextStyle(color: Colors.red))),
          FilledButton(key: const Key('proof-submit'), onPressed: _busy ? null : _submit, child: _busy ? const CircularProgressIndicator() : Text(s.t('submit'))),
        ]),
      ),
    );
  }
}
