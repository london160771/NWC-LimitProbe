import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { evaluateRunEvidence, safeErrorCode } from "./phase45-core.mjs";

const REPORT_VERSION = "2.2.0";
const REQUEST_IDS = ["A", "B"];
const SAFE_STATES = new Set(["SETTLED", "OPEN", "ACCEPTED", "PENDING", "CANCELED", "EXPIRED", "FAILED"]);
const SAFE_STAGES = new Set([
  "prepared",
  "barrier_armed_payment_may_have_been_dispatched",
  "both_client_calls_started",
  "dispatch_complete",
  "nwc_lookup_complete",
  "race_complete",
  "final_nwc_lookup_complete",
  "final_nwc_lookup_and_budget_complete",
  "post_dispatch_failure",
]);
const HASH_RE = /^[0-9a-f]{64}$/i;
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RENEWAL_PERIODS = new Set(["never", "hourly", "daily", "weekly", "monthly", "yearly"]);
const COLLECTION_STATUSES = new Set(["completed_deadline", "completed_terminal", "interrupted", "collector_error", "query_timeout"]);
const SAFE_REPORT_INPUT_DIAGNOSTICS = new Set(["race_results_candidate_invalid", "race_progress_candidate_invalid"]);
const SAFE_CAPTURE_ISSUES = new Set([
  "budget_missing_or_invalid", "budget_unit_unspecified", "budget_unit_invalid", "budget_unit_invalid_or_conflicting",
  "budget_currency_unsupported", "invalid_budget_number", "conflicting_budget_aliases", "budget_arithmetic_overflow",
  "budget_arithmetic_inconsistent", "budget_remaining_exceeds_total", "budget_renewal_invalid_or_conflicting",
  "budget_total_missing", "budget_used_missing", "budget_remaining_missing", "budget_snapshot_kind_invalid",
  "budget_snapshot_run_id_invalid", "budget_snapshot_timestamp_invalid", "budget_snapshot_timestamp_missing",
  "budget_snapshot_timestamp_conflict", "budget_snapshot_persisted_status_invalid",
  "budget_persisted_issue_metadata_conflict", "budget_persisted_validation_flags_conflict",
  "budget_persisted_issue_metadata_invalid",
]);
const SAFE_COLLECTION_ISSUES = new Set([
  "collector_start_missing_or_invalid", "collector_completion_missing", "collector_completion_binding_mismatch",
  "collector_completion_status_invalid", "collector_terminal_condition_unproven", "collector_deadline_condition_unproven",
  "collector_terminal_queries_incomplete", "collector_prior_interruption_prevents_bounded_claim",
  "collector_deadline_completion_early", "collector_expected_invoice_binding_invalid",
  "collector_completion_timestamp_invalid", "collector_terminal_completion_early",
  "collector_session_binding_invalid", "collector_session_duplicate_start", "collector_session_duplicate_completion",
  "collector_session_history_missing", "collector_session_chronology_invalid", "collector_query_chronology_or_binding_invalid",
  "collector_observation_chronology_or_binding_invalid", "collector_top_level_session_mismatch", "collector_top_level_completion_mismatch",
  "collector_successful_completion_missing", "collector_deadline_evidence_missing", "collector_terminal_completion_unproven",
  "collector_deadline_completion_early",
  "collector_completion_without_start", "collector_query_after_session_completion", "collector_observation_after_session_completion",
  "collector_trailing_record_incomplete", "collector_journal_invalid",
  "collector_deadline_mismatch", "collector_observation_malformed_entry", "collector_observation_container_invalid", "bob_observation_container_invalid",
  "bob_observation_malformed_entry", "bob_completion_timestamp_missing_or_before_observation",
  "nwc_settlement_timestamp_missing", "nwc_terminal_unpaid_settlement_timestamp_unexpected", "nwc_settlement_predates_dispatch",
  "nwc_settlement_timestamp_invalid", "nwc_settlement_after_observation", "nwc_settlement_after_completion", "invoice_required_grace_mismatch",
]);

function integer(value, { allowNegative = false } = {}) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && (allowNegative || value >= 0) ? value : null;
  }
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && (allowNegative || number >= 0) ? number : null;
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : null;
}

function hash(value) {
  return typeof value === "string" && HASH_RE.test(value) ? value.toLowerCase() : null;
}

function runId(value) {
  return typeof value === "string" && RUN_ID_RE.test(value) ? value.toLowerCase() : null;
}

