import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class ForgotScreen extends ConsumerStatefulWidget {
  const ForgotScreen({super.key});
  @override
  ConsumerState<ForgotScreen> createState() => _ForgotScreenState();
}

class _ForgotScreenState extends ConsumerState<ForgotScreen> {
  final _id = TextEditingController();
  bool _sent = false;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.t('forgotPassword'))),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: _sent
            ? Text(s.t('resetSent'), key: const Key('reset-sent'))
            : Column(children: [
                TextField(controller: _id, decoration: InputDecoration(labelText: s.t('mobileOrEmail'))),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: () async {
                    // Same message whether or not the account exists.
                    await ref.read(authRepoProvider).forgotPassword(_id.text.trim()).catchError((_) {});
                    if (mounted) setState(() => _sent = true);
                  },
                  child: Text(s.t('submit')),
                ),
              ]),
      ),
    );
  }
}
