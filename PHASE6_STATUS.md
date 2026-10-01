# Phase 6 and Phase 6.1 status

## Evidence status

The existing `reports/phase6-evidence.json` and the PASS described in the original Phase 6 record are **historical and provisional**. They lack the run binding, bounded receiver observation history, and validated NWC lookup evidence now required by Phase 6.1. Do not use that report as final evidence or as the result of a fresh run.

Phase 6.1 correctness hardening is implemented and unit-tested. A fresh live race and replacement evidence report have **not** been produced in this environment. On 2026-10-01, `wsl -d Ubuntu -- bash -lc '...'` returned WSL usage help instead of starting Ubuntu. No fresh connection, invoice, or payment was created, and no live result is claimed.

## Phase 6.1 behavior

- Each run receives a fresh run ID that is bound to both invoices, initial Bob observations, dispatch attempts, NWC lookup observations, and final Bob observations.
- Bob lookup observations include the requested and returned hashes, expected amount, state, paid amount, and timestamp. Reconciliation polls for 90 seconds at 2-second intervals and captures a final observation at or just after the deadline. Because LND settlement timestamps have second precision, a settlement in the barrier's release second is ambiguous and cannot establish attribution. `OPEN`, `ACCEPTED`, `PENDING`, `NOT_FOUND`, or missing evidence at the deadline remains unresolved and produces `INCONCLUSIVE` unless a valid terminal Bob state is present.
- Final NWC lookups happen after Bob's bounded observation window. The report preserves NWC requested hash, returned hash, state, amount, fees, timestamp, and missing values. Missing, stale, mismatched, or contradictory NWC evidence prevents PASS.
- Dispatch timing records the shared barrier release, per-request wall and monotonic timestamps, response times, and call-start delta. It proves both client calls started before either response; it does not claim Alby Hub internal overlap or transport publication timing.
- Error codes use a fixed allowlist with `OTHER` fallback. Input fields are validated and reports are constructed from an allowlist.
- Budget fields accept strict integer numbers or digit strings only when the field name explicitly declares msat; unitless budget fields, booleans, conflicting aliases, and inconsistent total/used/remaining arithmetic are rejected. Principal, payment fees, and wallet budget values remain separate. A post-race budget is supplementary and cannot hide an otherwise proven FAIL.
- Reports derive their default generated timestamp from captured evidence, so identical evidence produces identical report bytes.

## Tests

From PowerShell in the project root:

```powershell
npm test
```

Phase 6.1 test result in this environment: **31 passed, 0 failed**. The suite covers the shared barrier, delayed settlement, deadline timeout, NWC/Bob contradiction, stale and mismatched run evidence, strict msat arithmetic, booleans, serialized timing, conflicting duplicate observations, redaction, post-dispatch persistence, missing start budget, and PASS/FAIL/INCONCLUSIVE report cases.

## Fresh live rerun procedure

Use an unused private directory, for example `/home/uk/.local/share/nwc-limitprobe-phase6-1`, with mode `700` and `umask 077`. Configure a **new** Alby Hub NWC app/connection named `LimitProbe Phase6.1 Race` with exactly 1,000 sats, renewal `never`, and scopes `get_balance`, `get_info`, `lookup_invoice`, and `pay_invoice`. Save its sanitized app configuration and NWC URI in that private directory only. Do not reuse the Phase 2–3 or Phase 4–5 connection.

The following commands assume the existing Polar topology and Docker network remain available. Run them from PowerShell through WSL as shown; they do not recreate Polar, nodes, channels, Hub, or relay.

Create two invoices once, then validate/store their hashes and create the run ID. Raw invoice JSON is private and is removed by the capture script:

```powershell
wsl -d Ubuntu -- bash -lc 'set -euo pipefail; d="/home/uk/.local/share/nwc-limitprobe-phase6-1"; umask 077; docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest addinvoice --amt=700 > "$d/bob-addinvoice-a.json"; docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest addinvoice --amt=700 > "$d/bob-addinvoice-b.json"; docker run --rm -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "$d:/run/private" -w /app node:22-bookworm node scripts/phase45-save-invoices.mjs'
```

Capture initial Bob state, sanitize it, and verify the fresh NWC connection without paying:

```powershell
wsl -d Ubuntu -- bash -lc 'set -euo pipefail; d="/home/uk/.local/share/nwc-limitprobe-phase6-1"; a="$(cat "$d/bob-payment-hash-a")"; b="$(cat "$d/bob-payment-hash-b")"; umask 077; docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice "$a" > "$d/bob-lookup-initial-a.json"; docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice "$b" > "$d/bob-lookup-initial-b.json"; docker run --rm -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "$d:/run/private" -w /app node:22-bookworm node scripts/phase45-parse-bob-lookups.mjs initial; docker run --rm --network polar-network-1_default -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "$d:/run/private:ro" -w /app node:22-bookworm node scripts/phase45-nwc-preflight.mjs'
```

Run the shared-barrier race once. The sentinel and sanitized progress file make any dispatch attempt one-shot and durable:

```powershell
wsl -d Ubuntu -- bash -lc 'set -euo pipefail; d="/home/uk/.local/share/nwc-limitprobe-phase6-1"; test ! -e "$d/phase6.1-payment-dispatch-started"; docker run --rm --network polar-network-1_default -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "$d:/run/private" -w /app node:22-bookworm node scripts/phase45-race.mjs'
```

Poll Bob through the bounded window (requires `jq` in Ubuntu), then query NWC again after Bob's final observation. Both scripts persist only sanitized evidence:

```powershell
wsl -d Ubuntu -- bash -lc 'set -euo pipefail; cd "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe"; PRIVATE_DIR="/home/uk/.local/share/nwc-limitprobe-phase6-1" bash scripts/phase45-reconcile-bob.sh'
wsl -d Ubuntu -- bash -lc 'set -euo pipefail; d="/home/uk/.local/share/nwc-limitprobe-phase6-1"; docker run --rm --network polar-network-1_default -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "$d:/run/private" -w /app node:22-bookworm node scripts/phase45-nwc-final-lookup.mjs'
```

Generate a report to a new Phase 6.1 path. The output contains payment hashes and sanitized observations only:

```powershell
wsl -d Ubuntu -- bash -lc 'set -euo pipefail; docker run --rm -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe/reports:/app/reports" -v "/home/uk/.local/share/nwc-limitprobe-phase6-1:/run/private:ro" -w /app node:22-bookworm npm run phase6:report -- --race /run/private/phase45-race-results.json --bob /run/private/bob-final-evidence.json --out reports/phase6.1-evidence.json'
```

If WSL, Docker, Polar, Alby Hub, or the new NWC connection is unavailable, stop before invoice creation/payment. Do not alter the historical report or infer a live classification from the old run.
