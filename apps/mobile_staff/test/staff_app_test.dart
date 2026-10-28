import 'package:cwm_staff/main.dart';
import 'package:cwm_staff/screens/task_detail_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

/// Lets real file I/O (captures) and fake-async work (widgets, HTTP fakes) both make progress.
Future<void> settleIo(WidgetTester t) async {
  for (var i = 0; i < 30; i++) {
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await t.pump(const Duration(milliseconds: 20));
  }
  await t.pumpAndSettle();
}

Future<void> signIn(WidgetTester t, {String password = 'Swachh#2026'}) async {
  await t.enterText(find.byKey(const Key('identifier')), '9876500001');
  await t.enterText(find.byKey(const Key('password')), password);
  await t.tap(find.byKey(const Key('login-submit')));
  await t.pumpAndSettle();
}

Future<void> openTask(WidgetTester t) async {
  await t.tap(find.byKey(const Key('complaint-c1')));
  await t.pumpAndSettle();
}

Future<void> tapVisible(WidgetTester t, Finder f) async {
  await t.ensureVisible(f);
  await t.pumpAndSettle();
  await t.tap(f);
  await t.pumpAndSettle();
}

void main() {

  testWidgets('a rooted phone is refused before the login screen', (t) async {
    final env = TestEnv(StaffBackend(), rooted: true);
    await t.pumpWidget(env.app(const StaffApp()));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('device-unsafe')), findsOneWidget);
    expect(find.byKey(const Key('login-submit')), findsNothing);
  });

  testWidgets('administrators (MFA accounts) and citizens are sent to the right app', (t) async {
    final env = TestEnv(StaffBackend());
    await t.pumpWidget(env.app(const StaffApp()));
    await t.pumpAndSettle();
    await signIn(t, password: 'admin');
    expect(find.byKey(const Key('login-error')), findsOneWidget);
    expect(env.store.tokens, isNull, reason: 'no session is stored for an MFA account');

    env.backend.role = 'CITIZEN';
    await signIn(t);
    expect(find.byKey(const Key('wrong-app')), findsOneWidget);
    expect(find.textContaining('citizens'), findsOneWidget);
  });

  testWidgets('temporary password: no device registration until the password is changed', (t) async {
    final env = TestEnv(StaffBackend(mustChange: true));
    await t.pumpWidget(env.app(const StaffApp()));
    await t.pumpAndSettle();
    await signIn(t);
    expect(find.byKey(const Key('cp-submit')), findsOneWidget);
    expect(env.backend.bodiesOf('POST /devices'), isEmpty, reason: 'the API refuses /devices while a temporary password is set');

    await t.enterText(find.byKey(const Key('cp-current')), 'Temp#1234');
    await t.enterText(find.byKey(const Key('cp-new')), 'short');
    await t.tap(find.byKey(const Key('cp-submit')));
    await t.pumpAndSettle();
    expect(env.backend.bodiesOf('POST /auth/change-password'), isEmpty, reason: 'weak password is caught on the phone');

    await t.enterText(find.byKey(const Key('cp-new')), 'Ganga#2026x');
    await t.enterText(find.byKey(const Key('cp-confirm')), 'Ganga#2026x');
    await t.tap(find.byKey(const Key('cp-submit')));
    await t.pumpAndSettle();
    expect(env.backend.bodiesOf('POST /auth/change-password').single, {'currentPassword': 'Temp#1234', 'newPassword': 'Ganga#2026x'});
    expect(env.backend.bodiesOf('POST /devices'), hasLength(1));
    expect(env.store.tokens!.accessToken, 'a2', reason: 'the rotated session from change-password is kept');
    expect(find.byKey(const Key('complaint-c1')), findsOneWidget);
  });

  testWidgets('worker: open tasks, navigate, start work needs a photo and sends signed proof with location', (t) async {
    final env = TestEnv(StaffBackend(), signedIn: true);
    await t.pumpWidget(env.app(const StaffApp()));
    await t.pumpAndSettle();
    expect(env.backend.queries.first['open'], 'true');
    expect(find.byKey(const Key('filter-pending')), findsNothing, reason: 'status filters are for supervisors');

    await openTask(t);
    expect(find.byKey(const Key('assign')), findsNothing);
    expect(find.byKey(const Key('reject')), findsNothing);
    expect(find.byKey(const Key('resolve')), findsNothing, reason: 'a worker resolves only after starting');

    await tapVisible(t, find.byKey(const Key('navigate')));
    expect(env.navigations.single, (25.005, 80.005));

    await tapVisible(t, find.byKey(const Key('start-work')));
    await t.tap(find.byKey(const Key('proof-submit')));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('proof-message')), findsOneWidget);

    await t.tap(find.byKey(const Key('capture')));
    await settleIo(t);
    await t.tap(find.byKey(const Key('proof-submit')));
    await settleIo(t);

    final start = env.backend.bodiesOf('POST /complaints/c1/start').single as Map;
    expect(start['mediaIds'], ['m1']);
    expect(start['location'], {'lat': 25.0051, 'lng': 80.0052, 'accuracyM': 7.0});
    final confirm = env.backend.bodiesOf('POST /media/m1/confirm').single as Map;
    expect(confirm['signature'], isNotEmpty);
    expect(find.byKey(const Key('resolve')), findsOneWidget, reason: 'detail reloads as WORK_IN_PROGRESS');
    expect(env.outboxStorage.saved, isEmpty);
  });

  testWidgets('worker offline: resolution is queued, buttons hidden, and sent when back online', (t) async {
    final env = TestEnv(StaffBackend(status: 'WORK_IN_PROGRESS'), signedIn: true);
    await t.pumpWidget(env.app(const StaffApp()));
    await t.pumpAndSettle();
    await openTask(t);
    env.backend.offline = true;

    await tapVisible(t, find.byKey(const Key('resolve')));
    await t.tap(find.byKey(const Key('capture')));
    await settleIo(t);
    await t.enterText(find.byKey(const Key('remark')), 'ok');
    await t.tap(find.byKey(const Key('proof-submit')));
    await t.pumpAndSettle();
    expect(find.text('Write at least 5 characters'), findsOneWidget, reason: 'API needs a 5+ character remark');

    await t.enterText(find.byKey(const Key('remark')), 'Heap cleared and lime sprinkled');
    await t.tap(find.byKey(const Key('proof-submit')));
    await settleIo(t);
    expect(env.outboxStorage.saved, hasLength(1));
    expect(find.byKey(const Key('queued-here')), findsOneWidget);
    expect(find.byKey(const Key('resolve')), findsNothing, reason: 'no double submission while queued');

    env.backend.offline = false;
    await t.tap(find.descendant(of: find.byKey(const Key('queued-here')), matching: find.byIcon(Icons.refresh)));
    await settleIo(t);
    final resolve = env.backend.bodiesOf('POST /complaints/c1/resolve').last as Map;
    expect(resolve['remark'], 'Heap cleared and lime sprinkled');
    expect(resolve['mediaIds'], hasLength(1));
    expect(env.outboxStorage.saved, isEmpty);
    expect(find.byKey(const Key('queued-here')), findsNothing);
  });

  testWidgets('supervisor: status filters, assign a worker, reject needs a reason', (t) async {
    final env = TestEnv(StaffBackend(role: 'SUPERVISOR', status: 'PENDING'), signedIn: true);
    await t.pumpWidget(env.app(const StaffApp()));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('filter-pending')));
    await t.pumpAndSettle();
    expect(env.backend.queries.last['status'], 'PENDING');

    await openTask(t);
    expect(find.byKey(const Key('start-work')), findsNothing, reason: 'nothing to start before a worker is assigned');
    await tapVisible(t, find.byKey(const Key('assign')));
    expect(find.textContaining('3 open'), findsOneWidget);
    await t.tap(find.byKey(const Key('worker-wk2')));
    await t.pumpAndSettle();
    expect(env.backend.bodiesOf('POST /complaints/c1/assign').single, {'workerId': 'wk2'});

    await tapVisible(t, find.byKey(const Key('reject')));
    await t.enterText(find.byKey(const Key('reject-reason')), 'dup');
    await t.tap(find.byKey(const Key('reject-confirm')));
    await t.pumpAndSettle();
    expect(env.backend.bodiesOf('POST /complaints/c1/reject'), isEmpty);
    await t.enterText(find.byKey(const Key('reject-reason')), 'Private property, not a public spot');
    await t.tap(find.byKey(const Key('reject-confirm')));
    await t.pumpAndSettle();
    expect(env.backend.bodiesOf('POST /complaints/c1/reject').single, {'reason': 'Private property, not a public spot'});
    expect(find.text('Rejected'), findsWidgets);
  });

  testWidgets('a complaint from an event zone says so on the task screen', (t) async {
    final env = TestEnv(StaffBackend(role: 'SUPERVISOR', zone: 'Rajim Mela'), signedIn: true);
    await t.pumpWidget(env.app(const StaffApp()));
    await t.pumpAndSettle();
    await openTask(t);
    expect(find.text('Event: Rajim Mela'), findsOneWidget);
  });

  testWidgets('push: token registered at sign-in; a new-task push refreshes the inbox; a tapped push opens the task; sign-out removes the token', (t) async {
    final env = TestEnv(StaffBackend());
    await t.pumpWidget(env.app(const StaffApp()));
    await t.pumpAndSettle();
    await signIn(t);
    await settleIo(t); // registration runs in the background after sign-in
    expect(env.backend.bodiesOf('POST /notifications/push-tokens').single, {'token': env.push.currentToken, 'platform': 'ANDROID'});

    final before = env.backend.queries.length;
    env.push.foregroundCtl.add(const PushMessage(title: 'New task assigned', complaintId: 'c1'));
    await t.pumpAndSettle();
    expect(find.text('New task assigned'), findsOneWidget);
    expect(env.backend.queries.length, greaterThan(before), reason: 'inbox reloaded');

    env.push.openedCtl.add(const PushMessage(complaintId: 'c1'));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('navigate')), findsOneWidget, reason: 'task detail opened');
    await t.pageBack();
    await t.pumpAndSettle();

    await t.tap(find.text('Profile'));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('logout')));
    await settleIo(t);
    expect(env.backend.bodiesOf('DELETE /notifications/push-tokens').single, {'token': 'fcm-token-0000000000000000000001'});
    expect(env.push.deleted, isTrue);
  });

  test('action matrix mirrors the API state machine', () {
    final w = StaffActions(Role.worker, ComplaintStatus.assigned);
    expect([w.start, w.resolve, w.assign, w.reject], [true, false, false, false]);
    final wip = StaffActions(Role.worker, ComplaintStatus.workInProgress);
    expect([wip.start, wip.resolve], [false, true]);
    final sup = StaffActions(Role.supervisor, ComplaintStatus.reopened);
    expect([sup.start, sup.resolve, sup.assign, sup.reject], [true, true, true, true]);
    final closed = StaffActions(Role.supervisor, ComplaintStatus.resolved);
    expect([closed.start, closed.resolve, closed.assign, closed.reject], [false, false, false, false]);
  });

  testWidgets('sign-out with unsent proof warns, then deletes the queue so the next user cannot send it', (t) async {
    final env = TestEnv(StaffBackend(status: 'WORK_IN_PROGRESS'), signedIn: true);
    await t.pumpWidget(env.app(const StaffApp()));
    await t.pumpAndSettle();
    await openTask(t);
    env.backend.offline = true;
    await tapVisible(t, find.byKey(const Key('resolve')));
    await t.tap(find.byKey(const Key('capture')));
    await settleIo(t);
    await t.enterText(find.byKey(const Key('remark')), 'Heap cleared fully');
    await t.tap(find.byKey(const Key('proof-submit')));
    await settleIo(t);
    expect(env.outboxStorage.saved, hasLength(1));

    await t.pageBack();
    await t.pumpAndSettle();
    await t.tap(find.text('Profile'));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('logout')));
    await t.pumpAndSettle();
    expect(find.byKey(const Key('unsent-warning')), findsOneWidget);
    await t.tap(find.text('Cancel'));
    await t.pumpAndSettle();
    expect(env.outboxStorage.saved, hasLength(1));

    await t.tap(find.byKey(const Key('logout')));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('confirm-signout')));
    await settleIo(t);
    expect(env.outboxStorage.saved, isEmpty);
    expect(env.dir.listSync(), isEmpty, reason: 'capture files are deleted too');
    expect(env.store.tokens, isNull);
    expect(find.byKey(const Key('login-submit')), findsOneWidget);
  });
}
