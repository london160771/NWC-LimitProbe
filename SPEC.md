# NWC LimitProbe — Product Specification

## Product

**NWC LimitProbe** is a black-box conformance and stress tester for Nostr Wallet Connect spending limits.

> AI agents are given Bitcoin wallets with spending limits. LimitProbe proves whether those limits actually stop overspending.

- **Primary track:** Machine Money
- **Secondary fit:** Freedom Stack
- **Primary users:** NWC wallet developers and operators giving autonomous agents Lightning wallets

## Problem and invariant

Concurrent payment requests can race a wallet's budget accounting: both may pass a limit check before either updates the remaining budget. LimitProbe tests the externally observable invariant:

```text
settled principal attributable to the test <= spendable budget at test start
```

Fees, wallet-reported budget semantics, and timestamps must be recorded separately so the report does not hide ambiguity. A payment response alone is not proof of settlement.

## MVP scenario

1. Connect to one Alby Hub NWC connection with `pay_invoice` and the available budget/invoice-lookup permissions.
2. Read and record the starting budget.
3. Obtain two distinct BOLT11 invoices from the receiver LND node in Polar. Each invoice is individually affordable, but their combined principal exceeds the configured budget (demo default: 1,000 sats).
4. Hold both requests behind one start barrier, then dispatch both `pay_invoice` calls concurrently.
5. Capture request, response, error, and timing data without serializing the calls.
6. Reconcile each invoice's final state with `lookup_invoice`, retrying only within a bounded settlement window.
7. Sum only confirmed settled principal, report fees separately, evaluate the invariant, and show a clear result.

## Result semantics

- **PASS:** reconciliation is complete and settled principal does not exceed the starting spendable budget.
- **FAIL:** reconciliation is complete and settled principal exceeds the starting spendable budget.
- **INCONCLUSIVE:** budget cannot be established, settlement cannot be reconciled, required NWC capabilities are unavailable, or the run is otherwise invalid.

`INCONCLUSIVE` must never be presented as `PASS`. A rejected payment is useful evidence but does not itself determine the result; actual settlement does.

## Dashboard

Keep the dashboard to one test flow:

- connection/capability status, with secrets redacted;
- starting budget and two requested invoice amounts;
- synchronized launch control and live per-payment states;
- wallet responses, final settlement, fees, and timing;
- prominent PASS, FAIL, or INCONCLUSIVE result;
- compact downloadable JSON report.

The Alby browser extension is optional and must not be a runtime dependency.

## Acceptance criteria

- A local regtest path works end to end: local Nostr relay → Alby Hub → payer LND in Polar → receiver LND in Polar.
- A single NWC payment can be sent and independently reconciled.
- Two requests are demonstrably launched from the same barrier with dispatch timestamps recorded.
- Final classification is derived from reconciled invoice state, not only `pay_invoice` responses.
- The report is deterministic for captured evidence, redacts NWC secrets/preimages, and explains the tested invariant.
- The current Alby Hub run produces an honest conformance result; no vulnerability is assumed.

## Non-goals

- A generic wallet or payment SDK
- A wallet product, AI-agent marketplace, or production spending guardrail
- Multi-wallet support in the MVP
- A general security scanner, fuzzing platform, or fault lab
- Mainnet funds or a mandatory browser extension
- Making the historical Electrum reproduction a release blocker

## Stretch goal

Reproduce the historical Electrum 4.7.1 failure. If a faithful end-to-end environment is too costly, use a clearly labeled deterministic fixture. Fixture results must never be represented as a live wallet test.
