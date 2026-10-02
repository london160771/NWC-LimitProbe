import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  TwoPartyBarrier,
  classifyInvariant,
  captureBudgetSnapshot,
  dispatchTwoPayments,
  evaluateRunEvidence,
  normalizeBudgetMsat,
  reconcileTwoInvoices,
  safeErrorCode,
  sanitizeNwcLookup,
  sanitizeReceiverObservation,
  sumConfirmedSettledPrincipalMsat,
  validateInvoiceLifecycle,
} from "../scripts/phase45-core.mjs";
import { markPostDispatchFailure, persistPrivateProgress } from "../scripts/phase45-progress.mjs";
import { HASH_A, HASH_B, RUN_ID, makeEvidence } from "./phase61-evidence-fixture.mjs";

const outcome = (settled, amountPaidSat) => ({
  reconciled: true,
  terminal: true,
  settled,
  amountPaidSat,
  amountPaidMsat: amountPaidSat * 1_000,
});

test("two-party barrier holds both participants until one shared release", async () => {
  const barrier = new TwoPartyBarrier();
  let released = false;
  assert.throws(() => barrier.release("too-early"), /barrier_not_fully_armed/);
  const first = barrier.arriveAndWait().then((at) => { released = true; return at; });
  await Promise.resolve();
  assert.equal(released, false);
  const second = barrier.arriveAndWait();
  await barrier.waitUntilArmed();
  assert.equal(barrier.arrivals, 2);
  barrier.release("2026-10-01T12:00:00.000Z");
  assert.deepEqual(await Promise.all([first, second]), [
    "2026-10-01T12:00:00.000Z",
    "2026-10-01T12:00:00.000Z",
  ]);
});

test("both pay calls start after the shared barrier before either response", async () => {
  const deferred = [];
  const calls = [];
  let monotonic = 10;
  let wall = 0;
  let durableDispatchProgress = null;
  const requests = [
    { id: "A", paymentHash: HASH_A, amountSat: 700, invoice: "invoice-a" },
    { id: "B", paymentHash: HASH_B, amountSat: 700, invoice: "invoice-b" },
  ];
  const run = dispatchTwoPayments(requests, (invoice) => {
    calls.push(invoice);
    return new Promise((resolve) => deferred.push(resolve));
  }, {
    runId: RUN_ID,
    wallClock: () => `2026-10-01T12:00:00.${String(wall++).padStart(3, "0")}Z`,
    monotonicClock: () => monotonic++,
    onBothDispatched: (snapshot) => { durableDispatchProgress = snapshot; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["invoice-a", "invoice-b"]);
  assert.equal(deferred.length, 2);
  assert.equal(durableDispatchProgress.attempts.length, 2);
  assert.equal(durableDispatchProgress.attempts.every((attempt) => typeof attempt.dispatchMonotonicMs === "number"), true);
  deferred[0]({ fees_paid: "10", preimage: "must-not-be-returned" });
  deferred[1]({ fees_paid: 0, preimage: "must-not-be-returned" });
  const result = await run;
  assert.equal(result.dispatchDeltaMs, 1);
  assert.equal(result.attempts.every((attempt) => attempt.barrierReleasedAt === result.barrierReleasedAt), true);
  assert.equal(Math.max(...result.attempts.map((attempt) => attempt.dispatchMonotonicMs)) < Math.min(...result.attempts.map((attempt) => attempt.responseMonotonicMs)), true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.feesPaidMsat), [10, 0]);
  assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
});

test("budget normalization rejects booleans and validates exact msat arithmetic", () => {
  const normalized = normalizeBudgetMsat({ total_budget_msats: "1000000", used_budget_msats: 700_001, remaining_budget_msats: 299_999 });
  assert.equal(normalized.valid, true);
  assert.equal(normalized.remainingBudgetMsat, 299_999);
  assert.equal(normalizeBudgetMsat({ total_budget_msats: true, used_budget_msats: 0, remaining_budget_msats: 1_000_000 }).valid, false);
  const unknownRemainingUnit = normalizeBudgetMsat({ total_budget: 1_000_000, used_budget: 0, remaining_budget: 1_000_000 });
  assert.equal(unknownRemainingUnit.valid, false);
  assert.ok(unknownRemainingUnit.issues.includes("budget_unit_unspecified"));
  const inconsistent = normalizeBudgetMsat({ total_budget_msats: 1_000_000, used_budget_msats: 999_000, remaining_budget_msats: 999_000 });
  assert.equal(inconsistent.valid, false);
  assert.ok(inconsistent.issues.includes("budget_arithmetic_inconsistent"));
  assert.equal(normalizeBudgetMsat({ total_budget: 1_000, total_budget_msats: 1_000_000, used_budget_msats: 0, remaining_budget_msats: 1_000_000 }).valid, false);
  assert.equal(normalizeBudgetMsat({ total_budget_msats: 1_000_000, used_budget_msats: -1, remaining_budget_msats: 1_000_001 }).valid, false);
  assert.equal(normalizeBudgetMsat({ total_budget_msats: 1_000_000, used_budget_msats: 0, remaining_budget_msats: 1_000_001 }).valid, false);
});

test("capture-time budget failures survive persisted normalization and evaluator", () => {
  const invalidCapture = captureBudgetSnapshot({ total_budget_msats: 1_000_000, used_budget_msats: 0, remaining_budget_msats: 1_000_001, renewal_period: "never" }, {
    kind: "starting", runId: RUN_ID, observedAt: "2026-10-01T10:00:00.600Z",
  });
  assert.equal(invalidCapture.capturedValidationStatus, "invalid");
  assert.ok(invalidCapture.capturedValidationIssues.includes("budget_arithmetic_inconsistent"));
  const persistedAndReparsed = JSON.parse(JSON.stringify(invalidCapture));
  assert.equal(normalizeBudgetMsat(persistedAndReparsed).valid, false);
  const { raceEvidence, bobEvidence } = makeEvidence();
  raceEvidence.startingBudget = { ...persistedAndReparsed, totalBudgetMsat: 1_000_000, usedBudgetMsat: 0, remainingBudgetMsat: 1_000_000, renewalPeriod: "never" };
  const evaluated = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(evaluated.startingBudgetVerified, false);
  assert.equal(evaluated.invariantHolds, null);
  assert.ok(evaluated.reasonCodes.includes("starting_budget_capture_previously_invalid"));
});

test("persisted budget capture requires its original observation timestamp", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  raceEvidence.startingBudget.observedAt = null;
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.startingBudgetVerified, false);
  assert.equal(result.invariantHolds, null);
  assert.ok(result.reasonCodes.includes("starting_budget_snapshot_timestamp_missing"));
});

