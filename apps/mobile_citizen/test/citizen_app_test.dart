import 'package:cwm_citizen/main.dart';
import 'package:cwm_citizen/screens/complaint_detail_screen.dart';
import 'package:cwm_citizen/screens/new_complaint_screen.dart';
import 'package:cwm_citizen/screens/register_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

/// Hosts [w] on a pushed route above a placeholder, as in the app, so Navigator.pop and
/// snack bars behave like they do for real users.
Widget screen(Widget w) => MaterialApp(
      locale: const Locale('en'),
      supportedLocales: supportedAppLocales,
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: Builder(builder: (context) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (Navigator.of(context).canPop()) return;
          Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => w));
        });
        return const Scaffold(body: Text('previous screen'));
      }),
    );

/// Scrolls the page's list until [finder] is built (ListView builds children lazily).
Future<void> reveal(WidgetTester t, Finder finder) async {
  final list = find.byType(ListView).first;
  // Try scrolling back up first (already-passed widgets), then down.
  for (var i = 0; i < 15 && finder.evaluate().isEmpty; i++) {
    await t.drag(list, const Offset(0, 300));
    await t.pump();
  }
  if (finder.evaluate().isEmpty) await t.dragUntilVisible(finder, list, const Offset(0, -150));
  await t.ensureVisible(finder);
  await t.pumpAndSettle();
}

/// Lets real file I/O (captures) and fake-async work (widgets, HTTP fakes) both make progress.
Future<void> settleIo(WidgetTester t) async {
  for (var i = 0; i < 30; i++) {
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await t.pump(const Duration(milliseconds: 20));
  }
  await t.pumpAndSettle();
}

Future<void> pick(WidgetTester t, String key, String item) async {
  await reveal(t, find.byKey(Key(key)));
  await t.pumpAndSettle();
  await t.tap(find.byKey(Key(key)));
  await t.pumpAndSettle();
  await t.tap(find.text(item).last);
  await t.pumpAndSettle();
}

