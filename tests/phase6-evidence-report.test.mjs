import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvidenceReport } from "../scripts/phase6-evidence-report.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const FIXED_TIME = "2026-10-01T12:00:00.000Z";

function evidence({
  settledA = true,
  settledB = false,
  bobPhase = "final",
  omitBarrier = false,
  omitBudgetAfter = false,
  poisonInputs = false,
} = {}) {
  const attempts = [
    {
      id: "A",
      paymentHash: HASH_A,
      dispatchedAt: "2026-10-01T10:35:46.822Z",
      result: "success",
      errorCode: null,
      feesPaidMsat: 0,
    },
    {
      id: "B",
      paymentHash: HASH_B,
      dispatchedAt: "2026-10-01T10:35:46.823Z",
      result: "error",
      errorCode: "QUOTA_EXCEEDED",
      feesPaidMsat: null,
    },
  ];
  const raceEvidence = {
    schemaVersion: 1,
    test: "phase4-two-payment-budget-race",
    wallet: "Alby Hub / Alice",
    network: "regtest",
    startingBudget: {
      totalMsat: 1_000_000,
      usedMsat: 0,
      spendableMsat: 1_000_000,
      spendableSats: 1_000,
      renewal: "never",
    },
    barrierReleasedAt: omitBarrier ? null : "2026-10-01T10:35:46.822Z",
    dispatchDeltaMs: 1.704,
    attempts,
    budgetAfter: omitBudgetAfter
      ? null
      : {
          totalBudgetMsat: 1_000_000,
          usedBudgetMsat: settledA && settledB ? 1_400_000 : settledA || settledB ? 700_000 : 0,
          remainingBudgetMsat: settledA && settledB ? 0 : settledA || settledB ? 300_000 : 1_000_000,
          renewalPeriod: "never",
        },
  };
  if (poisonInputs) {
    raceEvidence.attempts[0].invoice = ["lnbcrt1", "fake-invoice"].join("");
    raceEvidence.attempts[0].preimage = "fake-preimage";
    raceEvidence.attempts[1].errorCode = "NOT_AN_ALLOWED_CODE";
    raceEvidence.connectionUri = ["nostr+walletconnect:/", "/fake-uri"].join("");
    raceEvidence.invoice = ["lnbcrt1", "fake-invoice"].join("");
    raceEvidence.preimage = "fake-preimage";
    raceEvidence.password = "fake-pw";
    raceEvidence.token = "fake-tok";
    raceEvidence.macaroon = "fake-mac";
    raceEvidence.tls = "fake-tls";
    raceEvidence["rpc" + "Password"] = "fake-rpc";
  }

  const outcomes = [
    {
      id: "A",
      paymentHash: HASH_A,
      reconciled: true,
      settled: settledA,
      state: settledA ? "SETTLED" : "OPEN",
      amountPaidSat: settledA ? 700 : 0,
      settleDateUnix: settledA ? 1790850947 : null,
      settledAt: settledA ? "2026-10-01T10:35:47.000Z" : null,
    },
    {
      id: "B",
      paymentHash: HASH_B,
      reconciled: true,
      settled: settledB,
      state: settledB ? "SETTLED" : "OPEN",
      amountPaidSat: settledB ? 700 : 0,
      settleDateUnix: settledB ? 1790850948 : null,
      settledAt: settledB ? "2026-10-01T10:35:48.000Z" : null,
    },
  ];
  const bobEvidence = { phase: bobPhase, outcomes };
  if (poisonInputs) {
    bobEvidence.preimage = "other-fake-preimage";
    bobEvidence.password = "other-pw";
  }
  return { raceEvidence, bobEvidence };
}

function makeReport(options = {}) {
  return buildEvidenceReport({ ...evidence(options), generatedAt: FIXED_TIME });
}

test("generates a PASS report from complete independently reconciled evidence", () => {
  const report = makeReport();
  assert.equal(report.finalClassification, "PASS");
  assert.equal(report.independentlySettledPrincipalSats, 700);
  assert.equal(report.invariant.holds, true);
  assert.deepEqual(report.attempts.map((attempt) => attempt.bobSettlement.settled), [true, false]);
  assert.equal(report.postRaceRemainingBudgetSats, 300);
});

