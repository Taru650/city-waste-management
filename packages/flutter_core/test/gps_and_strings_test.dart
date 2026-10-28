import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeLocation implements LocationSource {
  FakeLocation(this.next);
  Object next;
  @override
  Future<GeoFix> current() async => next is GeoFix ? next as GeoFix : throw next;
}

GeoFix fix({double acc = 8, bool mocked = false}) => GeoFix(lat: 21, lng: 81, accuracyM: acc, isMocked: mocked);

Widget host(Widget child, String lang) => MaterialApp(
      locale: Locale(lang),
      supportedLocales: const [Locale('hi'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  test('capture gate: precise real fixes pass; mocked or imprecise fixes are blocked', () {
    const gate = CaptureGate();
    expect(gate.check(fix()).accuracyM, 8);
    expect(() => gate.check(fix(mocked: true)), throwsA(isA<CaptureBlocked>().having((b) => b.reason, 'reason', BlockReason.mockLocation)));
    expect(() => gate.check(fix(acc: 80)), throwsA(isA<CaptureBlocked>().having((b) => b.reason, 'reason', BlockReason.inaccurate)));
  });

  testWidgets('GPS chip explains the state in Hindi and English, and the gate opens only when ready', (tester) async {
    final source = FakeLocation(fix(mocked: true));
    final ctrl = GpsGateController(source, interval: const Duration(hours: 1));
    await tester.pumpWidget(host(GpsStatusChip(ctrl), 'en'));
    ctrl.start();
    await tester.pumpAndSettle();
    expect(find.text('Fake location app detected. Turn it off to continue.'), findsOneWidget);
    expect(ctrl.ready, isFalse);

    source.next = fix(acc: 120);
    ctrl.start();
    await tester.pumpAndSettle();
    expect(find.textContaining('120'), findsOneWidget);

    source.next = CaptureBlocked(BlockReason.permissionDenied);
    ctrl.start();
    await tester.pumpAndSettle();
    expect(find.text('Allow location access to take photos'), findsOneWidget);

    source.next = fix(acc: 7);
    ctrl.start();
    await tester.pumpAndSettle();
    expect(ctrl.ready, isTrue);
    await tester.pumpWidget(host(GpsStatusChip(ctrl), 'hi'));
    expect(find.text('लोकेशन 7 मीटर तक सटीक'), findsOneWidget);
    ctrl.dispose();
  });

  test('every English string has a Hindi translation', () {
    expect(S.missingHindi().toList(), isEmpty);
  });

  test('status chips and timeline labels exist for every status and event', () {
    const s = S('hi');
    for (final st in statusApi.values) {
      expect(s.t('st.$st'), isNot('st.$st'));
    }
    for (final ev in ['CREATE', 'ROUTE', 'ASSIGN', 'START', 'RESOLVE', 'REJECT', 'MARK_DUPLICATE', 'CLOSE', 'REOPEN', 'AUTO_CLOSE', 'SLA_BREACH', 'ESCALATE']) {
      expect(s.t('ev.$ev'), isNot('ev.$ev'));
    }
  });

  test('passwordProblem mirrors the API basic rule', () {
    expect(passwordProblem('short1'), isTrue);
    expect(passwordProblem('onlyletters'), isTrue);
    expect(passwordProblem('12345678'), isTrue);
    expect(passwordProblem('Ganga2026'), isFalse);
    expect(passwordProblem('a1' * 65), isTrue, reason: 'over 128 characters');
  });

  test('device integrity: missing native channel (iOS/desktop) does not block; a native report is passed through', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    expect((await const NativeDeviceIntegrity().check()).compromised, isFalse);
    const ch = MethodChannel('org.citywaste/device_integrity');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(ch, (call) async => {'compromised': true, 'reasons': ['found /sbin/su']});
    addTearDown(() => messenger.setMockMethodCallHandler(ch, null));
    final r = await const NativeDeviceIntegrity().check();
    expect(r.compromised, isTrue);
    expect(r.reasons, ['found /sbin/su']);
  });
}
