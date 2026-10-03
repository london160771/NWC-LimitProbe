import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandboxEvidence } from "../dashboard/sandbox/sandbox-evidence.js";
import { MAX_SANDBOX_SATS, runSandboxSimulation, validateSandboxConfiguration } from "../dashboard/sandbox/sandbox-runner.js";

const DEFAULT = {
  startingBudgetSats: 1_000,
  attemptAmountSats: { A: 700, B: 700 },
  behavior: "enforce_limit",
};
const FIXED_ID = "a0000000-0000-4000-8000-000000000001";

function fixedOptions() {
  let monotonic = 10;
  let time = Date.parse("2026-10-03T12:00:00.000Z");
  return {
    runIdFactory: () => FIXED_ID,
    wallClock: () => new Date(time += 1),
    monotonicClock: () => monotonic += 0.5,
  };
}

async function simulate(overrides = {}, options = fixedOptions()) {
  const configuration = {
    ...DEFAULT,
    ...overrides,
    attemptAmountSats: { ...DEFAULT.attemptAmountSats, ...(overrides.attemptAmountSats ?? {}) },
  };
  return runSandboxSimulation({ ...options, configuration });
}

test("enforced 1,000 budget with concurrent 700 + 700 settles exactly one and passes", async () => {
  const run = await simulate();
  assert.equal(run.mode, "sandbox");
  assert.deepEqual(run.configuration, {
    startingBudgetSats: 1_000,
    attemptAmountSats: { A: 700, B: 700 },
    behavior: "enforce_limit",
    maxInputSats: MAX_SANDBOX_SATS,
    tieBreak: "A_then_B_after_shared_barrier",
  });
  assert.deepEqual(run.attempts.map((attempt) => attempt.result), ["SUCCESS", "QUOTA_EXCEEDED"]);
  assert.equal(run.settledPrincipalSats, 700);
  assert.equal(run.remainingBudgetSats, 300);
  assert.equal(run.overspendSats, 0);
  assert.equal(run.invariant.holds, true);
  assert.equal(run.finalClassification, "PASS");
});

test("both payment attempts wait at one shared barrier and dispatch timestamps are recorded", async () => {
  const run = await simulate();
  assert.equal(run.attempts[0].barrierReleasedAt, run.attempts[1].barrierReleasedAt);
  assert.equal(run.barrierReleasedAt, run.attempts[0].barrierReleasedAt);
  assert.deepEqual(run.dispatchTimestamps, {
    A: run.attempts[0].dispatchedAt,
    B: run.attempts[1].dispatchedAt,
  });
  assert.ok(Number.isFinite(run.dispatchDeltaMs) && run.dispatchDeltaMs >= 0);
});

test("allow-overspend behavior settles both and classifies overspend as FAIL", async () => {
  const run = await simulate({ behavior: "allow_overspend" });
  assert.deepEqual(run.attempts.map((attempt) => attempt.result), ["SUCCESS", "SUCCESS"]);
  assert.equal(run.settledPrincipalSats, 1_400);
  assert.equal(run.overspendSats, 400);
  assert.equal(run.remainingBudgetSats, null);
  assert.equal(run.invariant.holds, false);
  assert.equal(run.finalClassification, "FAIL");
});

test("two 400-sat attempts settle under a 1,000-sat enforced budget", async () => {
  const run = await simulate({ attemptAmountSats: { A: 400, B: 400 } });
  assert.deepEqual(run.attempts.map((attempt) => attempt.result), ["SUCCESS", "SUCCESS"]);
  assert.equal(run.settledPrincipalSats, 800);
  assert.equal(run.remainingBudgetSats, 200);
  assert.equal(run.invariant.holds, true);
  assert.equal(run.finalClassification, "PASS");
});

test("settlement exactly equal to the configured budget passes with zero remaining", async () => {
  const run = await simulate({ attemptAmountSats: { A: 600, B: 400 } });
  assert.deepEqual(run.attempts.map((attempt) => attempt.result), ["SUCCESS", "SUCCESS"]);
  assert.equal(run.settledPrincipalSats, 1_000);
  assert.equal(run.remainingBudgetSats, 0);
  assert.equal(run.overspendSats, 0);
  assert.equal(run.finalClassification, "PASS");
});

