import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final privacyNoticeProvider = FutureProvider.autoDispose.family<PrivacyNotice, String>((ref, lang) => ref.watch(privacyRepoProvider).notice(lang));

/// The DPDP notice, in the app's language.
class PrivacyNoticeView extends ConsumerWidget {
  const PrivacyNoticeView({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    return ref.watch(privacyNoticeProvider(s.lang)).when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ErrorRetry(e, onRetry: () => ref.invalidate(privacyNoticeProvider(s.lang))),
          data: (n) => ListView(padding: const EdgeInsets.all(16), children: [
            Text(n.title, style: Theme.of(context).textTheme.titleLarge, key: const Key('notice-title')),
            for (final (h, b) in n.sections) ...[
              const SizedBox(height: 12),
              Text(h, style: Theme.of(context).textTheme.titleSmall),
              Text(b),
            ],
            if (n.officer.name.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text(s.t('grievanceOfficer'), style: Theme.of(context).textTheme.titleSmall),
              Text([n.officer.name, n.officer.email, n.officer.phone].where((x) => x.isNotEmpty).join('\n')),
            ],
            Padding(padding: const EdgeInsets.only(top: 12), child: Text('v${n.version}', style: Theme.of(context).textTheme.bodySmall)),
          ]),
        );
  }
}

class PrivacyNoticeScreen extends StatelessWidget {
  const PrivacyNoticeScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: Text(S.of(context).t('privacyNotice'))), body: const PrivacyNoticeView());
}

/// Shown instead of the app when the citizen has not accepted the current notice.
class ConsentScreen extends ConsumerStatefulWidget {
  const ConsentScreen({super.key});
  @override
  ConsumerState<ConsentScreen> createState() => _ConsentScreenState();
}

class _ConsentScreenState extends ConsumerState<ConsentScreen> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final notice = ref.watch(privacyNoticeProvider(s.lang)).value;
    return Scaffold(
      appBar: AppBar(title: Text(s.t('privacyNotice')), actions: [
        TextButton(onPressed: () => ref.read(sessionProvider.notifier).logout(), child: Text(s.t('signOut'))),
      ]),
      body: Column(children: [
        Padding(padding: const EdgeInsets.all(16), child: Text(s.t('consentUpdated'), key: const Key('consent-required'))),
        const Expanded(child: PrivacyNoticeView()),
        Padding(
          padding: const EdgeInsets.all(16),
          child: FilledButton(
            key: const Key('consent-accept'),
            onPressed: notice == null || _busy
                ? null
                : () async {
                    setState(() => _busy = true);
                    try {
                      await ref.read(privacyRepoProvider).consent(notice.version, s.lang);
                      await ref.read(sessionProvider.notifier).consentGiven();
                    } on ApiException catch (e) {
                      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
                    } finally {
                      if (mounted) setState(() => _busy = false);
                    }
                  },
            child: Text(s.t('accept')),
          ),
        ),
      ]),
    );
  }
}

/// Right of access: the export, readable and copyable.
class MyDataScreen extends ConsumerWidget {
  const MyDataScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.t('myData'))),
      body: FutureBuilder<Map<String, dynamic>>(
        future: ref.read(privacyRepoProvider).myData(),
        builder: (context, snap) {
          if (snap.hasError) return Center(child: Text('${snap.error}'));
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final text = const JsonEncoder.withIndent('  ').convert(snap.data);
          return ListView(padding: const EdgeInsets.all(16), children: [
            Text(s.t('myDataHint')),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                key: const Key('copy-data'),
                icon: const Icon(Icons.copy),
                label: Text(s.t('copy')),
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: text));
                  if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.t('copied'))));
                },
              ),
            ),
            SelectableText(text, key: const Key('my-data'), style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
          ]);
        },
      ),
    );
  }
}

/// Right of correction: name and email (the mobile number is the account identity).
Future<void> showCorrectProfile(BuildContext context, WidgetRef ref, Me me) async {
  final s = S.of(context);
  final name = TextEditingController(text: me.name);
  final email = TextEditingController(text: me.email ?? '');
  final saved = await showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text(s.t('editProfile')),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(key: const Key('edit-name'), controller: name, decoration: InputDecoration(labelText: s.t('name'))),
        TextField(key: const Key('edit-email'), controller: email, decoration: InputDecoration(labelText: s.t('email')), keyboardType: TextInputType.emailAddress),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: Text(s.t('cancel'))),
        FilledButton(
          key: const Key('edit-save'),
          onPressed: () async {
            try {
              await ref.read(privacyRepoProvider).correct(
                    name: name.text.trim() == me.name ? null : name.text.trim(),
                    email: email.text.trim() == (me.email ?? '') ? null : email.text.trim(),
                  );
              if (c.mounted) Navigator.pop(c, true);
            } on ApiException catch (e) {
              if (c.mounted) ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text(e.message)));
            }
          },
          child: Text(s.t('save')),
        ),
      ],
    ),
  );
  if (saved == true) await ref.read(sessionProvider.notifier).refreshMe();
}

/// Right of erasure / consent withdrawal, with the password as confirmation.
Future<void> showDeleteAccount(BuildContext context, WidgetRef ref) async {
  final s = S.of(context);
  final pw = TextEditingController();
  String? error;
  final done = await showDialog<bool>(
    context: context,
    builder: (c) => StatefulBuilder(
      builder: (c, setState) => AlertDialog(
        title: Text(s.t('deleteAccount')),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(s.t('deleteWarning'), key: const Key('delete-warning')),
          TextField(key: const Key('delete-password'), controller: pw, obscureText: true, decoration: InputDecoration(labelText: s.t('password'), errorText: error)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: Text(s.t('cancel'))),
          FilledButton(
            key: const Key('delete-confirm'),
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () async {
              try {
                await ref.read(privacyRepoProvider).erase(pw.text);
                if (c.mounted) Navigator.pop(c, true);
              } on ApiException catch (e) {
                setState(() => error = e.message);
              }
            },
            child: Text(s.t('deleteConfirm')),
          ),
        ],
      ),
    ),
  );
  if (done == true) {
    await ref.read(sessionProvider.notifier).erased();
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.t('accountDeleted'))));
  }
}
