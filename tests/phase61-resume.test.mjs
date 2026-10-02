import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PHASE61_RESUME_INVOICES,
  PHASE61_RESUME_RUN_ID,
  privateFileMetadataIsSafe,
  validateResumeBobLookups,
  validateResumeRun,
  validateResumeStartingBudget,
} from "../scripts/phase61-resume-validation.mjs";

const runConfig = () => ({
  runId: PHASE61_RESUME_RUN_ID,
  network: "regtest",
  expectedInvoices: PHASE61_RESUME_INVOICES.map(({ id, paymentHash, amountSat }) => ({ id, paymentHash, amountSat })),
});

const invoiceFacts = () => PHASE61_RESUME_INVOICES.map(({ id, paymentHash, amountSat }) => ({
  id,
  fileHash: paymentHash,
  decodedHash: paymentHash,
  amountSat,
  network: "regtest",
  invoicePresent: true,
}));

const bobLookups = () => PHASE61_RESUME_INVOICES.map(({ id, paymentHash, amountSat }) => ({
  id,
  lookup: {
    r_hash: paymentHash,
    value: String(amountSat),
    state: "OPEN",
    settled: false,
    amt_paid_sat: "0",
  },
}));

test("resume is bound to this run, both hashes, amounts, and existing invoices", () => {
  assert.deepEqual(validateResumeRun({ runConfig: runConfig(), invoiceFacts: invoiceFacts() }), { valid: true, reasonCodes: [] });

  const staleRun = runConfig();
  staleRun.runId = "00000000-0000-0000-0000-000000000000";
  assert.equal(validateResumeRun({ runConfig: staleRun, invoiceFacts: invoiceFacts() }).valid, false);

  const badConfigHash = runConfig();
  badConfigHash.expectedInvoices[0].paymentHash = PHASE61_RESUME_INVOICES[1].paymentHash;
  assert.equal(validateResumeRun({ runConfig: badConfigHash, invoiceFacts: invoiceFacts() }).valid, false);

  const badInvoiceHash = invoiceFacts();
  badInvoiceHash[1].decodedHash = PHASE61_RESUME_INVOICES[0].paymentHash;
  assert.equal(validateResumeRun({ runConfig: runConfig(), invoiceFacts: badInvoiceHash }).valid, false);
});

test("resume rejects Bob evidence that is non-OPEN, settled, paid, mismatched, or ambiguous", () => {
  const valid = { runId: PHASE61_RESUME_RUN_ID, expectedInvoices: runConfig().expectedInvoices, lookups: bobLookups() };
  assert.equal(validateResumeBobLookups(valid).valid, true);

  for (const mutate of [
    (lookup) => { lookup.state = "ACCEPTED"; },
    (lookup) => { lookup.settled = true; },
    (lookup) => { lookup.amt_paid_sat = "700"; },
    (lookup) => { lookup.r_hash = PHASE61_RESUME_INVOICES[1].paymentHash; },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed.lookups[0].lookup);
    assert.equal(validateResumeBobLookups(changed).valid, false);
  }

  const duplicate = structuredClone(valid);
  duplicate.lookups[1].id = "A";
  assert.equal(validateResumeBobLookups(duplicate).valid, false);
});

test("resume budget requires exactly 1,000,000 msat total, zero used, full remaining, never renewal", () => {
  const valid = validateResumeStartingBudget({
    budgetResponse: { total_budget: 1_000_000, used_budget: 0, renewal_period: "never" },
    appConfig: { budgetRenewal: "never" },
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.remainingBudgetMsat, 1_000_000);

  for (const budgetResponse of [
    { total_budget: 999_000, used_budget: 0, renewal_period: "never" },
    { total_budget: 1_000_000, used_budget: 1, renewal_period: "never" },
    { total_budget: 1_000_000, used_budget: 0, remaining_budget_msats: 999_999, renewal_period: "never" },
    { total_budget: true, used_budget: 0, renewal_period: "never" },
  ]) {
    assert.equal(validateResumeStartingBudget({ budgetResponse, appConfig: { budgetRenewal: "never" } }).valid, false);
  }
  assert.equal(validateResumeStartingBudget({
    budgetResponse: { total_budget: 1_000_000, used_budget: 0, renewal_period: "daily" },
    appConfig: { budgetRenewal: "never" },
  }).valid, false);
  assert.equal(validateResumeStartingBudget({
    budgetResponse: { total_budget: 1_000_000, used_budget: 0, renewal_period: "never" },
    appConfig: { budgetRenewal: "monthly" },
  }).valid, false);
});

test("private artifact ownership requires the invoking uid and mode 0600", () => {
  assert.equal(privateFileMetadataIsSafe({ uid: 1000, expectedUid: 1000, mode: 0o600 }), true);
  assert.equal(privateFileMetadataIsSafe({ uid: 0, expectedUid: 1000, mode: 0o600 }), false);
  assert.equal(privateFileMetadataIsSafe({ uid: 1000, expectedUid: 1000, mode: 0o644 }), false);

  const dockerWrapper = readFileSync(new URL("../scripts/phase61-docker-run.sh", import.meta.url), "utf8");
  const appHelper = readFileSync(new URL("../scripts/phase61-create-app.sh", import.meta.url), "utf8");
  const reconcileHelper = readFileSync(new URL("../scripts/phase45-reconcile-bob.sh", import.meta.url), "utf8");
  assert.match(dockerWrapper, /uk_uid="\$\(id -u uk\)"/);
  assert.match(dockerWrapper, /docker run --user "\$uk_uid:\$uk_gid"/);
  assert.match(dockerWrapper, /mode 0600/);
  assert.match(appHelper, /id -u uk/);
  assert.match(reconcileHelper, /id -u uk/);
});

test("explicit resume branch cannot create invoices and refuses prior dispatch state", () => {
  const runner = readFileSync(new URL("../run-phase61-live.ps1", import.meta.url), "utf8");
  const resumeStart = runner.indexOf('if [[ "$resume_existing_run" == "1" ]]; then\n  stage="resume_existing_run_artifact_validation"');
  const freshStart = runner.indexOf('else\n  stage="create_two_fresh_bob_invoices"', resumeStart);
  assert.ok(resumeStart >= 0 && freshStart > resumeStart);
  const resumeBranch = runner.slice(resumeStart, freshStart);
  assert.doesNotMatch(resumeBranch, /addinvoice|phase45-save-invoices\.mjs/);
  assert.match(resumeBranch, /phase6\.1-payment-dispatch-started/);
  assert.match(resumeBranch, /phase45-race-results\.json/);
  assert.match(runner, /phase45-race\.mjs --resume-existing-run/);
  assert.match(runner, /if \(-not \$ResumeExistingRun\)/);
  assert.match(runner, /existing_phase61_run_state_requires_explicit_resume_mode/);
  assert.ok(runner.includes(PHASE61_RESUME_RUN_ID));
  const createAppBlock = runner.slice(runner.indexOf("if (-not $ResumeExistingRun)"), runner.indexOf("$linuxScript = @'"));
  assert.match(createAppBlock, /phase61-create-app\.sh/);
});
