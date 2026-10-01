# Post-Phase-6 correctness review

Date: 2026-10-01

Decision: **FIX-BEFORE-PROCEEDING**. The independent GPT-6 Sol reviewer with High reasoning also returned this decision. Phase 7 and Phase 8 are not approved by this review. No implementation, tests, historical fixture, dashboard, or existing evidence report was changed.

## Scope and verification

Read AGENTS.md, SPEC.md, DESIGN.md, PHASE2_3_STATUS.md, PHASE4_5_STATUS.md, PHASE6_STATUS.md, the Phase 4-6 scripts/tests, the installed nostr-core request implementation, and reports/phase6-evidence.json. Reviewed the implementation changes from baseline 94dd4b3 through 73480ff.

`npm test` completed with 15 passed, 0 failed. Additional read-only Node probes used synthetic evidence and mocked RelayPool methods. No live wallet operations were performed. Attempts to read the private original WSL artifacts could not run because the available wsl executable returned installation/usage help. The live provenance and exact original response chronology therefore remain unverified in this environment; the checked-in report and completion records were reviewed directly.

The shared barrier is correct at the application-call boundary: both tasks await the same promise, release requires two arrivals, and neither payment call awaits the other. A mock of the installed NWC transport observed two publish operations before either completed. The recorded 1.704 ms gap measures entry into payInvoice, before encryption/signing/publishing; it does not prove simultaneous receipt or overlapping execution inside Alby Hub.

Bob's direct lncli lookupinvoice path is independent of the wallet/NWC response. Settlement arithmetic on complete, valid evidence is correct for the fixed scenario: 700 <= 1,000 is within budget and 1,400 > 1,000 exceeds it. Fees are reported separately in msat. The public report uses a narrow field projection and a safe NWC error allowlist; no live credential or preimage was observed in it. These strengths do not establish settlement finality or resolve contradictions.

## Findings

### F1 — HIGH — An OPEN receiver invoice is treated as finally unpaid

Affected: scripts/phase45-core.mjs, reconcileTwoInvoices, lines 242-246; scripts/phase45-parse-bob-lookups.mjs, final branch, lines 61-86; scripts/phase45-race.mjs, NWC lookup loop, lines 125-142; reports/phase6-evidence.json.

Issue: OPEN with zero paid is immediately reconciled as unpaid. The documented Phase 5 process takes one receiver snapshot; NWC lookup also runs once. No bounded settlement window, observation timestamps, polling configuration, or deadline is recorded. A client reply timeout is not settlement cancellation. An open invoice can still settle after the observation, so 700 settled plus one OPEN invoice can incorrectly PASS.

Fix: implement the specified bounded reconciliation policy for these two invoices and record its observations/deadline. Treat OPEN/pending/accepted as unresolved unless the run also establishes a documented final rejection and sufficient independent receiver evidence. At deadline, unresolved evidence must remain INCONCLUSIVE. Preserve the existing sample as historical evidence; qualify its PASS/complete claims until finality is demonstrated. A much later lookup alone cannot reconstruct the original observation window.

### F2 — HIGH — Missing and contradictory NWC lookup evidence is ignored

Affected: scripts/phase6-evidence-report.mjs, buildEvidenceReport, lines 81-174 and report projection at 180-235; scripts/phase45-race.mjs, safeLookup, lines 73-87.

Issue: buildEvidenceReport never reads race.nwcLookups. Both absent lookups and a lookup claiming B settled while Bob reports B OPEN produce PASS with complete=true. Required NWC reconciliation is not validated or exported. safeLookup also coerces explicit null numeric fields to zero and can overwrite the requested hash with a missing response hash, obscuring what was requested versus returned.

Fix: retain separate expected and returned hashes, preserve missing numbers, allowlist lookup fields, and validate observations for both attempts. Record NWC/receiver disagreements and return INCONCLUSIVE for unresolved contradictions. A documented NOT_FOUND plus a terminal rejected attempt and independent unpaid evidence needs an explicit policy; NOT_FOUND alone is not settlement proof. Do not infer settlement from pay_invoice success.

### F3 — HIGH — Initial unpaid evidence is not bound to the dispatched invoices

Affected: scripts/phase45-race.mjs, initialBob validation, lines 27-34 and request validation at 36-56; scripts/phase45-parse-bob-lookups.mjs, initial branch, lines 31-60; scripts/phase6-evidence-report.mjs, buildEvidenceReport.

Issue: the runner only checks initialBob.phase, an aggregate boolean, and an array length. It never checks that initial evidence contains the same two hashes subsequently dispatched. The report has no initial observations or run identifier binding. Stale initial evidence can validate already-settled target invoices and falsely attribute their prior payments to this race, causing a false FAIL. A synthetic settlement timestamp before dispatch is accepted by the report.

Fix: bind initial, dispatch, NWC, and receiver evidence to one run and the same distinct hashes. Record initial observation times and validated invoice amounts. Reject stale/mismatched initial records and settlement before dispatch, allowing for LND's second-resolution settlement timestamp. Export enough sanitized attribution evidence to audit the claim.

