import 'dart:async';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart';
import '../api/api_exception.dart';
import '../api/repositories.dart';
import '../api/token_store.dart';
import '../capture/camera_screen.dart';
import '../capture/captured_media.dart';
import '../capture/compressor.dart';
import '../capture/geo.dart';
import '../capture/uploader.dart';
import '../config.dart';
import '../models/models.dart';
import '../offline/outbox.dart';
import '../security/device_registry.dart';
import '../security/device_signer.dart';
import '../push/push.dart';
import '../security/attestation.dart';
import '../security/device_integrity.dart';

// Overridable building blocks (tests replace the platform-backed ones).
final configProvider = Provider<CoreConfig>((_) => CoreConfig.fromEnvironment());
final tokenStoreProvider = Provider<TokenStore>((_) => SecureTokenStore());
final signerProvider = Provider<DeviceSigner>((_) => const KeystoreSigner());
final locationProvider = Provider<LocationSource>((_) => const GeolocatorSource());
final compressorProvider = Provider<MediaCompressor>((_) => const NativeCompressor());

final apiClientProvider = Provider<ApiClient>((ref) {
  final c = ApiClient(ref.watch(configProvider), ref.watch(tokenStoreProvider));
  ref.onDispose(c.dispose);
  return c;
});
final integritySourceProvider = Provider<IntegrityTokenSource>((ref) => NativeIntegrity(ref.watch(configProvider).cloudProjectNumber));
final attestorProvider = Provider((ref) => Attestor(ref.watch(apiClientProvider), ref.watch(integritySourceProvider)));
final authRepoProvider = Provider((ref) => AuthRepository(ref.watch(apiClientProvider), attestor: ref.watch(attestorProvider)));
final mastersRepoProvider = Provider((ref) => MastersRepository(ref.watch(apiClientProvider)));
final complaintsRepoProvider = Provider((ref) => ComplaintsRepository(ref.watch(apiClientProvider)));
final notificationsRepoProvider = Provider((ref) => NotificationsRepository(ref.watch(apiClientProvider)));
final staffRepoProvider = Provider((ref) => StaffRepository(ref.watch(apiClientProvider)));
final deviceRegistryProvider = Provider((ref) => DeviceRegistry(ref.watch(apiClientProvider), ref.watch(signerProvider),
    platform: Platform.isIOS ? 'IOS' : 'ANDROID', attestor: ref.watch(attestorProvider)));
final uploaderProvider = Provider((ref) => MediaUploader(ref.watch(apiClientProvider), ref.watch(signerProvider), ref.watch(deviceRegistryProvider)));

/// App-private directory for captures waiting to upload (not the gallery, not shared storage).
final captureDirProvider = FutureProvider<Directory>((_) async {
  final d = Directory('${(await getApplicationSupportDirectory()).path}/captures');
  return d.create(recursive: true);
});

final outboxStorageProvider = FutureProvider<OutboxStorage>((_) async {
  final dir = await getApplicationSupportDirectory();
  return FileOutboxStorage(File('${dir.path}/outbox.json'));
});

final outboxProvider = FutureProvider<Outbox>((ref) async {
  final box = Outbox(await ref.watch(outboxStorageProvider.future), ref.watch(uploaderProvider), ref.watch(complaintsRepoProvider));
  await box.load();
  ref.onDispose(box.dispose);
  return box;
});

/// UI language: Hindi unless the user chose English.
class LocaleNotifier extends Notifier<Locale> {
  @override
  Locale build() => const Locale('hi');
  void set(String lang) => state = Locale(lang == 'en' ? 'en' : 'hi');
}

final localeProvider = NotifierProvider<LocaleNotifier, Locale>(LocaleNotifier.new);

/// The signed-in user (null = signed out). Registers the device key after sign-in.
class SessionNotifier extends AsyncNotifier<Me?> {
  StreamSubscription<void>? _expiry;

  @override
  Future<Me?> build() async {
    final api = ref.watch(apiClientProvider);
    _expiry?.cancel();
    _expiry = api.onSessionExpired.listen((_) => state = const AsyncData(null));
    ref.onDispose(() => _expiry?.cancel());
    if (!await ref.read(authRepoProvider).hasSession()) return null;
    try {
      final me = await _load();
      if (!me.mustChangePassword) _startPush();
      return me;
    } on ApiException catch (e) {
      if (e.isUnauthorized) return null;
      rethrow;
    }
  }

  Future<Me> _load() async {
    final me = await ref.read(authRepoProvider).me();
    ref.read(localeProvider.notifier).set(me.preferredLanguage);
    return me;
  }

