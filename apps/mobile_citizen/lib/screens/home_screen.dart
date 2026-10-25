import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'complaint_detail_screen.dart';
import 'new_complaint_screen.dart';
import 'privacy_screens.dart';

final myComplaintsProvider = FutureProvider.autoDispose<Paged<Complaint>>((ref) => ref.watch(complaintsRepoProvider).list(pageSize: 50));
final notificationsProvider = FutureProvider.autoDispose<Paged<AppNotification>>((ref) => ref.watch(notificationsRepoProvider).list());

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});
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

  /// Send anything queued while offline whenever the app comes back to the foreground.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _flushOutbox();
  }

  Future<void> _flushOutbox() async {
    try {
      final box = await ref.read(outboxProvider.future);
      final r = await box.run();
      if (r.completed > 0) ref.invalidate(myComplaintsProvider);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    // A push while the app is open: refresh what it is about and say so; a tapped push opens it.
    ref.listen(foregroundPushProvider, (_, next) => next.whenData((m) {
          ref.invalidate(myComplaintsProvider);
          ref.invalidate(notificationsProvider);
          if (m.title != null) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m.title!)));
        }));
    ref.listen(openedPushProvider, (_, next) => next.whenData((m) {
          if (m.complaintId != null) Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ComplaintDetailScreen(m.complaintId!)));
        }));
    final pages = [const _MyComplaints(), const _Notifications(), const _Profile()];
    return Scaffold(
      appBar: AppBar(title: Text(s.t('appName')), actions: [
        IconButton(icon: const Icon(Icons.search), tooltip: s.t('track'), onPressed: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => const TrackScreen()))),
      ]),
      body: pages[_tab],
      floatingActionButton: _tab == 0
          ? FloatingActionButton.extended(
              key: const Key('new-complaint'),
              icon: const Icon(Icons.add_a_photo),
              label: Text(s.t('newComplaint')),
              onPressed: () async {
                await Navigator.push(context, MaterialPageRoute<void>(builder: (_) => const NewComplaintScreen()));
                ref.invalidate(myComplaintsProvider);
              },
            )
          : null,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          NavigationDestination(icon: const Icon(Icons.list_alt), label: s.t('myComplaints')),
          NavigationDestination(icon: const Icon(Icons.notifications), label: s.t('notifications')),
          NavigationDestination(icon: const Icon(Icons.person), label: s.t('profile')),
        ],
      ),
    );
  }
}

class _MyComplaints extends ConsumerWidget {
  const _MyComplaints();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final data = ref.watch(myComplaintsProvider);
    final outbox = ref.watch(outboxProvider).value;
    return RefreshIndicator(
      onRefresh: () async {
        await outbox?.run();
        ref.invalidate(myComplaintsProvider);
        await ref.read(myComplaintsProvider.future);
      },
      child: ListView(children: [
        if (outbox != null) OutboxBanner(outbox),
        ...data.when(
          loading: () => [const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator()))],
          error: (e, _) => [ErrorRetry(e, onRetry: () => ref.invalidate(myComplaintsProvider))],
          data: (page) => page.items.isEmpty
              ? [Padding(padding: const EdgeInsets.all(32), child: Center(child: Text(s.t('empty'))))]
              : [
                  for (final c in page.items)
                    ComplaintTile(c, key: Key('complaint-${c.id}'), onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ComplaintDetailScreen(c.id)))),
                ],
        ),
        const SizedBox(height: 80),
      ]),
    );
  }
}

class _Notifications extends ConsumerWidget {
  const _Notifications();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    return ref.watch(notificationsProvider).when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ErrorRetry(e, onRetry: () => ref.invalidate(notificationsProvider)),
          data: (page) => RefreshIndicator(
            onRefresh: () async => ref.invalidate(notificationsProvider),
            child: ListView(children: [
              if (page.items.isNotEmpty)
                Align(alignment: Alignment.centerRight, child: TextButton(
                  onPressed: () async {
                    await ref.read(notificationsRepoProvider).markAllRead();
                    ref.invalidate(notificationsProvider);
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
                    ref.invalidate(notificationsProvider);
                    if (n.complaintId != null && context.mounted) {
                      Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ComplaintDetailScreen(n.complaintId!)));
                    }
                  },
                ),
            ]),
          ),
        );
  }
}

class _Profile extends ConsumerWidget {
  const _Profile();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final me = ref.watch(sessionProvider).value;
    final lang = ref.watch(localeProvider).languageCode;
    return ListView(padding: const EdgeInsets.all(16), children: [
      ListTile(leading: const Icon(Icons.person), title: Text(me?.name ?? ''), subtitle: Text(me?.mobile ?? '')),
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
      const Divider(height: 24),
      if (me != null)
        ListTile(key: const Key('edit-profile'), leading: const Icon(Icons.edit), title: Text(s.t('editProfile')), onTap: () => showCorrectProfile(context, ref, me)),
      ListTile(
        key: const Key('open-my-data'), leading: const Icon(Icons.download), title: Text(s.t('myData')),
        onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => const MyDataScreen())),
      ),
      ListTile(
        leading: const Icon(Icons.privacy_tip), title: Text(s.t('privacyNotice')),
        onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => const PrivacyNoticeScreen())),
      ),
      ListTile(
        key: const Key('delete-account'), leading: const Icon(Icons.delete_forever, color: Colors.red),
        title: Text(s.t('deleteAccount'), style: const TextStyle(color: Colors.red)), onTap: () => showDeleteAccount(context, ref),
      ),
      const SizedBox(height: 24),
      const SignOutButton(),
      const SizedBox(height: 8),
      const Align(alignment: Alignment.center, child: LanguageToggle()),
    ]);
  }
}

class TrackScreen extends ConsumerStatefulWidget {
  const TrackScreen({super.key});
  @override
  ConsumerState<TrackScreen> createState() => _TrackScreenState();
}

class _TrackScreenState extends ConsumerState<TrackScreen> {
  final _no = TextEditingController();
  String? _error;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.t('track'))),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(children: [
          TextField(key: const Key('track-no'), controller: _no, decoration: InputDecoration(labelText: s.t('complaintNo'), hintText: '0446-800123-26-000457', errorText: _error)),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: () async {
              try {
                final c = await ref.read(complaintsRepoProvider).track(_no.text.trim());
                if (context.mounted) Navigator.pushReplacement(context, MaterialPageRoute<void>(builder: (_) => ComplaintDetailScreen(c.id)));
              } on ApiException catch (e) {
                setState(() => _error = e.message);
              }
            },
            child: Text(s.t('track')),
          ),
        ]),
      ),
    );
  }
}
