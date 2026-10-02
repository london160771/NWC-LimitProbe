import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  assert.equal(result.reportVersion, "2.2.0");
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
  assert.equal(result.requiredGraceSeconds, 30);
  assert.equal(result.invoiceLifecycle.length, 2);
  assert.equal(result.invoiceLifecycle[0].expirySeconds, 120);
  assert.ok(result.invoiceLifecycle[0].reconciliationDeadline);
});

test("report preserves collector timestamps captured with nanosecond precision", () => {
  const input = makeEvidence();
  const withNanoseconds = (value) => value.replace(/\.(\d{3})Z$/, (_match, milliseconds) => `.${milliseconds}000001Z`);
  input.bobEvidence.startedAt = withNanoseconds(input.bobEvidence.startedAt);
  input.bobEvidence.completedAt = withNanoseconds(input.bobEvidence.completedAt);
  for (const event of input.bobEvidence.collectionSessions) {
    if (event.startedAt) event.startedAt = withNanoseconds(event.startedAt);
    if (event.completedAt) event.completedAt = withNanoseconds(event.completedAt);
  }
  const result = buildEvidenceReport({ ...input, generatedAt: GENERATED_AT });
  assert.equal(result.reconciliation.collection.startedAt, makeEvidence().bobEvidence.startedAt);
  assert.equal(result.reconciliation.collection.completedAt, makeEvidence().bobEvidence.completedAt);
  assert.equal(result.reconciliation.collection.sessions[0].startedAt, makeEvidence().bobEvidence.collectionSessions[0].startedAt);
  assert.equal(result.evidenceCompleteness.supplementaryIssues.includes("bob_completion_timestamp_missing_or_before_observation"), false);
  assert.equal(result.evidenceCompleteness.supplementaryIssues.includes("collector_session_chronology_invalid"), false);
});

test("report re-derives collector issues instead of exporting stale persisted timestamp failures", () => {
  const input = makeEvidence();
  input.bobEvidence.collectionIssues = [
    "collector_session_chronology_invalid",
    "collector_query_chronology_or_binding_invalid",
    "collector_trailing_record_incomplete",
  ];
  const result = buildEvidenceReport({ ...input, generatedAt: GENERATED_AT });
  assert.deepEqual(result.reconciliation.collection.issues, ["collector_trailing_record_incomplete"]);
});

