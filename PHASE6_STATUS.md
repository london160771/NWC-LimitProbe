# Phase 6 completion record

Date: 2026-10-01

## Outcome

Phase 6 adds a standalone Node.js evidence-report generator. It reads the completed Phase 4 race artifact and Phase 5 Bob-side reconciliation artifact, then writes `reports/phase6-evidence.json`. It does not depend on or start a dashboard or UI.

The generated report is redacted and allowlisted: it includes the two payment hashes and required timing, NWC result, Bob settlement, budget, invariant, and classification fields. It never copies input objects wholesale. Invoice strings, connection URIs, preimages, credentials, TLS/macaroons, RPC data, and arbitrary error text are excluded. NWC errors are reduced to a small safe code allowlist.

Classification is recalculated with `reconcileTwoInvoices` from `scripts/phase45-core.mjs`; the input artifact's prior classification is not trusted. Missing or inconsistent run, timing, budget, attempt, or Bob evidence produces `INCONCLUSIVE`. Null and absent numeric evidence remains missing rather than being coerced to zero.

## Report result

- Report version: `1.0.0`
- Network: `regtest`
- Wallet: `Alby Hub / NWC`
- Configured budget: 1,000 sats, renewal `never`
- Requests: two, 700 sats each
- Independently settled principal: 700 sats
- Post-race remaining budget: 300 sats
- Classification: `PASS`

The downloadable sample is `reports/phase6-evidence.json`. It was generated from the existing private Phase 4–5 artifacts. The JSON contains payment hashes only; the BOLT-11 invoices and connection material remain in the private WSL data directory.

## Reproduction

From PowerShell, generate a report from the existing completed run. The source artifacts and project source are mounted read-only; only the report directory is writable:

```powershell
wsl -d Ubuntu -- bash -lc 'docker run --rm -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe/reports:/app/reports" -v "/home/uk/.local/share/nwc-limitprobe-phase4-5:/run/private:ro" -w /app node:22-bookworm npm run phase6:report'
```

The command writes `reports/phase6-evidence.json`. By default `generatedAt` is the current UTC time. To reproduce identical JSON bytes from the same evidence, pass an explicit timestamp and output path:

```powershell
wsl -d Ubuntu -- bash -lc 'docker run --rm -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe/reports:/app/reports" -v "/home/uk/.local/share/nwc-limitprobe-phase4-5:/run/private:ro" -w /app node:22-bookworm npm run phase6:report -- --generated-at 2026-10-01T11:32:30.540Z --out reports/phase6-evidence.json'
```

Run all tests with `npm test`.

## Tests and audit

The report tests cover PASS, FAIL, INCONCLUSIVE, required fields, secret-bearing input projection, and byte-stable output for identical evidence and timestamp. They also verify missing Bob settlement amounts remain inconclusive. The shared Phase 4–5 and NIP encryption regression tests remain in the same suite.

The project-root `AGENTS.md`, `SPEC.md`, and `DESIGN.md` are the restored NWC LimitProbe source-of-truth documents. A credential scan found no secret-like values in them before commit.