test("persisted budget status flags cannot contradict a valid capture marker", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  raceEvidence.startingBudget.valid = false;
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.startingBudgetVerified, false);
  assert.ok(result.reasonCodes.includes("starting_budget_snapshot_persisted_status_invalid"));
});

test("persisted budget issue arrays and validation flags must agree", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  raceEvidence.startingBudget.issues = ["budget_currency_unsupported"];
  const issuesMismatch = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(issuesMismatch.startingBudgetVerified, false);
  assert.ok(issuesMismatch.reasonCodes.includes("starting_budget_persisted_issue_metadata_conflict"));

  const flagsMismatch = makeEvidence();
  flagsMismatch.raceEvidence.startingBudget.complete = false;
  const invalidFlags = evaluateRunEvidence(flagsMismatch);
  assert.equal(invalidFlags.startingBudgetVerified, false);
  assert.ok(invalidFlags.reasonCodes.includes("starting_budget_persisted_validation_flags_conflict"));
});

test("Alby Hub get_budget wire response parses legacy msat fields and derives remaining", () => {
  const normalized = normalizeBudgetMsat({
    used_budget: 0,
    total_budget: 1_000_000,
    renewal_period: "never",
  });
  assert.deepEqual(normalized, {
    totalBudgetMsat: 1_000_000,
    usedBudgetMsat: 0,
    remainingBudgetMsat: 1_000_000,
    renewalPeriod: "never",
    valid: true,
    complete: true,
    issues: [],
  });
  assert.equal(normalized.totalBudgetMsat / 1000, 1_000);
  assert.equal(normalized.remainingBudgetMsat / 1000, 1_000);
});

test("budget normalization rejects conflicting units and malformed live aliases", () => {
  assert.equal(normalizeBudgetMsat({ total_budget: 1_000_000, used_budget: 0, renewal_period: "never", unit: "sat" }).valid, false);
  assert.equal(normalizeBudgetMsat({ total_budget: 1_000_000, total_budget_msats: 999_000, used_budget: 0, renewal_period: "never" }).valid, false);
  assert.equal(normalizeBudgetMsat({ total_budget_sat: 1_000, used_budget_sat: 0, renewal_period: "never" }).valid, false);
  assert.equal(normalizeBudgetMsat({ total_budget: true, used_budget: 0, renewal_period: "never" }).valid, false);
  assert.equal(normalizeBudgetMsat({ total_budget: 1_000_000, used_budget: 0, renewal_period: "never", unit: "msat", budget_unit: "sat" }).valid, false);
});

test("invariant classifies PASS, FAIL, and missing starting budget without boolean coercion", () => {
  const pass = classifyInvariant({ startingSpendableBudgetMsat: 1_000_000, outcomes: [outcome(true, 700), outcome(false, 0)] });
  assert.equal(pass.classification, "PASS");
  assert.equal(pass.invariantHolds, true);
  const fail = classifyInvariant({ startingSpendableBudgetMsat: 1_000_000, outcomes: [outcome(true, 700), outcome(true, 700)] });
  assert.equal(fail.classification, "FAIL");
  assert.equal(fail.invariantHolds, false);
  const unknown = classifyInvariant({ startingSpendableBudgetSats: true, outcomes: [outcome(true, 700), outcome(false, 0)] });
  assert.equal(unknown.classification, "INCONCLUSIVE");
  assert.equal(unknown.invariantHolds, null);
});

test("delayed settlement after initial OPEN is reconciled from timestamped history", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "PASS");
  assert.equal(result.receiverOutcomes[0].observationCount, 2);
  assert.equal(result.receiverOutcomes[0].state, "SETTLED");
});