function renewal(value) {
  return typeof value === "string" && RENEWAL_PERIODS.has(value) ? value : null;
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
    race?.startingBudget?.observedAt,
    race?.startingBudget?.capturedAt,
    race?.budgetAfter?.observedAt,
    race?.finalNwcLookupCompletedAt,
    race?.finalBudgetCapturedAt,
    race?.finalBobEvidenceCompletedAt,
    race?.requestsPreparedAt,
    race?.barrierReleasedAt,
    ...(Array.isArray(race?.attempts) ? race.attempts.flatMap((item) => [item?.dispatchedAt, item?.responseAt]) : []),
    ...(Array.isArray(race?.nwcLookups) ? race.nwcLookups.map((item) => item?.observedAt) : []),
    ...(Array.isArray(bob?.observations) ? bob.observations.map((item) => item?.observedAt) : []),
    bob?.completedAt,
    ...(Array.isArray(bob?.queryAttempts) ? bob.queryAttempts.flatMap((item) => [item?.attemptedAt, item?.completedAt]) : []),
  ].map(timestamp).filter(Boolean).sort();
  return values.at(-1) ?? null;
}

function projectNwcLookup(item) {
  const evidenceType = item?.evidenceType === "not_found" ? "not_found" : item?.evidenceType === "returned_record" || item?.evidenceType == null ? "returned_record" : null;
  return {
    evidenceType,
    runId: runId(item?.runId),
    id: REQUEST_IDS.includes(item?.id) ? item.id : null,
    requestedHash: hash(item?.requestedHash),
    returnedHash: evidenceType === "not_found" ? null : hash(item?.returnedHash),
    expectedAmountSat: integer(item?.expectedAmountSat),
    state: evidenceType === "not_found" ? null : state(item?.lookupState),
    amountMsat: evidenceType === "not_found" ? null : integer(item?.amountMsat),
    feesPaidMsat: evidenceType === "not_found" ? null : integer(item?.feesPaidMsat),
    settledAt: evidenceType === "not_found" ? null : timestamp(item?.settledAt),
    observedAt: timestamp(item?.observedAt),
    errorCode: item?.errorCode == null ? null : safeErrorCode(item.errorCode),
    validationIssues: Array.isArray(item?.validationIssues) ? item.validationIssues.filter((code) => [
      "nwc_lookup_numeric_alias_conflict", "nwc_fee_invalid", "nwc_lookup_amount_invalid", "nwc_not_found_shape_invalid", "nwc_settlement_timestamp_invalid",
    ].includes(code)).sort() : [],
  };
}

function projectReceiverObservation(item) {
  return {
    sessionId: typeof item?.sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.sessionId) ? item.sessionId.toLowerCase() : null,
    runId: runId(item?.runId),
    id: REQUEST_IDS.includes(item?.id) ? item.id : null,
    requestedHash: hash(item?.requestedHash),
    returnedHash: hash(item?.returnedHash),
    expectedAmountSat: integer(item?.expectedAmountSat),
    state: state(item?.state),
    settled: typeof item?.settled === "boolean" ? item.settled : null,
    amountPaidSat: integer(item?.amountPaidSat),
    amountPaidMsat: integer(item?.amountPaidMsat),
    settleDateUnix: integer(item?.settleDateUnix),
    settledAt: timestamp(item?.settledAt),
    observedAt: timestamp(item?.observedAt),
    acquiredAt: timestamp(item?.acquiredAt),
    errorCode: item?.errorCode == null ? null : safeErrorCode(item.errorCode),
  };
}

