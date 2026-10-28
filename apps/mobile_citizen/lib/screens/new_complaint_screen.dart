import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Report a problem: camera captures first (they carry the location), then the ward detected
/// from GPS (any ward/ULB, not the home ward), type, landmark and description.
class NewComplaintScreen extends ConsumerStatefulWidget {
  const NewComplaintScreen({super.key});
  @override
  ConsumerState<NewComplaintScreen> createState() => _NewComplaintScreenState();
}

class _NewComplaintScreenState extends ConsumerState<NewComplaintScreen> {
  final _form = GlobalKey<FormState>();
  final _landmark = TextEditingController();
  final _desc = TextEditingController();
  final List<CapturedMedia> _captures = [];
  List<NamedItem> _types = [];
  String? _typeId;
  LocateResult? _located;
  bool _locating = false, _noWard = false, _busy = false;
  String? _manualWardId, _message;

  @override
  void initState() {
    super.initState();
    ref.read(mastersRepoProvider).complaintTypes().then((t) => mounted ? setState(() => _types = t) : null).catchError((_) {});
  }

  int get _videos => _captures.where((c) => c.kind == MediaKind.video).length;

  Future<void> _capture() async {
    final media = await ref.read(captureLauncherProvider)(context, allowVideo: _videos == 0);
    if (media == null || !mounted) return;
    setState(() => _captures.add(media));
    if (_captures.length == 1) await _locate(media.fix);
  }

  Future<void> _locate(GeoFix fix) async {
    setState(() => _locating = true);
    try {
      final r = await ref.read(mastersRepoProvider).locate(fix.lat, fix.lng);
      setState(() {
        _located = r;
        _noWard = r == null;
      });
    } catch (_) {
      setState(() => _noWard = false); // offline: the server detects the ward from GPS when the complaint is sent
    } finally {
      if (mounted) setState(() => _locating = false);
    }
  }

  Future<void> _submit() async {
    final s = S.of(context);
    if (_captures.isEmpty) return setState(() => _message = s.t('photosNeeded'));
    if (!_form.currentState!.validate()) return;
    if (_noWard && _manualWardId == null) return setState(() => _message = s.t('noWardDetected'));
    setState(() {
      _busy = true;
      _message = null;
    });
    final fix = _captures.first.fix;
    final box = await ref.read(outboxProvider.future);
    await box.enqueue(kind: OutboxKind.createComplaint, payload: {
      'typeId': _typeId, 'lat': fix.lat, 'lng': fix.lng, 'accuracyM': fix.accuracyM,
      if (_manualWardId != null) 'wardId': _manualWardId,
      'landmark': _landmark.text.trim(), 'description': _desc.text.trim(),
    }, captures: List.of(_captures));
    final r = await box.run();
    if (!mounted) return;
    setState(() => _busy = false);
    final failed = box.items.where((i) => i.state != OutboxState.pending).firstOrNull;
    if (r.completed > 0) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.t('submitted'))));
      Navigator.pop(context);
    } else if (failed != null) {
      setState(() => _message = s.t('uploadFailed', {'reason': failed.lastError ?? ''}));
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.t('queuedOffline'))));
      Navigator.pop(context);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.t('newComplaint'))),
      body: SafeArea(
        child: Form(
          key: _form,
          child: ListView(padding: const EdgeInsets.all(16), children: [
            Text(s.t('cameraOnly'), style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 8),
            CaptureStrip(captures: _captures, onCapture: _capture, onRemove: (c) => setState(() => _captures.remove(c))),
            const SizedBox(height: 12),
            if (_locating) const LinearProgressIndicator(),
            if (_located != null)
              ListTile(
                key: const Key('detected-ward'),
                leading: const Icon(Icons.place, color: Colors.green),
                title: Text(s.t('detectedWard', {'ulb': _located!.ulbName, 'ward': _located!.wardNumber})),
                subtitle: Text(_located!.districtName),
              ),
            if (_noWard) ...[
              Text(s.t('noWardDetected'), key: const Key('no-ward'), style: const TextStyle(color: Colors.orange)),
              const SizedBox(height: 8),
              WardPicker(onChanged: (id) => setState(() => _manualWardId = id)),
            ],
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              key: const Key('type'), initialValue: _typeId, isExpanded: true, decoration: InputDecoration(labelText: s.t('type')),
              items: [for (final t in _types) DropdownMenuItem(value: t.id, child: Text(t.label(s.lang)))],
              onChanged: (v) => setState(() => _typeId = v), validator: (v) => v == null ? s.t('required') : null,
            ),
            const SizedBox(height: 12),
            TextFormField(key: const Key('landmark'), controller: _landmark, maxLength: 50, decoration: InputDecoration(labelText: s.t('landmark'))),
            TextFormField(
              key: const Key('description'), controller: _desc, maxLength: 250, maxLines: 3, decoration: InputDecoration(labelText: s.t('description')),
              validator: (v) => (v ?? '').trim().length < 5 ? s.t('required') : null,
            ),
            if (_message != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_message!, key: const Key('form-message'), style: const TextStyle(color: Colors.red))),
            FilledButton(key: const Key('submit'), onPressed: _busy ? null : _submit, child: _busy ? const CircularProgressIndicator() : Text(s.t('submit'))),
          ]),
        ),
      ),
    );
  }
}

/// District → ULB → Ward, for places without a mapped ward boundary.
class WardPicker extends ConsumerStatefulWidget {
  const WardPicker({super.key, required this.onChanged});
  final ValueChanged<String?> onChanged;
  @override
  ConsumerState<WardPicker> createState() => _WardPickerState();
}

class _WardPickerState extends ConsumerState<WardPicker> {
  List<NamedItem> _d = [], _u = [], _w = [];
  String? _di, _ui, _wi;

  @override
  void initState() {
    super.initState();
    ref.read(mastersRepoProvider).districts().then((v) => mounted ? setState(() => _d = v) : null).catchError((_) {});
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final m = ref.read(mastersRepoProvider);
    Widget dd(String label, String? v, List<NamedItem> items, ValueChanged<String?> f) => Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: DropdownButtonFormField<String>(
            initialValue: v, isExpanded: true, decoration: InputDecoration(labelText: label),
            items: [for (final i in items) DropdownMenuItem(value: i.id, child: Text(i.label(s.lang)))], onChanged: f,
          ),
        );
    return Column(children: [
      dd(s.t('district'), _di, _d, (v) async {
        setState(() {
          _di = v;
          _ui = null;
          _wi = null;
          _u = [];
          _w = [];
        });
        widget.onChanged(null);
        if (v != null) _u = await m.ulbs(v);
        if (mounted) setState(() {});
      }),
      dd(s.t('ulb'), _ui, _u, (v) async {
        setState(() {
          _ui = v;
          _wi = null;
          _w = [];
        });
        widget.onChanged(null);
        if (v != null) _w = await m.wards(v);
        if (mounted) setState(() {});
      }),
      dd(s.t('ward'), _wi, _w, (v) {
        setState(() => _wi = v);
        widget.onChanged(v);
      }),
    ]);
  }
}
