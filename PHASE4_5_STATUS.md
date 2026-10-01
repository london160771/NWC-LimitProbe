# Phase 4–5 completion record

Date: 2026-10-01

## Outcome

Phase 1–3 remained intact. The existing Polar network, Alice/Bob nodes, channel, Alby Hub, and relay were reused. Phase 4 created one fresh 1,000 sat non-renewing NWC connection, then dispatched exactly two 700 sat Bob invoices through a shared synchronization barrier. Phase 5 independently reconciled both payment hashes using Bob's `lncli lookupinvoice`.

**Classification: PASS.** Bob confirms 700 sats settled and the second invoice remains unpaid. `700 <= 1,000` sats. The NWC responses were recorded but were not used to decide the invariant.

## Fresh connection and preflight

| Setting | Verified value |
| --- | --- |
| Hub / payer | Existing Alby Hub / Alice LND |
| Network | regtest |
| Relay | `ws://limitprobe-relay:8080` |
| Encryption | NIP-44; verified |
| App name | `LimitProbe Phase4 Race` |
| Budget | 1,000 sat; 1,000,000 msat |
| Renewal | `never` |
| Used before race | 0 sat |
| Scopes | `get_balance`, `get_info`, `lookup_invoice`, `pay_invoice` |
| Required methods advertised and checked | `get_balance`, `get_budget`, `get_info`, `lookup_invoice`, `pay_invoice` |
| Payer balance before race | 489,530,000 msat |

`get_budget` was rejected as an app-creation scope by Hub CLI, so it was not added to the app scopes. The fresh connection's NWC info event advertised `get_budget`, and both preflight and post-race `get_budget` calls succeeded. No payment was made during preflight. The previous 10,000 sat Phase 2–3 connection was not used.

The fresh NWC URI and app configuration are outside the repository at `/home/uk/.local/share/nwc-limitprobe-phase4-5/nwc-url` and `/home/uk/.local/share/nwc-limitprobe-phase4-5/app-config.json`. Invoice strings, raw Hub/CLI output, and runtime results also remain in that mode-700 private directory; private files use mode 600. Only payment hashes and sanitized evidence appear below.

## Race evidence

Both invoices decoded as distinct 700 sat regtest invoices. Bob's initial lookups matched the hashes and reported `OPEN`, `settled=false`, and `amt_paid_sat=0` for each before dispatch.

Starting budget was queried from the fresh NWC connection immediately before release: total 1,000,000 msat, used 0 msat, spendable 1,000,000 msat (1,000 sat), renewal `never`. Both requests were prepared before entering the same two-party barrier.

| Event | UTC |
| --- | --- |
| Starting budget captured | 2026-10-01T10:35:46.815Z |
| Both requests prepared | 2026-10-01T10:35:46.821Z |
| Shared barrier released | 2026-10-01T10:35:46.822Z |
| A dispatched | 2026-10-01T10:35:46.822Z |
| B dispatched | 2026-10-01T10:35:46.823Z |
| Dispatch delta (monotonic clock) | 1.704 ms |

| Request | Payment hash | NWC `pay_invoice` result | Error | Fee |
| --- | --- | --- | --- | --- |
| A | `3dd82bf3dc7ec6c8e977f770f0373df3f34e6b73df29a2f60f74b5cb3a974e48` | success | — | 0 msat |
| B | `70fa8bc6f15bcbe9b3fbd39610931db03d364d8e1b94df064e7d9b33f8387810` | error | `QUOTA_EXCEEDED` | not reported |

The NWC `lookup_invoice` follow-up reported A settled for 700,000 msat and B `NOT_FOUND`; Bob's independent queries below are the reconciliation ground truth.

## Bob-side reconciliation and invariant

| Request | Bob state | Settled | `amount_paid_sat` | Bob settlement time (UTC) |
| --- | --- | --- | ---: | --- |
| A | `SETTLED` | true | 700 | 2026-10-01T10:35:47.000Z |
| B | `OPEN` | false | 0 | — |

Both lookups matched their expected payment hashes and were independently reconciled. `totalSettledPrincipalSats = 700`; starting spendable budget was 1,000 sats; classification is **PASS**.

Post-race NWC budget: total 1,000,000 msat, used 700,000 msat (700 sat), remaining 300,000 msat (300 sat), renewal `never`.

## Reproduction commands

Run these from PowerShell in this workspace. Linux and Docker commands use the existing Ubuntu WSL distro and existing Docker network. The commands mount only private files as data; they never print the NWC URI or BOLT-11 invoices.

Focused test suite (9 passed, 0 failed):

```powershell
npm test
```

Preflight the already-created fresh connection without sending payments:

```powershell
wsl -d Ubuntu -- bash -lc 'docker run --rm --network polar-network-1_default -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "/home/uk/.local/share/nwc-limitprobe-phase4-5:/run/private:ro" -w /app node:22-bookworm node scripts/phase45-nwc-preflight.mjs'
```