### F4 — HIGH — Capture-stage redaction accepts arbitrary secret-shaped values

Affected: scripts/phase45-core.mjs, safeErrorCode, lines 54-57; scripts/phase45-race.mjs, errorCode, lines 67-70 and stdout/stderr at 186-195; scripts/phase45-nwc-preflight.mjs, errorCode, lines 26-30.

Issue: a 1-64 character alphanumeric/underscore/hyphen regex is not an allowlist. A synthetic 64-hex error code survives dispatchTwoPayments unchanged and would be printed by the race runner. That shape can contain an NWC secret or preimage. The report's later safe projection cannot repair disclosure in earlier stdout/private artifacts. Receiver initial-state and hash projections also need bounded validation before logging.

Fix: use an explicit safe error-code allowlist at capture and output boundaries, with a fixed OTHER/unknown fallback; validate state enums and hash format before printing. Test secret-shaped codes and unexpected protocol fields through actual stdout/stderr paths. No actual leaked credential was observed in the reviewed public report.

### F5 — HIGH — Budget contradictions can be certified complete

Affected: scripts/phase6-evidence-report.mjs, normalizedBudgetAfter, lines 61-73 and buildEvidenceReport at 134-135; scripts/phase45-core.mjs, normalizeBudgetMsat, lines 126-159.

Issue: post-race totals are not checked against used and remaining values. A 1,000,000 msat total with 999,000 used and 999,000 remaining still produces PASS/complete. A zero-used/full-remaining budget after Bob confirms settlement is also ignored. Core normalization accepts boolean false as numeric zero and assumes generic field aliases use msat without a unit contract. The sample's arithmetic is consistent, but the validator does not establish that generally.

Fix: validate types and documented units, reject conflicting aliases, and check arithmetic according to the observed Hub policy. Preserve overspend values rather than assuming remaining cannot be negative or clamped. Record whether reported budget usage includes fees or reservations, and explain or classify unresolved contradictions. Principal and routing fees must remain separate; do not enforce a principal-only usage equality without knowing the wallet's policy.

### F6 — MEDIUM — Report does not verify concurrency evidence or preserve response timing

Affected: scripts/phase45-core.mjs, dispatchTwoPayments, lines 75-89; scripts/phase6-evidence-report.mjs, buildEvidenceReport, lines 103-132 and report attempt projection at 186-202.

Issue: dispatchDeltaMs is trusted if nonnegative, timestamps only need to parse, and per-attempt barrier timestamps and response times are ignored. Synthetic evidence with B dispatched about a minute after A responded still produces PASS/complete. The export omits responseAt, budget capture time, and request preparation time. The core code is concurrent, but the report cannot substantiate that property for its evidence.

Fix: distinguish call-start timing from transport publication timing; record the promised transport timing if claiming transport dispatch. Validate both attempts share the release, budget capture/preparation precede it, and calls overlap where response evidence permits. Preserve response timestamps and monotonic timing information sufficient to audit the delta; classify invalid evidence as INCONCLUSIVE. Do not claim Hub internal overlap from client timing.

### F7 — MEDIUM — Optional post-budget/whole-satoshi checks obscure a conclusive verdict

Affected: scripts/phase6-evidence-report.mjs, normalizedBudgetAfter, lines 65-72 and buildEvidenceReport at 134-135, 171-178; tests/phase6-evidence-report.test.mjs, missing-evidence test.

Issue: a failed post-race get_budget forces INCONCLUSIVE even when a valid run and independently reconciled settlements establish FAIL against a verified starting budget. Requiring remainingMsat divisible by 1,000 also rejects legitimate nonzero-msat fees; for example, 700,001 used and 299,999 remaining in the fixed scenario. This conflicts with the specification's starting-spendable-budget invariant.

Fix: distinguish evidence required for the verdict from supplementary post-race accounting. Preserve missing post-budget diagnostics without obscuring a conclusive invariant result; actual contradictions still need resolution. Keep budget/fee precision in msat and display fractional sats explicitly if needed. State that PASS concerns settled principal, not fee-inclusive expenditure.

### F8 — MEDIUM — Contradictory duplicate Bob lookups make verdict order-dependent

Affected: scripts/phase45-core.mjs, reconcileTwoInvoices, lines 216-221.

Issue: Map construction silently retains the last observation per hash. Supplying SETTLED and OPEN records for B yields PASS or FAIL solely by reversing input order. The current two-file path limits exposure, but the exported reconciler does not honor the missing/contradictory-evidence rule and is unsafe for the required polling history.

Fix: reject duplicate contradictory records, or explicitly reconcile timestamped observation history using a documented state-transition policy. Never select final truth by array position. Test duplicate hashes, contradictory snapshots, and reordered inputs.

### F9 — MEDIUM — An invalid run can still report invariant.holds=true

Affected: scripts/phase6-evidence-report.mjs, buildEvidenceReport, lines 159-178 and 223-229.

Issue: the evaluator uses a hardcoded 1,000-sat budget even when the starting budget is missing/invalid. finalClassification becomes INCONCLUSIVE, but independentlySettledPrincipalSats and invariant.holds can still assert a successful comparison to that unverified budget. Removing startingBudget reproduced INCONCLUSIVE with holds=true.

