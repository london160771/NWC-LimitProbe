import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { reconcileTwoInvoices } from "./phase45-core.mjs";

const REPORT_VERSION = "1.0.0";
const CONFIGURED_BUDGET_SATS = 1_000;
const REQUESTED_AMOUNT_SATS = 700;
const REQUEST_IDS = ["A", "B"];
const SAFE_STATES = new Set(["SETTLED", "OPEN", "CANCELED", "EXPIRED"]);
const SAFE_NWC_ERRORS = new Set([
  "BAD_REQUEST",
  "INTERNAL",
  "INSUFFICIENT_BALANCE",
  "NOT_FOUND",
  "OTHER",
  "PAYMENT_FAILED",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "RESTRICTED",
  "UNAUTHORIZED",
]);

function nonnegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizedTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safePaymentHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function safeErrorCode(value) {
  return typeof value === "string" && SAFE_NWC_ERRORS.has(value)
    ? value
    : value == null
      ? null
      : "OTHER";
}

function exactlyOneById(values, id) {
  if (!Array.isArray(values)) return null;
  const matches = values.filter((value) => value?.id === id);
  return matches.length === 1 ? matches[0] : null;
}

function addMissing(missing, condition, reason) {
  if (!condition && !missing.includes(reason)) missing.push(reason);
}

function normalizedBudgetAfter(value) {
  const totalMsat = nonnegativeInteger(value?.totalBudgetMsat);
  const usedMsat = nonnegativeInteger(value?.usedBudgetMsat);
  const remainingMsat = nonnegativeInteger(value?.remainingBudgetMsat);
  const remainingSats =
    remainingMsat !== null && remainingMsat % 1_000 === 0 ? remainingMsat / 1_000 : null;
  const isComplete =
    totalMsat === CONFIGURED_BUDGET_SATS * 1_000 &&
    usedMsat !== null &&
    remainingMsat !== null &&
    remainingSats !== null &&
    value?.renewalPeriod === "never";
  return { isComplete, remainingSats };
}

/**
 * Build a stable, allowlisted report from the sanitized Phase 4 race result and
 * Bob's independently reconciled Phase 5 evidence. Supply generatedAt in tests
 * or when byte-for-byte reproducibility is required.
 */