test("OPEN at the bounded reconciliation deadline remains INCONCLUSIVE", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  bobEvidence.observations = bobEvidence.observations.map((item) => item.id === "A"
    ? { ...item, state: "OPEN", settled: false, amountPaidSat: 0, settleDateUnix: 0, settledAt: null }
    : item);
  raceEvidence.nwcLookups = raceEvidence.nwcLookups.map((item) => item.id === "A"
    ? { ...item, lookupState: "OPEN", settledAt: null }
    : item);
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.equal(result.invariantHolds, null);
  assert.ok(result.reasonCodes.includes("receiver_unresolved_at_deadline"));
});

test("NWC and Bob terminal contradictions remain INCONCLUSIVE", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  raceEvidence.nwcLookups[0].lookupState = "OPEN";
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("nwc_receiver_settlement_contradiction"));
});

test("NWC lookup run/hash mismatches and duplicate conflicting lookups are rejected", () => {
  const wrongHash = makeEvidence();
  wrongHash.raceEvidence.nwcLookups[0].returnedHash = HASH_B;
  const mismatch = evaluateRunEvidence(wrongHash);
  assert.equal(mismatch.classification, "INCONCLUSIVE");
  assert.ok(mismatch.reasonCodes.includes("nwc_lookup_returned_hash_mismatch"));

  const wrongRun = makeEvidence();
  wrongRun.raceEvidence.nwcLookups[0].runId = "stale-run";
  assert.equal(evaluateRunEvidence(wrongRun).classification, "INCONCLUSIVE");

  const duplicate = makeEvidence();
  duplicate.raceEvidence.nwcLookups.push({
    ...duplicate.raceEvidence.nwcLookups[0],
    lookupState: "OPEN",
    settledAt: null,
  });
  const ambiguous = evaluateRunEvidence(duplicate);
  assert.equal(ambiguous.classification, "INCONCLUSIVE");
  assert.ok(ambiguous.reasonCodes.includes("duplicate_nwc_lookup_timestamp"));
});

test("stale initial receiver evidence is rejected", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  raceEvidence.initialBobObservations[0].observedAt = "2026-10-01T10:00:00.700Z";
  raceEvidence.initialBobObservations[0].acquiredAt = raceEvidence.initialBobObservations[0].observedAt;
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("initial_receiver_observation_stale_or_mismatched"));
});

test("freshness is checked again against the dispatch timestamps", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  raceEvidence.initialBobObservations[0].observedAt = "2026-10-01T09:59:30.000Z";
  raceEvidence.initialBobObservations[0].acquiredAt = raceEvidence.initialBobObservations[0].observedAt;
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("initial_receiver_observation_stale_before_dispatch"));
});

test("initial Bob freshness uses each lookup acquisition time, not later parser completion", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  const first = raceEvidence.initialBobObservations[0];
  first.acquiredAt = "2026-10-01T09:59:20.000Z";
  first.observedAt = "2026-10-01T10:00:00.500Z";
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("initial_receiver_observation_stale_before_dispatch"));
});

test("receiver evidence rejects OPEN settlement time, missing SETTLED time, and unexpected errors", () => {
  const openTimestamp = makeEvidence();
  const open = openTimestamp.bobEvidence.observations.find((item) => item.id === "A" && item.state === "OPEN");
  open.settleDateUnix = 1790848801;
  open.settledAt = "2026-10-01T10:00:01.000Z";
  assert.equal(evaluateRunEvidence(openTimestamp).classification, "INCONCLUSIVE");
  assert.ok(evaluateRunEvidence(openTimestamp).reasonCodes.includes("receiver_pending_evidence_invalid"));

  const noTime = makeEvidence();
  const settled = noTime.bobEvidence.observations.find((item) => item.id === "A" && item.state === "SETTLED");
  settled.settleDateUnix = null;
  settled.settledAt = null;
  assert.ok(evaluateRunEvidence(noTime).reasonCodes.includes("receiver_settlement_timestamp_missing"));

  const error = makeEvidence();
  error.bobEvidence.observations.find((item) => item.id === "A" && item.state === "SETTLED").errorCode = "OTHER";
  assert.ok(evaluateRunEvidence(error).reasonCodes.includes("receiver_observation_mismatched_or_out_of_window"));
});

test("terminal unpaid receiver evidence rejects settlement timestamps", () => {
  const input = makeEvidence();
  const canceled = input.bobEvidence.observations.find((item) => item.id === "B" && item.state === "CANCELED");
  canceled.settleDateUnix = 1790848811;
  canceled.settledAt = new Date(canceled.settleDateUnix * 1_000).toISOString();
  const result = evaluateRunEvidence(input);
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("receiver_terminal_unpaid_evidence_invalid"));
});

test("conflicting receiver settlement timestamp aliases and msat values are rejected", () => {
  const input = makeEvidence();
  const settled = input.bobEvidence.observations.find((item) => item.id === "A" && item.state === "SETTLED");
  const conflict = sanitizeReceiverObservation({
    runId: RUN_ID, id: "A", requestedHash: HASH_A, expectedAmountSat: 700,
    lookup: { r_hash: HASH_A, state: "SETTLED", settled: true, amt_paid_sat: 700, amt_paid_msat: 700_001, settle_date: 1790848811, settledAt: "2026-10-01T10:00:12.000Z" },
    observedAt: settled.observedAt,
  });
  input.bobEvidence.observations = input.bobEvidence.observations.map((item) => item === settled ? conflict : item);
  const result = evaluateRunEvidence(input);
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("receiver_settlement_timestamp_conflict"));
  assert.ok(result.reasonCodes.includes("receiver_amount_msat_sat_mismatch"));
});

