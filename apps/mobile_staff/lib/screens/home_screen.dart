import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'task_detail_screen.dart';

/// Inbox filter: open work by default; supervisors can narrow to one status or to overdue.
enum InboxFilter { open, pending, assigned, inProgress, reopened, overdue, all }

final inboxFilterProvider = NotifierProvider<InboxFilterNotifier, InboxFilter>(InboxFilterNotifier.new);

class InboxFilterNotifier extends Notifier<InboxFilter> {
  @override
  InboxFilter build() => InboxFilter.open;
  void set(InboxFilter f) => state = f;
}

final inboxProvider = FutureProvider.autoDispose<Paged<Complaint>>((ref) {
  final repo = ref.watch(complaintsRepoProvider);
  return switch (ref.watch(inboxFilterProvider)) {
    InboxFilter.open => repo.list(open: true, pageSize: 100),
    InboxFilter.pending => repo.list(status: 'PENDING', pageSize: 100),
    InboxFilter.assigned => repo.list(status: 'ASSIGNED', pageSize: 100),
    InboxFilter.inProgress => repo.list(status: 'WORK_IN_PROGRESS', pageSize: 100),
    InboxFilter.reopened => repo.list(status: 'REOPENED', pageSize: 100),
    InboxFilter.overdue => repo.list(overdue: true, pageSize: 100),
    InboxFilter.all => repo.list(pageSize: 100),
  };
});
final staffNotificationsProvider = FutureProvider.autoDispose<Paged<AppNotification>>((ref) => ref.watch(notificationsRepoProvider).list());

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key, required this.me});
  final Me me;
  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> with WidgetsBindingObserver {
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _flushOutbox();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// Field work is often done without signal: send queued proof whenever the app is reopened.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _flushOutbox();
  }

  Future<void> _flushOutbox() async {
    try {
      final box = await ref.read(outboxProvider.future);
      final r = await box.run();
      if (r.completed > 0) ref.invalidate(inboxProvider);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    // New task / handover pushes: refresh the inbox; a tapped push opens the task.
    ref.listen(foregroundPushProvider, (_, next) => next.whenData((m) {
          ref.invalidate(inboxProvider);
          ref.invalidate(staffNotificationsProvider);
          if (m.title != null) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m.title!)));
        }));
    ref.listen(openedPushProvider, (_, next) => next.whenData((m) {
          if (m.complaintId != null) Navigator.push(context, MaterialPageRoute<void>(builder: (_) => TaskDetailScreen(m.complaintId!)));
        }));
    final supervisor = widget.me.role == Role.supervisor;
    final pages = [_Inbox(supervisor: supervisor), const _Notifications(), _Profile(me: widget.me)];
    return Scaffold(
      appBar: AppBar(title: Text(s.t('staffAppName'))),
      body: pages[_tab],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          NavigationDestination(icon: const Icon(Icons.assignment), label: s.t(supervisor ? 'inbox' : 'tasks')),
          NavigationDestination(icon: const Icon(Icons.notifications), label: s.t('notifications')),
          NavigationDestination(icon: const Icon(Icons.person), label: s.t('profile')),
        ],
      ),
    );
  }
}

