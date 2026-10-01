import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  TwoPartyBarrier,
  classifyInvariant,
  dispatchTwoPayments,
  evaluateRunEvidence,
  normalizeBudgetMsat,
  reconcileTwoInvoices,
  safeErrorCode,
  sanitizeNwcLookup,
} from "../scripts/phase45-core.mjs";
import { markPostDispatchFailure, persistPrivateProgress } from "../scripts/phase45-progress.mjs";
import { HASH_A, HASH_B, RUN_ID, makeEvidence } from "./phase61-evidence-fixture.mjs";

const outcome = (settled, amountPaidSat) => ({
  reconciled: true,
  terminal: true,
  settled,
  amountPaidSat,
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
  const unknownUnit = normalizeBudgetMsat({ total_budget: 1_000_000, used_budget: 0, remaining_budget: 1_000_000 });
  assert.equal(unknownUnit.valid, false);
  assert.ok(unknownUnit.issues.includes("budget_unit_unspecified"));
  const inconsistent = normalizeBudgetMsat({ total_budget_msats: 1_000_000, used_budget_msats: 999_000, remaining_budget_msats: 999_000 });
  assert.equal(inconsistent.valid, false);
  assert.ok(inconsistent.issues.includes("budget_arithmetic_inconsistent"));
  assert.equal(normalizeBudgetMsat({ total_budget: 1_000, total_budget_msats: 1_000_000, used_budget_msats: 0, remaining_budget_msats: 1_000_000 }).valid, false);
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
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("initial_receiver_observation_stale_or_mismatched"));
});

test("receiver settlement timestamps in the dispatch second are ambiguous", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  const finalA = bobEvidence.observations.find((item) => item.id === "A" && item.state === "SETTLED");
  finalA.settleDateUnix = Math.floor(Date.parse(raceEvidence.barrierReleasedAt) / 1_000);
  const result = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.ok(result.reasonCodes.includes("receiver_settlement_time_out_of_chronology"));
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
