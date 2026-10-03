import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandboxEvidence } from "../dashboard/sandbox/sandbox-evidence.js";
import { runSandboxSimulation } from "../dashboard/sandbox/sandbox-runner.js";

test("1,000 sats with two concurrent 700 sat attempts settles exactly one", async () => {
  const run = await runSandboxSimulation();
  assert.equal(run.mode, "sandbox");
  assert.equal(run.startingBudgetSats, 1_000);
  assert.deepEqual(run.attempts.map((attempt) => attempt.requestedAmountSats), [700, 700]);
  assert.deepEqual(run.attempts.map((attempt) => attempt.result), ["SUCCESS", "QUOTA_EXCEEDED"]);
  assert.equal(run.attempts.filter((attempt) => attempt.settledAmountSats > 0).length, 1);
});

test("sandbox computes 700 settled, 300 remaining, a held invariant, and PASS", async () => {
  const run = await runSandboxSimulation();
  assert.equal(run.settledPrincipalSats, 700);
  assert.equal(run.remainingBudgetSats, 300);
  assert.deepEqual(run.invariant, { expression: "settledPrincipalSats <= startingBudgetSats", holds: true });
  assert.equal(run.finalClassification, "PASS");
  assert.ok(Number.isFinite(run.dispatchDeltaMs) && run.dispatchDeltaMs >= 0);
  assert.ok(Date.parse(run.barrierReleasedAt));
  assert.ok(Date.parse(run.dispatchTimestamps.A));
  assert.ok(Date.parse(run.dispatchTimestamps.B));
});

test("every sandbox simulation receives a fresh run ID", async () => {
  const first = await runSandboxSimulation();
  const second = await runSandboxSimulation();
  assert.notEqual(first.runId, second.runId);
});

test("sandbox evidence has a sandbox-only label and complete export fields", async () => {
  const run = await runSandboxSimulation();
  const evidence = createSandboxEvidence(run, "2026-10-03T12:00:00.000Z");
  assert.equal(evidence.mode, "sandbox");
  assert.equal(evidence.runId, run.runId);
  assert.equal(evidence.startingBudgetSats, 1_000);
  assert.deepEqual(evidence.attempts.map((attempt) => attempt.requestedAmountSats), [700, 700]);
  assert.deepEqual(evidence.attempts.map((attempt) => attempt.simulatedPaymentResult), ["SUCCESS", "QUOTA_EXCEEDED"]);
  assert.ok(evidence.attempts.every((attempt) => typeof attempt.dispatchTimestamp === "string"));
  assert.equal(evidence.dispatchDeltaMs, run.dispatchDeltaMs);
  assert.equal(evidence.settledPrincipalSats, 700);
  assert.equal(evidence.remainingBudgetSats, 300);
  assert.equal(evidence.invariant.holds, true);
  assert.equal(evidence.finalClassification, "PASS");
  assert.equal(evidence.generatedAt, "2026-10-03T12:00:00.000Z");
  assert.match(evidence.notice, /simulation only/i);
});
