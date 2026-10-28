import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'screens/change_password_screen.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';

void main() {
  CoreConfig.fromEnvironment().assertReleaseReady();
  runApp(const ProviderScope(child: StaffApp()));
}

class StaffApp extends ConsumerWidget {
  const StaffApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp(
      title: 'Swachh Seva Staff',
      theme: buildCwmTheme(),
      locale: ref.watch(localeProvider),
      supportedLocales: supportedAppLocales,
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: const IntegrityGate(child: SessionGate()),
    );
  }
}

/// Staff handle evidence that decides whether work was done: refuse to run on a rooted or modified
/// phone. (Heuristic only; Play Integrity on the server is the real control, see SECURITY.md.)
class IntegrityGate extends ConsumerWidget {
  const IntegrityGate({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    return ref.watch(integrityReportProvider).when(
          loading: () => Scaffold(body: Center(child: Text(s.t('checkingDevice')))),
          // A failing check must not lock everyone out; the server still verifies every capture.
          error: (_, _) => child,
          data: (r) => r.compromised
              ? Scaffold(
                  body: Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        const Icon(Icons.gpp_bad, size: 64, color: Colors.red),
                        const SizedBox(height: 16),
                        Text(s.t('deviceUnsafe'), key: const Key('device-unsafe'), textAlign: TextAlign.center),
                      ]),
                    ),
                  ),
                )
              : child,
        );
  }
}

/// Signed out → login; administrators and citizens → told which app to use; a temporary password
/// → must be changed first (the API refuses everything else until then); otherwise home.
class SessionGate extends ConsumerWidget {
  const SessionGate({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    return session.when(
      loading: () => const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (e, _) => Scaffold(body: ErrorRetry(e, onRetry: () => ref.invalidate(sessionProvider))),
      data: (me) {
        if (me == null) return const LoginScreen();
        if (me.role != Role.supervisor && me.role != Role.worker) {
          return WrongAppScreen(message: S.of(context).t(me.role == Role.citizen ? 'citizenOnly' : 'useMobileRole'));
        }
        if (me.mustChangePassword) return const ChangePasswordScreen();
        return HomeScreen(me: me);
      },
    );
  }
}

class WrongAppScreen extends ConsumerWidget {
  const WrongAppScreen({super.key, required this.message});
  final String message;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(message, textAlign: TextAlign.center, key: const Key('wrong-app')),
            const SizedBox(height: 16),
            FilledButton(onPressed: () => ref.read(sessionProvider.notifier).logout(), child: Text(S.of(context).t('signOut'))),
          ]),
        ),
      ),
    );
  }
}
