import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TwoPartyBarrier,
  classifyInvariant,
  dispatchTwoPayments,
  normalizeBudgetMsat,
  reconcileTwoInvoices,
  sumSettledPrincipalSats,
} from "../scripts/phase45-core.mjs";

test("two-party barrier holds both participants until one shared release", async () => {
  const barrier = new TwoPartyBarrier();
  let released = false;
  assert.throws(() => barrier.release("too-early"), /barrier_not_fully_armed/);
  const first = barrier.arriveAndWait().then((at) => {
    released = true;
    return at;
  });
  await Promise.resolve();
  assert.equal(released, false);

  const second = barrier.arriveAndWait();
  await barrier.waitUntilArmed();
  assert.equal(barrier.arrivals, 2);
  assert.equal(released, false);
  assert.equal(barrier.release("2026-10-01T12:00:00.000Z"), "2026-10-01T12:00:00.000Z");
  assert.deepEqual(await Promise.all([first, second]), [
    "2026-10-01T12:00:00.000Z",
    "2026-10-01T12:00:00.000Z",
  ]);
});

test("dispatch prepares and releases both payment calls without awaiting either", async () => {
  const deferred = [];
  const calls = [];
  let monotonic = 10;
  let wall = 0;
  const requests = [
    { id: "A", paymentHash: "a".repeat(64), invoice: "invoice-a" },
    { id: "B", paymentHash: "b".repeat(64), invoice: "invoice-b" },
  ];
  const run = dispatchTwoPayments(requests, (invoice) => {
    calls.push(invoice);
    return new Promise((resolve) => deferred.push(resolve));
  }, {
    wallClock: () => `2026-10-01T12:00:00.${String(wall++).padStart(3, "0")}Z`,
    monotonicClock: () => monotonic++,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["invoice-a", "invoice-b"]);
  assert.equal(deferred.length, 2);
  deferred[0]({ fees_paid: 10, preimage: "must-not-be-returned" });
  deferred[1]({ fees_paid: 0, preimage: "must-not-be-returned" });

  const result = await run;
  assert.equal(result.barrierReleasedAt, "2026-10-01T12:00:00.000Z");
  assert.equal(result.dispatchDeltaMs, 1);
  assert.deepEqual(result.attempts.map(({ result: state }) => state), ["success", "success"]);
  assert.deepEqual(result.attempts.map(({ feesPaidMsat }) => feesPaidMsat), [10, 0]);
  assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
});

test("budget response normalizes Alby msat fields and infers remaining budget", () => {
  assert.deepEqual(
    normalizeBudgetMsat({ total_budget_msats: 1_000_000, used_budget_msats: 250_000 }),
    {
      totalBudgetMsat: 1_000_000,
      usedBudgetMsat: 250_000,
      remainingBudgetMsat: 750_000,
      renewalPeriod: null,
    },
  );
});

test("settled principal sum includes only independently reconciled settlements", () => {
  assert.equal(
    sumSettledPrincipalSats([
      { reconciled: true, settled: true, amountPaidSat: 700 },
      { reconciled: true, settled: false, amountPaidSat: 0 },
      { reconciled: false, settled: true, amountPaidSat: 900 },
    ]),
    700,
  );
});

test("invariant classifies PASS, FAIL, and INCONCLUSIVE", () => {
  const pass = classifyInvariant({
    startingSpendableBudgetSats: 1_000,
    outcomes: [
      { reconciled: true, settled: true, amountPaidSat: 700 },
      { reconciled: true, settled: false, amountPaidSat: 0 },
    ],
  });
  assert.equal(pass.classification, "PASS");
  assert.equal(pass.totalSettledPrincipalSats, 700);

  const fail = classifyInvariant({
    startingSpendableBudgetSats: 1_000,
    outcomes: [
      { reconciled: true, settled: true, amountPaidSat: 700 },
      { reconciled: true, settled: true, amountPaidSat: 700 },
    ],
  });
  assert.equal(fail.classification, "FAIL");
  assert.equal(fail.totalSettledPrincipalSats, 1_400);

  const inconclusive = classifyInvariant({
    startingSpendableBudgetSats: 1_000,
    outcomes: [{ reconciled: true, settled: false, amountPaidSat: 0 }],
  });
  assert.equal(inconclusive.classification, "INCONCLUSIVE");
  assert.equal(inconclusive.totalSettledPrincipalSats, null);
});

test("two Bob lookups reconcile one settled invoice and one unpaid invoice", () => {
  const firstHash = "a".repeat(64);
  const secondHash = "b".repeat(64);
  const result = reconcileTwoInvoices({
    startingSpendableBudgetSats: 1_000,
    expectedInvoices: [
      { id: "A", paymentHash: firstHash, amountSat: 700 },
      { id: "B", paymentHash: secondHash, amountSat: 700 },
    ],
    bobLookups: [
      { r_hash: firstHash, settled: true, state: "SETTLED", amt_paid_sat: "700", settle_date: "1790800000" },
      { r_hash: secondHash, settled: false, state: "OPEN", amt_paid_sat: "0", settle_date: "0" },
    ],
  });
  assert.equal(result.classification, "PASS");
  assert.equal(result.totalSettledPrincipalSats, 700);
  assert.deepEqual(result.outcomes.map(({ settled }) => settled), [true, false]);
  assert.equal(result.outcomes[0].settledAt, "2026-09-30T20:26:40.000Z");
});

test("missing, mismatched, or contradictory Bob evidence is inconclusive", () => {
  const result = reconcileTwoInvoices({
    startingSpendableBudgetSats: 1_000,
    expectedInvoices: [
      { id: "A", paymentHash: "a".repeat(64), amountSat: 700 },
      { id: "B", paymentHash: "b".repeat(64), amountSat: 700 },
    ],
    bobLookups: [
      { r_hash: "a".repeat(64), settled: false, state: "ACCEPTED", amt_paid_sat: "0" },
      { r_hash: "b".repeat(64), settled: true, state: "SETTLED", amt_paid_sat: "600" },
    ],
  });
  assert.equal(result.classification, "INCONCLUSIVE");
  assert.equal(result.outcomes.every(({ reconciled }) => !reconciled), true);
});
