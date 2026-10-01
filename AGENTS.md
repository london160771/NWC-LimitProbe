# NWC LimitProbe — Agent Guide

## Mission

Build the smallest credible black-box NWC spending-limit conformance/stress tester for the BOSS Battle hackathon.

- Primary track: **Machine Money**
- Secondary fit: **Freedom Stack**
- System under test: **Alby Hub**
- Local stack: **two LND nodes in Polar + local Nostr relay + NWC client**
- Core proof: **synchronized concurrent payments → `lookup_invoice` reconciliation → PASS/FAIL/INCONCLUSIVE**

`SPEC.md` defines product behavior. `DESIGN.md` defines the architecture and build sequence. If code or plans conflict with either file, stop and resolve the conflict explicitly; do not silently expand scope.

## Non-negotiable rules

1. Treat Alby Hub as a black box and use NWC for wallet operations.
2. Never infer settlement solely from a successful `pay_invoice` response; reconcile every attempt with `lookup_invoice` and, where available, receiver evidence.
3. Never convert missing or contradictory evidence into PASS. Use INCONCLUSIVE with a reason.
4. Launch both payment requests from one explicit barrier. Do not accidentally serialize them.
5. Keep principal, fees, budget units, and budget window semantics explicit.
6. Never log or commit NWC secrets, macaroon material, seed phrases, TLS keys, payment preimages, or other credentials. Redact them in UI, fixtures, reports, and test output.
7. Use regtest/local funds only for the MVP.
8. Keep protocol, evaluator, and report logic independent of the UI.
9. Add only the narrow interfaces required by the current phase. Do not create a generic wallet/payment SDK, multi-wallet layer, fuzzing framework, or fault lab.
10. The Electrum 4.7.1 path is optional. Label simulations as fixtures and never present them as live-wallet evidence.

## Required workflow

Work in this order and finish each phase with a reproducible proof before advancing:

1. Polar + Lightning works.
2. Alby Hub + NWC connection works.
3. One payment works and settles.
4. Two payments launch concurrently.
5. Settlement reconciliation and the invariant work.
6. The result/report works.
7. The historical fixture is attempted only if time remains.
8. The tiny dashboard and demo are polished last.

For every phase:

- state the smallest testable outcome;
- implement only what that outcome requires;
- add or update focused tests;
- run the relevant checks and record exact reproduction steps;
- update the docs when observed protocol behavior differs from an assumption;
- preserve evidence for errors and INCONCLUSIVE results instead of hiding them.

## GPT-6 Sol High checkpoints

Request a **GPT-6 Sol with High reasoning** review at these gates and do not self-approve the gate:

- **After Phase 3 — feasibility:** end-to-end topology, NWC permissions/capabilities, secret handling, and settlement proof.
- **After Phase 6 — correctness:** actual concurrency, reconciliation, invariant math, timeout behavior, redaction, tests, and false PASS/FAIL risks.
- **After Phase 8 — demo readiness:** narrow scope, reproducible setup, dashboard clarity, report claims, and live-versus-fixture labeling.

Give the reviewer `SPEC.md`, `DESIGN.md`, the relevant diff, test output, and a concise list of unresolved assumptions. Address high-severity findings before proceeding; document any consciously deferred lower-severity item.

## Definition of done

The MVP is done when a fresh local setup can run one documented test against Alby Hub, launch two invoices from the same barrier, reconcile both final states, and produce a redacted, downloadable report with a defensible PASS, FAIL, or INCONCLUSIVE result. The demo must explain that LimitProbe tests the guardrail—it is not the guardrail.
