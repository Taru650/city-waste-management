import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'proof_screen.dart';

final taskProvider = FutureProvider.autoDispose.family<Complaint, String>((ref, id) => ref.watch(complaintsRepoProvider).get(id));
final taskMediaProvider = FutureProvider.autoDispose.family<List<MediaItem>, String>((ref, id) => ref.watch(complaintsRepoProvider).media(id));

/// What this user may do on this complaint. Mirrors the API state machine (state-machine.ts) so
/// only valid buttons are shown; the server still decides.
class StaffActions {
  StaffActions(Role role, ComplaintStatus st)
      : assign = role == Role.supervisor && _triage.contains(st),
        reject = role == Role.supervisor && _triage.contains(st),
        start = st == ComplaintStatus.assigned || st == ComplaintStatus.reopened,
        resolve = st == ComplaintStatus.workInProgress || (role == Role.supervisor && (st == ComplaintStatus.assigned || st == ComplaintStatus.reopened));

  static const _triage = {ComplaintStatus.pending, ComplaintStatus.assigned, ComplaintStatus.reopened};
  final bool assign, reject, start, resolve;
}

class TaskDetailScreen extends ConsumerWidget {
  const TaskDetailScreen(this.id, {super.key});
  final String id;

  void _refresh(WidgetRef ref) {
    ref.invalidate(taskProvider(id));
    ref.invalidate(taskMediaProvider(id));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final me = ref.watch(sessionProvider).value;
    final task = ref.watch(taskProvider(id));
    final outbox = ref.watch(outboxProvider).value;
    return Scaffold(
      appBar: AppBar(title: Text(task.value?.complaintNo ?? s.t('complaintNo'))),
      // skipError keeps the last loaded copy on screen when a refresh fails (no signal in the
      // field), so the task and its queued-upload notice stay visible.
      body: task.when(
        skipError: true,
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorRetry(e, onRetry: () => _refresh(ref)),
        data: (complaint) {
          final stale = task.hasError;
          final c = complaint;
          final can = StaffActions(me?.role ?? Role.worker, c.status);
          return RefreshIndicator(
            onRefresh: () async => _refresh(ref),
            child: ListView(children: [
              if (stale) MaterialBanner(content: Text(s.t('offline'), key: const Key('stale')), actions: [TextButton(onPressed: () => _refresh(ref), child: Text(s.t('retry')))]),
              ListTile(
                title: Text(c.typeName(s.lang), style: Theme.of(context).textTheme.titleLarge),
                subtitle: Text('${c.ulbName} · ${s.t('ward')} ${c.wardNumber}'),
                trailing: StatusChip(c.status),
              ),
              if (c.eventZoneName != null)
                ListTile(dense: true, leading: const Icon(Icons.festival, color: Colors.deepPurple), title: Text(s.t('eventZone', {'name': c.eventZoneName}), key: const Key('event-zone'))),
              if (c.landmark != null) ListTile(dense: true, leading: const Icon(Icons.place), title: Text(c.landmark!)),
              ListTile(dense: true, leading: const Icon(Icons.notes), title: Text(c.description)),
              ListTile(
                dense: true, leading: const Icon(Icons.schedule),
                title: Text('${s.t('filed')}: ${fmtDate(c.createdAt)}'),
                subtitle: c.status.isOpen ? Text('${s.t('slaDue')}: ${fmtDate(c.slaDueAt)}', style: TextStyle(color: c.slaBreached ? Colors.red : null)) : null,
              ),
              ListTile(dense: true, leading: const Icon(Icons.engineering), title: Text('${s.t('assignedTo')}: ${c.workerName ?? s.t('unassigned')}')),
              if (c.reopenCount > 0) ListTile(dense: true, leading: const Icon(Icons.replay, color: Colors.deepOrange), title: Text('${s.t('st.REOPENED')} × ${c.reopenCount}')),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: OutlinedButton.icon(
                  key: const Key('navigate'),
                  icon: const Icon(Icons.directions),
                  label: Text(s.t('navigate')),
                  onPressed: () => ref.read(mapLauncherProvider)(c.lat, c.lng),
                ),
              ),
              if (outbox != null) _QueuedNotice(outbox: outbox, complaintId: id, onSent: () => _refresh(ref)),
              _ActionBar(c: c, can: can, outbox: outbox, onChanged: () => _refresh(ref)),
              const Divider(),
              ref.watch(taskMediaProvider(id)).when(
                    loading: () => const LinearProgressIndicator(),
                    error: (_, _) => const SizedBox.shrink(),
                    data: (m) => MediaStrip(m),
                  ),
              const Divider(),
              Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 0), child: Text(s.t('history'), style: Theme.of(context).textTheme.titleMedium)),
              EventTimeline(c.events),
              const SizedBox(height: 24),
            ]),
          );
        },
      ),
    );
  }
}