Fix: make the evaluated invariant unknown when its budget or run validity is unverified. Preserve known receiver amounts as explicitly observed partial evidence, and use the captured starting spendable budget as the actual comparison operand. Keep any arithmetic against a configured target clearly separate from the run verdict.

### F10 — MEDIUM — Failure paths can produce no durable inconclusive report

Affected: scripts/phase45-race.mjs, final-only artifact write and catch, lines 180-197; scripts/phase6-evidence-report.mjs, readJson/runCli, lines 239-262; scripts/phase45-core.mjs, settledAt conversion, lines 247-259.

Issue: race evidence is only written after later lookup/budget steps finish; a subsequent write/runtime failure leaves no durable attempt artifact. paymentMayHaveBeenDispatched becomes false once stage advances past concurrent_pay_invoice, even though payments occurred. Missing/malformed report input files throw rather than producing an INCONCLUSIVE report. An out-of-range but safe-integer settle_date can throw RangeError during Date.toISOString. SDK reply/publication timeouts exist, but no recorded overall reconciliation deadline exists.

Fix: persist sanitized per-stage/attempt evidence, retain a dispatch-ever-started flag, and turn expected input/date failures into bounded reason-coded INCONCLUSIVE output. Validate timestamp range before converting. Record the relevant timeout and reconciliation policy. Add tests for post-dispatch failures and late settlement; do not treat client timeout as proof of nonpayment.

### F11 — LOW — Default report bytes vary for identical captured evidence

Affected: scripts/phase6-evidence-report.mjs, buildEvidenceReport, line 82; PHASE6_STATUS.md, reproduction instructions; tests/phase6-evidence-report.test.mjs, byte-stability test.

Issue: default generatedAt comes from the current clock. Byte stability is demonstrated only with an explicitly supplied timestamp, while SPEC.md requires determinism for captured evidence. The limitation is honestly documented.

Fix: derive the official report timestamp from captured evidence or require an explicit timestamp for reproducible export. Keep generation metadata separate if desired. Test the documented default command as well as fixed-time serialization.

## Reproduction evidence

Run the unchanged suite from PowerShell: `npm test` (15 passed, 0 failed).

Additional synthetic probes invoked buildEvidenceReport with an otherwise valid fixed 1,000-sat / two-700-sat run. Results:

| Mutation | Actual current result |
| --- | --- |
| No race.nwcLookups | PASS, complete=true |
| NWC reports B settled, Bob reports B OPEN | PASS, complete=true |
| B dispatch occurs after A response, delta about 60 seconds | PASS, complete=true |
| Post-budget used=999,000 and remaining=999,000 msat against total=1,000,000 | PASS, complete=true |
| Post-budget used=0 and remaining=1,000,000 despite 700-sat settlement | PASS, complete=true |
| Missing starting budget | INCONCLUSIVE, invariant.holds=true |
| Receiver settlement predates dispatch | PASS, complete=true |
| Conflicting duplicate Bob B observations reordered | PASS changes to FAIL |
| Arbitrary synthetic 64-hex payment error code | Retained verbatim in capture result |

These are validation probes, not live-wallet evidence and not a historical Electrum fixture.

## Coverage and sample claims

Existing coverage is useful for the shared barrier, deferred payment overlap, encryption tags, basic invariant math, accepted/rejected receiver states, field projection, and fixed-time serialization. It does not cover delayed settlement after timeout, NWC/receiver contradiction, missing NWC observations, stale initial evidence, serial timing evidence, duplicate lookup conflicts, inconsistent budget arithmetic, fractional-msat fees, secret-shaped capture errors, malformed CLI files, or post-dispatch persistence failure. Some current tests explicitly expect OPEN to PASS and fractional post-budget sats to make the run INCONCLUSIVE; those expectations need to change with the policy.

The checked-in sample defensibly records a 700-sat receiver settlement, a zero-paid OPEN receiver snapshot for the other invoice, a reported QUOTA_EXCEEDED rejection, a 1.704 ms client call-start gap, and 300 sats reported remaining. The available export does not substantiate terminal finality, an observation window, complete NWC reconciliation, or Hub internal concurrency. Its unqualified PASS and evidenceCompleteness.complete=true exceed what the exported evidence proves. This is a tester correctness finding, not a finding that Alby Hub violated its budget.

Required gate action: resolve HIGH findings, add focused failure-path checks, produce corrected/reviewable evidence, and obtain the required independent review again before starting the historical fixture or dashboard. No BLOCKER finding is assigned beyond this closed correctness gate; MEDIUM/LOW items require resolution or an explicit documented deferral consistent with SPEC.md and DESIGN.md.

Protocol references checked: [LND invoice schema](https://github.com/lightningnetwork/lnd/blob/master/lnrpc/lightning.proto) distinguishes OPEN/SETTLED/CANCELED/ACCEPTED and provides sat/msat paid amounts; [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md) specifies lookup states and msat fee amounts. These are protocol references, not verification of the live private artifacts.
