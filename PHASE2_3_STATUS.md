# Phase 2–3 completion record

Date: 2026-09-29

## Outcome

Phase 1 was preserved. The existing Polar network, funded Alice node, Bob node, and active channel were not recreated or changed.

Phase 2 passed after a repository-stored patch to `nostr-core@1.0.4`. Phase 3 completed one 1,000 sat payment from Alby Hub through NWC to one invoice created on Bob. Alby's NWC `lookup_invoice` reported settlement, and Bob's LND `lookupinvoice` independently confirmed the same payment hash, amount, and settlement time.

No concurrency or race test was started.

## Exact dependency bug and patch

The installed `nostr-core@1.0.4` selected NIP-44 from the wallet's NWC info event and encrypted the request with NIP-44, but `dist/nwc.js` built request events with only `[['p', this.walletPubkey]]`. NIP-47 treats a missing `encryption` tag as NIP-04, so Alby Hub attempted NIP-04 decryption and returned `BAD_REQUEST: failed to decrypt … no initialization vector`.

The patch adds `['encryption', 'nip44_v2']` when `requestScheme === 'nip44'`. For NIP-04, it retains the existing `p`-only tags, which preserves the legacy NIP-04 behavior. NIP-47's [encryption negotiation rules](https://github.com/nostr-protocol/nips/blob/master/47.md) specify the selected encryption tag and the NIP-04 default when it is absent.

The patch is reproducible through `patch-package`, not a manual `node_modules` edit:

- `patches/nostr-core+1.0.4.patch` contains the dependency diff.
- `package.json` pins `patch-package@8.0.0` and runs it in `postinstall`.
- `package-lock.json` pins the dependency graph.

## Regression result

`npm test` passed: 2 tests, 0 failures.

- NIP-44 generated request includes `['encryption', 'nip44_v2']`.
- NIP-04 generated request retains only the `p` tag.

## Phase 2 result

The live check used the existing Alby Hub and local relay. It connected, read the wallet info event, confirmed NIP-44 by a successful `get_info` round trip, then called `get_balance`.

- NWC connection: connected through `ws://limitprobe-relay:8080`
- Encryption: `nip44`; verified: `true`
- Wallet info event advertised `nip44_v2 nip04`.
- Wallet network: `regtest`
- Balance before the payment: `490530000` msat
- Required methods present: `get_info`, `get_balance`, `pay_invoice`, `lookup_invoice`
- Additional advertised methods: `get_budget`, `multi_pay_invoice`, `multi_pay_keysend`, `pay_keysend`
- `get_budget`: succeeded
- Configured app budget: 10,000 sat, renewal `never`

After the clean install and completed payment, the Phase 2 check was rerun successfully; the remaining balance was `489530000` msat.

## Phase 3 result

Exactly one Bob invoice was created with `lncli addinvoice --amt=1000`. The BOLT-11 decoder confirmed 1,000 sat and the regtest network before payment. Alby Hub received exactly one NWC `pay_invoice` request.

| Field | Result |
| --- | --- |
| Payment amount | 1,000 sat (1,000,000 msat) |
| Payment hash | `2a8c89092417052e73bf8815ff57847d171f7e0d1961bdd9cc2aa98b70f670c2` |
| NWC payment response | `success` |
| Fees | 0 msat |
| Dispatch time | `2026-09-29T20:15:30.154Z` |
| NWC response time | `2026-09-29T20:15:33.917Z` |
| Alby `lookup_invoice` state | `settled`, observed at `2026-09-29T20:15:34.039Z` |
| Bob LND `lookupinvoice` | settled; hash matched; `amt_paid_sat=1000` |
| Bob settlement time | `2026-09-29T20:15:33.000Z` (Unix `1790712933`) |

Bob's lookup was run directly against `polar-n1-bob` using the payment hash. Raw `lncli` JSON was piped into `scripts/verify-bob-settlement.mjs`; the preimage was not printed.

## Local services and private file locations

| Component | Location / endpoint |
| --- | --- |
| Existing Polar Docker network | `polar-network-1_default` (`NWC-LimitProbe`) |
| Alby Hub | `limitprobe-albyhub`, image `ghcr.io/getalby/hub:v1.24.0`, UI `http://127.0.0.1:8080` |
| Local relay | `limitprobe-relay`, `ws://limitprobe-relay:8080`, no host port published |
| Alice LND | `polar-n1-alice:10009` inside Docker; host gRPC port `10001` |
| Bob LND | `polar-n1-bob:10009` inside Docker; host gRPC port `10002` |
| Hub data | `/home/uk/.local/share/nwc-limitprobe-phase2-3/albyhub` |
| Relay database | `/home/uk/.local/share/nwc-limitprobe-phase2-3/relay` |
| Hub password | `/home/uk/.local/share/nwc-limitprobe-phase2-3/credentials/hub-password` |
| Hub CLI token | `/home/uk/.local/share/nwc-limitprobe-phase2-3/hub-cli/token.jwt` |
| NWC URI | `/home/uk/.local/share/nwc-limitprobe-phase2-3/nwc-output/nwc-url` |
| Bob invoice and payment hash | `/home/uk/.local/share/nwc-limitprobe-phase2-3/invoice/` |
| Alice TLS certificate | `/home/uk/.polar/networks/1/volumes/lnd/alice/tls.cert`, mounted read-only at `/lnd/tls.cert` |
| Alice admin macaroon | `/home/uk/.polar/networks/1/volumes/lnd/alice/data/chain/bitcoin/regtest/admin.macaroon`, mounted read-only at `/lnd/admin.macaroon` |

