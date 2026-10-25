import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

import '../api/api_exception.dart';
import '../api/repositories.dart';

/// A push received while the app is open, or the one the user tapped to open it.
class PushMessage {
  const PushMessage({this.title, this.body, this.complaintId});
  final String? title;
  final String? body;
  final String? complaintId;
}

/// The push transport (Firebase Cloud Messaging in the apps, a fake in tests).
abstract class PushClient {
  Future<bool> requestPermission();
  Future<String?> token();
  Stream<String> get tokenRefresh;
  Stream<PushMessage> get foreground;
  Stream<PushMessage> get opened;
  Future<PushMessage?> initialMessage();
  Future<void> deleteToken();
}

/// Firebase project settings passed with `--dart-define` (no google-services.json in the repo):
/// FIREBASE_API_KEY, FIREBASE_APP_ID, FIREBASE_SENDER_ID, FIREBASE_PROJECT_ID. Without them the
/// apps run without push and rely on the in-app notification inbox.
class FirebaseSettings {
  const FirebaseSettings({required this.apiKey, required this.appId, required this.senderId, required this.projectId});
  final String apiKey;
  final String appId;
  final String senderId;
  final String projectId;

  static FirebaseSettings? fromEnvironment() {
    const apiKey = String.fromEnvironment('FIREBASE_API_KEY');
    const appId = String.fromEnvironment('FIREBASE_APP_ID');
    const senderId = String.fromEnvironment('FIREBASE_SENDER_ID');
    const projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
    if (apiKey.isEmpty || appId.isEmpty || senderId.isEmpty || projectId.isEmpty) return null;
    return const FirebaseSettings(apiKey: apiKey, appId: appId, senderId: senderId, projectId: projectId);
  }
}

PushMessage _fromRemote(RemoteMessage m) =>
    PushMessage(title: m.notification?.title, body: m.notification?.body, complaintId: m.data['complaintId'] as String?);

/// Uses FCM *registration tokens* (getToken / onTokenRefresh / deleteToken), which is what the API's
/// FCM HTTP v1 sender targets. firebase_messaging 17 deprecates them in favour of Installation-ID
/// "direct send" (register / onRegistered); migrating needs the server side changed and verified
/// against a real Firebase project at the same time, so it is a tracked follow-up, not done blind.
// ignore_for_file: deprecated_member_use
class FirebasePushClient implements PushClient {
  FirebasePushClient._(this._fm);
  final FirebaseMessaging _fm;

  /// Initialises Firebase; null when the build has no Firebase settings or init fails.
  static Future<FirebasePushClient?> create(FirebaseSettings? s) async {
    if (s == null) return null;
    try {
      await Firebase.initializeApp(options: FirebaseOptions(apiKey: s.apiKey, appId: s.appId, messagingSenderId: s.senderId, projectId: s.projectId));
      return FirebasePushClient._(FirebaseMessaging.instance);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<bool> requestPermission() async {
    final r = await _fm.requestPermission();
    return r.authorizationStatus == AuthorizationStatus.authorized || r.authorizationStatus == AuthorizationStatus.provisional;
  }

  @override
  Future<String?> token() => _fm.getToken();
  @override
  Stream<String> get tokenRefresh => _fm.onTokenRefresh;
  @override
  Stream<PushMessage> get foreground => FirebaseMessaging.onMessage.map(_fromRemote);
  @override
  Stream<PushMessage> get opened => FirebaseMessaging.onMessageOpenedApp.map(_fromRemote);
  @override
  Future<PushMessage?> initialMessage() async {
    final m = await _fm.getInitialMessage();
    return m == null ? null : _fromRemote(m);
  }

  @override
  Future<void> deleteToken() => _fm.deleteToken();
}

/// Keeps the server's list of push tokens for this install in step with the session: registered
/// after sign-in (and whenever FCM rotates it), removed at sign-out so the next user of a shared
/// phone never receives the previous user's notifications.
class PushRegistrar {
  PushRegistrar(this.client, this.notifications, {this.platform = 'ANDROID'});
  final PushClient? client;
  final NotificationsRepository notifications;
  final String platform;
  String? _registered;
  StreamSubscription<String>? _refresh;

  String? get registeredToken => _registered;

  Future<void> start() async {
    final c = client;
    if (c == null) return;
    try {
      if (!await c.requestPermission()) return;
      final t = await c.token();
      if (t != null) await _send(t);
      await _refresh?.cancel();
      _refresh = c.tokenRefresh.listen((t) => _send(t).catchError((_) {}));
    } catch (_) {
      // Push is best-effort; the in-app inbox still works.
    }
  }

  Future<void> _send(String token) async {
    await notifications.registerPushToken(token, platform);
    _registered = token;
  }

  /// Must run while the session is still valid (the removal is an authenticated call).
  Future<void> stop() async {
    await _refresh?.cancel();
    _refresh = null;
    final t = _registered;
    _registered = null;
    if (t != null) {
      try {
        await notifications.removePushToken(t);
      } on ApiException {
        // offline: the token is deleted below, so FCM stops delivering to it anyway
      }
    }
    try {
      await client?.deleteToken();
    } catch (_) {}
  }
}
