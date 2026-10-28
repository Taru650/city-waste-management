# Swachh Seva: City Waste Management (Next.js + MySQL)

A city-cleanliness grievance system. Citizens report garbage, water-logging or blocked drains with a photo taken in the
app; the complaint is routed by GPS to the right ward supervisor, assigned to a field worker, resolved with geotagged
proof, and rated by the citizen. Officers get pendency, SLA and quality reports.

This folder is a **complete Next.js application on MySQL** organised as MVC:

* **one REST API** (`/api/v1`) serves the website **and** the Flutter mobile apps, with the same business rules;
* a **website** for administrators and supervisors (dashboard, complaints, staff, masters, event zones);
* **database migrations** and **demo-data seeders**;
* secure sign-in, role-based access control, and a test suite that checks the security rules.

> It sits next to the earlier NestJS/PostgreSQL implementation (`apps/api`, `apps/web`), which is unchanged.

**Contents:** [Windows setup](#windows-setup-command-prompt) ·
[Demo logins](#demo-logins) · [Commands](#commands) · [Project layout](#project-layout-mvc) ·
[One API](#one-api-for-the-website-and-the-apps) · [Security](#security-and-roles) · [Settings](#settings-env) ·
[Tests](#tests) · [Production](#going-to-production) · [Troubleshooting](#troubleshooting) · [Limits](#known-limitations)
· [API reference](docs/API.md) · [Mobile apps](docs/MOBILE_APPS.md)

---

## Windows setup (Command Prompt)

Everything below is typed in **Command Prompt (CMD)**: press `Win`, type `cmd`, press Enter.
Plan on 20–30 minutes the first time. Steps 1 and 2 are one-time installs.

### 1. Install Node.js 22 (LTS)

1. Download the Windows installer from <https://nodejs.org> (choose **22.x LTS**) and run it with the defaults.
2. **Close CMD and open a new one**, then check:

   ```bat
   node -v
   npm -v
   ```

   `node -v` must print `v20.9` or newer (v22 recommended).

### 2. Install MySQL 8.4 (not XAMPP, not MariaDB)

The app uses MySQL's geographic functions, which MariaDB (what XAMPP and WAMP ship) does not have in the same form.

1. Download **MySQL Installer / MySQL Community Server 8.4 LTS** for Windows from <https://dev.mysql.com/downloads/mysql/>.
2. In the installer choose **Server only** (or "Developer Default"), keep port **3306**, choose
   *Use Strong Password Encryption*, set a **root password** and write it down, and let it **run as a Windows service**
   (default name `MySQL84`).
3. Check it is running. In CMD:

   ```bat
   "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -u root -p -e "SELECT VERSION();"
   ```

   Enter the root password. You should see `8.4.x`. (Tip: add `C:\Program Files\MySQL\MySQL Server 8.4\bin` to
   your `Path` to type just `mysql`.)

### 3. Get the code

With Git:

```bat
git clone https://github.com/Taru650/city-waste-management.git
cd city-waste-management
git checkout claude/nextjs-mysql-mvc
cd apps\mvc-app
```

Without Git: download the ZIP of that branch from GitHub, unzip it, and `cd` into the `apps\mvc-app` folder.
**Keep the folder outside OneDrive/Dropbox** and avoid very long paths (for example `C:\projects\cwm`).

### 4. Install the dependencies

```bat
npm install
```

This takes a few minutes. It installs ready-made Windows builds of the two native packages (password hashing and image
processing), so you do **not** need Visual Studio.

### 5. Create the database and the database user

Open the MySQL prompt (it asks for the root password):

```bat
"C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -u root -p
```

At the `mysql>` prompt paste these lines, then type `exit`:

```sql
CREATE DATABASE cwm_mvc CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE cwm_mvc_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'cwm'@'localhost' IDENTIFIED BY 'cwm_dev_pass';
CREATE USER 'cwm'@'127.0.0.1' IDENTIFIED BY 'cwm_dev_pass';
GRANT ALL PRIVILEGES ON cwm_mvc.* TO 'cwm'@'localhost';
GRANT ALL PRIVILEGES ON cwm_mvc_test.* TO 'cwm'@'localhost';
GRANT ALL PRIVILEGES ON cwm_mvc.* TO 'cwm'@'127.0.0.1';
GRANT ALL PRIVILEGES ON cwm_mvc_test.* TO 'cwm'@'127.0.0.1';
```

`cwm_mvc_test` is only used by the automated tests (they wipe it). Change `cwm_dev_pass` to a password of your own if
you like, and use the same one in the next step.

### 6. Create your settings file (`.env`)

```bat
copy .env.example .env
npm run gen:secrets
```

`gen:secrets` fills the three secret keys (it never overwrites a value you already set). If you chose another database
password, edit the file (`notepad .env`) and set `DB_PASSWORD=` to it. **If your password contains `#` or spaces, put it
in double quotes**, e.g. `DB_PASSWORD="pa#ss word"`.

Keep `.env` private. It is ignored by Git. Never overwrite it on a running system: losing `PII_ENCRYPTION_KEY` or
`PII_HASH_KEY` makes stored phone numbers and e-mails unreadable.

### 7. Check, create the tables, add the demo data

```bat
npm run doctor
npm run db:migrate
npm run db:seed
```

* `doctor` checks Node, `.env`, the MySQL login, the MySQL version, spatial support and port 3000, and tells you
  what to fix in plain words. Run it any time something looks wrong.
* `db:migrate` creates all tables (migrations are in `src\db\migrations`).
* `db:seed` adds demo districts, wards, 12 accounts and 56 complaints with photos (about a month of history).
  Running it again changes nothing.

(`npm run setup` does `gen:secrets`, `db:migrate` and `db:seed` in one go.)

**If `db:migrate` prints a "NOTE: database-level append-only guards were NOT created":** that is normal on a default
MySQL install (binary logging is on). The app still protects the history tables in code. To also turn on the database
guard, once, as root:

```bat
"C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -u root -p -e "SET GLOBAL log_bin_trust_function_creators = 1;"
npm run db:guards
```

To keep that setting after a MySQL restart, add `log_bin_trust_function_creators=1` under `[mysqld]` in
`C:\ProgramData\MySQL\MySQL Server 8.4\my.ini` and restart the `MySQL84` service.

### 8. Start the application

```bat
npm run dev
```

You will see `[web] Ready` and `[worker] started` (the worker sends notifications, enforces deadlines and processes
videos). Open <http://localhost:3000> in a browser and sign in with a [demo login](#demo-logins). Stop with `Ctrl + C`.

**Optional extras** (the app works without them): install [FFmpeg](https://ffmpeg.org/download.html) and set
`FFMPEG_PATH` / `FFPROBE_PATH` in `.env` so videos are compressed; set `MAIL_TRANSPORT=smtp` and `SMTP_URL` to send real
password-reset e-mail (by default the reset link is printed in the terminal).

---

## Demo logins

Password for **every** demo account: `Demo@12345`. Sign in with the mobile number.

| Who | Mobile | What to try |
|---|---|---|
| Web Admin | 9000000001 | Statewide dashboard, districts, ULBs, complaint types and deadlines |
| District Admin | 9000000002 | One district: ULBs, Sub Admins, reports |
| District Admin (2nd district) | 9000000009 | Proves one district cannot see another |
| Sub Admin, Nagar Nigam | 9000000003 | Complaints, assign workers, wards, areas, staff, event zones |
| Sub Admin, Nagar Parishad | 9000000008 | A second ULB (separate data) |
| Supervisor, North | 9000000004 | Only the complaints of the North area |
| Supervisor, South | 9000000005 | Only the South area |
| Worker | 9000000006, 9000000007 | Mobile app only (the website says so) |
| Citizen | 9100000001 to 9100000003 | Mobile app only |

The demo wards are centred on `DEMO_CENTER_LAT` / `DEMO_CENTER_LNG` in `.env` (default 21.2514, 81.6296). Set them to
where you will test the phone app, then `npm run db:reset`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Website + API on port 3000 **and** the background worker, with live reload |
| `npm run dev:web` | Only the website and API |
| `npm run worker` | Only the background worker |
| `npm run build` then `npm start` | Production build and start (web + worker) |
| `npm run doctor` | Checks the whole setup and explains problems |
| `npm run gen:secrets` | Creates `.env` if missing and fills the three secret keys |
| `npm run db:migrate` / `db:rollback` / `db:status` | Apply / undo the last batch / list migrations |
| `npm run db:seed` | Adds the demo data (safe to repeat) |
| `npm run db:reset` | **Deletes everything** in a demo database and rebuilds it (refuses names without `mvc`, `demo`, `dev` or `test`, and refuses in production) |
| `npm run db:guards` | Installs the database-level append-only guards (see step 7) |
| `npm test` | Unit and integration tests (uses `cwm_mvc_test`) |
| `npm run build && npm run test:e2e` | Browser tests (use their own throwaway database `cwm_mvc_e2e`) |
| `npm run lint` / `npm run typecheck` | Code checks |

## Project layout (MVC)

```
src/
  app/                    ROUTING ONLY: Next.js folders map to URLs
    api/v1/**/route.ts      "API routes": one thin file per endpoint (wiring, no logic)
    (portal)/, login/ ...   website pages: one-line shells that render a view
  models/                 MODEL: all SQL lives here (one class per table group). Nothing else talks to MySQL.
  services/               business rules: state machine, routing by GPS, scoping, SLA, privacy, reports
  controllers/            CONTROLLERS: take a validated request, call services, shape the answer
  views/                  VIEWS: the website's React components
    pages/                  the screens (Dashboard, ComplaintDetail, Masters ...)
    components/             shell, charts, maps, filters
    lib/                    browser helpers (API client with silent token renewal, formatting)
    server/                 server-side helpers for pages (who is signed in)
  validation/             request schemas (zod); unknown or extra fields are rejected
  middleware/             route wrapper, authentication, role checks, CSRF, rate limits, CORS, CSP
  config/env.ts           every setting, validated at start-up with a clear message
  db/                     connection, SQL helpers, migrations/, seeds/ (demo data)
  jobs/                   background job queue (in MySQL) and the periodic jobs
  lib/                    pure helpers (complaint numbers, state machine, signing, file checks)
  proxy.ts                runs before pages and API: CSP nonce, sign-in redirect, CORS
scripts/                  db.ts (migrate, seed, reset), doctor, gen-secrets, worker
tests/                    unit + integration tests          e2e/   browser tests (Playwright)
docs/                     API.md, MOBILE_APPS.md
```

One request, end to end: `POST /api/v1/complaints/{id}/assign` → `route.ts` → **middleware** (rate limit, sign-in, role,
CSRF, schema) → **controller** → **service** (is the caller allowed to see this complaint? is the transition legal?)
→ **model** (SQL in one transaction, writes the history row) → JSON back. The website calls exactly this endpoint; so
does the mobile app.

## One API for the website and the apps

Every feature is a `/api/v1` endpoint; the website has no private back door. The only difference is how the session is
carried:

| Client | Sign in | Session |
|---|---|---|
| Website | `POST /auth/login` with `"session":"cookie"` | `httpOnly`, `SameSite=Strict` cookies; **no token reaches page scripts**; state-changing calls also need the header `x-cwm-csrf: 1` from the same origin |
| Mobile app | `POST /auth/login` (default `"session":"token"`) | access + refresh tokens in the JSON answer, sent as `Authorization: Bearer ...` |

Access tokens last 15 minutes; refresh tokens rotate on every use and reuse ends the whole session. See
[docs/API.md](docs/API.md) for every endpoint and [docs/MOBILE_APPS.md](docs/MOBILE_APPS.md) for the apps.

## Security and roles

* **Sign-in:** Argon2id password hashes; 5 wrong passwords lock the account for 15 minutes; generic error messages;
  per-IP rate limits on sign-in, sign-up and password reset. No second factor in this edition.
* **Sessions:** short-lived signed tokens, **checked against the database on every request**, so disabling a user,
  changing a password or signing out takes effect immediately. Staff created by an admin get a temporary password and
  must change it first.
* **Access control:** the role *and* the jurisdiction are enforced in the service and in every SQL query. A supervisor
  cannot read another area's complaint by changing an id; a Sub Admin cannot read another ULB; a citizen sees only their
  own complaints.
* **Browser protection:** CSRF header + same-origin check, strict CSP with per-request nonce, `X-Frame-Options: DENY`,
  HSTS, `no-store` API answers, CORS only for origins you list (never with cookies).
* **Data:** phone numbers and e-mails are encrypted at rest (and searched by a keyed hash); history tables are
  append-only; photos are checked by signature, size and content and are served only through 5-minute signed links;
  camera-only evidence is verified with a per-device signed manifest.
* **Privacy (DPDP Act):** notice and consent, data export, correction and erasure for citizens.

| Role | Can |
|---|---|
| **Web Admin** | everything below, for all districts; districts, ULBs, complaint types and deadlines |
| **District Admin** | one district: ULBs, Sub Admins, reports, event zones |
| **Sub Admin** | one ULB: wards and boundaries, areas, supervisors and workers, assign, resolve, reject, duplicates, reports, event zones |
| **Supervisor** | own area's complaints: assign, resolve, reject, duplicates; reports for the area |
| **Worker** | own tasks in the mobile app: start and resolve with camera proof |
| **Citizen** | register, file complaints anywhere (mobile app), track, rate, reopen, privacy rights |

## Settings (`.env`)

`.env.example` explains every line. The ones you are most likely to change:

| Setting | Meaning |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | MySQL login (use `127.0.0.1`, not `localhost`) |
| `JWT_ACCESS_SECRET`, `PII_ENCRYPTION_KEY`, `PII_HASH_KEY` | Generated by `npm run gen:secrets`. Back them up |
| `APP_URL` | The address people use (password-reset links, production origin checks) |
| `COOKIE_SECURE` | `false` on `http://localhost`, `true` in production (HTTPS) |
| `TRUST_PROXY_HOPS` | Number of reverse proxies in front (0 locally, 1+ in production) |
| `CORS_ORIGINS` | Other websites allowed to call the API from a browser (token mode only) |
| `RATE_LIMIT_*` | Requests per minute per client |
| `STORAGE_DIR` | Where photos and videos are stored on disk |
| `MAP_TILE_URL` | Map tiles for the website (the browser needs internet to load them) |
| `FFMPEG_PATH`, `FFPROBE_PATH`, `CLAMAV_HOST` | Optional video compression and malware scanning |
| `MAIL_TRANSPORT`, `SMTP_URL` | `log` prints reset links in the terminal; `smtp` sends e-mail |
| `GRIEVANCE_OFFICER_*` | Shown in the privacy notice; required in production |
| `DEMO_CENTER_LAT/LNG` | Centre of the demo wards |

A wrong or missing value stops the app at start-up and names the variable to fix.

## Tests

```bat
npm test
```

379 unit and integration tests against the dedicated `cwm_mvc_test` database (rebuilt on every run; it refuses any
database whose name does not contain `test`). They cover login and sessions, every role's access, GPS routing, the
complaint life cycle, media checks, SLA jobs, privacy, reports and the demo data. The security tests were mutation-checked
(a control was deliberately broken to make sure a test fails).

```bat
npm run build
npm run test:e2e
```

Real-browser tests of the production build on a throwaway database (`cwm_mvc_e2e`): sign-in and session handling,
CSRF, CORS and headers, every page with figures cross-checked against SQL, complaint actions, masters, staff, event
zones, and the layout at five screen widths. If Playwright cannot download its browser, set `PW_CHROMIUM` to the path of
an installed Chrome/Chromium.

The mobile client is tested against this API too: `packages/flutter_core/tool/contract_mvc.sh` runs the real Dart
client (sign-up, signed photo uploads, assignment, offline resolve, rating, privacy, cookie session) against a running copy.

## Going to production

This edition is a complete, tested application, **not a hardened deployment**. Before real users:

1. Put it behind an **HTTPS reverse proxy** (Nginx, IIS ARR, Caddy) and set `NODE_ENV=production`, `APP_URL=https://...`,
   `COOKIE_SECURE=true`, `TRUST_PROXY_HOPS=1` (the app refuses to start otherwise).
2. Use a dedicated MySQL user with only the rights on its own database, a strong password, and **back up** the database
   and the `STORAGE_DIR` folder together, plus your `.env` secrets.
3. Run `npm run build`, then `npm start` (web + worker), under a service manager so it restarts.
4. **Never run `db:reset` or `db:rollback`** against real data (both refuse in production mode). Apply new migrations with
   `npm run db:migrate` after a backup.
5. Have the system security-tested by an independent party before public launch.

Rate limits and export limits are kept in each process's memory, so run one app process (or sticky sessions).

## Troubleshooting

First run `npm run doctor`: it checks most of the items below and prints the fix.

### Installing

| You see | Cause and fix |
|---|---|
| `'node' / 'npm' is not recognized` | Node is not installed, or CMD was open during install. Install Node 22 LTS, then open a **new** CMD. |
| `npm install` fails with `EPERM`, `EBUSY` or `EACCES` | Antivirus or OneDrive is locking files. Move the project to `C:\projects\cwm`, close editors, delete the `node_modules` folder, run `npm install` again. |
| `npm install` fails with `ETIMEDOUT` / `ECONNRESET` / `E403` | Network or company proxy. Try again; behind a proxy run `npm config set proxy http://host:port` and `npm config set https-proxy http://host:port`. |
| Errors mentioning `node-gyp` or "Visual Studio" | Rare (a prebuilt binary was not found). Use Node 22 LTS 64-bit; if it persists install *Visual Studio Build Tools* with "Desktop development with C++". |
| `Unsupported engine` warning | Node is older than 20.9. Install Node 22 LTS. |

### MySQL and the database

| You see | Cause and fix |
|---|---|
| `'mysql' is not recognized` | Use the full path (step 2) or add `C:\Program Files\MySQL\MySQL Server 8.4\bin` to `Path`. |
| `ECONNREFUSED 127.0.0.1:3306` | MySQL is not running. Open *Services*, start **MySQL84** (or `net start MySQL84` in an **Administrator** CMD). Check `DB_PORT` matches the installed port. |
| `ER_ACCESS_DENIED_ERROR` | Wrong `DB_USER`/`DB_PASSWORD` in `.env`, or step 5 was skipped. A password with `#` or spaces must be in double quotes. Re-run the `CREATE USER` lines (both `localhost` and `127.0.0.1`). |
| `ER_BAD_DB_ERROR` (unknown database) | Create it: step 5, or `mysql -u root -p -e "CREATE DATABASE cwm_mvc CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"`. |
| `ER_DBACCESS_DENIED_ERROR` | The `GRANT` lines were not run for that database. |
| "This is MariaDB" | You are connecting to XAMPP/WAMP's MariaDB. Install MySQL 8.4 and point `DB_PORT` at it (for example 3307 if both are installed). |
| `ENOTFOUND localhost` / IPv6 `::1` problems | Use `DB_HOST=127.0.0.1`. |
| "database-level append-only guards were NOT created" | Not an error. See the end of step 7 to switch the guard on. |
| `Table ... doesn't exist` | Run `npm run db:migrate`. |
| Migration stopped half-way | Fix the cause, run `npm run db:migrate` again (finished steps are skipped). On a **demo** database you may `npm run db:reset`. |

### Starting and running

| You see | Cause and fix |
|---|---|
| `Configuration problem in your .env file: ...` | The named variable is empty or malformed. Run `npm run gen:secrets` for the three secrets; otherwise fix the line shown. |
| `Port 3000 is in use` / `EADDRINUSE` | `netstat -ano \| findstr :3000`, then `taskkill /PID <number> /F`. Or use another port: `npx next dev -p 3001` (and set `APP_URL`). |
| `Cannot find module ...` or odd build errors after pulling new code | `npm install`, then delete the `.next` folder and start again. |
| Page shows "This page could not be displayed" | Open the CMD window running `npm run dev`; the real error is printed there. |
| Blank map, grey boxes | Map tiles need internet in the **browser**. Behind a firewall set `MAP_TILE_URL` to an allowed tile server. |
| "Invalid credentials" for a demo account | Did you run `npm run db:seed`? (`npm run doctor` shows the user count.) The mobile number is the user name, the password is `Demo@12345`. After 5 wrong tries the account is locked for 15 minutes. |
| "Too many requests" (429) | The rate limit. Locally every client shares one counter; wait a minute or raise `RATE_LIMIT_AUTH_PER_MIN` / `RATE_LIMIT_GLOBAL_PER_MIN` in `.env`. |
| Signed out again and again | Make sure `COOKIE_SECURE=false` on `http://localhost` (a secure cookie is dropped over plain HTTP). |
| Notifications, reset e-mails or SLA escalations never happen | The worker is not running. `npm run dev` starts it; otherwise run `npm run worker`. With `MAIL_TRANSPORT=log` the reset link is in the terminal. |
| Photo links stop working after a few minutes | By design: links are valid for 5 minutes. Reload the page. |
| Photos or videos missing after `db:reset` | Reset also clears `STORAGE_DIR\media`; run `npm run db:seed` again. |
| Videos are not compressed / have no thumbnail | FFmpeg is optional. Install it and set `FFMPEG_PATH` and `FFPROBE_PATH`. |
| `db:reset` says it refuses | The database name must contain `mvc`, `demo`, `dev` or `test`, and `NODE_ENV` must not be `production`. This protects real data. |
| Tests fail with "Unknown database cwm_mvc_test" | Create the test database (step 5). Tests never use your demo database. |
| Browser tests cannot launch Chrome | `npx playwright install chromium`, or set `PW_CHROMIUM` to an installed Chrome. |

### Phone cannot reach the app

See [docs/MOBILE_APPS.md](docs/MOBILE_APPS.md): same Wi-Fi, the PC's LAN address (not `localhost`), Windows Firewall rule
for port 3000, and `adb reverse` for USB debugging.

## Known limitations

Stated plainly so nobody is surprised:

* **Tested on Linux with MySQL 8.0.46.** The Windows instructions follow the same commands but were **not run on
  Windows**. Report any difference; `npm run doctor` is the first thing to run.
* **Demo scope:** no second factor; no Google Play Integrity or CAPTCHA (the apps' requests for them are accepted and
  ignored); push notifications only if you configure Firebase; video compression needs FFmpeg; malware scanning is the
  EICAR test signature unless you run ClamAV; e-mail is printed to the terminal unless you configure SMTP.
* **Boundaries closer than about 10 cm** cannot be told apart by MySQL's geographic calculation; such an upload is
  refused with an explanation instead of being guessed. Ward polygons should not overlap by more than 100 m².
* **Database-level append-only guard** needs the one-time setting in step 7; without it the rule is enforced in code.
* **Single process:** rate limits and export limits live in memory, and the job queue uses MySQL (no Redis), which is
  right for a pilot, not for very high volume.
* Signing keys cannot be rotated without signing everyone out; there is no built-in backup tool (use `mysqldump`).
* Not independently penetration-tested.