The NWC URI, password, token, TLS certificate contents, macaroon contents, Bob invoice, and preimage are not recorded in project documentation. The payment hash is recorded because it is the requested payment identifier; it is not an NWC connection secret.

## Commands

Run from PowerShell. Linux/Docker work uses the existing Ubuntu WSL distro. The `node:22-bookworm` image runs Node 22; no Node installation or Polar rebuild is required in WSL.

Install/pin the patch mechanism and apply the checked-in patch:

```powershell
wsl -d Ubuntu -- bash -lc 'docker run --rm -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app" -w /app node:22-bookworm npm install --no-audit --no-fund --save-dev --save-exact patch-package@8.0.0'
wsl -d Ubuntu -- bash -lc 'docker run --rm -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app" -w /app node:22-bookworm npm run postinstall'
```

The clean lockfile reproduction also completed successfully and applied `nostr-core@1.0.4 ✔` from `postinstall`:

```powershell
wsl -d Ubuntu -- bash -lc 'docker run --rm -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app" -w /app node:22-bookworm npm ci --no-audit --no-fund'
```

Run the focused regression checks:

```powershell
wsl -d Ubuntu -- bash -lc 'docker run --rm -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -w /app node:22-bookworm npm test'
```

Run the complete Phase 2 NWC check (the URI is mounted read-only and never printed):

```powershell
wsl -d Ubuntu -- bash -lc 'docker run --rm --network polar-network-1_default -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "/home/uk/.local/share/nwc-limitprobe-phase2-3/nwc-output/nwc-url:/run/secrets/nwc-url:ro" -w /app node:22-bookworm node scripts/phase2-nwc-check.mjs'
```

Create and privately extract one Bob invoice. The temporary raw CLI JSON is mode 600 and is removed after the extractor validates the BOLT-11 amount, network, and hash:

```powershell
wsl -d Ubuntu -- bash -lc 'set -euo pipefail; mkdir -m 700 -p "/home/uk/.local/share/nwc-limitprobe-phase2-3/invoice"; chmod 700 "/home/uk/.local/share/nwc-limitprobe-phase2-3/invoice"; umask 077; docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest addinvoice --amt=1000 --memo="NWC LimitProbe Phase 3" > "/home/uk/.local/share/nwc-limitprobe-phase2-3/invoice/bob-addinvoice.json"; cat "/home/uk/.local/share/nwc-limitprobe-phase2-3/invoice/bob-addinvoice.json" | docker run --rm -i -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "/home/uk/.local/share/nwc-limitprobe-phase2-3/invoice:/run/invoice" -w /app node:22-bookworm node scripts/save-bob-invoice.mjs; rm -f "/home/uk/.local/share/nwc-limitprobe-phase2-3/invoice/bob-addinvoice.json"'
```

Pay once through NWC and poll NWC `lookup_invoice` for settlement:

```powershell
wsl -d Ubuntu -- bash -lc 'docker run --rm --network polar-network-1_default -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "/home/uk/.local/share/nwc-limitprobe-phase2-3/nwc-output/nwc-url:/run/secrets/nwc-url:ro" -v "/home/uk/.local/share/nwc-limitprobe-phase2-3/invoice/bob-invoice:/run/secrets/bob-invoice:ro" -v "/home/uk/.local/share/nwc-limitprobe-phase2-3/invoice/bob-payment-hash:/run/secrets/bob-payment-hash:ro" -w /app node:22-bookworm node scripts/phase3-single-payment.mjs'
```

Independently verify settlement on Bob. Raw `lncli` output is piped through the verifier, which prints only the payment hash, settled state, amount, and settlement time:

```powershell
wsl -d Ubuntu -- bash -lc 'set -o pipefail; docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice 2a8c89092417052e73bf8815ff57847d171f7e0d1961bdd9cc2aa98b70f670c2 2>/dev/null | docker run --rm -i -v "/mnt/c/Users/uk/OneDrive/Desktop/NWC limitprobe:/app:ro" -v "/home/uk/.local/share/nwc-limitprobe-phase2-3/invoice/bob-payment-hash:/run/secrets/bob-payment-hash:ro" -w /app node:22-bookworm node scripts/verify-bob-settlement.mjs'
```

## Files changed

- `package.json`, `package-lock.json`
- `patches/nostr-core+1.0.4.patch`
- `tests/nwc-encryption-tag.test.mjs`
- `scripts/phase2-nwc-check.mjs`
- `scripts/phase3-single-payment.mjs`
- `scripts/save-bob-invoice.mjs`
- `scripts/verify-bob-settlement.mjs`
- `scripts/save-nwc-url.mjs`
- `.gitignore`
- `PHASE2_3_STATUS.md`

The workspace has no Git metadata, so there is no Git diff. `node_modules/` remains ignored and the runtime patch was applied by `patch-package` from the checked-in patch file.

## Secrets/output audit and assumptions

- The NWC URI, password, token, TLS certificate contents, macaroon contents, invoice string, and preimage were not printed or stored in project documentation.
- Secret-bearing files remain outside the workspace in the WSL private data directory. Invoice artifacts were written mode 600; the temporary raw `addinvoice` response was removed.
- The payment hash above is intentionally recorded to satisfy the reconciliation record.
- The Phase 3 report intentionally includes that requested payment hash; its misleading hash-redacted flag was removed from the script after inspecting the output.
- The prior container-inspection output that exposed Bitcoin Core RPC credential fields is not present in project files or documentation.
- Assumption verified: Alby Hub can use the existing Alice LND node on regtest and the existing relay when NIP-47 encryption is correctly tagged.
- Phase 3 was one invoice and one NWC payment only; no concurrency test was performed.
- The GPT-6 Sol High post-Phase-3 feasibility checkpoint has been reached. Stop implementation here.
