import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final _mobileRe = RegExp(r'^[6-9]\d{9}$');
final _emailRe = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');

/// SRS fields: District → ULB → Ward (cascading), name, father/husband name, mobile, email, password.
class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key});
  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _guardian = TextEditingController();
  final _mobile = TextEditingController();
  final _email = TextEditingController();
  final _pw = TextEditingController();
  final _pw2 = TextEditingController();
  List<NamedItem> _districts = [], _ulbs = [], _wards = [];
  String? _districtId, _ulbId, _wardId, _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    ref.read(mastersRepoProvider).districts().then((d) => mounted ? setState(() => _districts = d) : null).catchError((Object e) {
      if (mounted) setState(() => _error = '$e');
    });
  }

  Future<void> _pickDistrict(String? id) async {
    setState(() {
      _districtId = id;
      _ulbId = null;
      _wardId = null;
      _ulbs = [];
      _wards = [];
    });
    if (id != null) {
      final u = await ref.read(mastersRepoProvider).ulbs(id);
      if (mounted) setState(() => _ulbs = u);
    }
  }

  Future<void> _pickUlb(String? id) async {
    setState(() {
      _ulbId = id;
      _wardId = null;
      _wards = [];
    });
    if (id != null) {
      final w = await ref.read(mastersRepoProvider).wards(id);
      if (mounted) setState(() => _wards = w);
    }
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(authRepoProvider).registerCitizen(
            homeWardId: _wardId!, name: _name.text.trim(), guardianName: _guardian.text.trim(),
            mobile: _mobile.text.trim(), email: _email.text.trim(), password: _pw.text,
          );
      await ref.read(sessionProvider.notifier).registered();
      if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    String? req(String? v) => (v ?? '').trim().isEmpty ? s.t('required') : null;
    DropdownButtonFormField<String> dropdown(String key, String label, String? value, List<NamedItem> items, ValueChanged<String?> onChanged) =>
        DropdownButtonFormField<String>(
          key: Key(key), initialValue: value, isExpanded: true, decoration: InputDecoration(labelText: label),
          items: [for (final i in items) DropdownMenuItem(value: i.id, child: Text(i.label(s.lang)))],
          onChanged: onChanged, validator: (v) => v == null ? s.t('required') : null,
        );

    return Scaffold(
      appBar: AppBar(title: Text(s.t('register'))),
      body: SafeArea(
        child: Form(
          key: _form,
          child: ListView(padding: const EdgeInsets.all(20), children: [
            if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(_error!, key: const Key('register-error'), style: const TextStyle(color: Colors.red))),
            dropdown('district', s.t('district'), _districtId, _districts, _pickDistrict),
            const SizedBox(height: 12),
            dropdown('ulb', s.t('ulb'), _ulbId, _ulbs, _pickUlb),
            const SizedBox(height: 12),
            dropdown('ward', s.t('ward'), _wardId, _wards, (v) => setState(() => _wardId = v)),
            Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Text(s.t('homeWardNote'), style: Theme.of(context).textTheme.bodySmall)),
            TextFormField(key: const Key('name'), controller: _name, decoration: InputDecoration(labelText: s.t('name')), validator: (v) => (v ?? '').trim().length < 2 ? s.t('required') : null),
            const SizedBox(height: 12),
            TextFormField(key: const Key('guardian'), controller: _guardian, decoration: InputDecoration(labelText: s.t('guardianName'))),
            const SizedBox(height: 12),
            TextFormField(
              key: const Key('mobile'), controller: _mobile, keyboardType: TextInputType.phone, maxLength: 10,
              decoration: InputDecoration(labelText: s.t('mobile'), prefixText: '+91 '),
              validator: (v) => _mobileRe.hasMatch((v ?? '').trim()) ? null : s.t('invalidMobile'),
            ),
            TextFormField(
              key: const Key('email'), controller: _email, keyboardType: TextInputType.emailAddress, decoration: InputDecoration(labelText: s.t('email')),
              validator: (v) => _emailRe.hasMatch((v ?? '').trim()) ? null : s.t('invalidEmail'),
            ),
            const SizedBox(height: 12),
            TextFormField(
              key: const Key('reg-password'), controller: _pw, obscureText: true,
              decoration: InputDecoration(labelText: s.t('password'), helperText: s.t('passwordRule')),
              validator: (v) {
                final p = v ?? '';
                if (passwordProblem(p)) return s.t('passwordRule');
                return req(v);
              },
            ),
            const SizedBox(height: 12),
            TextFormField(
              key: const Key('reg-password2'), controller: _pw2, obscureText: true, decoration: InputDecoration(labelText: s.t('confirmPassword')),
              validator: (v) => v == _pw.text ? null : s.t('passwordsDiffer'),
            ),
            const SizedBox(height: 20),
            FilledButton(key: const Key('register-submit'), onPressed: _busy ? null : _submit, child: _busy ? const CircularProgressIndicator() : Text(s.t('register'))),
          ]),
        ),
      ),
    );
  }
}
