import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../i18n/strings.dart';
import '../state/providers.dart';

class LanguageToggle extends ConsumerWidget {
  const LanguageToggle({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lang = ref.watch(localeProvider).languageCode;
    return TextButton(
      key: const Key('lang-toggle'),
      onPressed: () => ref.read(localeProvider.notifier).set(lang == 'hi' ? 'en' : 'hi'),
      child: Text(lang == 'hi' ? 'English' : 'हिन्दी'),
    );
  }
}

/// Signs out, first warning when queued uploads would be discarded (they cannot be sent under
/// another account, see Outbox.clear).
class SignOutButton extends ConsumerWidget {
  const SignOutButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    return OutlinedButton.icon(
      key: const Key('logout'),
      icon: const Icon(Icons.logout),
      label: Text(s.t('signOut')),
      onPressed: () async {
        final unsent = ref.read(outboxProvider).value?.items.length ?? 0;
        if (unsent > 0) {
          final ok = await showDialog<bool>(
            context: context,
            builder: (c) => AlertDialog(
              content: Text(s.t('unsentOnSignOut', {'n': unsent}), key: const Key('unsent-warning')),
              actions: [
                TextButton(onPressed: () => Navigator.pop(c, false), child: Text(s.t('cancel'))),
                TextButton(key: const Key('confirm-signout'), onPressed: () => Navigator.pop(c, true), child: Text(s.t('signOut'))),
              ],
            ),
          );
          if (ok != true) return;
        }
        await ref.read(sessionProvider.notifier).logout();
      },
    );
  }
}
