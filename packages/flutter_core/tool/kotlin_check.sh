#!/usr/bin/env bash
# Type-checks both apps' MainActivity.kt without the Android SDK or Google Maven (both unreachable
# in some build sandboxes): Kotlin compiler + Android framework classes (Robolectric android-all)
# from Maven Central, Flutter's embedding from the local engine cache, and compile-only stubs for
# the few Google-Maven-only APIs (Play Integrity, Play services Tasks, AndroidX Lifecycle) in
# kotlin-check/stubs. The CI APK build is the full check; this catches Kotlin errors early.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="${TMPDIR:-/tmp}/cwm-kotlin-check"
mkdir -p "$WORK"
[ -d "$WORK/lib" ] || mvn -q -f "$HERE/kotlin-check/pom.xml" dependency:copy-dependencies -DoutputDirectory="$WORK/lib"
FLUTTER_ROOT="${FLUTTER_ROOT:-$(dirname "$(dirname "$(command -v flutter)")")}"
EMBEDDING=$(ls "$FLUTTER_ROOT"/bin/cache/artifacts/engine/android-arm64-release/flutter.jar)
CP="$WORK/lib/android-all-14-robolectric-10818077.jar:$EMBEDDING:$WORK/lib/kotlin-stdlib-2.1.21.jar"
status=0
for kt in "$ROOT"/apps/mobile_*/android/app/src/main/kotlin/org/citywaste/*/MainActivity.kt; do
  echo "== ${kt#$ROOT/}"
  out=$(java -cp "$WORK/lib/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -Werror -cp "$CP" -jvm-target 17 \
         -d "$WORK/out" "$kt" "$HERE/kotlin-check/stubs" 2>&1) || status=1
  echo "$out" | grep -v JAVA_TOOL_OPTIONS || true
done
exit $status
