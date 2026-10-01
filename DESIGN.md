# NWC LimitProbe — Technical Design

## System boundary

```text
Dashboard / runner
  └─ NWC client ⇄ local Nostr relay ⇄ Alby Hub (system under test)
                                      └─ payer LND (Polar)
                                           ⇄ receiver LND (Polar)
```

LimitProbe observes the wallet only through NWC. Direct receiver-node access may create invoices and confirm ground truth, but must not alter the wallet under test or its budget state.

Runtime baseline: Node.js 22 and the previously selected `nostr-core` NWC client, kept behind the narrow adapter below so protocol details do not leak across the application.

## Components

- **Runner:** owns one test run, validates inputs, captures the initial budget, coordinates the start barrier, and enforces timeouts.
- **NWC adapter:** the narrow NIP-47 boundary for capability discovery, budget retrieval, `pay_invoice`, and `lookup_invoice`.
- **Race coordinator:** prepares two immutable payment attempts, releases them in the same event-loop turn, and records monotonic dispatch/response times.
- **Reconciler:** polls each invoice to a terminal state within a bounded window and preserves contradictory or missing evidence.
- **Evaluator:** pure logic that applies the invariant to captured evidence and returns PASS, FAIL, or INCONCLUSIVE with reason codes.
- **Reporter:** emits a versioned JSON report and the small dashboard view from the same result model.

Do not introduce a reusable payment abstraction beyond what this single probe requires.

## Run model

```text
created → validating → budget_captured → armed → racing
        → reconciling → evaluating → pass | fail | inconclusive
```

Each attempt records: invoice/payment hash, principal, dispatch and response timestamps, wallet response/error, lookup observations, terminal settlement state, settled amount, and fee when available. Never log the NWC secret or payment preimage.

The run records: schema version, run ID, wallet label, relay URL, advertised capabilities, starting budget and its units/window, barrier-release timestamp, reconciliation deadline, evaluator version, result, and reason codes.

## Concurrency and reconciliation

Before release, validate both invoices and construct both requests. Use a shared deferred promise/barrier; each task awaits it, then calls `pay_invoice` without awaiting the other task. Record timestamps immediately around transport dispatch.

After both calls resolve or time out, reconcile both invoices with `lookup_invoice`. Where possible, cross-check against the receiver LND node. The authoritative conclusion is based on terminal settlement evidence:

- count a confirmed settled invoice once;
- do not count pending, unknown, expired, or failed invoices as settled;
- classify the run as INCONCLUSIVE when evidence needed for the invariant remains unresolved;
- keep principal and fees separate, while preserving the wallet's stated budget semantics in the report.

All timeouts, polling intervals, and retry counts are explicit configuration and recorded in the run.

## Suggested repository shape

```text
src/
  nwc/           # narrow protocol adapter
  probe/         # runner, barrier, reconciler, evaluator
  report/        # versioned result schema and JSON export
  ui/            # small dashboard only
tests/
  unit/          # invariant, state transitions, redaction
  integration/   # local relay + Alby Hub + Polar path
fixtures/
  electrum-4.7.1/  # optional, clearly labeled historical fixture
```

## Phased build and review gates

1. **Polar + Lightning:** payer and receiver LND nodes, funded channel, two payable invoices.
2. **Alby Hub + NWC:** local relay and a constrained NWC connection.
3. **Single payment:** pay once and confirm it with `lookup_invoice`.
   - **GPT-6 Sol High checkpoint A — feasibility:** review the end-to-end proof, permission model, secret handling, and whether the black-box boundary remains intact. Stop and fix blockers before building the race.
4. **Concurrent race:** shared barrier, two simultaneous `pay_invoice` calls, complete timing evidence.
5. **Settlement and invariant:** bounded lookup reconciliation and pure result evaluation.
6. **PASS/FAIL report:** versioned evidence model, INCONCLUSIVE paths, JSON export, and redaction.
   - **GPT-6 Sol High checkpoint B — correctness:** review concurrency semantics, settlement authority, budget/fee accounting, false PASS risks, and tests. Resolve high-severity findings before UI work.
7. **Historical fixture (optional):** faithful Electrum 4.7.1 reproduction or an explicitly simulated deterministic fixture.
8. **Tiny UI and demo polish:** render the existing runner/report; do not move correctness logic into the UI.
   - **GPT-6 Sol High checkpoint C — demo readiness:** review scope, judge-facing clarity, reproducibility, failure handling, and claims about live versus fixture evidence.

The first go/no-go milestone is Phase 3: one successful Alby Hub → NWC → Polar/LND payment with independent settlement confirmation.
