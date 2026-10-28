# DAST (OWASP ZAP)

Authenticated scan of the API (every endpoint from the OpenAPI spec, as a Sub Admin) and the portal
(spidered with a real Sub Admin session), using ZAP's automation framework.

```bash
# ZAP 2.16+ (needs Java 17+): https://www.zaproxy.org/download/
ZAP_HOME=/opt/ZAP_2.16.1 ./run-zap.sh      # → results/zap-report.html / .json
```
`run-zap.sh` starts the e2e environment (fresh seeded database, real API on :3100 with 2-hour access
tokens so the scan does not expire mid-way, production portal build on :3200), signs in with TOTP
(`auth.mjs`) and runs `zap-plan.yaml`. Endpoints that would end the scanner's own session or lock
its account (logout, change password, MFA, erasure, staff status changes) are excluded; they are
covered by the API's security tests instead.

The result of the vendor's own run is summarised in [`docs/ops/DAST.md`](../../docs/ops/DAST.md).
For the external audit, run ZAP (or the auditor's tool) against **staging**, not this local stack.
