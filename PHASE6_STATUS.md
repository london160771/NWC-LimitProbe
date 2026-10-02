# Phase 6 status — correctness hardening

## Preserved Phase 6.1 evidence

The saved Phase 6.1 run `b542cedc-c9dc-4baf-8d87-58de1bb02a5b` remains **INCONCLUSIVE**. Its report at `reports/phase6.1-evidence.json` is a preserved regression reference and was not changed by Phase 6.2 work. The Phase 6.1 private run state and app are also outside the Phase 6.2 private directory and were not used or modified.

## Phase 6.2 implementation status

The correctness hardening is implemented and unit-tested. No live invoice or payment was created or dispatched during this phase.

- Budget evidence stores capture-time validity and issue codes. Evaluation refuses an invalid capture even if its normalized values are later changed to appear valid; persisted values are revalidated with exact msat arithmetic.
- Persisted budget snapshots must retain matching `observedAt`/`capturedAt` timestamps and consistent `valid`/`complete` flags; a missing observation timestamp cannot be recovered from another field.
- Initial Bob `OPEN` evidence must be fresh within 30 seconds of dispatch. Receiver states, hashes, run IDs, amounts, settlement timestamps, error codes, and paid sat/msat values are checked for internal consistency. When both paid units are present, `amountPaidMsat` must equal `amountPaidSat * 1000`.
- LND settlement seconds represent `[T.000, (T+1).000)`. Same-second overlap is accepted only when the run proves that both invoices were newly created for this run, independently observed OPEN/unpaid immediately before dispatch, and the controlled topology has one payer path. A settlement interval wholly before dispatch is rejected. Same-second attribution outside those conditions is inconclusive.
- NWC returned lookup records and explicit `NOT_FOUND` responses are separate evidence types. `NOT_FOUND` contains only the requested hash, run binding, timestamp, and `errorCode=NOT_FOUND`; it never proves unpaid. It can accompany independent terminal Bob `CANCELED`/`EXPIRED` evidence. NWC `FAILED` is accepted as an outgoing terminal payment result where the protocol reports it, but Bob remains the receiver-side unpaid ground truth.
- Any NWC `SETTLED` record contradicts a final independent Bob terminal-unpaid result, even if a later NWC lookup is `NOT_FOUND`.
- Bob collection uses an append-only JSONL journal. Every `lncli lookupinvoice` has an 8-second execution timeout. Sessions record start, deadline, completion, query attempts, safe error codes, observations, and one of `completed_deadline`, `completed_terminal`, `interrupted`, `collector_error`, or `query_timeout`. A resumed journal is preserved; an interrupted bounded window cannot later be represented as fully observed at the deadline.
- A collector completion claim must be supported by observations and query attempts from that session itself; it cannot borrow earlier-session evidence. Terminal completion also validates receiver hashes, settlement flags, and sat/msat amounts. A failed final NWC connection is saved as sanitized incomplete evidence so the report can remain INCONCLUSIVE.
- Final NWC lookups and a timestamped final `get_budget` happen after Bob reconciliation. PASS requires the final budget total and renewal to match the starting configuration and used msat to match independently settled principal plus reported fees. Missing or contradictory supplementary budget evidence leaves an otherwise passing run INCONCLUSIVE; independently proven FAIL remains FAIL.
- The Phase 6.2 report projects run IDs, renewal periods, states, errors, and collector fields through allowlists. Reports are deterministic from captured evidence and include receiver paid msat separately from paid sats and sender fees.

## Tests and checks

Run the complete suite from PowerShell in the project root:

```powershell
npm test
```

Phase 6.2 validation result: **65 passed, 0 failed**. Focused coverage includes all eight review findings, capture-to-persistence budget invalidation, receiver false-PASS probes, secret-shaped exported fields, final accounting contradictions, NWC `NOT_FOUND`/`FAILED` policy, collector timeout/error/interruption/restart/deadline evidence, and same-second attribution policy.

## Prepared final clean run — NOT EXECUTED