function projectAttempt(item, id) {
  const result = item?.result === "success" || item?.result === "error" ? item.result : "unknown";
  return {
    id,
    runId: runId(item?.runId),
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
export function buildEvidenceReport({ raceEvidence, bobEvidence, generatedAt, inputDiagnostics = [] } = {}) {
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
    runId: runId(outcome.runId),
    paymentHash: outcome.paymentHash,
    expectedAmountSats: outcome.expectedAmountSat,
    reconciled: outcome.reconciled,
    terminal: outcome.terminal,
    state: outcome.state,
    settled: outcome.settled,
    amountPaidSats: outcome.amountPaidSat,
    amountPaidMsat: outcome.amountPaidMsat,
    settledAt: outcome.settledAt,
    latestObservedAt: timestamp(outcome.latestObservedAt),
    observationCount: outcome.observationCount,
    reasonCodes: outcome.reasonCodes,
  }));
  const inputIssueCodes = Array.isArray(inputDiagnostics)
    ? [...new Set(inputDiagnostics.filter((issue) => typeof issue === "string" && SAFE_REPORT_INPUT_DIAGNOSTICS.has(issue)))].sort()
    : [];
  const supplementary = [...(evaluated.supplementaryReasonCodes ?? evaluated.reasonCodes.filter((reason) => reason.startsWith("post_race_"))), ...inputIssueCodes];
  const verdictReasons = evaluated.proofReasonCodes ?? evaluated.reasonCodes.filter((reason) => !reason.startsWith("post_race_"));
  const finalClassification = evaluated.classification === "FAIL" ? "FAIL"
    : evaluated.classification === "PASS" && inputIssueCodes.length > 0 ? "INCONCLUSIVE"
      : evaluated.classification;
  const starting = race.startingBudget ?? {};

  return {
    reportVersion: REPORT_VERSION,
    generatedAt: generatedTimestamp,
    runId: runId(race.runId),
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
      renewalPeriod: renewal(starting.renewalPeriod),
      captureValidationStatus: starting.capturedValidationStatus === "valid" || starting.capturedValidationStatus === "invalid" ? starting.capturedValidationStatus : "missing",
      captureIssueCodes: Array.isArray(starting.capturedValidationIssues) ? starting.capturedValidationIssues.filter((issue) => SAFE_CAPTURE_ISSUES.has(issue)).sort() : [],
    },
    requestsPreparedAt: timestamp(race.requestsPreparedAt),
    requiredGraceSeconds: integer(race.requiredGraceSeconds),
    invoiceLifecycle: Array.isArray(race.invoiceLifecycle) ? race.invoiceLifecycle.map((item) => ({
      id: REQUEST_IDS.includes(item?.id) ? item.id : null,
      paymentHash: hash(item?.paymentHash),
      createdAt: timestamp(item?.createdAt),
      invoiceTimestampUnix: integer(item?.invoiceTimestampUnix),
      expirySeconds: integer(item?.expirySeconds),
      expiresAtUnix: integer(item?.expiresAtUnix),
      dispatchAt: timestamp(item?.dispatchAt),
      reconciliationDeadline: timestamp(item?.reconciliationDeadline),
      requiredGraceSeconds: integer(item?.requiredGraceSeconds),
    })).sort((a, b) => (a.id ?? "").localeCompare(b.id ?? "")) : [],
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
      collection: {
        startedAt: timestamp(bob.startedAt),
        deadline: timestamp(bob.deadline),
        completedAt: timestamp(bob.completedAt),
        completionStatus: COLLECTION_STATUSES.has(bob.completionStatus) ? bob.completionStatus : "collector_error",
        queryAttempts: Array.isArray(bob.queryAttempts) ? bob.queryAttempts.map((item) => ({
          id: REQUEST_IDS.includes(item?.id) ? item.id : null,
          attemptedAt: timestamp(item?.attemptedAt),
          completedAt: timestamp(item?.completedAt),
          status: ["success", "query_timeout", "collector_error"].includes(item?.status) ? item.status : "collector_error",
    errorCode: item?.errorCode == null ? null : safeErrorCode(item.errorCode),
        })).sort((a, b) => (a.attemptedAt ?? "").localeCompare(b.attemptedAt ?? "") || (a.id ?? "").localeCompare(b.id ?? "")) : [],
        issues: Array.isArray(bob.collectionIssues) ? bob.collectionIssues.filter((item) => SAFE_COLLECTION_ISSUES.has(item)).sort() : [],
        sessions: Array.isArray(bob.collectionSessions) ? bob.collectionSessions.map((session) => ({
          sessionId: typeof session?.sessionId === "string" && /^[0-9a-f-]{36}$/i.test(session.sessionId) ? session.sessionId.toLowerCase() : null,
          runId: runId(session?.runId),
          recordType: session?.recordType === "collector_started" || session?.recordType === "collector_completed" ? session.recordType : null,
          startedAt: timestamp(session?.startedAt),
          completedAt: timestamp(session?.completedAt),
          deadline: timestamp(session?.deadline),
          completionStatus: COLLECTION_STATUSES.has(session?.completionStatus) ? session.completionStatus : null,
        })).sort((a, b) => (a.startedAt ?? a.completedAt ?? "").localeCompare(b.startedAt ?? b.completedAt ?? "")) : [],
      },
    },
    attempts,
    confirmedSettledPrincipalMsat: evaluated.confirmedSettledPrincipalMsat,
    independentlySettledPrincipalSats: evaluated.totalSettledPrincipalSats,
    independentlySettledPrincipalMsat: evaluated.totalSettledPrincipalMsat,
    postRaceBudget: {
      available: evaluated.postBudget.present,
      valid: evaluated.postBudget.valid,
      accountingConsistent: evaluated.postBudget.accountingConsistent,
      totalBudgetMsat: evaluated.postBudget.totalBudgetMsat,
      usedBudgetMsat: evaluated.postBudget.usedBudgetMsat,
      remainingBudgetMsat: evaluated.postBudget.remainingBudgetMsat,
      renewalPeriod: renewal(evaluated.postBudget.renewalPeriod),
      observedAt: timestamp(race.budgetAfter?.observedAt),
      captureValidationStatus: race.budgetAfter?.capturedValidationStatus === "valid" || race.budgetAfter?.capturedValidationStatus === "invalid" ? race.budgetAfter.capturedValidationStatus : "missing",
      issues: evaluated.postBudget.issues,
    },
    invariant: {
      expression: "totalSettledPrincipalSats * 1000 <= startingSpendableBudgetMsat",
      startingSpendableBudgetMsat: evaluated.startingSpendableBudgetMsat,
      independentlySettledPrincipalSats: evaluated.totalSettledPrincipalSats,
      holds: evaluated.invariantHolds,
    },
    finalClassification,
    evidenceCompleteness: {
      complete: finalClassification !== "INCONCLUSIVE",
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

/** Prefer completed results, falling back only to durable progress bound to this exact run. */
export function selectBoundRaceEvidence({ raceResults, raceProgress, expectedRunId, raceResultsPresent = raceResults != null } = {}) {
  const diagnostics = [];
  if (typeof expectedRunId !== "string" || !RUN_ID_RE.test(expectedRunId)) return { raceEvidence: null, diagnostics };
  for (const [index, candidate] of [raceResults, raceProgress].entries()) {
    const attempts = Array.isArray(candidate?.attempts) ? candidate.attempts : [];
    const idsValid = attempts.length === 2 && attempts.every((item) => item && typeof item === "object" &&
      !Array.isArray(item) && (item.id === "A" || item.id === "B")) &&
      attempts.filter((item) => item.id === "A").length === 1 && attempts.filter((item) => item.id === "B").length === 1;
    const paymentHashes = attempts.map((item) => hash(item?.requestedHash));
    const candidateIsBound = candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
      candidate.runId === expectedRunId && candidate.schemaVersion === 2 &&
      candidate.test === "phase4-two-payment-budget-race" && candidate.network === "regtest" &&
      candidate.wallet === "Alby Hub / Alice" && candidate.encryption === "nip44" && candidate.encryptionVerified === true &&
      idsValid &&
      paymentHashes.every(Boolean) && new Set(paymentHashes).size === 2 && timestamp(candidate.barrierReleasedAt) !== null &&
      attempts.every((item) => item?.runId === expectedRunId && hash(item?.requestedHash) !== null &&
        item?.expectedAmountSat === 700 && timestamp(item?.dispatchedAt) !== null &&
        item?.barrierReleasedAt === candidate.barrierReleasedAt &&
        (item?.paymentHash === undefined || item.paymentHash === item.requestedHash));
    if (candidateIsBound) {
      return { raceEvidence: candidate, diagnostics };
    }
    if (candidate != null || (index === 0 && raceResultsPresent)) {
      diagnostics.push(index === 0 ? "race_results_candidate_invalid" : "race_progress_candidate_invalid");
    }
  }
  return { raceEvidence: null, diagnostics: [...new Set(diagnostics)].sort() };
}

function runCli() {
  const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
  const { values } = parseArgs({
    options: {
      race: { type: "string", default: `${privateDirectory}/phase45-race-results.json` },
      "race-progress": { type: "string", default: `${privateDirectory}/phase45-race-progress.json` },
      "run-config": { type: "string", default: `${privateDirectory}/phase6-run-config.json` },
      bob: { type: "string", default: `${privateDirectory}/bob-final-evidence.json` },
      out: { type: "string", default: "reports/phase6-evidence.json" },
      "generated-at": { type: "string" },
    },
    allowPositionals: false,
  });
  const bobEvidence = readJson(values.bob);
  const runConfig = readJson(values["run-config"]);
  const expectedRunId = typeof runConfig?.runId === "string" && RUN_ID_RE.test(runConfig.runId)
    ? runConfig.runId
    : bobEvidence?.runId;
  const selection = selectBoundRaceEvidence({
    raceResults: readJson(values.race),
    raceProgress: readJson(values["race-progress"]),
    expectedRunId,
    raceResultsPresent: existsSync(values.race),
  });
  const report = buildEvidenceReport({
    raceEvidence: selection.raceEvidence,
    bobEvidence,
    generatedAt: values["generated-at"],
    inputDiagnostics: selection.diagnostics,
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
