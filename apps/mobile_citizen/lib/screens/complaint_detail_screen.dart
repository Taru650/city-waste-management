import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final complaintProvider = FutureProvider.autoDispose.family<Complaint, String>((ref, id) => ref.watch(complaintsRepoProvider).get(id));
final complaintMediaProvider = FutureProvider.autoDispose.family<List<MediaItem>, String>((ref, id) => ref.watch(complaintsRepoProvider).media(id));

class ComplaintDetailScreen extends ConsumerWidget {
  const ComplaintDetailScreen(this.id, {super.key});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final c = ref.watch(complaintProvider(id));
    return Scaffold(
      appBar: AppBar(title: Text(c.value?.complaintNo ?? s.t('complaintNo'))),
      body: c.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorRetry(e, onRetry: () => ref.invalidate(complaintProvider(id))),
        data: (c) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(complaintProvider(id));
            ref.invalidate(complaintMediaProvider(id));
          },
          child: ListView(children: [
            ListTile(
              title: Text(c.typeName(s.lang), style: Theme.of(context).textTheme.titleLarge),
              subtitle: Text('${c.ulbName} · ${s.t('ward')} ${c.wardNumber}'),
              trailing: StatusChip(c.status),
            ),
            if (c.landmark != null) ListTile(dense: true, leading: const Icon(Icons.place), title: Text(c.landmark!)),
            ListTile(dense: true, leading: const Icon(Icons.notes), title: Text(c.description)),
            ListTile(dense: true, leading: const Icon(Icons.schedule), title: Text('${s.t('filed')}: ${fmtDate(c.createdAt)}'),
                subtitle: c.status.isOpen ? Text('${s.t('slaDue')}: ${fmtDate(c.slaDueAt)}', style: TextStyle(color: c.slaBreached ? Colors.red : null)) : null),
            if (c.workerName != null) ListTile(dense: true, leading: const Icon(Icons.engineering), title: Text('${s.t('assignedTo')}: ${c.workerName}')),
            if (c.resolutionRemark != null) ListTile(dense: true, leading: const Icon(Icons.check_circle, color: Colors.green), title: Text(c.resolutionRemark!)),
            const Divider(),
            ref.watch(complaintMediaProvider(id)).when(
                  loading: () => const LinearProgressIndicator(),
                  error: (_, _) => const SizedBox.shrink(),
                  data: (m) => MediaStrip(m),
                ),
            if (c.canGiveFeedback) FeedbackCard(complaintId: id),
            const Divider(),
            Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 0), child: Text(s.t('history'), style: Theme.of(context).textTheme.titleMedium)),
            EventTimeline(c.events),
            const SizedBox(height: 24),
          ]),
        ),
      ),
    );
  }
}

/// 1–5 stars, optional comment; 1–2 stars may reopen the complaint (within 7 days).
class FeedbackCard extends ConsumerStatefulWidget {
  const FeedbackCard({super.key, required this.complaintId});
  final String complaintId;
  @override
  ConsumerState<FeedbackCard> createState() => _FeedbackCardState();
}

class _FeedbackCardState extends ConsumerState<FeedbackCard> {
  int _rating = 0;
  bool _reopen = false;
  bool _busy = false;
  final _remark = TextEditingController();

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final canReopen = _rating > 0 && _rating <= 2;
    return Card(
      key: const Key('feedback-card'),
      margin: const EdgeInsets.all(12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(s.t('rateTitle'), style: Theme.of(context).textTheme.titleMedium),
          Row(children: [
            for (var i = 1; i <= 5; i++)
              IconButton(
                key: Key('star-$i'),
                icon: Icon(i <= _rating ? Icons.star : Icons.star_border, color: Colors.amber, size: 32),
                onPressed: () => setState(() {
                  _rating = i;
                  if (i > 2) _reopen = false;
                }),
              ),
          ]),
          TextField(controller: _remark, maxLength: 250, decoration: InputDecoration(labelText: s.t('feedbackRemark'))),
          CheckboxListTile(
            key: const Key('reopen'),
            contentPadding: EdgeInsets.zero,
            value: _reopen,
            onChanged: canReopen ? (v) => setState(() => _reopen = v ?? false) : null,
            title: Text(s.t('reopen')),
            subtitle: canReopen ? null : Text(s.t('reopenOnlyLow')),
          ),
          FilledButton(
            key: const Key('feedback-submit'),
            onPressed: _rating == 0 || _busy
                ? null
                : () async {
                    setState(() => _busy = true);
                    try {
                      await ref.read(complaintsRepoProvider).feedback(widget.complaintId, rating: _rating, remark: _remark.text.trim(), reopen: _reopen);
                      if (!context.mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.t('thanks'))));
                      ref.invalidate(complaintProvider(widget.complaintId));
                    } on ApiException catch (e) {
                      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
                    } finally {
                      if (mounted) setState(() => _busy = false);
                    }
                  },
            child: Text(s.t('submit')),
          ),
        ]),
      ),
    );
  }
}