test("persisted receiver evidence cannot hide conflicting settleDateUnix and settledAt", () => {
  const input = makeEvidence();
  const settled = input.bobEvidence.observations.find((item) => item.id === "A" && item.state === "SETTLED");
  settled.settleDateUnix += 2;
  const result = evaluateRunEvidence(input);
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("receiver_settlement_timestamp_conflict"));
});

test("same-second settlement outside the controlled test-exclusive setup stays ambiguous", () => {
  const input = makeEvidence();
  input.raceEvidence.noOtherPayerPath = false;
  const result = evaluateRunEvidence(input);
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("receiver_same_second_attribution_not_controlled"));
});

test("same-second LND settlement interval may overlap millisecond dispatch", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  const finalA = bobEvidence.observations.find((item) => item.id === "A" && item.state === "SETTLED");
  finalA.settleDateUnix = Math.floor(Date.parse(raceEvidence.barrierReleasedAt) / 1_000);
  finalA.settledAt = new Date(finalA.settleDateUnix * 1_000).toISOString();
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "PASS");
  assert.equal(result.reasonCodes.includes("receiver_settlement_time_out_of_chronology"), false);
});

test("settlement interval ending before dispatch is invalid chronology", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  const finalA = bobEvidence.observations.find((item) => item.id === "A" && item.state === "SETTLED");
  finalA.settleDateUnix = Math.floor(Date.parse(raceEvidence.barrierReleasedAt) / 1_000) - 1;
  finalA.settledAt = new Date(finalA.settleDateUnix * 1_000).toISOString();
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("receiver_settlement_time_out_of_chronology"));
});

test("OPEN observed after the reconciliation deadline remains INCONCLUSIVE", () => {
  const { raceEvidence, bobEvidence } = makeEvidence({ terminalB: "OPEN" });
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("receiver_unresolved_at_deadline"));
});

test("confirmed settled receiver principal is preserved when the other invoice remains OPEN", () => {
  const { raceEvidence, bobEvidence } = makeEvidence({ terminalB: "OPEN" });
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.confirmedSettledPrincipalMsat, 700_000);
  assert.equal(result.totalSettledPrincipalSats, null);
  assert.equal(result.invariantHolds, null);
  assert.equal(sumConfirmedSettledPrincipalMsat(result.receiverOutcomes), 700_000);
});

test("mismatched payment hashes across requests and receiver observations are rejected", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  bobEvidence.observations[0].returnedHash = "c".repeat(64);
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("receiver_observation_mismatched_or_out_of_window"));
  const requestMismatch = makeEvidence();
  requestMismatch.raceEvidence.attempts[0].requestedHash = "c".repeat(64);
  requestMismatch.raceEvidence.attempts[0].paymentHash = "c".repeat(64);
  assert.equal(evaluateRunEvidence(requestMismatch).classification, "INCONCLUSIVE");
});

test("serialized dispatch timings are rejected", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  raceEvidence.attempts[1].dispatchMonotonicMs = String(raceEvidence.attempts[1].dispatchMonotonicMs);
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("dispatch_timing_invalid_or_serialized"));
});

test("persisted attempts bind through requestedHash when paymentHash alias is absent", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  for (const attempt of raceEvidence.attempts) delete attempt.paymentHash;
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "PASS");
  assert.equal(result.reasonCodes.includes("dispatched_attempt_run_or_hash_mismatch"), false);

  raceEvidence.attempts[0].paymentHash = HASH_B;
  const mismatchedAlias = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(mismatchedAlias.classification, "INCONCLUSIVE");
  assert.ok(mismatchedAlias.reasonCodes.includes("dispatched_attempt_run_or_hash_mismatch"));
});

test("duplicate conflicting receiver observations at the same timestamp are rejected", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  const first = bobEvidence.observations.find((item) => item.id === "A" && item.state === "OPEN");
  bobEvidence.observations.push({ ...first, state: "SETTLED", settled: true, amountPaidSat: 700, settleDateUnix: 1790848805, settledAt: "2026-10-01T10:00:05.000Z" });
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("duplicate_receiver_observation_timestamp"));
});

test("secret-shaped payment error codes map to OTHER before capture", async () => {
  const secretShaped = "f".repeat(64);
  assert.equal(safeErrorCode(secretShaped), "OTHER");
  let monotonic = 10;
  let wall = 0;
  const result = await dispatchTwoPayments([
    { id: "A", paymentHash: HASH_A, amountSat: 700, invoice: "a" },
    { id: "B", paymentHash: HASH_B, amountSat: 700, invoice: "b" },
  ], async (invoice) => {
    if (invoice === "a") throw Object.assign(new Error("hidden"), { code: secretShaped });
    return {};
  }, {
    runId: RUN_ID,
    wallClock: () => `2026-10-01T12:00:00.${String(wall++).padStart(3, "0")}Z`,
    monotonicClock: () => monotonic++,
  });
  assert.equal(result.attempts[0].errorCode, "OTHER");
  assert.equal(JSON.stringify(result).includes(secretShaped), false);
});