The dedicated runner is `run-phase62-live.ps1`. It uses the new private directory `/home/uk/.local/share/nwc-limitprobe-phase6-2`, creates the fresh Alby Hub app `LimitProbe-Phase62-Final`, and writes only to `reports/phase6.2-final-evidence.json`. It does not reuse Phase 6.1 credentials or overwrite the saved Phase 6.1 report.

The prepared flow is:

1. Verify existing Docker/Polar containers, the Alice-to-Bob channel, regtest health, relay, Hub, and read-only Phase 2 NWC health. Do not recreate the topology.
2. Create a fresh NWC app with exactly 1,000 sats, renewal `never`, and scopes `pay_invoice`, `get_balance`, `get_info`, and `lookup_invoice`. Keep the NWC URI and Hub token in the private directory/process environment only.
3. Run read-only NWC preflight and require NIP-44, regtest, the required methods, and budget `1,000,000 msat total / 0 used / 1,000,000 remaining`.
4. Create exactly two new Bob invoices for 700 sats each with 120-second expiry. Verify unique hashes, run binding, invoice expiry, and initial OPEN/unpaid state. Immediately before releasing the shared payment barrier, recheck the Bob observations are under 30 seconds old and each invoice still has at least 15 seconds of lifetime remaining.
5. Dispatch each `pay_invoice` once from the same barrier. Persist sanitized progress before release. Never retry after dispatch.
6. Poll Bob independently, with per-query timeouts and complete journal preservation, until A is `SETTLED` and B is terminal unpaid (`CANCELED`/`EXPIRED`), or both invoices are independently `SETTLED` (proven FAIL), or the declared 150-second deadline is actually observed. Other terminal combinations continue through the deadline.
7. After Bob reconciliation finishes, capture final NWC lookups and then a timestamped final budget. If the final NWC connection or lookup is unavailable, preserve only sanitized error evidence and generate an INCONCLUSIVE report. Generate the Phase 6.2 JSON report from those saved inputs only.

The final run must remain **INCONCLUSIVE** if Bob still reports OPEN/pending at the deadline, if a collector window was interrupted, if NWC and Bob disagree, or if final budget accounting cannot be reconciled. The prepared runner has not been invoked in this task.

## Phase 6.3 — final correctness lockdown

Status: implementation and local regression checks complete; the final live race remains **NOT EXECUTED**. The Phase 6.1 saved INCONCLUSIVE report remains a preserved reference and was not regenerated.

- A receiver-proven overspend is classified FAIL from the verified starting budget, bound attempts, and chronologically valid terminal Bob evidence. Missing or invalid NWC lookups, final-budget snapshots, or collector completion diagnostics are reported as supplementary issues and cannot downgrade that FAIL. PASS still requires all supplementary evidence to be complete and consistent.
- Collector validity is re-derived from persisted sessions, queries, and receiver observations. The validator requires actual session IDs, run/invoice binding, query-to-observation chronology, and a completion record. `completed_terminal` requires terminal observations before completion; `completed_deadline` requires completion and final successful observations at or after the declared deadline. A saved empty `collectionIssues` array has no authority.
- NWC capture records sanitized validation issue codes. Negative or malformed fees, malformed `NOT_FOUND` shapes, pre-run settlement times, conflicting fee sources, contradictory lookup histories, and a lookup completion timestamp preceding any contained observation prevent PASS. Principal and sender fees remain separate; final wallet accounting uses the fee value only when the response and lookup sources agree.
- Each initial Bob lookup carries its own acquisition timestamp from command completion. Freshness uses that timestamp, so a later parse cannot make an older result fresh. Each initial query has an eight-second bound.
- The Phase 6.2 runner now acquires an atomic run-wide lock before environment/app/invoice setup and holds it through report generation. A normal second invocation refuses. A forcibly interrupted process can leave the private lock directory; inspect its PID and run state before manually removing that lock.
- Invoice setup writes intent before A, persists A's hash-only receipt immediately, and records B intent before B is requested. Partial/ambiguous state is retained and blocks normal reruns. The explicit `phase45-invoice-setup.mjs abandon <setupId>` action marks an incomplete setup abandoned without deleting receipts or authorizing a new pair.
- The entire receiver query worker (LND query, sanitizer container, validation, and journal append) is now under one 15-second timeout. Timeout/error query records use fixed sanitized codes; the JSONL observation journal remains append-only.
- Invoice evidence persists creation/acquisition time, decoded issue time and expiry, absolute expiry, dispatch time, reconciliation deadline, and an explicit **30-second required grace**. Dispatch validation rejects issue times more than five seconds in the future, less than 15 seconds of invoice life, or a deadline earlier than expiry plus grace.
- The exported stage allowlist includes `final_nwc_lookup_and_budget_complete`.

