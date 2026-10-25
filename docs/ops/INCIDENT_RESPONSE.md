# Security incident response

**CERT-In Directions (28 April 2022): report cyber incidents to CERT-In within 6 hours of noticing
them** (incident@cert-in.org.in, or the online form), keep ICT logs for 180 days within India, and
keep system clocks synchronised to NTP (NIC / NPL servers).

## Severity
| Level | Examples | Response |
|---|---|---|
| P1 | data breach (citizen data exposed), admin account takeover, signing keys or `PII_*` keys leaked, defacement | immediately; CERT-In report within 6 h; DPDP Board + affected citizens notified as the Act and its Rules require |
| P2 | a staff account misused, malware upload caught repeatedly, sustained attack causing outage | same day; CERT-In report if it is a reportable incident type |
| P3 | single failed attack, vulnerability reported without exploitation | within a week |

## First hour (P1/P2)
1. **Contain**
   - One account: Staff page → Disable (ends its sessions at once). Citizen: disable via SQL
     `UPDATE users SET status='DISABLED', token_version = token_version + 1 WHERE id = …`.
   - Everyone: rotate `JWT_ACCESS_SECRET` (all access tokens invalid) and revoke all refresh tokens
     (`UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL`).
   - Stolen phone of a worker: Sub Admin disables the account; its device keys stop being accepted.
   - Malicious uploads: they are already quarantined (never served); check `audit_logs` for `MALWARE_DETECTED`.
2. **Preserve evidence**: snapshot the database, export API/proxy logs for the window, do not
   restart servers before copying logs. `audit_logs` is append-only at the database level.
3. **Assess**: what data, how many people, since when (audit log, refresh token IPs, proxy logs).
4. **Report**: CERT-In within 6 h (even with incomplete facts; update later), State IT, the ULB's
   Grievance Officer / DPO.

## Key rotation
| Secret | Impact of rotating | How |
|---|---|---|
| `JWT_ACCESS_SECRET` / `JWT_MFA_SECRET` | everyone signs in again within 15 min (refresh tokens still valid unless revoked) | change in the vault, redeploy |
| Refresh tokens | everyone signs in again | SQL above |
| `PII_ENCRYPTION_KEY` / `PII_HASH_KEY` | none for users (sign-in, MFA and lookups keep working throughout) | see below |
| Release keystore | Play app signing key cannot change; upload key can be reset through Play Console | Play Console |
| Play Integrity / FCM service accounts | none for users | create new key, update vault, delete old key |

### Rotating the PII keys (database or key leaked)
1. Generate new 32-byte keys in the vault. Deploy **every** API and worker replica with
   `PII_ENCRYPTION_KEY`/`PII_HASH_KEY` = new and `PII_ENCRYPTION_KEY_PREVIOUS`/`PII_HASH_KEY_PREVIOUS` = old.
   From then on everything written uses the new keys; old values are still read and found.
2. Run the job (resumable, safe while the app runs):
   `docker compose run --rm migrate node dist/database/rotate-pii-keys.js`. Exit code 2 means rows
   changed meanwhile or were unreadable: run it again; investigate any it lists as unreadable.
3. If the hash key changed: every user with MFA regenerates recovery codes (portal → Account),
   because their hashes cannot be recomputed. The job prints how many users hold codes.
4. Remove the `*_PREVIOUS` keys and redeploy. Take a fresh backup; older backups need the old keys,
   keep those (offline) for as long as those backups are retained.
Tested end to end in `test/security/key-rotation.e2e-spec.ts`.

## Contacts (fill before go-live)
| Role | Name | Phone | Email |
|---|---|---|---|
| Incident lead (State IT) | | | |
| ULB Sub Admin | | | |
| Grievance Officer / DPO | | | |
| Vendor on-call | | | |
| Hosting provider NOC | | | |