export function buildEvidenceReport({ raceEvidence, bobEvidence, generatedAt } = {}) {
  const generatedTimestamp = normalizedTimestamp(generatedAt ?? new Date().toISOString());
  if (generatedTimestamp === null) throw new Error("generated_timestamp_invalid");

  const missing = [];
  const race = raceEvidence && typeof raceEvidence === "object" ? raceEvidence : {};
  const bob = bobEvidence && typeof bobEvidence === "object" ? bobEvidence : {};
  const attemptRecords = Array.isArray(race.attempts) ? race.attempts : [];
  const bobRecords = Array.isArray(bob.outcomes) ? bob.outcomes : [];

  addMissing(missing, race.test === "phase4-two-payment-budget-race", "race_run_missing_or_unrecognized");
  addMissing(missing, race.network === "regtest", "network_not_verified_as_regtest");
  addMissing(missing, race.wallet === "Alby Hub / Alice", "wallet_not_verified");
  addMissing(
    missing,
    race.startingBudget?.totalMsat === CONFIGURED_BUDGET_SATS * 1_000 &&
      race.startingBudget?.usedMsat === 0 &&
      race.startingBudget?.spendableMsat === CONFIGURED_BUDGET_SATS * 1_000 &&
      race.startingBudget?.spendableSats === CONFIGURED_BUDGET_SATS &&
      race.startingBudget?.renewal === "never",
    "starting_budget_not_verified",
  );
  addMissing(missing, normalizedTimestamp(race.barrierReleasedAt) !== null, "barrier_timestamp_missing");
  addMissing(
    missing,
    typeof race.dispatchDeltaMs === "number" &&
      Number.isFinite(race.dispatchDeltaMs) &&
      race.dispatchDeltaMs >= 0,
    "dispatch_delta_missing",
  );
  addMissing(missing, bob.phase === "final", "bob_final_evidence_missing");

  const attempts = REQUEST_IDS.map((id) => exactlyOneById(attemptRecords, id));
  addMissing(
    missing,
    attemptRecords.length === REQUEST_IDS.length && attempts.every(Boolean),
    "two_unique_attempts_missing",
  );

  const hashes = attempts.map((attempt) => safePaymentHash(attempt?.paymentHash));
  addMissing(
    missing,
    hashes.every(Boolean) && new Set(hashes).size === REQUEST_IDS.length,
    "payment_hashes_missing_or_ambiguous",
  );

  for (let index = 0; index < REQUEST_IDS.length; index += 1) {
    const id = REQUEST_IDS[index];
    const attempt = attempts[index];
    addMissing(missing, normalizedTimestamp(attempt?.dispatchedAt) !== null, `dispatch_${id.toLowerCase()}_timestamp_missing`);
    addMissing(missing, attempt?.result === "success" || attempt?.result === "error", `nwc_${id.toLowerCase()}_result_missing`);
  }

  const budgetAfter = normalizedBudgetAfter(race.budgetAfter);
  addMissing(missing, budgetAfter.isComplete, "post_race_budget_missing_or_inconsistent");

  const bobById = REQUEST_IDS.map((id) => exactlyOneById(bobRecords, id));
  addMissing(
    missing,
    bobRecords.length === REQUEST_IDS.length && bobById.every(Boolean),
    "two_unique_bob_lookups_missing",
  );

  const expectedInvoices = REQUEST_IDS.map((id, index) => ({
    id,
    paymentHash: hashes[index] ?? "",
    amountSat: REQUESTED_AMOUNT_SATS,
  }));
  const bobLookups = bobById.filter(Boolean).map((outcome) => ({
    paymentHash: safePaymentHash(outcome.paymentHash) ?? "",
    settled: outcome.reconciled === true ? outcome.settled : undefined,
    state: SAFE_STATES.has(outcome.state) ? outcome.state : "UNRECONCILED",
    amountPaidSat: nonnegativeInteger(outcome.amountPaidSat),
    settleDateUnix: nonnegativeInteger(outcome.settleDateUnix),
  }));

  // Re-run the existing Phase 5 ground-truth reconciler; do not trust a
  // classification copied from either input artifact.
  const reconciliation = reconcileTwoInvoices({
    expectedInvoices,
    bobLookups,
    startingSpendableBudgetSats: CONFIGURED_BUDGET_SATS,
  });
  addMissing(
    missing,
    reconciliation.outcomes.length === REQUEST_IDS.length &&
      reconciliation.outcomes.every((outcome) => outcome.reconciled),
    "bob_settlement_reconciliation_incomplete",
  );

  const missingEvidence = [...missing].sort();
  const classification =
    missingEvidence.length === 0 ? reconciliation.classification : "INCONCLUSIVE";
  const settledPrincipal = reconciliation.totalSettledPrincipalSats;
  const invariantHolds =
    typeof settledPrincipal === "number" && Number.isFinite(settledPrincipal)
      ? settledPrincipal <= CONFIGURED_BUDGET_SATS
      : null;

  const reportAttempts = REQUEST_IDS.map((id, index) => {
    const attempt = attempts[index];
    const bobOutcome = reconciliation.outcomes.find((outcome) => outcome.id === id);
    const nwcStatus =
      attempt?.result === "success" || attempt?.result === "error" ? attempt.result : "unknown";
    const fee = nonnegativeInteger(attempt?.feesPaidMsat);
    return {
      id,
      paymentHash: hashes[index],
      requestedAmountSats: REQUESTED_AMOUNT_SATS,
      dispatchedAt: normalizedTimestamp(attempt?.dispatchedAt),
      nwcResult: {
        status: nwcStatus,
        errorCode: nwcStatus === "error" ? safeErrorCode(attempt?.errorCode) : null,
      },
      reportedFeesMsat: fee,
      bobSettlement: {
        reconciled: bobOutcome?.reconciled === true,
        state: bobOutcome?.reconciled === true ? bobOutcome.state : "UNRECONCILED",
        settled: bobOutcome?.reconciled === true ? bobOutcome.settled : null,
        amountPaidSat: bobOutcome?.reconciled === true ? bobOutcome.amountPaidSat : null,
        settledAt: bobOutcome?.reconciled === true ? bobOutcome.settledAt : null,
      },
    };
  });

  return {
    reportVersion: REPORT_VERSION,
    generatedAt: generatedTimestamp,
    network: "regtest",
    walletUnderTest: "Alby Hub / NWC",
    configuredBudgetSats: CONFIGURED_BUDGET_SATS,
    renewal: "never",
    requestCount: REQUEST_IDS.length,
    requestedAmountPerInvoiceSats: REQUESTED_AMOUNT_SATS,
    barrierReleasedAt: normalizedTimestamp(race.barrierReleasedAt),
    dispatchDeltaMs:
      typeof race.dispatchDeltaMs === "number" &&
      Number.isFinite(race.dispatchDeltaMs) &&
      race.dispatchDeltaMs >= 0
        ? race.dispatchDeltaMs
        : null,
    attempts: reportAttempts,
    independentlySettledPrincipalSats: settledPrincipal,
    postRaceRemainingBudgetSats: budgetAfter.remainingSats,
    invariant: {
      expression: "totalSettledPrincipalSats <= configuredBudgetSats",
      configuredBudgetSats: CONFIGURED_BUDGET_SATS,
      totalSettledPrincipalSats: settledPrincipal,
      holds: invariantHolds,
    },
    finalClassification: classification,
    evidenceCompleteness: {
      complete: missingEvidence.length === 0,
      missing: missingEvidence,
    },
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label}_input_missing_or_invalid`);
  }
}

function runCli() {
  const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
  const { values } = parseArgs({
    options: {
      race: { type: "string", default: `${privateDirectory}/phase45-race-results.json` },
      bob: { type: "string", default: `${privateDirectory}/bob-final-evidence.json` },
      out: { type: "string", default: "reports/phase6-evidence.json" },
      "generated-at": { type: "string" },
    },
    allowPositionals: false,
  });
  const report = buildEvidenceReport({
    raceEvidence: readJson(values.race, "race_evidence"),
    bobEvidence: readJson(values.bob, "bob_evidence"),
    generatedAt: values["generated-at"],
  });
  const outputPath = resolve(values.out);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  process.stdout.write(
    `${JSON.stringify({
      reportWritten: true,
      reportVersion: report.reportVersion,
      finalClassification: report.finalClassification,
      evidenceComplete: report.evidenceCompleteness.complete,
      output: outputPath,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli();
}