  Future<LoginOutcome> login(String identifier, String password) async {
    final outcome = await ref.read(authRepoProvider).login(identifier, password);
    if (outcome == LoginOutcome.ok) {
      final me = await _load();
      // The API refuses everything but the password change while a temporary password is set;
      // the device is registered in passwordChanged() instead.
      if (_capturesMedia(me) && !me.mustChangePassword) await ref.read(deviceRegistryProvider).register();
      if (!me.mustChangePassword) _startPush();
      state = AsyncData(me);
    }
    return outcome;
  }

  Future<void> registered() async {
    final me = await _load();
    await ref.read(deviceRegistryProvider).register();
    _startPush();
    state = AsyncData(me);
  }

  Future<void> refreshMe() async => state = AsyncData(await _load());

  /// After replacing a temporary password: the session is now fully usable.
  Future<void> passwordChanged() async {
    final me = await _load();
    if (_capturesMedia(me)) await ref.read(deviceRegistryProvider).register();
    _startPush();
    state = AsyncData(me);
  }

  /// Best-effort, in the background: sign-in never waits for (or fails because of) push.
  void _startPush() {
    unawaited(ref.read(pushRegistrarProvider.future).then((r) => r.start()).catchError((_) {}));
  }

  static bool _capturesMedia(Me me) => const {Role.citizen, Role.worker, Role.supervisor, Role.subAdmin}.contains(me.role);

  Future<void> logout() async {
    try {
      await (await ref.read(outboxProvider.future)).clear();
    } catch (_) {
      // storage unavailable: nothing to clear
    }
    try {
      // While the session is still valid: this install stops receiving this user's notifications.
      await (await ref.read(pushRegistrarProvider.future)).stop();
    } catch (_) {}
    await ref.read(authRepoProvider).logout();
    await ref.read(deviceRegistryProvider).forget();
    state = const AsyncData(null);
  }
}

final sessionProvider = AsyncNotifierProvider<SessionNotifier, Me?>(SessionNotifier.new);

/// Firebase Cloud Messaging, or null when the build has no Firebase settings (tests override it).
final pushClientProvider = FutureProvider<PushClient?>((ref) => FirebasePushClient.create(FirebaseSettings.fromEnvironment()));
final pushRegistrarProvider = FutureProvider<PushRegistrar>((ref) async =>
    PushRegistrar(await ref.watch(pushClientProvider.future), ref.watch(notificationsRepoProvider), platform: Platform.isIOS ? 'IOS' : 'ANDROID'));

/// Pushes that arrive while the app is open (refresh lists, show a banner).
final foregroundPushProvider = StreamProvider<PushMessage>((ref) async* {
  final c = await ref.watch(pushClientProvider.future);
  if (c != null) yield* c.foreground;
});

/// The push the user tapped to open the app (cold start or from the background).
final openedPushProvider = StreamProvider<PushMessage>((ref) async* {
  final c = await ref.watch(pushClientProvider.future);
  if (c == null) return;
  final first = await c.initialMessage();
  if (first != null) yield first;
  yield* c.opened;
});

/// Opens the in-app camera and returns the capture (null if cancelled). Tests override this.
typedef CaptureLauncher = Future<CapturedMedia?> Function(BuildContext context, {bool allowVideo});

final deviceIntegrityProvider = Provider<DeviceIntegrity>((ref) => const NativeDeviceIntegrity());
final integrityReportProvider = FutureProvider<IntegrityReport>((ref) => ref.watch(deviceIntegrityProvider).check());

/// Opens turn-by-turn directions to a point (Google Maps, or any app handling geo: links).
typedef MapLauncher = Future<bool> Function(double lat, double lng);
final mapLauncherProvider = Provider<MapLauncher>((ref) => (lat, lng) async {
      final maps = Uri.parse('https://www.google.com/maps/dir/?api=1&destination=$lat,$lng&travelmode=walking');
      if (await launchUrl(maps, mode: LaunchMode.externalApplication)) return true;
      return launchUrl(Uri.parse('geo:$lat,$lng?q=$lat,$lng'), mode: LaunchMode.externalApplication);
    });

final captureLauncherProvider = Provider<CaptureLauncher>((ref) => (context, {allowVideo = true}) async {
      final dir = await ref.read(captureDirProvider.future);
      if (!context.mounted) return null;
      return CameraCaptureScreen.open(context, location: ref.read(locationProvider), compressor: ref.read(compressorProvider), saveDir: dir, allowVideo: allowVideo);
    });