test("post-dispatch failure leaves durable sanitized progress", () => {
  const directory = mkdtempSync(join(tmpdir(), "nwc-limitprobe-progress-"));
  const path = join(directory, "progress.json");
  try {
    const progress = markPostDispatchFailure({
      runId: RUN_ID,
      stage: "nwc_lookup_invoice",
      paymentMayHaveBeenDispatched: false,
      attempts: [{ id: "A", requestedHash: HASH_A }],
    }, Object.assign(new Error("secret should not persist"), { code: "f".repeat(64) }));
    persistPrivateProgress(path, progress);
    const persisted = readFileSync(path, "utf8");
    const parsed = JSON.parse(persisted);
    assert.equal(parsed.paymentMayHaveBeenDispatched, true);
    assert.equal(parsed.stage, "post_dispatch_failure");
    assert.equal(parsed.failureCode, "OTHER");
    assert.equal(persisted.includes("secret should not persist"), false);
    assert.equal(persisted.includes("f".repeat(64)), false);
    if (process.platform !== "win32") assert.equal((statSync(path).mode & 0o777).toString(8), "600");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing or contradictory starting budget leaves invariant unknown", () => {
  const missing = makeEvidence();
  missing.raceEvidence.startingBudget = null;
  const result = evaluateRunEvidence(missing);
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.equal(result.invariantHolds, null);
  const contradictory = makeEvidence();
  contradictory.raceEvidence.startingBudget.remainingBudgetMsat = 999_999;
  assert.equal(evaluateRunEvidence(contradictory).classification, "INCONCLUSIVE");
});

test("a post-race budget contradiction cannot hide an otherwise proven FAIL", () => {
  const { raceEvidence, bobEvidence } = makeEvidence({ settledA: true, settledB: true });
  raceEvidence.budgetAfter.usedBudgetMsat = 999_000;
  raceEvidence.budgetAfter.remainingBudgetMsat = 999_000;
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "FAIL");
  assert.equal(result.invariantHolds, false);
  assert.ok(result.reasonCodes.some((reason) => reason.startsWith("post_race_")));
  const withinBudget = makeEvidence();
  withinBudget.raceEvidence.budgetAfter.usedBudgetMsat = 999_000;
  withinBudget.raceEvidence.budgetAfter.remainingBudgetMsat = 999_000;
  assert.equal(evaluateRunEvidence(withinBudget).classification, "INCONCLUSIVE");
});

test("PASS requires timestamped final budget accounting to match settled principal and starting configuration", () => {
  const mismatch = makeEvidence();
  mismatch.raceEvidence.budgetAfter.usedBudgetMsat = 0;
  mismatch.raceEvidence.budgetAfter.remainingBudgetMsat = 1_000_000;
  assert.equal(evaluateRunEvidence(mismatch).classification, "INCONCLUSIVE");
  assert.ok(evaluateRunEvidence(mismatch).reasonCodes.includes("post_race_budget_settlement_accounting_unresolved"));

  const changedTotal = makeEvidence();
  changedTotal.raceEvidence.budgetAfter.totalBudgetMsat = 2_000_000;
  changedTotal.raceEvidence.budgetAfter.remainingBudgetMsat = 1_300_000;
  assert.equal(evaluateRunEvidence(changedTotal).classification, "INCONCLUSIVE");

  const missingTime = makeEvidence();
  missingTime.raceEvidence.budgetAfter.observedAt = null;
  assert.equal(evaluateRunEvidence(missingTime).classification, "INCONCLUSIVE");

  const provenFail = makeEvidence({ settledA: true, settledB: true });
  provenFail.raceEvidence.budgetAfter.capturedValidationStatus = "invalid";
  provenFail.raceEvidence.budgetAfter.capturedValidationIssues = ["synthetic_bad_capture"];
  assert.equal(evaluateRunEvidence(provenFail).classification, "FAIL");
});

test("malformed final budget issue metadata cannot throw or hide proven overspend", () => {
  const fail = makeEvidence({ settledA: true, settledB: true });
  fail.raceEvidence.budgetAfter.capturedValidationIssues = [{ toString: null }, "x"];
  fail.raceEvidence.budgetAfter.issues = [{ toString: null }, "x"];
  let failResult;
  assert.doesNotThrow(() => { failResult = evaluateRunEvidence(fail); });
  assert.equal(failResult.classification, "FAIL");
  assert.ok(failResult.supplementaryReasonCodes.includes("post_race_budget_persisted_issue_metadata_invalid"));

  const pass = makeEvidence();
  pass.raceEvidence.budgetAfter.capturedValidationIssues = [{ toString: null }, "x"];
  pass.raceEvidence.budgetAfter.issues = [{ toString: null }, "x"];
  let passResult;
  assert.doesNotThrow(() => { passResult = evaluateRunEvidence(pass); });
  assert.equal(passResult.classification, "INCONCLUSIVE");
  assert.ok(passResult.supplementaryReasonCodes.includes("post_race_budget_persisted_issue_metadata_invalid"));
});

test("two terminal 700 sat settlements fail the budget invariant", () => {
  const { raceEvidence, bobEvidence } = makeEvidence({ settledA: true, settledB: true });
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "FAIL");
  assert.equal(result.totalSettledPrincipalSats, 1_400);
  assert.equal(result.invariantHolds, false);
});

