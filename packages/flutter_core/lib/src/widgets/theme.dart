import 'package:flutter/material.dart';

/// Municipal green, large touch targets, readable on low-end screens in sunlight.
ThemeData buildCwmTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: const Color(0xFF1F7A4D));
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    inputDecorationTheme: const InputDecorationTheme(border: OutlineInputBorder()),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48))),
  );
}

const supportedAppLocales = [Locale('hi'), Locale('en')];