class _Inbox extends ConsumerWidget {
  const _Inbox({required this.supervisor});
  final bool supervisor;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final data = ref.watch(inboxProvider);
    final filter = ref.watch(inboxFilterProvider);
    final outbox = ref.watch(outboxProvider).value;
    String label(InboxFilter f) => switch (f) {
          InboxFilter.open => s.t('tasks'),
          InboxFilter.pending => s.t('st.PENDING'),
          InboxFilter.assigned => s.t('st.ASSIGNED'),
          InboxFilter.inProgress => s.t('st.WORK_IN_PROGRESS'),
          InboxFilter.reopened => s.t('st.REOPENED'),
          InboxFilter.overdue => s.t('overdue'),
          InboxFilter.all => s.t('filterAll'),
        };
    // Workers only ever see their own open tasks; the filters are for supervisors' area view.
    final filters = supervisor ? InboxFilter.values : const [InboxFilter.open, InboxFilter.overdue];
    return RefreshIndicator(
      onRefresh: () async {
        await outbox?.run();
        ref.invalidate(inboxProvider);
        await ref.read(inboxProvider.future);
      },
      child: ListView(children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
          child: Row(children: [
            for (final f in filters)
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: ChoiceChip(key: Key('filter-${f.name}'), label: Text(label(f)), selected: filter == f, onSelected: (_) => ref.read(inboxFilterProvider.notifier).set(f)),
              ),
          ]),
        ),
        if (outbox != null) OutboxBanner(outbox),
        ...data.when(
          loading: () => [const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator()))],
          error: (e, _) => [ErrorRetry(e, onRetry: () => ref.invalidate(inboxProvider))],
          data: (page) => page.items.isEmpty
              ? [Padding(padding: const EdgeInsets.all(32), child: Center(child: Text(s.t('empty'))))]
              : [
                  for (final c in page.items)
                    ComplaintTile(c, key: Key('complaint-${c.id}'), onTap: () async {
                      await Navigator.push(context, MaterialPageRoute<void>(builder: (_) => TaskDetailScreen(c.id)));
                      ref.invalidate(inboxProvider);
                    }),
                ],
        ),
        const SizedBox(height: 24),
      ]),
    );
  }
}

class _Notifications extends ConsumerWidget {
  const _Notifications();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    return ref.watch(staffNotificationsProvider).when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ErrorRetry(e, onRetry: () => ref.invalidate(staffNotificationsProvider)),
          data: (page) => RefreshIndicator(
            onRefresh: () async => ref.invalidate(staffNotificationsProvider),
            child: ListView(children: [
              if (page.items.isNotEmpty)
                Align(alignment: Alignment.centerRight, child: TextButton(
                  onPressed: () async {
                    await ref.read(notificationsRepoProvider).markAllRead();
                    ref.invalidate(staffNotificationsProvider);
                  },
                  child: Text(s.t('markAllRead')),
                )),
              if (page.items.isEmpty) Padding(padding: const EdgeInsets.all(32), child: Center(child: Text(s.t('empty')))),
              for (final n in page.items)
                ListTile(
                  leading: Icon(Icons.circle, size: 10, color: n.readAt == null ? Colors.green : Colors.transparent),
                  title: Text(n.title, style: TextStyle(fontWeight: n.readAt == null ? FontWeight.bold : FontWeight.normal)),
                  subtitle: Text('${n.body}\n${fmtDate(n.createdAt)}'),
                  isThreeLine: true,
                  onTap: () async {
                    await ref.read(notificationsRepoProvider).markRead(n.id);
                    ref.invalidate(staffNotificationsProvider);
                    if (n.complaintId != null && context.mounted) {
                      Navigator.push(context, MaterialPageRoute<void>(builder: (_) => TaskDetailScreen(n.complaintId!)));
                    }
                  },
                ),
            ]),
          ),
        );
  }
}

class _Profile extends ConsumerWidget {
  const _Profile({required this.me});
  final Me me;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final lang = ref.watch(localeProvider).languageCode;
    return ListView(padding: const EdgeInsets.all(16), children: [
      ListTile(leading: const Icon(Icons.badge), title: Text(me.name), subtitle: Text('${me.mobile} · ${me.role == Role.supervisor ? 'Supervisor' : 'Worker'}')),
      ListTile(
        leading: const Icon(Icons.translate),
        title: Text(s.t('language')),
        trailing: SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'hi', label: Text('हिन्दी')), ButtonSegment(value: 'en', label: Text('English'))],
          selected: {lang},
          onSelectionChanged: (v) async {
            ref.read(localeProvider.notifier).set(v.first);
            await ref.read(authRepoProvider).setLanguage(v.first).catchError((_) {});
          },
        ),
      ),
      const SizedBox(height: 24),
      const SignOutButton(),
    ]);
  }
}