test("missing NWC lookup values are preserved as null and cannot pass", () => {
  const lookup = sanitizeNwcLookup({ runId: RUN_ID, id: "A", requestedHash: HASH_A, expectedAmountSat: 700, lookup: {} });
  assert.equal(lookup.requestedHash, HASH_A);
  assert.equal(lookup.returnedHash, null);
  assert.equal(lookup.lookupState, null);
  assert.equal(lookup.amountMsat, null);
  const { raceEvidence, bobEvidence } = makeEvidence({ missingNwc: true });
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
});

test("NWC NOT_FOUND is separate from a returned record and cannot settle OPEN evidence", () => {
  const open = makeEvidence({ terminalB: "OPEN" });
  open.raceEvidence.nwcLookups = open.raceEvidence.nwcLookups.map((item) => item.id === "B"
    ? sanitizeNwcLookup({ runId: RUN_ID, id: "B", requestedHash: HASH_B, expectedAmountSat: 700, error: { code: "NOT_FOUND" }, observedAt: item.observedAt })
    : item);
  const notFound = open.raceEvidence.nwcLookups.find((item) => item.id === "B");
  assert.equal(notFound.evidenceType, "not_found");
  assert.equal(notFound.errorCode, "NOT_FOUND");
  assert.equal(notFound.returnedHash, null);
  assert.equal(notFound.lookupState, null);
  assert.equal(notFound.amountMsat, null);
  assert.equal(open.raceEvidence.attempts.find((item) => item.id === "B").errorCode, "QUOTA_EXCEEDED");
  assert.equal(evaluateRunEvidence(open).classification, "INCONCLUSIVE");

  const malformedNotFound = sanitizeNwcLookup({ runId: RUN_ID, id: "B", requestedHash: HASH_B, expectedAmountSat: 700,
    error: { code: "NOT_FOUND" }, lookup: { state: "SETTLED", amount: 700_000, settled_at: 1790848861 },
    observedAt: "2026-10-01T10:02:33.000Z" });
  assert.ok(malformedNotFound.validationIssues.includes("nwc_not_found_shape_invalid"));
});

test("NOT_FOUND can support independent terminal CANCELED evidence but proves nothing alone", () => {
  const terminal = makeEvidence();
  terminal.raceEvidence.nwcLookups = terminal.raceEvidence.nwcLookups.map((item) => item.id === "B"
    ? sanitizeNwcLookup({ runId: RUN_ID, id: "B", requestedHash: HASH_B, expectedAmountSat: 700, error: { code: "NOT_FOUND" }, observedAt: item.observedAt })
    : item);
  assert.equal(evaluateRunEvidence(terminal).classification, "PASS");

  const mismatch = makeEvidence();
  mismatch.raceEvidence.nwcLookups = mismatch.raceEvidence.nwcLookups.map((item) => item.id === "B"
    ? sanitizeNwcLookup({ runId: RUN_ID, id: "B", requestedHash: HASH_A, expectedAmountSat: 700, error: { code: "NOT_FOUND" }, observedAt: item.observedAt })
    : item);
  const rejected = evaluateRunEvidence(mismatch);
  assert.equal(rejected.classification, "INCONCLUSIVE");
  assert.ok(rejected.reasonCodes.includes("nwc_lookup_run_or_request_binding_mismatch"));

  const returnedNotFound = makeEvidence();
  returnedNotFound.raceEvidence.nwcLookups = returnedNotFound.raceEvidence.nwcLookups.map((item) => item.id === "B"
    ? sanitizeNwcLookup({
        runId: RUN_ID, id: "B", requestedHash: HASH_B, expectedAmountSat: 700,
        lookup: { payment_hash: HASH_B, state: "NOT_FOUND", amount: 700_000 }, observedAt: item.observedAt,
      })
    : item);
  assert.equal(evaluateRunEvidence(returnedNotFound).classification, "INCONCLUSIVE");

  const earlierSettledRecord = makeEvidence();
  const bobHash = earlierSettledRecord.raceEvidence.nwcLookups.find((item) => item.id === "B");
  bobHash.lookupState = "SETTLED";
  bobHash.settledAt = null;
  earlierSettledRecord.raceEvidence.nwcLookups.push(sanitizeNwcLookup({
    runId: RUN_ID, id: "B", requestedHash: HASH_B, expectedAmountSat: 700,
    error: { code: "NOT_FOUND" }, observedAt: "2026-10-01T10:01:33.500Z",
  }));
  const contradiction = evaluateRunEvidence(earlierSettledRecord);
  assert.equal(contradiction.classification, "INCONCLUSIVE");
  assert.ok(contradiction.reasonCodes.includes("nwc_receiver_settlement_contradiction"));
});

test("the rejected invoice needs Bob CANCELED evidence after its actual expiry for PASS", () => {
  const evidence = makeEvidence({ settledA: true, settledB: false, terminalB: "EXPIRED" });
  const evaluation = evaluateRunEvidence(evidence);
  assert.equal(evaluation.classification, "INCONCLUSIVE");
  assert.ok(evaluation.proofReasonCodes.includes("receiver_natural_expiry_not_observed_as_canceled"));
  const bobB = evidence.bobEvidence.observations.filter((item) => item.id === "B").at(-1);
  const invoiceB = evidence.raceEvidence.invoiceLifecycle.find((item) => item.id === "B");
  assert.ok(Date.parse(bobB.observedAt) >= invoiceB.expiresAtUnix * 1_000);
});

