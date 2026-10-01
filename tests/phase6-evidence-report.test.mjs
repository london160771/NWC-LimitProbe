import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvidenceReport } from "../scripts/phase6-evidence-report.mjs";
import { GENERATED_AT, HASH_A, HASH_B, makeEvidence } from "./phase61-evidence-fixture.mjs";

function report(options = {}) {
  return buildEvidenceReport({ ...makeEvidence(options), generatedAt: GENERATED_AT });
}

test("generates PASS only with bound initial, NWC, and terminal Bob evidence", () => {
  const result = report();
  assert.equal(result.finalClassification, "PASS");
  assert.equal(result.independentlySettledPrincipalSats, 700);
  assert.equal(result.invariant.holds, true);
  assert.equal(result.startingBudget.verified, true);
  assert.deepEqual(result.reconciliation.invoices.map((invoice) => invoice.state), ["SETTLED", "CANCELED"]);
});

test("generates FAIL when both receiver invoices are terminally settled", () => {
  const result = report({ settledA: true, settledB: true });
  assert.equal(result.finalClassification, "FAIL");
  assert.equal(result.independentlySettledPrincipalSats, 1_400);
  assert.equal(result.invariant.holds, false);
});

test("missing and unresolved evidence generate INCONCLUSIVE with unknown invariant", () => {
  const noEvidence = buildEvidenceReport({ generatedAt: GENERATED_AT });
  const missingNwc = report({ missingNwc: true });
  const unresolved = makeEvidence();
  unresolved.bobEvidence.observations = unresolved.bobEvidence.observations.map((item) => item.id === "A"
    ? { ...item, state: "OPEN", settled: false, amountPaidSat: 0, settleDateUnix: 0, settledAt: null }
    : item);
  unresolved.raceEvidence.nwcLookups = unresolved.raceEvidence.nwcLookups.map((item) => item.id === "A"
    ? { ...item, lookupState: "OPEN", settledAt: null }
    : item);
  const timeout = buildEvidenceReport({ ...unresolved, generatedAt: GENERATED_AT });
  assert.equal(noEvidence.finalClassification, "INCONCLUSIVE");
  assert.equal(missingNwc.finalClassification, "INCONCLUSIVE");
  assert.equal(timeout.finalClassification, "INCONCLUSIVE");
  assert.equal(timeout.invariant.holds, null);
});

test("report includes required run binding, timing, lookup, and observation fields", () => {
  const result = report();
  assert.equal(result.reportVersion, "2.0.0");
  assert.equal(result.generatedAt, GENERATED_AT);
  assert.equal(result.network, "regtest");
  assert.equal(result.walletUnderTest, "Alby Hub / NWC");
  assert.equal(result.configuredBudgetSats, 1_000);
  assert.equal(result.renewal, "never");
  assert.equal(result.requestCount, 2);
  assert.equal(result.requestedAmountPerInvoiceSats, 700);
  assert.equal(result.attempts[0].paymentHash, HASH_A);
  assert.equal(result.attempts[1].paymentHash, HASH_B);
  assert.equal(result.barrierReleaseMonotonicMs, 100);
  assert.equal(result.attempts[0].dispatchMonotonicMs, 101);
  assert.equal(result.attempts[0].responseMonotonicMs, 200);
  assert.equal(result.reconciliation.nwcLookups[0].requestedHash, HASH_A);
  assert.equal(result.reconciliation.nwcLookups[0].returnedHash, HASH_A);
  assert.equal(result.reconciliation.nwcLookups[0].amountMsat, 700_000);
  assert.equal(result.reconciliation.initialBobObservations.length, 2);
  assert.equal(result.reconciliation.bobObservations.length, 4);
  assert.equal(result.postRaceBudget.remainingBudgetMsat, 300_000);
});

