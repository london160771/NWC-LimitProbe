import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { evaluateRunEvidence, safeErrorCode } from "./phase45-core.mjs";

const REPORT_VERSION = "2.0.0";
const REQUEST_IDS = ["A", "B"];
const SAFE_STATES = new Set(["SETTLED", "OPEN", "ACCEPTED", "PENDING", "CANCELED", "EXPIRED", "NOT_FOUND"]);
const SAFE_STAGES = new Set([
  "prepared",
  "barrier_armed_payment_may_have_been_dispatched",
  "both_client_calls_started",
  "dispatch_complete",
  "nwc_lookup_complete",
  "race_complete",
  "final_nwc_lookup_complete",
  "post_dispatch_failure",
]);
const HASH_RE = /^[0-9a-f]{64}$/i;

function integer(value, { allowNegative = false } = {}) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && (allowNegative || value >= 0) ? value : null;
  }
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && (allowNegative || number >= 0) ? number : null;
}

function timestamp(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function hash(value) {
  return typeof value === "string" && HASH_RE.test(value) ? value.toLowerCase() : null;
}

function state(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase();
  return SAFE_STATES.has(normalized) ? normalized : null;
}

function attemptById(attempts, id) {
  const matches = Array.isArray(attempts) ? attempts.filter((item) => item?.id === id) : [];
  return matches.length === 1 ? matches[0] : null;
}

function observedReportTime(race, bob) {
  const values = [
    race?.runStartedAt,
    race?.startingBudget?.capturedAt,
    race?.requestsPreparedAt,
    race?.barrierReleasedAt,
    ...(Array.isArray(race?.attempts) ? race.attempts.flatMap((item) => [item?.dispatchedAt, item?.responseAt]) : []),
    ...(Array.isArray(race?.nwcLookups) ? race.nwcLookups.map((item) => item?.observedAt) : []),
    ...(Array.isArray(bob?.observations) ? bob.observations.map((item) => item?.observedAt) : []),
  ].map(timestamp).filter(Boolean).sort();
  return values.at(-1) ?? null;
}

function projectNwcLookup(item) {
  return {
    runId: typeof item?.runId === "string" && /^[A-Za-z0-9-]{1,80}$/.test(item.runId) ? item.runId : null,
    id: REQUEST_IDS.includes(item?.id) ? item.id : null,
    requestedHash: hash(item?.requestedHash),
    returnedHash: hash(item?.returnedHash),
    expectedAmountSat: integer(item?.expectedAmountSat),
    state: state(item?.lookupState),
    amountMsat: integer(item?.amountMsat),
    feesPaidMsat: integer(item?.feesPaidMsat),
    settledAt: timestamp(item?.settledAt),
    observedAt: timestamp(item?.observedAt),
    errorCode: item?.errorCode == null ? null : safeErrorCode(item.errorCode),
  };
}

function projectReceiverObservation(item) {
  return {
    runId: typeof item?.runId === "string" && /^[A-Za-z0-9-]{1,80}$/.test(item.runId) ? item.runId : null,
    id: REQUEST_IDS.includes(item?.id) ? item.id : null,
    requestedHash: hash(item?.requestedHash),
    returnedHash: hash(item?.returnedHash),
    expectedAmountSat: integer(item?.expectedAmountSat),
    state: state(item?.state),
    settled: typeof item?.settled === "boolean" ? item.settled : null,
    amountPaidSat: integer(item?.amountPaidSat),
    settleDateUnix: integer(item?.settleDateUnix),
    settledAt: timestamp(item?.settledAt),
    observedAt: timestamp(item?.observedAt),
    errorCode: item?.errorCode == null ? null : safeErrorCode(item.errorCode),
  };
}

function projectAttempt(item, id) {
  const result = item?.result === "success" || item?.result === "error" ? item.result : "unknown";
  return {
    id,
    runId: typeof item?.runId === "string" && /^[A-Za-z0-9-]{1,80}$/.test(item.runId) ? item.runId : null,
    paymentHash: hash(item?.requestedHash),
    requestedAmountSats: integer(item?.expectedAmountSat),
    barrierReleasedAt: timestamp(item?.barrierReleasedAt),
    dispatchedAt: timestamp(item?.dispatchedAt),
    dispatchMonotonicMs: typeof item?.dispatchMonotonicMs === "number" && Number.isFinite(item.dispatchMonotonicMs) ? item.dispatchMonotonicMs : null,
    responseAt: timestamp(item?.responseAt),
    responseMonotonicMs: typeof item?.responseMonotonicMs === "number" && Number.isFinite(item.responseMonotonicMs) ? item.responseMonotonicMs : null,
    nwcResult: {
      status: result,
      errorCode: result === "error" ? safeErrorCode(item?.errorCode) : null,
    },
    reportedFeesMsat: integer(item?.feesPaidMsat),
  };
}

/** Build a deterministic, redacted report from one run's captured race and reconciliation evidence. */
export function buildEvidenceReport({ raceEvidence, bobEvidence, generatedAt } = {}) {
  const race = raceEvidence && typeof raceEvidence === "object" && !Array.isArray(raceEvidence) ? raceEvidence : {};
  const bob = bobEvidence && typeof bobEvidence === "object" && !Array.isArray(bobEvidence) ? bobEvidence : {};
  const evaluated = evaluateRunEvidence({ raceEvidence: race, bobEvidence: bob });
  const generatedTimestamp = timestamp(generatedAt) ?? observedReportTime(race, bob);
  const attemptInputs = REQUEST_IDS.map((id) => attemptById(race.attempts, id));
  const attempts = attemptInputs.map((item, index) => projectAttempt(item, REQUEST_IDS[index]));
  const initial = Array.isArray(race.initialBobObservations)
    ? race.initialBobObservations.map(projectReceiverObservation).sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))
    : [];
  const receiverObservations = Array.isArray(bob.observations)
    ? bob.observations.map(projectReceiverObservation).sort((a, b) => (a.observedAt ?? "").localeCompare(b.observedAt ?? "") || (a.id ?? "").localeCompare(b.id ?? ""))
    : [];
  const nwcLookups = Array.isArray(race.nwcLookups)
    ? race.nwcLookups.map(projectNwcLookup).sort((a, b) => (a.observedAt ?? "").localeCompare(b.observedAt ?? "") || (a.id ?? "").localeCompare(b.id ?? ""))
    : [];
  const outcomes = evaluated.receiverOutcomes.map((outcome) => ({
    id: outcome.id,
    runId: outcome.runId,
    paymentHash: outcome.paymentHash,
    expectedAmountSats: outcome.expectedAmountSat,
    reconciled: outcome.reconciled,
    terminal: outcome.terminal,
    state: outcome.state,
    settled: outcome.settled,
    amountPaidSats: outcome.amountPaidSat,
    settledAt: outcome.settledAt,
    latestObservedAt: timestamp(outcome.latestObservedAt),
    observationCount: outcome.observationCount,
    reasonCodes: outcome.reasonCodes,
  }));
  const supplementary = evaluated.reasonCodes.filter((reason) => reason.startsWith("post_race_"));
  const verdictReasons = evaluated.reasonCodes.filter((reason) => !reason.startsWith("post_race_"));
  const starting = race.startingBudget ?? {};

  return {
    reportVersion: REPORT_VERSION,
    generatedAt: generatedTimestamp,
    runId: typeof race.runId === "string" && /^[A-Za-z0-9-]{1,80}$/.test(race.runId) ? race.runId : null,
    network: "regtest",
    walletUnderTest: "Alby Hub / NWC",
    runState: {
      stage: SAFE_STAGES.has(race.stage) ? race.stage : "unknown",
      paymentMayHaveBeenDispatched: race.paymentMayHaveBeenDispatched === true,
      failureCode: race.failureCode == null ? null : safeErrorCode(race.failureCode),
    },
    configuredBudgetSats: 1_000,
    renewal: "never",
    requestCount: 2,
    requestedAmountPerInvoiceSats: 700,
    startingBudget: {
      capturedAt: timestamp(starting.capturedAt),
      totalBudgetMsat: integer(starting.totalBudgetMsat),
      usedBudgetMsat: integer(starting.usedBudgetMsat),
      spendableBudgetMsat: evaluated.startingBudgetVerified ? evaluated.startingSpendableBudgetMsat : null,
      spendableBudgetSats: evaluated.startingBudgetVerified && evaluated.startingSpendableBudgetMsat !== null
        ? evaluated.startingSpendableBudgetMsat / 1_000
        : null,
      verified: evaluated.startingBudgetVerified,
      renewalPeriod: typeof starting.renewalPeriod === "string" ? starting.renewalPeriod : null,
    },
    requestsPreparedAt: timestamp(race.requestsPreparedAt),
    barrierReleasedAt: timestamp(race.barrierReleasedAt),
    barrierReleaseMonotonicMs: typeof race.barrierReleaseMonotonicMs === "number" && Number.isFinite(race.barrierReleaseMonotonicMs)
      ? race.barrierReleaseMonotonicMs
      : null,
    dispatchTimingBoundary: race.dispatchTimingBoundary === "nwc_client_call_start" ? "NWC client call-start" : null,
    dispatchDeltaMs: typeof race.dispatchDeltaMs === "number" && Number.isFinite(race.dispatchDeltaMs) ? race.dispatchDeltaMs : null,
    reconciliation: {
      deadline: timestamp(race.reconciliationDeadline),
      windowMs: integer(race.reconciliationWindowMs),
      pollIntervalMs: integer(race.reconciliationPollIntervalMs),
      bobObservationCount: receiverObservations.length,
      initialBobObservations: initial,
      bobObservations: receiverObservations,
      nwcLookups,
      invoices: outcomes,
    },
    attempts,
    independentlySettledPrincipalSats: evaluated.totalSettledPrincipalSats,
    postRaceBudget: {
      available: evaluated.postBudget.present,
      valid: evaluated.postBudget.valid,
      totalBudgetMsat: evaluated.postBudget.totalBudgetMsat,
      usedBudgetMsat: evaluated.postBudget.usedBudgetMsat,
      remainingBudgetMsat: evaluated.postBudget.remainingBudgetMsat,
      renewalPeriod: evaluated.postBudget.renewalPeriod,
      issues: evaluated.postBudget.issues,
    },
    invariant: {
      expression: "totalSettledPrincipalSats * 1000 <= startingSpendableBudgetMsat",
      startingSpendableBudgetMsat: evaluated.startingSpendableBudgetMsat,
      independentlySettledPrincipalSats: evaluated.totalSettledPrincipalSats,
      holds: evaluated.invariantHolds,
    },
    finalClassification: evaluated.classification,
    evidenceCompleteness: {
      complete: evaluated.classification !== "INCONCLUSIVE",
      missingOrInvalid: verdictReasons,
      supplementaryIssues: supplementary,
    },
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
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
    raceEvidence: readJson(values.race),
    bobEvidence: readJson(values.bob),
    generatedAt: values["generated-at"],
  });
  const outputPath = resolve(values.out);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  process.stdout.write(`${JSON.stringify({
    reportWritten: true,
    reportVersion: report.reportVersion,
    finalClassification: report.finalClassification,
    evidenceComplete: report.evidenceCompleteness.complete,
    output: outputPath,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCli();
