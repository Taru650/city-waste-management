import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'screens/privacy_screens.dart';

void main() {
  CoreConfig.fromEnvironment().assertReleaseReady();
  runApp(const ProviderScope(child: CitizenApp()));
}

class CitizenApp extends ConsumerWidget {
  const CitizenApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp(
      title: 'Swachh Seva',
      theme: buildCwmTheme(),
      locale: ref.watch(localeProvider),
      supportedLocales: supportedAppLocales,
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: const SessionGate(),
    );
  }
}

/// Signed out → login; signed in as a citizen → home; staff → told to use the Staff app.
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
        if (me.role != Role.citizen) {
          return Scaffold(
            body: Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Text(S.of(context).t('citizenOnly'), textAlign: TextAlign.center, key: const Key('citizen-only')),
                  const SizedBox(height: 16),
                  FilledButton(onPressed: () => ref.read(sessionProvider.notifier).logout(), child: Text(S.of(context).t('signOut'))),
                ]),
              ),
            ),
          );
        }
        if (me.consentRequired) return const ConsentScreen();
        return const HomeScreen();
      },
    );
  }
}
