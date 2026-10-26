# Local setup: run the tests, run the system, build an APK for a phone

From a new machine to: every test suite passing, the portal open in a browser, and the Citizen
app on your phone talking to your own computer.

**Pick your path.** Everything except Android Studio runs on Linux.
- **Ubuntu 24.04 (or 22.04):** do everything in one place.
- **Windows 11:** use **WSL2 + Ubuntu** for parts 1–6 (tests, Docker, the API), and install
  **Flutter + Android Studio on Windows** for part 7, because the phone's USB cable is on Windows.
- **macOS:** the same steps work with Homebrew in place of `apt`. The compose stack's ClamAV image
  is x86-only, so on Apple silicon run it under emulation or remove `CLAMAV_HOST` for local runs.

Roughly 1–2 hours, most of it downloads. You need about 30 GB free disk and 16 GB RAM is comfortable.

---

## 1. Base tools (Ubuntu / WSL2)

**Windows only, first:** in PowerShell as Administrator run `wsl --install -d Ubuntu-24.04`,
reboot, open "Ubuntu" from the Start menu and create your Linux user. Then install
[Docker Desktop](https://www.docker.com/products/docker-desktop/) on Windows and enable
*Settings → Resources → WSL integration → Ubuntu-24.04*. Do everything below in the Ubuntu
terminal, inside your Linux home (`~`), not under `/mnt/c` (that is 10× slower).

**Ubuntu only:** install Docker Engine: https://docs.docker.com/engine/install/ubuntu/, then
`sudo usermod -aG docker $USER` and log out and in again.

Then, both:
```bash
sudo apt update
sudo apt install -y git curl unzip build-essential ffmpeg python3-venv redis-tools postgresql-client
# Node 22 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22 && nvm alias default 22
# S3 emulator used by the tests (moto)
python3 -m venv ~/moto-venv && ~/moto-venv/bin/pip install "moto[server]"
echo 'export MOTO_SERVER_BIN=$HOME/moto-venv/bin/moto_server' >> ~/.bashrc && source ~/.bashrc
docker run --rm hello-world   # proves Docker works
```

## 2. Get the code
```bash
cd ~
git clone https://github.com/Taru650/city-waste-management.git
cd city-waste-management
git status          # the default branch currently holds all the work; after the PR merges, use main
```
(If the repository is private, sign in first: `gh auth login`, or use a personal access token as the password.)

## 3. Test databases (PostgreSQL + PostGIS, Redis) in Docker
The tests expect `postgres:postgres@localhost:5432` and a password-less Redis on 6379, the same as CI:
```bash
docker run -d --name cwm-test-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgis/postgis:16-3.4
docker run -d --name cwm-test-redis -p 6379:6379 redis:7-alpine
sleep 5 && pg_isready -h localhost -U postgres && redis-cli ping
```
The tests create and drop their own databases (`cwm_test`, `cwm_e2e_test`); nothing else is touched.

## 4. Run the API tests
```bash
cd ~/city-waste-management/apps/api
npm ci
npm run lint && npm run typecheck
npm test            # unit + integration + security, about 5 minutes; expect "Tests: 475 passed"
```
If it fails at the start with `No S3 endpoint … moto_server could not be started`, run
`echo $MOTO_SERVER_BIN` and check that the file exists (step 1).

## 5. Run the portal tests (including a real browser)
```bash
cd ~/city-waste-management/apps/api && npm run build
cd ../web
npm ci
npm run lint && npm run typecheck && npm test        # unit tests (49)
npx playwright install --with-deps chromium          # asks for your sudo password once
npm run build
npm run test:e2e                                     # 51 browser tests, about 3 minutes
```

## 6. Run the whole system (Docker Compose)
Stop the test containers first (they use the same ports):
```bash
docker stop cwm-test-pg cwm-test-redis
```
Create the API's settings file:
```bash
cd ~/city-waste-management/apps/api
cp .env.example .env
for k in JWT_ACCESS_SECRET JWT_MFA_SECRET; do sed -i "s|^$k=.*|$k=$(openssl rand -base64 48 | tr -d '\n')|" .env; done
for k in PII_ENCRYPTION_KEY PII_HASH_KEY; do sed -i "s|^$k=.*|$k=$(openssl rand -base64 32)|" .env; done
sed -i "s|^S3_PUBLIC_ENDPOINT=.*|S3_PUBLIC_ENDPOINT=http://localhost:9000|" .env
grep -E "^(NODE_ENV|PLAY_INTEGRITY_MODE|MAIL_TRANSPORT)=" .env   # expect development / off / log
```
Start everything (the first run downloads images and the virus database, so allow 5–15 minutes
before the API is up; ClamAV is the slow one):
```bash
cd ~/city-waste-management
export POSTGRES_PASSWORD=dev-db-pass REDIS_PASSWORD=dev-redis-pass MINIO_ROOT_USER=minio MINIO_ROOT_PASSWORD=minio-dev-pass
docker compose -f infra/docker-compose.yml up --build -d
docker compose -f infra/docker-compose.yml ps        # wait until api is "healthy"
curl -s localhost:3000/api/v1/health/ready           # {"status":"ready","db":true,"redis":true}
```
Create the first Web Admin (mobile and email of your choice; the password must not contain either):
```bash
docker compose -f infra/docker-compose.yml run --rm -e SEED_ADMIN_MOBILE=9876500001 \
  -e SEED_ADMIN_EMAIL=admin@example.in -e SEED_ADMIN_PASSWORD='Choose-A-Strong-Pass-1' \
  migrate node dist/database/seed.js
```
Open **http://localhost:3001** and sign in with that mobile number and password. You will set up
an authenticator app (Google Authenticator or Microsoft Authenticator on your phone) and change
the password. Then create the data the apps need. The system starts empty:
1. **Masters → District** (any LGD code), then a **ULB** under it.
2. **Wards:** draw or upload a GeoJSON polygon **around where you will test the phone**
   (https://geojson.io makes one). Then the app detects the ward from GPS; otherwise the
   citizen picks it from a list.
3. **Area** covering those wards, then **Staff:** a Sub Admin, a Supervisor for the area and a
   Worker. Each is shown a temporary password once; they change it at first sign-in.

Useful: API docs at http://localhost:3000/api/docs; password-reset emails are printed in
`docker compose -f infra/docker-compose.yml logs api`; stop everything with `docker compose -f infra/docker-compose.yml down`
(add `-v` to wipe the data).

## 7. Build the app and install it on your phone
Do this where Android Studio is installed. On Windows 11 that is Windows itself, in **PowerShell**,
with a second clone of the repo on the Windows drive. Don't build from `\\wsl$\…`: Gradle on a
network path is slow and fails in odd ways.

0. **Windows only:** install [Git for Windows](https://git-scm.com/download/win), then in PowerShell:
   ```
   git config --global core.longpaths true
   mkdir C:\dev; cd C:\dev
   git clone https://github.com/Taru650/city-waste-management.git
   ```
1. Install **Android Studio** (https://developer.android.com/studio). Open it once and finish
   the setup wizard (it installs the Android SDK). Then *Settings → Languages & Frameworks →
   Android SDK → SDK Tools* and tick **Android SDK Command-line Tools** and **Android SDK Platform-Tools**.
   On Windows add `%LOCALAPPDATA%\Android\Sdk\platform-tools` to your user PATH (for `adb`).
2. Install **Flutter 3.47.8** (the version CI uses):
   `git clone https://github.com/flutter/flutter.git -b 3.47.8 C:\dev\flutter` (Ubuntu: `~/flutter`),
   add `C:\dev\flutter\bin` to your user PATH (*Start → "Edit environment variables for your account"*),
   open a new PowerShell, then:
   ```
   flutter doctor --android-licenses     # accept all
   flutter doctor                        # Android toolchain and Android Studio should be ✓
   ```
   If Gradle later complains about the Java version, install Temurin 17 and run `flutter config --jdk-dir <path to JDK 17>`.
3. Phone: *Settings → About phone →* tap **Build number** 7 times, then *Developer options →
   USB debugging* on. Plug it in, accept the prompt, and check `adb devices` lists it.
4. Build and install the **debug** app pointed at your computer (Docker Desktop publishes the
   API on Windows' `localhost:3000` too, so `adb` on Windows reaches the stack running in WSL2):
   ```
   cd C:\dev\city-waste-management\apps\mobile_citizen
   flutter pub get
   flutter build apk --debug --dart-define=API_BASE_URL=http://localhost:3000/api/v1
   adb reverse tcp:3000 tcp:3000
   adb reverse tcp:9000 tcp:9000
   adb install -r build\app\outputs\flutter-apk\app-debug.apk
   ```
   `adb reverse` makes the phone's `localhost:3000` (API) and `:9000` (photo storage) reach your
   computer over the cable. Debug builds may use plain HTTP only to `localhost`, and the API
   only listens on your computer, so Wi-Fi addresses will not work. Run the two
   `adb reverse` lines again after every reconnect. For live logs use
   `flutter run --dart-define=API_BASE_URL=http://localhost:3000/api/v1` instead of build + install.
5. Same for the Staff app: `apps/mobile_staff`, and sign in as the Supervisor or Worker from step 6.

The mobile unit tests run on the same machine:
`cd packages/flutter_core && flutter test`, then the same in `apps/mobile_citizen` and `apps/mobile_staff`.

**Expect on the phone:**
- Capture waits for GPS accuracy within 50 m (go near a window or outside).
- Fake-location apps are refused.
- Debug builds are slow and large; judge speed only on a release build.
- No push notifications without a Firebase project; the in-app inbox works.
- Play Integrity is off locally.

**Not for this setup:** release APKs need an HTTPS server, certificate pins and a Play Cloud project
number (see `packages/flutter_core/README.md`). The APKs CI builds point at a placeholder server and
will not connect to your computer.

## When something fails
| Symptom | Fix |
|---|---|
| `port is already allocated` on 5432/6379 | the test containers and compose are both running: `docker stop cwm-test-pg cwm-test-redis` (or `docker compose … down` before tests) |
| API container restarts, log says a setting is missing | `.env` step in part 6 skipped or a key empty |
| API "unhealthy" for minutes on first start | ClamAV is downloading its database; `docker compose … logs -f clamav` |
| App: "No internet connection" | `adb reverse` lines not run after reconnecting, or the API is not up (`curl localhost:3000/api/v1/health/ready`) |
| `ports are not available: exposing port TCP 127.0.0.1:9000` (Windows) | Port 9000 is in use or reserved by Windows (`netsh interface ipv4 show excludedportrange protocol=tcp`). Move it: `export MINIO_PORT=9100 MINIO_CONSOLE_PORT=9101`, set `S3_PUBLIC_ENDPOINT=http://localhost:9100` in `apps/api/.env`, run `up -d` again (and use `adb reverse tcp:9100 tcp:9100` for the phone) |
| App photos fail to upload | `S3_PUBLIC_ENDPOINT=http://localhost:9000` missing in `apps/api/.env`, or `adb reverse tcp:9000` not run; then `docker compose … up -d api` |
| `flutter doctor` shows Android licences ✗ | `flutter doctor --android-licenses` |
