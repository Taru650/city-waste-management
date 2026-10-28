import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Staff accounts are created by their Sub Admin, so there is no registration here. A forgotten
/// password is reset by the Sub Admin (temporary password, forced change on next sign-in).
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});
  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _form = GlobalKey<FormState>();
  final _id = TextEditingController();
  final _pw = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final outcome = await ref.read(sessionProvider.notifier).login(_id.text.trim(), _pw.text);
      // Accounts with MFA are administrators: they belong on the web portal.
      if (outcome == LoginOutcome.mfaRequired && mounted) setState(() => _error = S.of(context).t('useMobileRole'));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.t('staffAppName')), actions: const [LanguageToggle()]),
      body: SafeArea(
        child: Form(
          key: _form,
          child: ListView(padding: const EdgeInsets.all(20), children: [
            Text(s.t('signIn'), style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 16),
            if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(_error!, key: const Key('login-error'), style: const TextStyle(color: Colors.red))),
            TextFormField(
              key: const Key('identifier'), controller: _id, decoration: InputDecoration(labelText: s.t('mobileOrEmail')),
              keyboardType: TextInputType.emailAddress, autofillHints: const [AutofillHints.username],
              validator: (v) => (v ?? '').trim().length < 3 ? s.t('required') : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              key: const Key('password'), controller: _pw, obscureText: true, decoration: InputDecoration(labelText: s.t('password')),
              autofillHints: const [AutofillHints.password], validator: (v) => (v ?? '').isEmpty ? s.t('required') : null,
            ),
            const SizedBox(height: 20),
            FilledButton(key: const Key('login-submit'), onPressed: _busy ? null : _submit, child: _busy ? const CircularProgressIndicator() : Text(s.t('signIn'))),
          ]),
        ),
      ),
    );
  }
}