test("report CLI falls back to bound dispatch progress when results are absent and preserves FAIL", () => {
  const directory = mkdtempSync(join(tmpdir(), "nwc-phase62-report-fallback-"));
  try {
    const input = makeEvidence({ settledA: true, settledB: true });
    input.raceEvidence.stage = "dispatch_complete";
    const resultsPath = join(directory, "phase45-race-results.json");
    const progressPath = join(directory, "phase45-race-progress.json");
    const configPath = join(directory, "phase6-run-config.json");
    const bobPath = join(directory, "bob-final-evidence.json");
    const outputPath = join(directory, "evidence.json");
    writeFileSync(progressPath, JSON.stringify(input.raceEvidence));
    writeFileSync(configPath, JSON.stringify({ runId: input.raceEvidence.runId }));
    writeFileSync(bobPath, JSON.stringify(input.bobEvidence));
    const reportArgs = [
      resolve("scripts/phase6-evidence-report.mjs"),
      "--race", resultsPath,
      "--race-progress", progressPath,
      "--run-config", configPath,
      "--bob", bobPath,
      "--out", outputPath,
      "--generated-at", GENERATED_AT,
    ];
    const cli = spawnSync(process.execPath, reportArgs, { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const generated = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(generated.finalClassification, "FAIL");
    assert.equal(generated.runState.stage, "dispatch_complete");
    assert.equal(generated.runId, input.raceEvidence.runId);

    const mismatchedResults = structuredClone(input.raceEvidence);
    mismatchedResults.attempts[0].runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    writeFileSync(resultsPath, JSON.stringify(mismatchedResults));
    const fallbackAfterInvalidResults = spawnSync(process.execPath, reportArgs, { encoding: "utf8" });
    assert.equal(fallbackAfterInvalidResults.status, 0, fallbackAfterInvalidResults.stderr);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).finalClassification, "FAIL");
    const malformedResults = structuredClone(input.raceEvidence);
    malformedResults.attempts[0].id = { toString: null };
    writeFileSync(resultsPath, JSON.stringify(malformedResults));
    const fallbackAfterMalformedId = spawnSync(process.execPath, reportArgs, { encoding: "utf8" });
    assert.equal(fallbackAfterMalformedId.status, 0, fallbackAfterMalformedId.stderr);
    const malformedFallbackReport = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(malformedFallbackReport.finalClassification, "FAIL");
    assert.ok(malformedFallbackReport.evidenceCompleteness.supplementaryIssues.includes("race_results_candidate_invalid"));

    rmSync(progressPath);
    const noFallbackFirst = spawnSync(process.execPath, reportArgs, { encoding: "utf8" });
    assert.equal(noFallbackFirst.status, 0, noFallbackFirst.stderr);
    const noFallbackReport = JSON.parse(readFileSync(outputPath, "utf8"));
    const noFallbackSecond = spawnSync(process.execPath, reportArgs, { encoding: "utf8" });
    assert.equal(noFallbackSecond.status, 0, noFallbackSecond.stderr);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), noFallbackReport);
    assert.equal(noFallbackReport.finalClassification, "INCONCLUSIVE");
    assert.ok(noFallbackReport.evidenceCompleteness.supplementaryIssues.includes("race_results_candidate_invalid"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the persisted final NWC and budget completion stage is exported by its allowlisted name", () => {
  const input = makeEvidence();
  input.raceEvidence.stage = "final_nwc_lookup_and_budget_complete";
  const result = buildEvidenceReport({ ...input, generatedAt: GENERATED_AT });
  assert.equal(result.runState.stage, "final_nwc_lookup_and_budget_complete");
});

test("OPEN on one invoice preserves confirmed settled principal but not a PASS invariant", () => {
  const result = report({ terminalB: "OPEN" });
  assert.equal(result.finalClassification, "INCONCLUSIVE");
  assert.equal(result.confirmedSettledPrincipalMsat, 700_000);
  assert.equal(result.independentlySettledPrincipalSats, null);
  assert.equal(result.invariant.holds, null);
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
    rpcPassword: "q9v",
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

test("report validates every free-form export including run ID, renewal, and error fields", () => {
  const input = makeEvidence();
  const synthetic = ["nostr+walletconnect:", "/", "/private-secret-shaped-value"].join("");
  input.raceEvidence.runId = synthetic;
  input.bobEvidence.runId = synthetic;
  input.raceEvidence.startingBudget.runId = synthetic;
  input.raceEvidence.startingBudget.renewalPeriod = synthetic;
  input.raceEvidence.budgetAfter.renewalPeriod = synthetic;
  input.raceEvidence.attempts[1].runId = synthetic;
  input.raceEvidence.attempts[1].errorCode = synthetic;
  input.raceEvidence.nwcLookups[0].errorCode = synthetic;
  input.bobEvidence.observations[0].runId = synthetic;
  input.bobEvidence.observations[0].errorCode = synthetic;
  input.bobEvidence.completionStatus = synthetic;
  input.bobEvidence.collectionIssues = [synthetic];
  const result = buildEvidenceReport({ ...input, generatedAt: GENERATED_AT });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(synthetic), false);
  assert.equal(result.runId, null);
  assert.equal(result.startingBudget.renewalPeriod, null);
  assert.equal(result.postRaceBudget.renewalPeriod, null);
  assert.equal(result.attempts[1].nwcResult.errorCode, "OTHER");
  assert.equal(result.reconciliation.collection.completionStatus, "collector_error");
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

test("msat fractions remain precise and a missing post-budget blocks PASS", () => {
  const input = makeEvidence();
  input.raceEvidence.budgetAfter.usedBudgetMsat = 700_001;
  input.raceEvidence.budgetAfter.remainingBudgetMsat = 299_999;
  const fractional = buildEvidenceReport({ ...input, generatedAt: GENERATED_AT });
  assert.equal(fractional.finalClassification, "INCONCLUSIVE");
  assert.equal(fractional.postRaceBudget.remainingBudgetMsat, 299_999);

  const withoutBudget = makeEvidence();
  withoutBudget.raceEvidence.budgetAfter = null;
  const noPostBudget = buildEvidenceReport({ ...withoutBudget, generatedAt: GENERATED_AT });
  assert.equal(noPostBudget.finalClassification, "INCONCLUSIVE");
  assert.equal(noPostBudget.postRaceBudget.available, false);
  assert.equal(noPostBudget.evidenceCompleteness.complete, false);

  const partial = makeEvidence();
  partial.raceEvidence.budgetAfter = { totalBudgetMsat: 1_000_000 };
  const partialPostBudget = buildEvidenceReport({ ...partial, generatedAt: GENERATED_AT });
  assert.equal(partialPostBudget.finalClassification, "INCONCLUSIVE");
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

test("malformed NWC timestamp report generation is safe and deterministic", () => {
  const firstEvidence = makeEvidence();
  firstEvidence.raceEvidence.nwcLookups.find((item) => item.id === "A").settledAt = { toString: null };
  const first = buildEvidenceReport({ ...firstEvidence, generatedAt: GENERATED_AT });

  const secondEvidence = makeEvidence();
  secondEvidence.raceEvidence.nwcLookups.find((item) => item.id === "A").settledAt = { toString: null };
  const second = buildEvidenceReport({ ...secondEvidence, generatedAt: GENERATED_AT });

  assert.equal(first.finalClassification, "INCONCLUSIVE");
  assert.equal(first.reconciliation.nwcLookups.find((item) => item.id === "A").settledAt, null);
  assert.ok(first.evidenceCompleteness.supplementaryIssues.includes("nwc_settlement_timestamp_invalid"));
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  const overspend = makeEvidence({ settledA: true, settledB: true });
  overspend.raceEvidence.nwcLookups.find((item) => item.id === "A").settledAt = { toString: null };
  const overspendReport = buildEvidenceReport({ ...overspend, generatedAt: GENERATED_AT });
  assert.equal(overspendReport.finalClassification, "FAIL");
  assert.equal(overspendReport.independentlySettledPrincipalMsat, 1_400_000);
  assert.doesNotThrow(() => JSON.stringify(overspendReport));
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