test("projects allowlisted evidence fields and redacts secret-shaped values", () => {
  const input = makeEvidence();
  const secretCode = "d".repeat(64);
  const forbiddenValues = {
    invoice: ["ln", "bcrt1", "-synthetic"].join(""),
    preimage: ["private", "-preimage"].join(""),
    connectionUri: ["nostr+walletconnect:", "/", "/synthetic"].join(""),
    password: ["private", "-password"].join(""),
    token: ["private", "-token"].join(""),
    macaroon: ["private", "-macaroon"].join(""),
    rpcPassword: ["private", "-rpc-password"].join(""),
    errorText: ["private", "-error-text"].join(""),
  };
  input.raceEvidence.attempts[1].errorCode = secretCode;
  input.raceEvidence.attempts[0].invoice = forbiddenValues.invoice;
  input.raceEvidence.attempts[0].preimage = forbiddenValues.preimage;
  input.raceEvidence["connection" + "Uri"] = forbiddenValues.connectionUri;
  input.raceEvidence[["pass", "word"].join("")] = forbiddenValues.password;
  input.raceEvidence[["to", "ken"].join("")] = forbiddenValues.token;
  input.raceEvidence[["maca", "roon"].join("")] = forbiddenValues.macaroon;
  input.raceEvidence[["rpc", "Password"].join("")] = forbiddenValues.rpcPassword;
  input.raceEvidence.nwcLookups[0].arbitraryError = forbiddenValues.errorText;
  input.bobEvidence.observations[0].preimage = ["private", "-bob-preimage"].join("");
  const result = buildEvidenceReport({ ...input, generatedAt: GENERATED_AT });
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    secretCode,
    forbiddenValues.invoice,
    forbiddenValues.preimage,
    forbiddenValues.connectionUri,
    forbiddenValues.password,
    forbiddenValues.token,
    forbiddenValues.macaroon,
    forbiddenValues.rpcPassword,
    forbiddenValues.errorText,
    ["private", "-bob-preimage"].join(""),
  ]) assert.equal(serialized.includes(forbidden), false);
  assert.equal(result.attempts[1].nwcResult.errorCode, "OTHER");
});

test("missing NWC response hash and numeric fields stay null in report output", () => {
  const input = makeEvidence();
  input.raceEvidence.nwcLookups[0].returnedHash = null;
  input.raceEvidence.nwcLookups[0].amountMsat = null;
  const result = buildEvidenceReport({ ...input, generatedAt: GENERATED_AT });
  assert.equal(result.finalClassification, "INCONCLUSIVE");
  assert.equal(result.reconciliation.nwcLookups[0].returnedHash, null);
  assert.equal(result.reconciliation.nwcLookups[0].amountMsat, null);
});

test("msat fractions remain precise and a missing post-budget is supplementary", () => {
  const input = makeEvidence();
  input.raceEvidence.budgetAfter.usedBudgetMsat = 700_001;
  input.raceEvidence.budgetAfter.remainingBudgetMsat = 299_999;
  const fractional = buildEvidenceReport({ ...input, generatedAt: GENERATED_AT });
  assert.equal(fractional.finalClassification, "PASS");
  assert.equal(fractional.postRaceBudget.remainingBudgetMsat, 299_999);

  const withoutBudget = makeEvidence();
  withoutBudget.raceEvidence.budgetAfter = null;
  const noPostBudget = buildEvidenceReport({ ...withoutBudget, generatedAt: GENERATED_AT });
  assert.equal(noPostBudget.finalClassification, "PASS");
  assert.equal(noPostBudget.postRaceBudget.available, false);
  assert.equal(noPostBudget.evidenceCompleteness.complete, true);

  const partial = makeEvidence();
  partial.raceEvidence.budgetAfter = { totalBudgetMsat: 1_000_000 };
  const partialPostBudget = buildEvidenceReport({ ...partial, generatedAt: GENERATED_AT });
  assert.equal(partialPostBudget.finalClassification, "PASS");
  assert.equal(partialPostBudget.postRaceBudget.valid, false);
  assert.ok(partialPostBudget.evidenceCompleteness.supplementaryIssues.includes("post_race_budget_supplementary_incomplete"));
});

test("same captured evidence defaults to byte-identical report timestamps", () => {
  const firstEvidence = makeEvidence();
  const secondEvidence = makeEvidence();
  const first = buildEvidenceReport(firstEvidence);
  const second = buildEvidenceReport({
    raceEvidence: { ...secondEvidence.raceEvidence, attempts: [...secondEvidence.raceEvidence.attempts].reverse(), nwcLookups: [...secondEvidence.raceEvidence.nwcLookups].reverse() },
    bobEvidence: { ...secondEvidence.bobEvidence, observations: [...secondEvidence.bobEvidence.observations].reverse() },
  });
  assert.equal(first.generatedAt, second.generatedAt);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("older Phase 6 report input cannot be promoted to PASS", () => {
  const oldReport = buildEvidenceReport({
    raceEvidence: { test: "phase4-two-payment-budget-race", network: "regtest", wallet: "Alby Hub / Alice", attempts: [] },
    bobEvidence: { phase: "final", outcomes: [] },
    generatedAt: GENERATED_AT,
  });
  assert.equal(oldReport.finalClassification, "INCONCLUSIVE");
  assert.equal(oldReport.invariant.holds, null);
});