test("contradictory returned NWC records are invalid even beside receiver evidence", () => {
  const input = makeEvidence();
  input.raceEvidence.nwcLookups[0].returnedHash = HASH_B;
  input.raceEvidence.nwcLookups[0].lookupState = "OPEN";
  const result = evaluateRunEvidence(input);
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("nwc_lookup_returned_hash_mismatch"));
});

test("NWC FAILED is an outgoing terminal result, while Bob remains the unpaid ground truth", () => {
  const input = makeEvidence();
  input.raceEvidence.nwcLookups = input.raceEvidence.nwcLookups.map((item) => item.id === "B"
    ? sanitizeNwcLookup({
        runId: RUN_ID, id: "B", requestedHash: HASH_B, expectedAmountSat: 700,
        lookup: { payment_hash: HASH_B, state: "FAILED" }, observedAt: item.observedAt,
      })
    : item);
  const result = evaluateRunEvidence(input);
  assert.equal(result.classification, "PASS");
  assert.equal(result.nwcOutcomes.find((item) => item.id === "B").latest.lookupState, "FAILED");
});

test("proven overspend remains FAIL when NWC lookups or supplementary budget evidence are broken", () => {
  const noLookups = makeEvidence({ settledA: true, settledB: true });
  noLookups.raceEvidence.nwcLookups = [];
  assert.equal(evaluateRunEvidence(noLookups).classification, "FAIL");

  const missingCompletion = makeEvidence({ settledA: true, settledB: true });
  missingCompletion.bobEvidence.completedAt = null;
  missingCompletion.bobEvidence.completionStatus = "interrupted";
  missingCompletion.bobEvidence.collectionSessions = missingCompletion.bobEvidence.collectionSessions
    .filter((item) => item.recordType === "collector_started");
  assert.equal(evaluateRunEvidence(missingCompletion).classification, "FAIL");

  const interrupted = makeEvidence({ settledA: true, settledB: true });
  interrupted.bobEvidence.completionStatus = "interrupted";
  interrupted.bobEvidence.collectionSessions.find((item) => item.recordType === "collector_completed").completionStatus = "interrupted";
  assert.equal(evaluateRunEvidence(interrupted).classification, "FAIL");

  const collectorError = makeEvidence({ settledA: true, settledB: true });
  collectorError.bobEvidence.completionStatus = "collector_error";
  const terminalEvent = collectorError.bobEvidence.collectionSessions.find((item) => item.recordType === "collector_completed");
  terminalEvent.completionStatus = "collector_error";
  assert.equal(evaluateRunEvidence(collectorError).classification, "FAIL");

  const malformedFinal = makeEvidence({ settledA: true, settledB: true });
  malformedFinal.raceEvidence.budgetAfter = { ...malformedFinal.raceEvidence.budgetAfter, usedBudgetMsat: true };
  assert.equal(evaluateRunEvidence(malformedFinal).classification, "FAIL");

  const missingSupplement = makeEvidence({ settledA: true, settledB: true });
  missingSupplement.raceEvidence.nwcLookups = [];
  missingSupplement.raceEvidence.budgetAfter = null;
  missingSupplement.bobEvidence.completionStatus = "collector_error";
  missingSupplement.bobEvidence.collectionSessions.find((item) => item.recordType === "collector_completed").completionStatus = "collector_error";
  assert.equal(evaluateRunEvidence(missingSupplement).classification, "FAIL");
});

test("durable barrier dispatch plus independent overspend remains FAIL when payment replies are missing", () => {
  const incompletePass = makeEvidence();
  for (const attempt of incompletePass.raceEvidence.attempts) {
    delete attempt.result;
    delete attempt.responseAt;
    delete attempt.responseMonotonicMs;
  }
  const passWithMissingReplies = evaluateRunEvidence(incompletePass);
  assert.equal(passWithMissingReplies.classification, "INCONCLUSIVE");
  assert.ok(passWithMissingReplies.supplementaryReasonCodes.includes("nwc_payment_result_missing"));
  assert.ok(passWithMissingReplies.supplementaryReasonCodes.includes("dispatch_response_timing_incomplete_or_nonoverlapping"));

  const provenFail = makeEvidence({ settledA: true, settledB: true });
  for (const attempt of provenFail.raceEvidence.attempts) {
    delete attempt.result;
    delete attempt.responseAt;
    delete attempt.responseMonotonicMs;
  }
  const failWithoutReplies = evaluateRunEvidence(provenFail);
  assert.equal(failWithoutReplies.classification, "FAIL");
  assert.equal(failWithoutReplies.totalSettledPrincipalMsat, 1_400_000);
  assert.ok(failWithoutReplies.supplementaryReasonCodes.includes("nwc_payment_result_missing"));
});

test("malformed NWC settlement timestamps are supplementary and cannot crash evaluation", () => {
  const pass = makeEvidence();
  pass.raceEvidence.nwcLookups.find((item) => item.id === "A").settledAt = { toString: null };
  const passResult = evaluateRunEvidence(pass);
  assert.equal(passResult.classification, "INCONCLUSIVE");
  assert.ok(passResult.supplementaryReasonCodes.includes("nwc_settlement_timestamp_invalid"));

  const provenFail = makeEvidence({ settledA: true, settledB: true });
  provenFail.raceEvidence.nwcLookups.find((item) => item.id === "A").settledAt = { toString: null };
  const failResult = evaluateRunEvidence(provenFail);
  assert.equal(failResult.classification, "FAIL");
  assert.ok(failResult.supplementaryReasonCodes.includes("nwc_settlement_timestamp_invalid"));
});