test("generates a FAIL report when Bob confirms settled principal above budget", () => {
  const report = makeReport({ settledA: true, settledB: true });
  assert.equal(report.finalClassification, "FAIL");
  assert.equal(report.independentlySettledPrincipalSats, 1_400);
  assert.equal(report.invariant.holds, false);
});

test("missing Bob or race evidence produces INCONCLUSIVE", () => {
  const missingBob = buildEvidenceReport({
    raceEvidence: evidence().raceEvidence,
    bobEvidence: { phase: "final", outcomes: [] },
    generatedAt: FIXED_TIME,
  });
  const missingRaceField = makeReport({ omitBarrier: true });
  const missingPostBudget = makeReport({ omitBudgetAfter: true });
  const fractionalPostBudget = evidence();
  fractionalPostBudget.raceEvidence.budgetAfter.usedBudgetMsat = 699_999;
  fractionalPostBudget.raceEvidence.budgetAfter.remainingBudgetMsat = 300_001;
  const invalidPostBudget = buildEvidenceReport({
    ...fractionalPostBudget,
    generatedAt: FIXED_TIME,
  });
  const incompleteSettlement = evidence();
  incompleteSettlement.bobEvidence.outcomes[1].amountPaidSat = null;
  const missingSettlementAmount = buildEvidenceReport({
    ...incompleteSettlement,
    generatedAt: FIXED_TIME,
  });
  assert.equal(missingBob.finalClassification, "INCONCLUSIVE");
  assert.equal(missingRaceField.finalClassification, "INCONCLUSIVE");
  assert.equal(missingPostBudget.finalClassification, "INCONCLUSIVE");
  assert.equal(invalidPostBudget.finalClassification, "INCONCLUSIVE");
  assert.equal(missingSettlementAmount.finalClassification, "INCONCLUSIVE");
  assert.equal(missingBob.invariant.holds, null);
});

test("report contains the required stable fields and two hash-only attempts", () => {
  const report = makeReport();
  assert.deepEqual(
    Object.keys(report),
    [
      "reportVersion",
      "generatedAt",
      "network",
      "walletUnderTest",
      "configuredBudgetSats",
      "renewal",
      "requestCount",
      "requestedAmountPerInvoiceSats",
      "barrierReleasedAt",
      "dispatchDeltaMs",
      "attempts",
      "independentlySettledPrincipalSats",
      "postRaceRemainingBudgetSats",
      "invariant",
      "finalClassification",
      "evidenceCompleteness",
    ],
  );
  assert.equal(report.reportVersion, "1.0.0");
  assert.equal(report.generatedAt, FIXED_TIME);
  assert.equal(report.network, "regtest");
  assert.equal(report.walletUnderTest, "Alby Hub / NWC");
  assert.equal(report.configuredBudgetSats, 1_000);
  assert.equal(report.renewal, "never");
  assert.equal(report.requestCount, 2);
  assert.equal(report.requestedAmountPerInvoiceSats, 700);
  assert.equal(report.barrierReleasedAt, "2026-10-01T10:35:46.822Z");
  assert.equal(report.dispatchDeltaMs, 1.704);
  assert.deepEqual(report.attempts.map((attempt) => attempt.paymentHash), [HASH_A, HASH_B]);
  assert.equal(report.attempts.every((attempt) => !("invoice" in attempt)), true);
  assert.equal(report.attempts[0].reportedFeesMsat, 0);
  assert.equal(report.attempts[1].reportedFeesMsat, null);
});

test("projects allowlisted fields and excludes secret-bearing input properties", () => {
  const report = makeReport({ poisonInputs: true });
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    ["nostr+walletconnect:/", "/fake-uri"].join(""),
    "fake-uri",
    ["lnbcrt1", "fake-invoice"].join(""),
    "fake-preimage",
    "fake-pw",
    "fake-tok",
    "fake-mac",
    "fake-tls",
    "fake-rpc",
    "other-fake-preimage",
    "other-pw",
    "NOT_AN_ALLOWED_CODE",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `report leaked ${forbidden}`);
  }
});

test("same evidence and generated timestamp produce byte-identical JSON", () => {
  const first = makeReport();
  const { raceEvidence, bobEvidence } = evidence();
  const second = buildEvidenceReport({
    raceEvidence: { ...raceEvidence, attempts: [...raceEvidence.attempts].reverse() },
    bobEvidence: { ...bobEvidence, outcomes: [...bobEvidence.outcomes].reverse() },
    generatedAt: FIXED_TIME,
  });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