test("an individually oversized request is blocked under enforcement without breaching the budget", async () => {
  const run = await simulate({ startingBudgetSats: 100, attemptAmountSats: { A: 200, B: 40 } });
  assert.deepEqual(run.attempts.map((attempt) => attempt.result), ["QUOTA_EXCEEDED", "SUCCESS"]);
  assert.equal(run.settledPrincipalSats, 40);
  assert.equal(run.remainingBudgetSats, 60);
  assert.equal(run.invariant.holds, true);
  assert.equal(run.finalClassification, "PASS");
});

test("each valid simulation gets a fresh run ID", async () => {
  const first = await runSandboxSimulation({ configuration: DEFAULT });
  const second = await runSandboxSimulation({ configuration: DEFAULT });
  assert.match(first.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(first.runId, second.runId);
});

test("sandbox evidence preserves configuration, timing, derived invariant, and simulation label", async () => {
  const run = await simulate({ behavior: "allow_overspend" });
  const evidence = createSandboxEvidence(run, "2026-10-03T12:00:01.000Z");
  assert.equal(evidence.mode, "sandbox");
  assert.equal(evidence.runId, run.runId);
  assert.deepEqual(evidence.configuration, run.configuration);
  assert.equal(evidence.startingBudgetSats, 1_000);
  assert.deepEqual(evidence.attempts.map((attempt) => attempt.requestedAmountSats), [700, 700]);
  assert.deepEqual(evidence.attempts.map((attempt) => attempt.simulatedPaymentResult), ["SUCCESS", "SUCCESS"]);
  assert.ok(evidence.attempts.every((attempt) => typeof attempt.dispatchTimestamp === "string"));
  assert.equal(evidence.barrierReleasedAt, run.barrierReleasedAt);
  assert.equal(evidence.dispatchDeltaMs, run.dispatchDeltaMs);
  assert.equal(evidence.settledPrincipalSats, 1_400);
  assert.equal(evidence.overspendSats, 400);
  assert.equal(evidence.remainingBudgetSats, null);
  assert.equal(evidence.invariant.holds, false);
  assert.equal(evidence.finalClassification, "FAIL");
  assert.equal(evidence.generatedAt, "2026-10-03T12:00:01.000Z");
  assert.match(evidence.notice, /simulation only/i);
});

test("evidence refuses a classification that conflicts with simulated principal", async () => {
  const run = await simulate();
  assert.throws(() => createSandboxEvidence({ ...run, finalClassification: "FAIL" }), /classification/);
});

test("configuration validation rejects empty, zero, negative, decimal, nonnumeric, boolean, and over-limit inputs", () => {
  for (const value of ["", "0", "-1", "1.5", "abc", true, String(MAX_SANDBOX_SATS + 1)]) {
    const result = validateSandboxConfiguration({ ...DEFAULT, attemptAmountSats: { A: value, B: 700 } });
    assert.equal(result.valid, false, `expected rejection for ${String(value)}`);
    assert.ok(result.errors.attemptAmountA);
  }
  assert.equal(validateSandboxConfiguration({ ...DEFAULT, startingBudgetSats: "" }).valid, false);
  assert.equal(validateSandboxConfiguration({ ...DEFAULT, attemptAmountSats: { A: 700, B: "2.5" } }).valid, false);
  for (const value of ["", "0", "-1", "1.25", "coins", true, String(MAX_SANDBOX_SATS + 1)]) {
    assert.equal(validateSandboxConfiguration({ ...DEFAULT, startingBudgetSats: value }).valid, false);
  }
  assert.equal(validateSandboxConfiguration({ ...DEFAULT, behavior: "ignore_all_limits" }).valid, false);
});

test("configuration accepts the documented positive integer maximum and normalizes numeric strings", () => {
  const result = validateSandboxConfiguration({
    startingBudgetSats: String(MAX_SANDBOX_SATS),
    attemptAmountSats: { A: "1", B: String(MAX_SANDBOX_SATS) },
    behavior: "enforce_limit",
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.configuration.attemptAmountSats, { A: 1, B: MAX_SANDBOX_SATS });
});