test("empty collector history cannot certify PASS even when collectionIssues is empty", () => {
  const input = makeEvidence();
  input.bobEvidence.collectionSessions = [];
  input.bobEvidence.collectionIssues = [];
  const evaluated = evaluateRunEvidence(input);
  assert.equal(evaluated.classification, "INCONCLUSIVE");
  assert.ok(evaluated.reasonCodes.includes("bob_receiver_provenance_invalid"));
});

test("NWC fee contradictions and malformed fee captures block PASS but not proven FAIL", () => {
  const pass = makeEvidence();
  pass.raceEvidence.nwcLookups[0].feesPaidMsat = 999;
  const result = evaluateRunEvidence(pass);
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("nwc_fee_source_contradiction"));

  const negative = sanitizeNwcLookup({ runId: RUN_ID, id: "A", requestedHash: HASH_A, expectedAmountSat: 700,
    lookup: { payment_hash: HASH_A, state: "SETTLED", amount: 700_000, fees_paid: -1 }, observedAt: "2026-10-01T10:02:33.000Z" });
  assert.ok(negative.validationIssues.includes("nwc_fee_invalid"));
  const fail = makeEvidence({ settledA: true, settledB: true });
  fail.raceEvidence.nwcLookups[0].feesPaidMsat = 999;
  assert.equal(evaluateRunEvidence(fail).classification, "FAIL");
});

test("NWC rejects settlement before run and lookup completion before contained observations", () => {
  const beforeRun = makeEvidence();
  beforeRun.raceEvidence.nwcLookups[0].settledAt = "2026-09-30T23:59:59.000Z";
  assert.ok(evaluateRunEvidence(beforeRun).reasonCodes.includes("nwc_settlement_predates_run"));

  const completionEarly = makeEvidence();
  completionEarly.raceEvidence.finalNwcLookupCompletedAt = "2026-10-01T10:00:00.000Z";
  assert.ok(evaluateRunEvidence(completionEarly).reasonCodes.includes("nwc_lookup_completion_before_observation"));
});

test("invoice expiry requires fresh issue time, dispatch lifetime, and declared grace", () => {
  const createdAt = "2026-10-01T12:00:00.000Z";
  const invoiceTimestampUnix = Math.floor(Date.parse(createdAt) / 1_000);
  const expiresAtUnix = invoiceTimestampUnix + 120;
  const common = { createdAt, invoiceTimestampUnix, expirySeconds: 120, expiresAtUnix,
    dispatchAt: "2026-10-01T12:00:01.000Z", requiredGraceSeconds: 30, nowAt: "2026-10-01T12:00:01.000Z" };
  assert.equal(validateInvoiceLifecycle({ ...common, reconciliationDeadline: "2026-10-01T12:02:30.000Z" }).valid, true);
  assert.equal(validateInvoiceLifecycle({ ...common, reconciliationDeadline: "2026-10-01T12:02:30.001Z" }).valid, true);
  const insufficient = validateInvoiceLifecycle({ ...common, reconciliationDeadline: "2026-10-01T12:02:29.999Z" });
  assert.ok(insufficient.issues.includes("invoice_reconciliation_grace_insufficient"));
  const future = validateInvoiceLifecycle({ ...common, invoiceTimestampUnix: invoiceTimestampUnix + 6, expiresAtUnix: expiresAtUnix + 6, reconciliationDeadline: "2026-10-01T12:02:36.000Z" });
  assert.ok(future.issues.includes("invoice_timestamp_in_future"));
  const shortLife = validateInvoiceLifecycle({ ...common, dispatchAt: "2026-10-01T12:01:50.000Z", nowAt: "2026-10-01T12:01:50.000Z", reconciliationDeadline: "2026-10-01T12:02:30.000Z" });
  assert.ok(shortLife.issues.includes("invoice_remaining_lifetime_insufficient"));
});

test("Bob reconciliation accepts ordered history and rejects unknown or ambiguous histories", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  const expectedInvoices = [
    { id: "A", paymentHash: HASH_A, amountSat: 700 },
    { id: "B", paymentHash: HASH_B, amountSat: 700 },
  ];
  const result = reconcileTwoInvoices({
    runId: RUN_ID,
    expectedInvoices,
    bobObservations: bobEvidence.observations,
    barrierReleasedAt: raceEvidence.barrierReleasedAt,
    reconciliationDeadline: raceEvidence.reconciliationDeadline,
    startingSpendableBudgetMsat: 1_000_000,
  });
  assert.equal(result.classification, "PASS");
  const duplicate = reconcileTwoInvoices({
    runId: RUN_ID,
    expectedInvoices,
    bobObservations: [...bobEvidence.observations, { ...bobEvidence.observations[0], state: "PENDING" }],
    barrierReleasedAt: raceEvidence.barrierReleasedAt,
    reconciliationDeadline: raceEvidence.reconciliationDeadline,
    startingSpendableBudgetMsat: 1_000_000,
  });
  assert.equal(duplicate.classification, "INCONCLUSIVE");
});
