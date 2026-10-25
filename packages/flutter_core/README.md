# Mobile apps and flutter_core

| Path | What |
|---|---|
| `packages/flutter_core` | Shared Dart: API client, secure token store, camera capture + GPS gate + signing, uploader, offline outbox, Hindi/English strings, shared widgets |
| `apps/mobile_citizen` | **Swachh Seva**: citizens register, report problems with the in-app camera, track, rate |
| `apps/mobile_staff` | **Swachh Seva Staff**: supervisors (area inbox, assign, reject, resolve) and field workers (tasks, navigate, start/resolve with camera proof, offline) |

Flutter 3.47 / Dart 3.13. Android-first; iOS has no native capture signer yet.

## Run
```bash
cd apps/mobile_citizen            # or apps/mobile_staff
flutter pub get
# Emulator talking to a local API (debug builds allow cleartext to 10.0.2.2 only):
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1
```
Release builds refuse to start unless `API_BASE_URL` is HTTPS, `CERT_PINS` is set
(comma-separated base64 SHA-256 of the server certificate's SubjectPublicKeyInfo, include a backup pin)
and `PLAY_CLOUD_PROJECT_NUMBER` (the Google Cloud project linked to the app in Play Console, for
Play Integrity) is set. Push notifications are enabled by `FIREBASE_API_KEY`, `FIREBASE_APP_ID`,
`FIREBASE_SENDER_ID` and `FIREBASE_PROJECT_ID`; without them the apps use the in-app inbox only.
```bash
openssl s_client -connect api.example.in:443 </dev/null 2>/dev/null | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
flutter build apk --release --dart-define=API_BASE_URL=https://api.example.in/api/v1 --dart-define=CERT_PINS=<pin1>,<pin2> \
  --dart-define=PLAY_CLOUD_PROJECT_NUMBER=<number> --dart-define=FIREBASE_API_KEY=... --dart-define=FIREBASE_APP_ID=... \
  --dart-define=FIREBASE_SENDER_ID=... --dart-define=FIREBASE_PROJECT_ID=...
```
Release signing reads `android/key.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`), which is
git-ignored and written by CI from secrets. Without it the release APK is unsigned.

## Test
```bash
(cd packages/flutter_core && flutter analyze && flutter test)   # unit tests
(cd apps/mobile_citizen && flutter analyze && flutter test)     # widget tests, whole screens against a fake API
(cd apps/mobile_staff && flutter analyze && flutter test)
packages/flutter_core/tool/contract_test.sh                      # real Dart client against the real API (Play Integrity enforced)
packages/flutter_core/tool/kotlin_check.sh                       # type-check the native Kotlin without the Android SDK
```
The contract test needs PostgreSQL/PostGIS, Redis, the moto S3 emulator (`/opt/moto-venv/bin/moto_server` or
`MOTO_SERVER_BIN`), `apps/api` built and `apps/web` dependencies installed (it reuses the portal's e2e seed).

## Design notes
- **One API.** The apps call the same `/api/v1` endpoints as the portal with Bearer tokens.
- **Camera only.** Captures come from `CameraCaptureScreen`; there is no gallery or file picker dependency, and the
  Android manifests remove storage/media permissions. The shutter is disabled until GPS accuracy is ≤ 50 m and the
  location is not mocked.
- **Signed captures.** `KeystoreSigner` talks to `MainActivity` (channel `org.citywaste/device_key`), which keeps a
  non-exportable P-256 key in Android Keystore (StrongBox when available). See `docs/MEDIA_CAPTURE_CONTRACT.md`.
- **Play Integrity.** `Attestor` gets a server challenge (`/attestation/challenge`, or a 428 from `/devices`) and
  asks Play for a token with nonce = base64url(SHA-256(challenge | binding)); for device keys the binding is the
  public key. Sign-up and forgot-password carry the proof instead of a CAPTCHA.
- **Push.** `PushRegistrar` registers the FCM token after sign-in and removes it at sign-out (shared phones).
- **Offline.** Filing, start-work and resolve go through `Outbox`: queued with their captures, sent when online,
  retried without re-uploading, refusals shown with the server's reason, cleared at sign-out.
- **Tests never touch the camera or Keystore:** `package:flutter_core/testing.dart` provides `SoftwareSigner`
  (RFC 6979 P-256), `FakeBackend` and in-memory storage. Never import it from app code.
