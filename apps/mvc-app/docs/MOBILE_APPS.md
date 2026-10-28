# Using the Flutter apps with this API

The Citizen and Staff apps (`apps/mobile_citizen`, `apps/mobile_staff`, shared code in `packages/flutter_core`) talk to
the same `/api/v1` endpoints as the website. **No change to the app code is needed**; you only point them at this server.

This was verified, not assumed: `packages/flutter_core/tool/contract_mvc.sh` runs the real Dart client against a running
copy of this application (sign-up, GPS routing, signed photo uploads, assignment, offline resolve through the outbox,
rating, token refresh, privacy export/erasure, and a website cookie session reading what the app filed): **10 of 10
passed**. Running the app on a phone is a separate step that has not been tested against this server.

## Point an app at the server

The base URL is a build setting, `API_BASE_URL`, and must end in `/api/v1`.

**Phone connected by USB (easiest, works with the app's debug build):**

```bat
cd apps\mvc-app
npm run dev
adb reverse tcp:3000 tcp:3000
cd ..\mobile_citizen
flutter build apk --debug --dart-define=API_BASE_URL=http://localhost:3000/api/v1
adb install -r build\app\outputs\flutter-apk\app-debug.apk
```

`adb reverse` makes the phone's `localhost:3000` reach your PC. Run it again after every reconnect of the cable.
**Only port 3000 is needed now**: photos and videos also go to this server (the earlier setup also needed port 9000 for
MinIO). The error "No internet connection" in the app almost always means the `adb reverse` line was not run again or
`npm run dev` is not running; check `curl http://localhost:3000/api/v1/health/ready`.

**Phone on Wi-Fi:** the debug build allows plain `http://` only to `localhost` and the emulator address `10.0.2.2`
(`apps/mobile_citizen/android/app/src/debug/res/xml/network_security_config.xml`, same file in `mobile_staff`). For a
LAN address either add it there as another `<domain>`, or serve the app over HTTPS. Then use
`--dart-define=API_BASE_URL=http://192.168.1.20:3000/api/v1`, allow port 3000 through Windows Defender Firewall
(*Inbound rule, TCP 3000, Private networks*), and keep phone and PC on the same network. `npm run dev` answers on all
network addresses. The **Android emulator** needs nothing: `http://10.0.2.2:3000/api/v1` is its default.

**Real deployment:** put the app behind an HTTPS reverse proxy, build the apps with
`--dart-define=API_BASE_URL=https://your-domain/api/v1`, and set `APP_URL` to the same address on the server (signed
photo links are built from it).

## What is the same as the earlier (NestJS) API

Paths, request fields, token login (`accessToken`, `refreshToken`), refresh rotation, the camera-evidence flow
(declare, upload, signed confirm), complaint actions answering `201`, notification endpoints, privacy endpoints. See
[API.md](API.md).

## What is different (and handled)

| Difference | Effect on the apps |
|---|---|
| `POST /attestation/challenge` always answers `{ "enabled": false }` | The apps send no Play Integrity proof. Works as before; there is just no attestation. |
| No second factor | Administrators can sign in through the API too (the website is their normal client). The apps are for citizens, supervisors and workers. |
| Media bytes go to `PUT /media/{id}/content?exp=...&sig=...` on this server, not to S3 | The upload address in the answer of `POST /media/upload-url` is already a ready-to-use signed address. The app must not add a login header to it and does not. |
| Photos are served from this server through 5-minute signed links | Unchanged for the app (it uses the links from the API). |

## Good to know

* Reported GPS must be near the demo wards to be routed automatically. Set `DEMO_CENTER_LAT/LNG` in `.env` to where you
  are testing, then `npm run db:reset`; otherwise the citizen picks the ward by hand.
* A worker or supervisor on a **temporary password** must change it in the app before the signing key can be
  registered (same as before).
* Push notifications need Firebase set up (`FCM_SERVICE_ACCOUNT_JSON` on the server, the app's Firebase settings); without
  it notifications appear inside the app only.
