import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// First sign-in with a temporary password set by the Sub Admin.
class ChangePasswordScreen extends ConsumerStatefulWidget {
  const ChangePasswordScreen({super.key});
  @override
  ConsumerState<ChangePasswordScreen> createState() => _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends ConsumerState<ChangePasswordScreen> {
  final _form = GlobalKey<FormState>();
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(authRepoProvider).changePassword(_current.text, _next.text);
      await ref.read(sessionProvider.notifier).passwordChanged();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.t('mustChangePassword')), actions: [
        TextButton(onPressed: () => ref.read(sessionProvider.notifier).logout(), child: Text(s.t('signOut'))),
      ]),
      body: Form(
        key: _form,
        child: ListView(padding: const EdgeInsets.all(20), children: [
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(_error!, key: const Key('cp-error'), style: const TextStyle(color: Colors.red))),
          TextFormField(key: const Key('cp-current'), controller: _current, obscureText: true, decoration: InputDecoration(labelText: s.t('currentPassword')),
              validator: (v) => (v ?? '').isEmpty ? s.t('required') : null),
          const SizedBox(height: 12),
          TextFormField(key: const Key('cp-new'), controller: _next, obscureText: true, decoration: InputDecoration(labelText: s.t('newPassword'), helperText: s.t('passwordRule')),
              validator: (v) => passwordProblem(v ?? '') ? s.t('passwordRule') : null),
          const SizedBox(height: 12),
          TextFormField(key: const Key('cp-confirm'), controller: _confirm, obscureText: true, decoration: InputDecoration(labelText: s.t('confirmPassword')),
              validator: (v) => v != _next.text ? s.t('passwordsDiffer') : null),
          const SizedBox(height: 20),
          FilledButton(key: const Key('cp-submit'), onPressed: _busy ? null : _submit, child: _busy ? const CircularProgressIndicator() : Text(s.t('save'))),
        ]),
      ),
    );
  }
}