Focused regression coverage now includes proven FAIL with missing/broken supplementary evidence, evidence-derived collector chronology, fee conflicts, per-query acquisition freshness, invoice setup partial recovery refusal, full-pipeline timeout, concurrent runner lock refusal, budget metadata contradictions, expiry/grace boundaries, and report stage projection.

The next step is an independent GPT-6 Sol High review of the Phase 6.4 integration diff and test results. The live run remains blocked until that review approves the correctness gate. No dashboard, historical fixture, invoice, or payment action was performed.

## Phase 6.4 — integration lockdown

Status: integration hardening and local checks complete; the fresh final live race remains **NOT EXECUTED**. The saved Phase 6.1 report remains INCONCLUSIVE and unchanged.

- Collector journal parsing, receiver sanitization, evaluator classification, and report projection are exercised together. Independently verified 1,400,000 msat receiver principal remains FAIL through the complete pipeline.
- Initial Bob capture timestamps flow through the actual parser into race preparation. A delayed lookup retains its own acquisition time and is rejected as stale instead of being restamped at parse time.
- Raw NWC returned records and explicit NOT_FOUND responses flow through the capture sanitizer, evaluator, and report. A malformed NOT_FOUND shape cannot produce PASS.
- Invoice setup receipts flow through the persisted run configuration and evaluator. The two invoices must remain bound to the same run, expiry, dispatch, deadline, and required grace.
- The run-wide lifecycle lock is tested with mocked app-helper commands. A second lock acquisition is refused while the first runner holds the lock; the test does not contact Alby Hub or create an app.
- A terminal-unpaid B result is acceptable for PASS only when Bob reports **CANCELED** at or after that invoice's decoded absolute expiry. `EXPIRED`, an early `CANCELED`, an unresolved/missing invoice, or elapsed wall-clock time alone is not terminal unpaid proof. The collector keeps polling an early cancellation through natural expiry; missing post-expiry CANCELED evidence remains INCONCLUSIVE.
- If Bob LND is configured to remove canceled invoices and a later lookup returns no record, preserve that missing receiver evidence as a query/evidence failure and classify INCONCLUSIVE; do not infer unpaid from expiry time or NWC `NOT_FOUND`.
- Before any future live run, both Alice and Bob must report `synced_to_chain=true` and `synced_to_graph=true` on regtest. The runner enforces both checks before it can create invoices.
- The report's persisted completed stage `final_nwc_lookup_and_budget_complete` is allowlisted and tested so a completed run does not export `stage="unknown"`.

Validation from Windows PowerShell: `npm test` — **88 passed, 0 failed**. The six focused Phase 6.4 integration tests separately cover A–E plus malformed receiver-report inputs. Syntax, diff, redaction, and preserved-report-hash checks were run; details are in the Phase 6.4 handoff. No live runner, invoice creation, or payment was performed.

Review gate: **ready for another independent GPT-6 Sol High review; not approved for a live run yet**. Preserve the existing Phase 6.1 report as a regression reference. A future run must use the fresh Phase 6.2 app and produce new evidence only after Bob's actual post-expiry CANCELED observation and final post-reconciliation NWC lookups/budget have been captured.