Create two Bob invoices (the completed run used this `lncli` command once for A and once for B; capture raw JSON only in the private directory), then validate and extract hashes without printing invoice strings:

```powershell
wsl -d Ubuntu -- bash -lc 'set -euo pipefail; d="/home/uk/.local/share/nwc-limitprobe-phase4-5"; umask 077; docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest addinvoice --amt=700 > "$d/bob-addinvoice-a.json"; docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest addinvoice --amt=700 > "$d/bob-addinvoice-b.json"; docker run --rm -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "$d:/run/private" -w /app node:22-bookworm node scripts/phase45-save-invoices.mjs'
```

The race runner checks the saved 1,000 sat app configuration and the two initial Bob lookups, rechecks the NWC starting budget, arms one shared barrier, releases both prepared `pay_invoice` requests, then records both responses and the post-race NWC budget. It writes a one-time dispatch sentinel before release so it cannot be rerun accidentally:

Verify both invoices are still open and unpaid on Bob before dispatch:

```powershell
wsl -d Ubuntu -- bash -lc 'set -euo pipefail; d="/home/uk/.local/share/nwc-limitprobe-phase4-5"; a="$(cat "$d/bob-payment-hash-a")"; b="$(cat "$d/bob-payment-hash-b")"; umask 077; docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice "$a" > "$d/bob-lookup-initial-a.json"; docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice "$b" > "$d/bob-lookup-initial-b.json"; chmod 600 "$d"/bob-lookup-initial-*.json; docker run --rm -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "$d:/run/private" -w /app node:22-bookworm node scripts/phase45-parse-bob-lookups.mjs initial'
```

```powershell
wsl -d Ubuntu -- bash -lc 'set -euo pipefail; d="/home/uk/.local/share/nwc-limitprobe-phase4-5"; test ! -e "$d/phase45-payment-dispatch-started"; docker run --rm --network polar-network-1_default -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "$d:/run/private" -w /app node:22-bookworm node scripts/phase45-race.mjs'
```

Independent Bob reconciliation (the completed run queried each hash once; raw JSON stays private and is removed by the sanitizer after parsing):

```powershell
wsl -d Ubuntu -- bash -lc 'set -euo pipefail; d="/home/uk/.local/share/nwc-limitprobe-phase4-5"; a="$(cat "$d/bob-payment-hash-a")"; b="$(cat "$d/bob-payment-hash-b")"; umask 077; docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice "$a" > "$d/bob-lookup-final-a.json" 2> "$d/bob-lookup-final-a.stderr"; docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice "$b" > "$d/bob-lookup-final-b.json" 2> "$d/bob-lookup-final-b.stderr"; chmod 600 "$d"/bob-lookup-final-*.json "$d"/bob-lookup-final-*.stderr; docker run --rm -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "$d:/run/private" -w /app node:22-bookworm node scripts/phase45-parse-bob-lookups.mjs final'
```

The two-payment command is deliberately one-shot. Do not rerun it: the existing private sentinel marks that payment dispatch occurred.

## Tests and files

`npm test`: 9 passed, 0 failed. The focused Phase 4–5 tests cover the two-party barrier, both payment calls being started before either resolves, budget normalization, settled-principal summing, PASS/FAIL/INCONCLUSIVE invariant classification, two-outcome reconciliation, and ambiguous or incomplete evidence. The two existing NIP-44/NIP-04 regression tests also pass.

Files added:

- `scripts/phase45-core.mjs`
- `scripts/phase45-nwc-preflight.mjs`
- `scripts/phase45-parse-bob-lookups.mjs`
- `scripts/phase45-race.mjs`
- `scripts/phase45-save-invoices.mjs`
- `tests/phase45-core.test.mjs`
- `PHASE4_5_STATUS.md`

## Git and secret audit

Git baseline: `94dd4b3` (`Baseline: verified Phase 1-3`). Phase 4–5 changes are uncommitted additions listed above; tracked Phase 1–3 files were not modified. The prior Phase 2–3 record's statement that Git metadata was absent predates the baseline commit.

The NWC URI, credentials, invoices, preimages, RPC credentials, TLS/macaroon contents, and raw runtime outputs are outside the workspace and are not included in project files. Project evidence records payment hashes only. The report and scripts contain no live NWC URI, invoice string, preimage, password, token, macaroon, or Bitcoin RPC credential. The existing NIP-44 regression fixture contains only synthetic test data. `.gitignore` excludes `node_modules`, credential/runtime directories, NWC/credential/token files, invoices, and other private artifacts.

## Assumptions and blockers

- `get_budget` is exposed as an NWC method by this Hub build even though Hub CLI does not accept it as an app scope; the method worked before and after the race.
- Hub budget enforcement rejected the second concurrent request with `QUOTA_EXCEEDED`; Bob independently confirms it did not settle.
- No blockers remain for Phase 4–5. The run stopped here; dashboard and historical Electrum fixture work did not start.