/// While proof for this complaint is still queued, say so (and hide the buttons, so the same
/// work is not submitted twice).
class _QueuedNotice extends StatelessWidget {
  const _QueuedNotice({required this.outbox, required this.complaintId, required this.onSent});
  final Outbox outbox;
  final String complaintId;
  final VoidCallback onSent;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<List<OutboxItem>>(
      stream: outbox.changes,
      initialData: outbox.items,
      builder: (context, snap) {
        final mine = (snap.data ?? []).where((i) => i.complaintId == complaintId).toList();
        if (mine.isEmpty) return const SizedBox.shrink();
        return Card(
          key: const Key('queued-here'),
          color: Colors.amber.shade50,
          margin: const EdgeInsets.all(12),
          child: ListTile(
            leading: const Icon(Icons.cloud_upload),
            title: Text(S.of(context).t('actionPendingHere')),
            subtitle: mine.first.lastError != null ? Text(mine.first.lastError!) : null,
            trailing: IconButton(
              icon: const Icon(Icons.refresh),
              onPressed: () async {
                final r = await outbox.run();
                if (r.completed > 0) onSent();
              },
            ),
          ),
        );
      },
    );
  }
}

class _ActionBar extends ConsumerWidget {
  const _ActionBar({required this.c, required this.can, required this.outbox, required this.onChanged});
  final Complaint c;
  final StaffActions can;
  final Outbox? outbox;
  final VoidCallback onChanged;

  Future<void> _proof(BuildContext context, ProofKind kind) async {
    final done = await Navigator.push<bool>(context, MaterialPageRoute(builder: (_) => ProofScreen(complaint: c, kind: kind)));
    if (done == true) onChanged();
  }

  Future<void> _assign(BuildContext context, WidgetRef ref) async {
    final s = S.of(context);
    final picked = await showModalBottomSheet<Worker>(context: context, builder: (_) => const _WorkerPicker());
    if (picked == null || !context.mounted) return;
    try {
      await ref.read(complaintsRepoProvider).assign(c.id, workerId: picked.id);
      onChanged();
    } on ApiException catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.isNetwork ? s.t('offline') : e.message)));
    }
  }

  Future<void> _reject(BuildContext context, WidgetRef ref) async {
    final reason = await showDialog<String>(context: context, builder: (_) => const _RejectDialog());
    if (reason == null || !context.mounted) return;
    try {
      await ref.read(complaintsRepoProvider).reject(c.id, reason);
      onChanged();
    } on ApiException catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.isNetwork ? S.of(context).t('offline') : e.message)));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    return StreamBuilder<List<OutboxItem>>(
      stream: outbox?.changes,
      initialData: outbox?.items ?? const [],
      builder: (context, snap) {
        if ((snap.data ?? []).any((i) => i.complaintId == c.id)) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.all(16),
          child: Wrap(spacing: 8, runSpacing: 8, children: [
            if (can.start) FilledButton.icon(key: const Key('start-work'), icon: const Icon(Icons.play_arrow), label: Text(s.t('startWork')), onPressed: () => _proof(context, ProofKind.start)),
            if (can.resolve) FilledButton.icon(key: const Key('resolve'), icon: const Icon(Icons.check), label: Text(s.t('resolve')), onPressed: () => _proof(context, ProofKind.resolve)),
            if (can.assign) OutlinedButton.icon(key: const Key('assign'), icon: const Icon(Icons.person_add), label: Text(s.t('assignWorker')), onPressed: () => _assign(context, ref)),
            if (can.reject)
              OutlinedButton.icon(
                key: const Key('reject'), icon: const Icon(Icons.block, color: Colors.red), label: Text(s.t('reject')),
                onPressed: () => _reject(context, ref),
              ),
          ]),
        );
      },
    );
  }
}

class _WorkerPicker extends ConsumerWidget {
  const _WorkerPicker();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    return FutureBuilder<List<Worker>>(
      future: ref.read(staffRepoProvider).workers(),
      builder: (context, snap) {
        if (snap.hasError) return Padding(padding: const EdgeInsets.all(24), child: Text('${snap.error}'));
        if (!snap.hasData) return const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator()));
        final workers = snap.data!;
        if (workers.isEmpty) return Padding(padding: const EdgeInsets.all(24), child: Text(s.t('noWorkers')));
        return ListView(shrinkWrap: true, children: [
          ListTile(title: Text(s.t('assignWorker'), style: Theme.of(context).textTheme.titleMedium)),
          for (final w in workers)
            ListTile(
              key: Key('worker-${w.id}'),
              leading: const Icon(Icons.engineering),
              title: Text(w.name),
              subtitle: Text([if (w.areaName != null) w.areaName!, s.t('openTasks', {'n': w.openTasks})].join(' · ')),
              onTap: () => Navigator.pop(context, w),
            ),
        ]);
      },
    );
  }
}

class _RejectDialog extends StatefulWidget {
  const _RejectDialog();
  @override
  State<_RejectDialog> createState() => _RejectDialogState();
}

class _RejectDialogState extends State<_RejectDialog> {
  final _reason = TextEditingController();
  String? _error;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return AlertDialog(
      title: Text(s.t('reject')),
      content: TextField(
        key: const Key('reject-reason'), controller: _reason, maxLength: 500, maxLines: 3,
        decoration: InputDecoration(labelText: s.t('rejectReason'), errorText: _error),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: Text(s.t('cancel'))),
        FilledButton(
          key: const Key('reject-confirm'),
          onPressed: () {
            final r = _reason.text.trim();
            if (r.length < 5) return setState(() => _error = s.t('reasonMin'));
            Navigator.pop(context, r);
          },
          child: Text(s.t('reject')),
        ),
      ],
    );
  }
}