void main() {
  testWidgets('starts in Hindi; the language toggle switches to English', (t) async {
    final env = await TestEnv.create();
    await t.pumpWidget(env.app(const CitizenApp()));
    await t.pumpAndSettle();
    expect(find.text('लॉग इन करें'), findsWidgets);
    await t.tap(find.byKey(const Key('lang-toggle')));
    await t.pumpAndSettle();
    expect(find.text('Sign in'), findsWidgets);
  });

  testWidgets('wrong password shows the server message; correct password opens my complaints and registers the device key', (t) async {
    final env = await TestEnv.create();
    await t.pumpWidget(env.app(const CitizenApp()));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('identifier')), '9876543210');
    await t.enterText(find.byKey(const Key('password')), 'wrong');
    await t.tap(find.byKey(const Key('login-submit')));
    await t.pumpAndSettle();
    expect(find.text('Invalid credentials'), findsOneWidget);

    await t.enterText(find.byKey(const Key('password')), 'Swachh#2026');
    await t.tap(find.byKey(const Key('login-submit')));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('complaint-c1')), findsOneWidget);
    expect(env.backend.bodiesOf('POST /devices').single, containsPair('publicKey', isNotEmpty));
  });

  testWidgets('staff accounts are told to use the Staff app', (t) async {
    final env = await TestEnv.create(signedIn: true);
    env.backend.on('GET /auth/me', (_, _) => (200, meJson(role: 'WORKER')));
    await t.pumpWidget(env.app(const CitizenApp()));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('citizen-only')), findsOneWidget);
  });

  testWidgets('registration validates fields and sends the chosen home ward', (t) async {
    final env = await TestEnv.create();
    await t.pumpWidget(env.app(screen(const RegisterScreen())));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('mobile')), '12345');
    await t.enterText(find.byKey(const Key('email')), 'not-an-email');
    await t.enterText(find.byKey(const Key('reg-password')), 'short');
    await reveal(t, find.byKey(const Key('register-submit')));
    await t.tap(find.byKey(const Key('register-submit')));
    await t.pumpAndSettle();
    expect(find.text('Enter a 10-digit mobile number'), findsOneWidget);
    expect(find.text('Enter a valid email'), findsOneWidget);
    expect(env.backend.bodiesOf('POST /auth/register'), isEmpty);

    env.backend.on('POST /auth/register', (_, _) => (201, {'accessToken': 'a', 'refreshToken': 'r', 'expiresIn': 900}));
    await pick(t, 'district', 'Raipur');
    await pick(t, 'ulb', 'Nagar Nigam Alpha');
    await pick(t, 'ward', 'Ward 2');
    await t.enterText(find.byKey(const Key('name')), 'Asha Devi');
    await t.enterText(find.byKey(const Key('mobile')), '9876543210');
    await t.enterText(find.byKey(const Key('email')), 'asha@example.in');
    await t.enterText(find.byKey(const Key('reg-password')), 'Swachh#2026');
    await t.enterText(find.byKey(const Key('reg-password2')), 'Swachh#2026');
    await reveal(t, find.byKey(const Key('register-submit')));
    await t.tap(find.byKey(const Key('register-submit')));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('consent-error')), findsOneWidget);
    expect(env.backend.bodiesOf('POST /auth/register'), isEmpty, reason: 'DPDP: no account without consent');

    await reveal(t, find.byKey(const Key('open-notice')));
    await t.tap(find.byKey(const Key('open-notice')));
    await t.pumpAndSettle();
    expect(find.text('What we collect'), findsOneWidget);
    expect(find.textContaining('go@example.gov.in'), findsOneWidget);
    await t.pageBack();
    await t.pumpAndSettle();
    await reveal(t, find.byKey(const Key('consent')));
    await t.tap(find.byKey(const Key('consent')));
    await reveal(t, find.byKey(const Key('register-submit')));
    await t.tap(find.byKey(const Key('register-submit')));
    await t.pumpAndSettle();
    expect(env.backend.bodiesOf('POST /auth/register').single, {
      'consentNoticeVersion': '2026-10-25', 'consentLanguage': 'en',
      'homeWardId': 'w2', 'name': 'Asha Devi', 'mobile': '9876543210', 'email': 'asha@example.in', 'password': 'Swachh#2026',
    });
  });

  testWidgets('a citizen who has not accepted the current notice must accept it before using the app', (t) async {
    final env = await TestEnv.create(signedIn: true);
    var consented = false;
    env.backend.on('GET /auth/me', (_, _) => (200, meJson(consentRequired: !consented)));
    env.backend.on('POST /privacy/consent', (_, body) {
      consented = true;
      return (200, {'version': (body as Map)['noticeVersion']});
    });
    await t.pumpWidget(env.app(const CitizenApp()));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('consent-required')), findsOneWidget);
    expect(find.byKey(const Key('new-complaint')), findsNothing);
    await t.tap(find.byKey(const Key('consent-accept')));
    await t.pumpAndSettle();
    expect(env.backend.bodiesOf('POST /privacy/consent').single, {'noticeVersion': '2026-10-25', 'language': 'en'});
    expect(find.byKey(const Key('new-complaint')), findsOneWidget);
  });

  testWidgets('profile: my data is shown; deleting the account needs the password, then signs out everywhere', (t) async {
    final env = await TestEnv.create(signedIn: true);
    env.backend.on('GET /privacy/my-data', (_, _) => (200, {'profile': {'name': 'Asha', 'mobile': '9876543210'}, 'complaints': []}));
    env.backend.on('POST /privacy/erasure', (_, body) => (body as Map)['password'] == 'Swachh#2026' ? (204, null) : (400, {'message': 'Password is incorrect'}));
    await t.pumpWidget(env.app(const CitizenApp()));
    await t.pumpAndSettle();
    await t.tap(find.text('Profile'));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('open-my-data')));
    await t.pumpAndSettle();
    expect(find.textContaining('"mobile": "9876543210"'), findsOneWidget);
    await t.pageBack();
    await t.pumpAndSettle();

    await reveal(t, find.byKey(const Key('delete-account')));
    await t.tap(find.byKey(const Key('delete-account')));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('delete-warning')), findsOneWidget);
    await t.enterText(find.byKey(const Key('delete-password')), 'wrong');
    await t.tap(find.byKey(const Key('delete-confirm')));
    await t.pumpAndSettle();
    expect(find.text('Password is incorrect'), findsOneWidget);
    await t.enterText(find.byKey(const Key('delete-password')), 'Swachh#2026');
    await t.tap(find.byKey(const Key('delete-confirm')));
    await t.pumpAndSettle();
    expect(env.store.tokens, isNull);
    expect(find.byKey(const Key('login-submit')), findsOneWidget);
    expect(find.text('Your account has been deleted'), findsOneWidget);
  });

  group('reporting a problem', () {
    Future<void> fill(WidgetTester t) async {
      await pick(t, 'type', 'Garbage heap');
      await t.enterText(find.byKey(const Key('description')), 'Kachra 3 din se pada hai');
      await reveal(t, find.byKey(const Key('submit')));
    }

    testWidgets('requires a camera capture, shows the ward detected from GPS, then uploads and files', (t) async {
      final env = await TestEnv.create(signedIn: true);
      await t.pumpWidget(env.app(screen(const NewComplaintScreen())));
      await t.pumpAndSettle();
      await fill(t);
      await t.tap(find.byKey(const Key('submit')));
      await t.pumpAndSettle();
      expect(find.text('Take at least one photo or video of the problem'), findsOneWidget);

      await t.dragUntilVisible(find.byKey(const Key('capture')), find.byType(ListView).first, const Offset(0, 150));
      await t.tap(find.byKey(const Key('capture')));
      await t.pumpAndSettle();
      expect(find.text('Detected: Nagar Nigam Alpha, Ward 1'), findsOneWidget);
      await reveal(t, find.byKey(const Key('submit')));
      await t.tap(find.byKey(const Key('submit')));
      await settleIo(t);
      final created = env.backend.bodiesOf('POST /complaints').single as Map;
      expect(created['mediaIds'], ['m1']);
      expect(created['typeId'], 't1');
      expect(created.containsKey('wardId'), isFalse); // GPS decides the ward on the server
      expect(env.backend.calls.map((c) => c.$1), containsAllInOrder(['POST /media/upload-url', 'PUT STORAGE', 'POST /media/m1/confirm', 'POST /complaints']));
    });

    testWidgets('without internet the complaint is kept and the user is told it will be sent later', (t) async {
      final env = await TestEnv.create(signedIn: true);
      await t.pumpWidget(env.app(screen(const NewComplaintScreen())));
      await t.pumpAndSettle();
      await t.tap(find.byKey(const Key('capture')));
      await t.pumpAndSettle();
      await fill(t);
      env.backend.offline = true;
      await t.tap(find.byKey(const Key('submit')));
      await settleIo(t);
      expect(find.text('No internet. Saved and will be sent automatically.'), findsOneWidget);
      expect(env.backend.bodiesOf('POST /complaints'), isEmpty);
      expect(env.outboxStorage.saved.single['kind'], 'createComplaint'); // kept for later
    });

    testWidgets('where no ward boundary covers the GPS point, the citizen must choose the ward', (t) async {
      final env = await TestEnv.create(signedIn: true);
      env.backend.on('GET /masters/locate', (_, _) => (404, {'message': 'No ward boundary covers this location'}));
      await t.pumpWidget(env.app(screen(const NewComplaintScreen())));
      await t.pumpAndSettle();
      await t.tap(find.byKey(const Key('capture')));
      await t.pumpAndSettle();
      expect(find.byKey(const Key('no-ward')), findsOneWidget);
      await fill(t);
      await t.tap(find.byKey(const Key('submit')));
      await t.pumpAndSettle();
      expect(find.byKey(const Key('form-message')), findsOneWidget);
      expect(env.backend.bodiesOf('POST /media/upload-url'), isEmpty);
    });
  });

  testWidgets('feedback: reopen is only possible with 1–2 stars; the rating is sent', (t) async {
    final env = await TestEnv.create(signedIn: true);
    env.backend.on('GET /complaints/c1', (_, _) => (200, complaintJson(status: 'RESOLVED', resolvedAt: DateTime.now().toUtc().toIso8601String())));
    env.backend.on('GET /complaints/c1/media', (_, _) => (200, []));
    env.backend.on('POST /complaints/c1/feedback', (_, _) => (201, complaintJson(status: 'REOPENED')));
    await t.pumpWidget(env.app(screen(const ComplaintDetailScreen('c1'))));
    await t.pumpAndSettle();
    await t.ensureVisible(find.byKey(const Key('star-4')));
    await t.tap(find.byKey(const Key('star-4')));
    await t.pumpAndSettle();
    expect(t.widget<CheckboxListTile>(find.byKey(const Key('reopen'))).onChanged, isNull);
    await t.tap(find.byKey(const Key('star-2')));
    await t.pumpAndSettle();
    await t.ensureVisible(find.byKey(const Key('reopen')));
    await t.tap(find.byKey(const Key('reopen')));
    await t.ensureVisible(find.byKey(const Key('feedback-submit')));
    await t.tap(find.byKey(const Key('feedback-submit')));
    await t.pumpAndSettle();
    expect(env.backend.bodiesOf('POST /complaints/c1/feedback').single, {'rating': 2, 'reopen': true});
  });
}
