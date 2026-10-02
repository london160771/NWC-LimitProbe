import { performance } from "node:perf_hooks";
import { validatePersistedCollectorEvidence } from "./phase45-collector-core.mjs";

const SAFE_ERROR_CODES = new Set([
  "BAD_REQUEST",
  "CONNECTION_FAILED",
  "INSUFFICIENT_BALANCE",
  "INTERNAL",
  "NOT_FOUND",
  "OTHER",
  "PAYMENT_FAILED",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "RESTRICTED",
  "TIMEOUT",
  "UNAUTHORIZED",
]);
const RECEIVER_STATES = new Set(["SETTLED", "OPEN", "ACCEPTED", "PENDING", "CANCELED", "EXPIRED"]);
const NWC_STATES = new Set([...RECEIVER_STATES, "FAILED"]);
const HASH_RE = /^[0-9a-f]{64}$/i;
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RENEWAL_PERIODS = new Set(["never", "hourly", "daily", "weekly", "monthly", "yearly"]);
const RECEIVER_VALIDATION_ISSUES = new Set(["receiver_amount_alias_conflict", "receiver_settlement_timestamp_conflict", "receiver_session_id_invalid"]);
const INITIAL_OBSERVATION_MAX_AGE_MS = 30_000;

export const RECONCILIATION_WINDOW_MS = 150_000;
export const RECONCILIATION_POLL_INTERVAL_MS = 2_000;
export const REQUIRED_GRACE_SECONDS = 30;
export const EXPECTED_INVOICE_EXPIRY_SECONDS = 120;
export const MAX_INVOICE_CLOCK_SKEW_SECONDS = 5;
const FINAL_NWC_LOOKUP_GRACE_MS = 30_000;
const BUDGET_CAPTURE_ISSUE_CODES = new Set([
  "budget_missing_or_invalid", "budget_unit_unspecified", "budget_unit_invalid", "budget_unit_invalid_or_conflicting",
  "budget_currency_unsupported", "invalid_budget_number", "conflicting_budget_aliases", "budget_arithmetic_overflow",
  "budget_arithmetic_inconsistent", "budget_remaining_exceeds_total", "budget_renewal_invalid_or_conflicting",
  "budget_total_missing", "budget_used_missing", "budget_remaining_missing", "budget_snapshot_kind_invalid",
  "budget_snapshot_run_id_invalid", "budget_snapshot_timestamp_invalid",
]);

function strictInteger(value, { allowNegative = false } = {}) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    if (!allowNegative && value < 0) return null;
    return value;
  }
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  if (!allowNegative && value.startsWith("-")) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowNegative && parsed < 0)) return null;
  return parsed;
}

function safeTimestamp(value) {
  const match = typeof value === "string"
    ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3,9})Z$/.exec(value)
    : null;
  if (!match) return null;
  // Runtime timestamps may carry nanoseconds. The evaluator compares wall-clock
  // observations at millisecond precision, so validate the source and project
  // it to a canonical millisecond timestamp instead of rejecting it.
  const canonical = `${match[1]}.${match[2].slice(0, 3)}Z`;
  const date = new Date(canonical);
  return Number.isFinite(date.getTime()) && date.toISOString() === canonical ? canonical : null;
}

function safeHash(value) {
  return typeof value === "string" && HASH_RE.test(value) ? value.toLowerCase() : null;
}

function normalizeHashAliases(source, keys) {
  const present = keys.filter((key) => Object.hasOwn(source ?? {}, key) && source[key] !== undefined);
  if (present.length === 0) return null;
  const values = present.map((key) => safeHash(source[key]));
  if (values.some((value) => value === null) || new Set(values).size !== 1) return null;
  return values[0];
}

function safeState(value, allowed) {
  if (typeof value !== "string") return null;
  const state = value.toUpperCase();
  return allowed.has(state) ? state : null;
}

function safeEpochSeconds(value) {
  const seconds = strictInteger(value);
  if (seconds === null || seconds === 0) return null;
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > 8.64e15) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function settlementTimestampAliasesConflict(settleDateUnix, settledAt) {
  const hasSeconds = settleDateUnix !== null && settleDateUnix !== undefined && settleDateUnix !== 0;
  const hasIso = settledAt !== null && settledAt !== undefined;
  if (!hasSeconds && !hasIso) return false;
  const fromSeconds = hasSeconds ? safeEpochSeconds(settleDateUnix) : null;
  const fromIso = hasIso ? safeTimestamp(settledAt) : null;
  if ((hasSeconds && fromSeconds === null) || (hasIso && fromIso === null)) return true;
  return hasSeconds && hasIso && fromSeconds !== fromIso;
}

export function safeErrorCode(errorOrCode) {
  const candidate = typeof errorOrCode === "string"
    ? errorOrCode
    : errorOrCode?.code ?? errorOrCode?.error?.code;
  return typeof candidate === "string" && SAFE_ERROR_CODES.has(candidate) ? candidate : "OTHER";
}

export class TwoPartyBarrier {
  #arrivals = 0;
  #releasedAt = null;
  #resolveArmed;
  #resolveRelease;
  #rejectRelease;
  #armed;
  #released;

  constructor() {
    this.#armed = new Promise((resolve) => { this.#resolveArmed = resolve; });
    this.#released = new Promise((resolve, reject) => { this.#resolveRelease = resolve; this.#rejectRelease = reject; });
  }

  arriveAndWait() {
    if (this.#releasedAt !== null) throw new Error("barrier_already_released");
    if (this.#arrivals >= 2) throw new Error("barrier_has_two_participants");
    this.#arrivals += 1;
    if (this.#arrivals === 2) this.#resolveArmed();
    return this.#released;
  }

  waitUntilArmed() { return this.#armed; }

  release(timestamp) {
    if (this.#arrivals !== 2) throw new Error("barrier_not_fully_armed");
    if (this.#releasedAt !== null) throw new Error("barrier_already_released");
    const normalized = safeTimestamp(timestamp);
    if (normalized === null) throw new Error("barrier_release_timestamp_required");
    this.#releasedAt = normalized;
    this.#resolveRelease(normalized);
    return normalized;
  }

  abort(error) {
    if (this.#releasedAt !== null) throw new Error("barrier_already_released");
    this.#rejectRelease(error instanceof Error ? error : new Error("barrier_aborted"));
  }

  get arrivals() { return this.#arrivals; }
  get releasedAt() { return this.#releasedAt; }
}

export async function dispatchTwoPayments(
  requests,
  payInvoice,
  {
    runId,
    wallClock = () => new Date().toISOString(),
    monotonicClock = () => performance.now(),
    beforeRelease = () => undefined,
    onBothDispatched = () => undefined,
  } = {},
) {
  if (!Array.isArray(requests) || requests.length !== 2) throw new Error("exactly_two_requests_required");
  if (typeof payInvoice !== "function") throw new Error("pay_invoice_function_required");
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) throw new Error("run_id_required");

  const barrier = new TwoPartyBarrier();
  let releasedMonotonicMs = null;
  let barrierReleasedAt = null;
  const startedAttempts = [];
  const jobs = requests.map(async (request) => {
    await barrier.arriveAndWait();
    const dispatchedAt = safeTimestamp(wallClock());
    const dispatchMonotonicMs = monotonicClock();
    if (dispatchedAt === null || typeof dispatchMonotonicMs !== "number" || !Number.isFinite(dispatchMonotonicMs)) {
      return {
        runId, id: request.id, requestedHash: safeHash(request.paymentHash), expectedAmountSat: strictInteger(request.amountSat),
        barrierReleasedAt: barrier.releasedAt, dispatchedAt, dispatchMonotonicMs: null,
        responseAt: safeTimestamp(wallClock()), responseMonotonicMs: monotonicClock(),
        result: "error", errorCode: "OTHER", feesPaidMsat: null,
      };
    }
    try {
      const responsePromise = payInvoice(request.invoice, request);
      startedAttempts.push({
        runId,
        id: request.id,
        requestedHash: safeHash(request.paymentHash),
        paymentHash: safeHash(request.paymentHash),
        expectedAmountSat: strictInteger(request.amountSat),
        barrierReleasedAt: barrier.releasedAt,
        dispatchedAt,
        dispatchMonotonicMs,
      });
      if (startedAttempts.length === 2) {
        onBothDispatched({
          barrierReleasedAt: barrier.releasedAt,
          barrierReleaseMonotonicMs: releasedMonotonicMs,
          attempts: startedAttempts.map((attempt) => ({ ...attempt })),
        });
      }
      const response = await responsePromise;
      const fee = normalizeAliases(response, ["fees_paid", "fees_paid_msat", "feesPaidMsat"]);
      return {
        runId,
        id: request.id,
        requestedHash: safeHash(request.paymentHash),
        expectedAmountSat: strictInteger(request.amountSat),
        barrierReleasedAt: barrier.releasedAt,
        dispatchedAt,
        dispatchMonotonicMs,
        responseAt: safeTimestamp(wallClock()),
        responseMonotonicMs: monotonicClock(),
        result: "success",
        errorCode: null,
        feesPaidMsat: fee.value,
        validationIssues: fee.issue ? ["payment_fee_invalid"] : [],
      };
    } catch (error) {
      return {
        runId,
        id: request.id,
        requestedHash: safeHash(request.paymentHash),
        expectedAmountSat: strictInteger(request.amountSat),
        barrierReleasedAt: barrier.releasedAt,
        dispatchedAt,
        dispatchMonotonicMs,
        responseAt: safeTimestamp(wallClock()),
        responseMonotonicMs: monotonicClock(),
        result: "error",
        errorCode: safeErrorCode(error),
        feesPaidMsat: null,
        validationIssues: [],
      };
    }
  });

  await barrier.waitUntilArmed();
  try {
    beforeRelease();
    barrierReleasedAt = safeTimestamp(wallClock());
    releasedMonotonicMs = monotonicClock();
    barrier.release(barrierReleasedAt);
  } catch (error) {
    barrier.abort(error);
    await Promise.allSettled(jobs);
    throw error;
  }
  const attempts = await Promise.all(jobs);
  const dispatchDeltaMs = Number(Math.abs(attempts[0].dispatchMonotonicMs - attempts[1].dispatchMonotonicMs).toFixed(3));
  return {
    barrierReleasedAt,
    barrierReleaseMonotonicMs: releasedMonotonicMs,
    dispatchDeltaMs,
    attempts,
  };
}

function normalizeAliases(source, keys, { allowNegative = false } = {}) {
  const present = keys.filter((key) => Object.hasOwn(source ?? {}, key) && source[key] !== undefined);
  if (present.length === 0) return { value: null, issue: null };
  const values = present.map((key) => strictInteger(source[key], { allowNegative }));
  if (values.some((value) => value === null)) return { value: null, issue: "invalid_budget_number" };
  if (new Set(values).size !== 1) return { value: null, issue: "conflicting_budget_aliases" };
  return { value: values[0], issue: null };
}

/**
 * Normalize Alby/NWC get_budget values to millisatoshis. Alby Hub's legacy
 * get_budget wire shape uses `total_budget` and `used_budget` without a unit
 * suffix; those values are millisatoshis. Other unitless `remaining_budget`
 * data stays ambiguous and is rejected.
 */
export function normalizeBudgetMsat(budget) {
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    return {
      totalBudgetMsat: null, usedBudgetMsat: null, remainingBudgetMsat: null,
      renewalPeriod: null, valid: false, complete: false, issues: ["budget_missing_or_invalid"],
    };
  }
  const unitlessBudgetKeys = ["remaining_budget"];
  const satBudgetKeys = [
    "total_budget_sat", "total_budget_sats", "used_budget_sat", "used_budget_sats",
    "remaining_budget_sat", "remaining_budget_sats", "totalBudgetSat", "totalBudgetSats",
    "usedBudgetSat", "usedBudgetSats", "remainingBudgetSat", "remainingBudgetSats",
  ];
  const unitKeys = ["unit", "budget_unit", "budgetUnit", "amount_unit", "amountUnit"]
    .filter((key) => Object.hasOwn(budget, key));
  const allowedUnits = new Set(["msat", "msats", "millisatoshi", "millisatoshis"]);
  const unitValues = unitKeys.map((key) => budget[key]);
  const issues = [];
  if (unitlessBudgetKeys.some((key) => Object.hasOwn(budget, key))) issues.push("budget_unit_unspecified");
  if (satBudgetKeys.some((key) => Object.hasOwn(budget, key))) issues.push("budget_unit_invalid");
  if (unitKeys.length > 0 && (
    unitValues.some((value) => typeof value !== "string" || !allowedUnits.has(value.toLowerCase())) ||
    new Set(unitValues.map((value) => typeof value === "string" ? value.toLowerCase() : value)).size !== 1
  )) issues.push("budget_unit_invalid_or_conflicting");
  if (["currency", "currency_code", "currencyCode"].some((key) => Object.hasOwn(budget, key))) {
    issues.push("budget_currency_unsupported");
  }
  const total = normalizeAliases(budget, ["total_budget", "total_budget_msats", "total_budget_msat", "totalBudgetMsat", "totalBudgetMsats"]);
  const used = normalizeAliases(budget, ["used_budget", "used_budget_msats", "used_budget_msat", "usedBudgetMsat", "usedBudgetMsats"]);
  const remaining = normalizeAliases(budget, ["remaining_budget_msats", "remaining_budget_msat", "remainingBudgetMsat", "remainingBudgetMsats"], { allowNegative: true });
  issues.push(...[total.issue, used.issue, remaining.issue].filter(Boolean));
  let totalBudgetMsat = total.value;
  let usedBudgetMsat = used.value;
  let remainingBudgetMsat = remaining.value;

  if (totalBudgetMsat !== null && usedBudgetMsat !== null && remainingBudgetMsat === null && !remaining.issue) {
    remainingBudgetMsat = totalBudgetMsat - usedBudgetMsat;
  }
  if (totalBudgetMsat !== null && remainingBudgetMsat !== null && usedBudgetMsat === null && !used.issue) {
    usedBudgetMsat = totalBudgetMsat - remainingBudgetMsat;
  }
  if (usedBudgetMsat !== null && remainingBudgetMsat !== null && totalBudgetMsat === null && !total.issue) {
    totalBudgetMsat = usedBudgetMsat + remainingBudgetMsat;
  }
  if ([totalBudgetMsat, usedBudgetMsat, remainingBudgetMsat].some((value) => value !== null && !Number.isSafeInteger(value))) {
    issues.push("budget_arithmetic_overflow");
  }
  if (usedBudgetMsat !== null && remainingBudgetMsat !== null && !Number.isSafeInteger(usedBudgetMsat + remainingBudgetMsat)) {
    issues.push("budget_arithmetic_overflow");
  }
  if (totalBudgetMsat !== null && usedBudgetMsat !== null && remainingBudgetMsat !== null && totalBudgetMsat !== usedBudgetMsat + remainingBudgetMsat) {
    issues.push("budget_arithmetic_inconsistent");
  }
  if (totalBudgetMsat !== null && remainingBudgetMsat !== null && remainingBudgetMsat > totalBudgetMsat) {
    issues.push("budget_remaining_exceeds_total");
  }

  const renewalKeys = ["renewal_period", "renewalPeriod"].filter((key) => Object.hasOwn(budget, key));
  const renewalValues = renewalKeys.map((key) => budget[key]);
  const renewalPeriod = renewalValues.length && renewalValues.every((value) => typeof value === "string" && RENEWAL_PERIODS.has(value)) && new Set(renewalValues).size === 1
    ? renewalValues[0]
    : null;
  if (renewalKeys.length > 0 && renewalPeriod === null) {
    issues.push("budget_renewal_invalid_or_conflicting");
  }
  for (const [key, value] of [["total", totalBudgetMsat], ["used", usedBudgetMsat], ["remaining", remainingBudgetMsat]]) {
    if (value === null && !issues.some((issue) => issue.includes("budget_number") || issue.includes("budget_aliases"))) {
      issues.push(`budget_${key}_missing`);
    }
  }
  const uniqueIssues = [...new Set(issues)];
  return {
    totalBudgetMsat,
    usedBudgetMsat,
    remainingBudgetMsat,
    renewalPeriod,
    valid: uniqueIssues.length === 0,
    complete: totalBudgetMsat !== null && usedBudgetMsat !== null && remainingBudgetMsat !== null,
    issues: uniqueIssues,
  };
}

/** Persist capture-time normalization so invalid captures cannot be rehabilitated later. */
export function captureBudgetSnapshot(rawBudget, { kind, runId, observedAt = new Date().toISOString() } = {}) {
  const normalized = normalizeBudgetMsat(rawBudget);
  const issues = [...normalized.issues];
  if (kind !== "starting" && kind !== "final") issues.push("budget_snapshot_kind_invalid");
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) issues.push("budget_snapshot_run_id_invalid");
  if (safeTimestamp(observedAt) === null) issues.push("budget_snapshot_timestamp_invalid");
  const capturedValidationIssues = [...new Set(issues)].sort();
  const valid = capturedValidationIssues.length === 0 && normalized.valid && normalized.complete;
  return {
    kind: kind === "starting" || kind === "final" ? kind : null,
    runId: typeof runId === "string" && RUN_ID_RE.test(runId) ? runId : null,
    observedAt: safeTimestamp(observedAt),
    capturedAt: safeTimestamp(observedAt),
    totalBudgetMsat: normalized.totalBudgetMsat,
    usedBudgetMsat: normalized.usedBudgetMsat,
    remainingBudgetMsat: normalized.remainingBudgetMsat,
    renewalPeriod: normalized.renewalPeriod,
    capturedValidationStatus: valid ? "valid" : "invalid",
    capturedValidationIssues,
    valid,
    complete: normalized.complete,
    issues: capturedValidationIssues,
  };
}

function validateCapturedBudget(snapshot, { kind, runId } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { valid: false, normalized: normalizeBudgetMsat(null), issues: ["budget_snapshot_missing"] };
  }
  const issues = [];
  const capturedIssues = Array.isArray(snapshot.capturedValidationIssues) ? snapshot.capturedValidationIssues : null;
  const persistedIssues = Array.isArray(snapshot.issues) ? snapshot.issues : null;
  const canonicalCapturedIssues = capturedIssues && capturedIssues.every((issue) =>
    typeof issue === "string" && BUDGET_CAPTURE_ISSUE_CODES.has(issue)) ? capturedIssues : null;
  const canonicalPersistedIssues = persistedIssues && persistedIssues.every((issue) =>
    typeof issue === "string" && BUDGET_CAPTURE_ISSUE_CODES.has(issue)) ? persistedIssues : null;
  if (!canonicalCapturedIssues || !canonicalPersistedIssues) {
    issues.push("budget_persisted_issue_metadata_invalid");
  } else if (JSON.stringify([...canonicalCapturedIssues].sort()) !== JSON.stringify([...canonicalPersistedIssues].sort())) {
    issues.push("budget_persisted_issue_metadata_conflict");
  }
  if (snapshot.capturedValidationStatus !== "valid") issues.push("budget_capture_previously_invalid");
  if (snapshot.valid !== true || snapshot.complete !== true) issues.push("budget_snapshot_persisted_status_invalid");
  if (!capturedIssues || capturedIssues.length !== 0) issues.push("budget_capture_issue_codes_present");
  if (snapshot.runId !== runId) issues.push("budget_snapshot_run_id_mismatch");
  if (snapshot.kind !== kind) issues.push("budget_snapshot_kind_mismatch");
  if (safeTimestamp(snapshot.observedAt) === null) issues.push("budget_snapshot_timestamp_missing");
  if (snapshot.capturedAt !== undefined &&
    (safeTimestamp(snapshot.capturedAt) === null || snapshot.capturedAt !== snapshot.observedAt)) {
    issues.push("budget_snapshot_timestamp_conflict");
  }
  const normalized = normalizeBudgetMsat(snapshot);
  if (!normalized.valid || !normalized.complete) issues.push(...normalized.issues);
  if (snapshot.valid !== normalized.valid || snapshot.complete !== normalized.complete) issues.push("budget_persisted_validation_flags_conflict");
  return { valid: issues.length === 0, normalized, issues: [...new Set(issues)].sort() };
}

export function validateInvoiceLifecycle({ createdAt, invoiceTimestampUnix, expirySeconds, expiresAtUnix, dispatchAt, reconciliationDeadline, requiredGraceSeconds = REQUIRED_GRACE_SECONDS, nowAt = new Date().toISOString() }) {
  const issues = [];
  const createdMs = safeTimestamp(createdAt) === null ? Number.NaN : Date.parse(createdAt);
  const dispatchMs = safeTimestamp(dispatchAt) === null ? Number.NaN : Date.parse(dispatchAt);
  const deadlineMs = safeTimestamp(reconciliationDeadline) === null ? Number.NaN : Date.parse(reconciliationDeadline);
  const nowMs = safeTimestamp(nowAt) === null ? Number.NaN : Date.parse(nowAt);
  const issued = strictInteger(invoiceTimestampUnix);
  const expiry = strictInteger(expirySeconds);
  const expiresAt = strictInteger(expiresAtUnix);
  const grace = strictInteger(requiredGraceSeconds);
  if (![createdMs, dispatchMs, deadlineMs, nowMs].every(Number.isFinite) || issued === null || expiry === null || expiresAt === null || grace === null) {
    issues.push("invoice_lifecycle_fields_invalid");
  } else {
    if (issued * 1_000 > createdMs + MAX_INVOICE_CLOCK_SKEW_SECONDS * 1_000) issues.push("invoice_timestamp_in_future");
    if (expiry !== EXPECTED_INVOICE_EXPIRY_SECONDS || expiresAt !== issued + expiry) issues.push("invoice_expiry_decode_mismatch");
    if (grace !== REQUIRED_GRACE_SECONDS) issues.push("invoice_required_grace_mismatch");
    if (dispatchMs < createdMs || dispatchMs > nowMs + MAX_INVOICE_CLOCK_SKEW_SECONDS * 1_000) issues.push("invoice_dispatch_chronology_invalid");
    if (expiresAt * 1_000 - dispatchMs < 15_000) issues.push("invoice_remaining_lifetime_insufficient");
    if (deadlineMs < expiresAt * 1_000 + REQUIRED_GRACE_SECONDS * 1_000) issues.push("invoice_reconciliation_grace_insufficient");
  }
  return { valid: issues.length === 0, issues: [...new Set(issues)].sort() };
}

export function sanitizeReceiverObservation({ runId, id, requestedHash, expectedAmountSat, lookup, observedAt = new Date().toISOString(), acquiredAt = observedAt, sessionId }) {
  const raw = lookup && typeof lookup === "object" && !Array.isArray(lookup) ? lookup : {};
  const state = safeState(raw.state, RECEIVER_STATES);
  const paid = normalizeAliases(raw, ["amt_paid_sat", "amountPaidSat"]);
  const paidMsat = normalizeAliases(raw, ["amt_paid_msat", "amountPaidMsat"]);
  const settleAliases = normalizeAliases(raw, ["settle_date", "settleDateUnix"]);
  const settledDate = settleAliases.value === 0 ? null : settleAliases.value;
  const rawSettledAt = safeEpochSeconds(raw.settle_date);
  const settledAtAliases = [raw.settledAt, raw.settled_at].filter((value) => value !== undefined).map(safeTimestamp);
  const settledAtConflict = settledAtAliases.some((value) => value === null) || new Set(settledAtAliases).size > 1 ||
    (rawSettledAt !== null && settledAtAliases.length > 0 && rawSettledAt !== settledAtAliases[0]) ||
    settlementTimestampAliasesConflict(settledDate, settledAtAliases[0]);
  return {
    ...(sessionId === undefined ? {} : { sessionId: typeof sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId) ? sessionId.toLowerCase() : null }),
    runId: typeof runId === "string" && RUN_ID_RE.test(runId) ? runId : null,
    id: id === "A" || id === "B" ? id : null,
    requestedHash: safeHash(requestedHash),
    returnedHash: normalizeHashAliases(raw, ["r_hash", "payment_hash", "paymentHash"]),
    expectedAmountSat: strictInteger(expectedAmountSat),
    state,
    settled: typeof raw.settled === "boolean" ? raw.settled : null,
    amountPaidSat: paid.value,
    amountPaidMsat: paidMsat.value,
    settleDateUnix: settledDate,
    settledAt: settledAtConflict ? null : rawSettledAt ?? settledAtAliases[0] ?? safeEpochSeconds(settledDate),
    observedAt: safeTimestamp(observedAt),
    acquiredAt: safeTimestamp(acquiredAt),
    errorCode: raw.errorCode == null ? null : safeErrorCode(raw.errorCode),
    validationIssues: [...new Set([
      ...(paid.issue ? ["receiver_amount_alias_conflict"] : []),
      ...(paidMsat.issue ? ["receiver_amount_alias_conflict"] : []),
      ...(settleAliases.issue || settledAtConflict ? ["receiver_settlement_timestamp_conflict"] : []),
      ...(sessionId !== undefined && !(typeof sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) ? ["receiver_session_id_invalid"] : []),
    ])].sort(),
  };
}

export function sanitizeNwcLookup({ runId, id, requestedHash, expectedAmountSat, lookup, error, observedAt = new Date().toISOString() }) {
  const raw = lookup && typeof lookup === "object" && !Array.isArray(lookup) ? lookup : {};
  const amount = normalizeAliases(raw, ["amount", "amount_msat", "amountMsat"]);
  const fee = normalizeAliases(raw, ["fees_paid", "fees_paid_msat", "feesPaidMsat"]);
  const settledAtAlias = normalizeAliases(raw, ["settled_at", "settledAtUnix"]);
  const settledAtValue = settledAtAlias.value === 0 ? null : settledAtAlias.value;
  const notFound = error != null && safeErrorCode(error) === "NOT_FOUND";
  const validationIssues = [];
  if (amount.issue || fee.issue) validationIssues.push("nwc_lookup_numeric_alias_conflict");
  if (settledAtAlias.issue) validationIssues.push("nwc_settlement_timestamp_invalid");
  if (fee.value === null && ["fees_paid", "fees_paid_msat", "feesPaidMsat"].some((key) => Object.hasOwn(raw, key) && raw[key] !== undefined)) validationIssues.push("nwc_fee_invalid");
  if (amount.value === null && ["amount", "amount_msat", "amountMsat"].some((key) => Object.hasOwn(raw, key) && raw[key] !== undefined)) validationIssues.push("nwc_lookup_amount_invalid");
  const notFoundForbidden = ["state", "settled", "amount", "amount_msat", "amountMsat", "amount_paid_msat", "amount_paid_sat", "fees_paid", "fees_paid_msat", "feesPaidMsat", "settled_at", "settledAtUnix", "settle_date", "settleDateUnix", "payment_hash", "paymentHash", "preimage", "payment_preimage"]
    .some((key) => Object.hasOwn(raw, key) && raw[key] !== undefined);
  if (notFound && notFoundForbidden) validationIssues.push("nwc_not_found_shape_invalid");
  if (!notFound && settledAtValue !== null && safeEpochSeconds(settledAtValue) === null) validationIssues.push("nwc_settlement_timestamp_invalid");
  return {
    evidenceType: notFound ? "not_found" : "returned_record",
    runId: typeof runId === "string" && RUN_ID_RE.test(runId) ? runId : null,
    id: id === "A" || id === "B" ? id : null,
    requestedHash: safeHash(requestedHash),
    returnedHash: notFound ? null : normalizeHashAliases(raw, ["payment_hash", "paymentHash"]),
    expectedAmountSat: strictInteger(expectedAmountSat),
    lookupState: notFound ? null : safeState(raw.state, NWC_STATES),
    amountMsat: notFound ? null : amount.value,
    feesPaidMsat: notFound ? null : fee.value,
    settledAt: notFound ? null : safeEpochSeconds(settledAtValue),
    observedAt: safeTimestamp(observedAt),
    errorCode: error ? safeErrorCode(error) : null,
    validationIssues: [...new Set(validationIssues)].sort(),
  };
}

export function validateInitialObservations({ runId, expectedInvoices, observations, beforeAt, dispatchAtById }) {
  const reasons = [];
  const beforeMs = safeTimestamp(beforeAt) === null ? Number.NaN : Date.parse(beforeAt);
  if (!Number.isFinite(beforeMs)) reasons.push("initial_validation_time_missing");
  const expected = Array.isArray(expectedInvoices) ? expectedInvoices : [];
  if (expected.length !== 2) reasons.push("expected_invoice_set_invalid");
  const ids = new Set(expected.map((item) => item?.id));
  const hashes = expected.map((item) => safeHash(item?.paymentHash));
  if (ids.size !== 2 || !["A", "B"].every((id) => ids.has(id)) || hashes.some((hash) => !hash) || new Set(hashes).size !== 2) {
    reasons.push("expected_invoice_binding_invalid");
  }
  const records = Array.isArray(observations) ? observations : [];
  for (const invoice of expected) {
    const hash = safeHash(invoice?.paymentHash);
    const matching = records.filter((item) => item?.id === invoice?.id);
    if (matching.length !== 1) {
      reasons.push("initial_receiver_observation_missing_or_ambiguous");
      continue;
    }
    const item = matching[0];
    const acquiredAt = item?.acquiredAt;
    const observedAt = item?.observedAt;
    const at = safeTimestamp(acquiredAt) === null ? Number.NaN : Date.parse(acquiredAt);
    const observedMs = safeTimestamp(observedAt) === null ? Number.NaN : Date.parse(observedAt);
    const dispatchAt = safeTimestamp(dispatchAtById?.[invoice.id]) === null ? Number.NaN : Date.parse(dispatchAtById[invoice.id]);
    if (
      item?.runId !== runId || item?.requestedHash !== hash || item?.returnedHash !== hash ||
      item?.expectedAmountSat !== strictInteger(invoice?.amountSat) || item?.state !== "OPEN" ||
      item?.settled !== false || item?.amountPaidSat !== 0 || item?.amountPaidMsat !== 0 || item?.settleDateUnix != null || item?.settledAt != null ||
      item?.errorCode != null || (Array.isArray(item?.validationIssues) && item.validationIssues.length > 0) ||
      !Number.isFinite(at) || !Number.isFinite(observedMs) || observedAt !== acquiredAt || at >= beforeMs
    ) reasons.push("initial_receiver_observation_stale_or_mismatched");
    if (dispatchAtById && (!Number.isFinite(dispatchAt) || at >= dispatchAt || dispatchAt - at > INITIAL_OBSERVATION_MAX_AGE_MS)) {
      reasons.push("initial_receiver_observation_stale_before_dispatch");
    }
  }
  if (records.length !== 2) reasons.push("initial_receiver_observation_count_invalid");
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
}

/** Validate acquisition fields before producing the sanitized snapshot consumed by the race. */
export function prepareInitialReceiverObservations({ runId, expectedInvoices, observations, beforeAt, dispatchAtById }) {
  const checked = validateInitialObservations({ runId, expectedInvoices, observations, beforeAt, dispatchAtById });
  const records = Array.isArray(observations) ? observations : [];
  const normalized = records.map((item) => sanitizeReceiverObservation({
    runId: item?.runId,
    id: item?.id,
    requestedHash: item?.requestedHash,
    expectedAmountSat: item?.expectedAmountSat,
    lookup: item && typeof item === "object" ? {
      r_hash: item.returnedHash,
      state: item.state,
      settled: item.settled,
      amt_paid_sat: item.amountPaidSat,
      amt_paid_msat: item.amountPaidMsat,
      ...(item.settleDateUnix == null ? {} : { settle_date: item.settleDateUnix }),
      ...(item.settledAt == null ? {} : { settledAt: item.settledAt }),
      errorCode: item.errorCode,
    } : null,
    observedAt: item?.observedAt ?? null,
    acquiredAt: item?.acquiredAt ?? null,
  }));
  return { ...checked, observations: normalized };
}

function normalizeReceiverObservationHistory({ runId, expected, observations, barrierReleasedAt, reconciliationDeadline, dispatchedAt, controlledAttribution }) {
  const id = expected.id;
  const hash = safeHash(expected.paymentHash);
  const amountSat = strictInteger(expected.amountSat);
  const releaseMs = safeTimestamp(barrierReleasedAt) === null ? Number.NaN : Date.parse(barrierReleasedAt);
  const dispatchMs = safeTimestamp(dispatchedAt) === null ? Number.NaN : Date.parse(dispatchedAt);
  const deadlineMs = safeTimestamp(reconciliationDeadline) === null ? Number.NaN : Date.parse(reconciliationDeadline);
  const deadlineGraceMs = RECONCILIATION_POLL_INTERVAL_MS + 5_000;
  const records = (Array.isArray(observations) ? observations : []).filter((item) => item?.id === id);
  const reasons = [];
  if (!hash || amountSat === null || !Number.isFinite(releaseMs) || !Number.isFinite(deadlineMs) || deadlineMs <= releaseMs) {
    reasons.push("reconciliation_bounds_or_expected_invoice_invalid");
  }
  if (records.length === 0) reasons.push("receiver_observation_missing");
  const normalized = records.map((item) => {
    const state = safeState(item?.state, RECEIVER_STATES);
    const observedMs = safeTimestamp(item?.observedAt) === null ? Number.NaN : Date.parse(item.observedAt);
    if (
      item?.runId !== runId || item?.requestedHash !== hash || item?.returnedHash !== hash ||
      item?.expectedAmountSat !== amountSat || !state || item?.amountPaidSat === null ||
      strictInteger(item?.amountPaidSat) === null || strictInteger(item?.amountPaidMsat) === null || !Number.isFinite(observedMs) ||
      observedMs < releaseMs || observedMs > deadlineMs + deadlineGraceMs || item?.errorCode != null ||
      (Array.isArray(item?.validationIssues) && item.validationIssues.length > 0)
    ) reasons.push("receiver_observation_mismatched_or_out_of_window");
    if (Array.isArray(item?.validationIssues)) {
      for (const issue of item.validationIssues) if (RECEIVER_VALIDATION_ISSUES.has(issue)) reasons.push(issue);
    }
    if (settlementTimestampAliasesConflict(item?.settleDateUnix, item?.settledAt)) {
      reasons.push("receiver_settlement_timestamp_conflict");
    }
    return { item, state, observedMs };
  }).sort((a, b) => a.observedMs - b.observedMs);

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous.observedMs === current.observedMs) reasons.push("duplicate_receiver_observation_timestamp");
    const previousTerminal = ["SETTLED", "CANCELED", "EXPIRED"].includes(previous.state);
    if (previousTerminal && (previous.state !== current.state || previous.item?.amountPaidSat !== current.item?.amountPaidSat)) {
      reasons.push("receiver_terminal_state_contradiction");
    }
  }

  for (const entry of normalized) {
    const { item, state } = entry;
    const paid = strictInteger(item?.amountPaidSat);
    const paidMsat = strictInteger(item?.amountPaidMsat);
    if (paidMsat !== null && paid !== null && paidMsat !== paid * 1_000) reasons.push("receiver_amount_msat_sat_mismatch");
    if (state === "SETTLED" && (item?.settled !== true || paid !== amountSat || paidMsat !== amountSat * 1_000)) reasons.push("receiver_settlement_amount_or_flag_mismatch");
    if (["CANCELED", "EXPIRED"].includes(state) &&
      (item?.settled !== false || paid !== 0 || paidMsat !== 0 || item?.settleDateUnix != null || item?.settledAt != null)) {
      reasons.push("receiver_terminal_unpaid_evidence_invalid");
    }
    if (["OPEN", "ACCEPTED", "PENDING"].includes(state) && (item?.settled !== false || paid !== 0 || paidMsat !== 0 || item?.settleDateUnix != null || item?.settledAt != null)) reasons.push("receiver_pending_evidence_invalid");
    if (state === "SETTLED" && item?.settleDateUnix != null) {
      const settleSec = strictInteger(item?.settleDateUnix);
      // LND's whole-second timestamp represents [T.000, (T + 1).000). A
      // same-second overlap is attributable only for a test-exclusive invoice
      // proven OPEN/unpaid immediately before this one dispatch.
      const settleStartMs = settleSec === null ? Number.NaN : settleSec * 1_000;
      const settleEndMs = settleSec === null ? Number.NaN : (settleSec + 1) * 1_000;
      if (
        settleSec === null || !Number.isSafeInteger(settleStartMs) || !Number.isSafeInteger(settleEndMs) ||
        settleEndMs <= (controlledAttribution === true && Number.isFinite(dispatchMs) ? dispatchMs : releaseMs) || settleStartMs > entry.observedMs
      ) {
        reasons.push("receiver_settlement_time_out_of_chronology");
      } else if (controlledAttribution !== true && Number.isFinite(dispatchMs) && settleStartMs <= dispatchMs && dispatchMs < settleEndMs) {
        reasons.push("receiver_settlement_attribution_ambiguous");
      }
    } else if (state === "SETTLED") reasons.push("receiver_settlement_timestamp_missing");
  }

  const latest = normalized.at(-1) ?? null;
  const isTerminal = latest && ["SETTLED", "CANCELED", "EXPIRED"].includes(latest.state);
  if (latest && !isTerminal) {
    reasons.push(latest.observedMs < deadlineMs ? "receiver_unresolved_before_deadline" : "receiver_unresolved_at_deadline");
  }
  const valid = reasons.length === 0;
  const settled = valid && isTerminal ? latest.state === "SETTLED" : null;
  const reconciled = valid && isTerminal;
  return {
    outcome: {
      runId,
      id,
      paymentHash: hash,
      expectedAmountSat: amountSat,
      reconciled,
      terminal: isTerminal === true,
      settled,
      state: latest?.state ?? null,
      amountPaidSat: reconciled ? strictInteger(latest.item.amountPaidSat) : null,
      amountPaidMsat: reconciled ? strictInteger(latest.item.amountPaidMsat) : null,
      settleDateUnix: reconciled && settled ? strictInteger(latest.item.settleDateUnix) : null,
      settledAt: reconciled && settled ? safeTimestamp(latest.item.settledAt) : null,
      latestObservedAt: latest?.item?.observedAt ?? null,
      observationCount: records.length,
      reasonCodes: [...new Set(reasons)].sort(),
    },
    reasons,
  };
}

export function reconcileTwoInvoices({ runId, expectedInvoices, bobObservations, barrierReleasedAt, reconciliationDeadline, dispatchedAtById, controlledAttribution = false, startingSpendableBudgetMsat, startingSpendableBudgetSats }) {
  const expected = Array.isArray(expectedInvoices) ? expectedInvoices : [];
  const reasons = [];
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) reasons.push("run_id_invalid");
  if (expected.length !== 2) reasons.push("expected_invoice_set_invalid");
  const hashes = expected.map((item) => safeHash(item?.paymentHash));
  if (hashes.some((hash) => !hash) || new Set(hashes).size !== 2) reasons.push("expected_payment_hashes_invalid_or_duplicate");
  const seenIds = new Set(expected.map((item) => item?.id));
  if (seenIds.size !== 2 || !["A", "B"].every((id) => seenIds.has(id))) reasons.push("expected_invoice_ids_invalid");
  const perInvoice = expected.map((invoice) => normalizeReceiverObservationHistory({
    runId,
    expected: invoice,
    observations: bobObservations,
    barrierReleasedAt,
    reconciliationDeadline,
    dispatchedAt: dispatchedAtById?.[invoice.id],
    controlledAttribution,
  }));
  for (const item of perInvoice) reasons.push(...item.reasons);
  if ((Array.isArray(bobObservations) ? bobObservations : []).some((item) => !expected.some((invoice) => invoice?.id === item?.id))) {
    reasons.push("unexpected_receiver_observation_id");
  }
  const outcomes = perInvoice.map(({ outcome }) => outcome);
  const budgetMsat = startingSpendableBudgetMsat !== undefined
    ? strictInteger(startingSpendableBudgetMsat)
    : (() => {
        const sats = strictInteger(startingSpendableBudgetSats);
        return sats === null ? null : sats * 1_000;
      })();
  const invariant = classifyInvariant({ startingSpendableBudgetMsat: budgetMsat, outcomes });
  return {
    outcomes,
    ...invariant,
    valid: reasons.length === 0 && invariant.classification !== "INCONCLUSIVE",
    reasonCodes: [...new Set(reasons)].sort(),
  };
}

function normalizeNwcHistory({ runId, runStartedAt, dispatchedAt, expected, observations, receiverOutcome, barrierReleasedAt, reconciliationDeadline, receiverCompletedAt, finalLookupCompletedAt }) {
  const records = (Array.isArray(observations) ? observations : []).filter((item) => item?.id === expected.id);
  const reasons = [];
  if (records.length === 0) reasons.push("nwc_lookup_missing");
  const hash = safeHash(expected.paymentHash);
  const expectedAmountSat = strictInteger(expected.amountSat);
  const releaseMs = safeTimestamp(barrierReleasedAt) === null ? Number.NaN : Date.parse(barrierReleasedAt);
  const dispatchMs = safeTimestamp(dispatchedAt) === null ? Number.NaN : Date.parse(dispatchedAt);
  const deadlineMs = safeTimestamp(reconciliationDeadline) === null ? Number.NaN : Date.parse(reconciliationDeadline);
  const deadlineGraceMs = FINAL_NWC_LOOKUP_GRACE_MS;
  const normalized = records.map((item) => {
    const evidenceType = item?.evidenceType ?? "returned_record";
    const state = evidenceType === "not_found" ? null : safeState(item?.lookupState, NWC_STATES);
    const observedMs = safeTimestamp(item?.observedAt) === null ? Number.NaN : Date.parse(item.observedAt);
    const amountMsat = strictInteger(item?.amountMsat);
    if (item?.runId !== runId || item?.requestedHash !== hash || item?.expectedAmountSat !== expectedAmountSat) {
      reasons.push("nwc_lookup_run_or_request_binding_mismatch");
    }
    if (!Number.isFinite(observedMs) || observedMs < releaseMs || observedMs > deadlineMs + deadlineGraceMs) {
      reasons.push("nwc_lookup_out_of_window");
    }
    let settlementMs = null;
    if (evidenceType === "not_found") {
      if (item?.errorCode !== "NOT_FOUND" || item?.returnedHash != null || item?.lookupState != null || item?.amountMsat != null || item?.feesPaidMsat != null ||
          item?.settledAt != null || (Array.isArray(item?.validationIssues) && item.validationIssues.length > 0)) {
        reasons.push("nwc_not_found_shape_invalid");
      }
    } else if (evidenceType !== "returned_record") {
      reasons.push("nwc_lookup_evidence_type_invalid");
    } else {
      if (!state || item?.errorCode != null) reasons.push("nwc_returned_record_state_or_error_invalid");
      if (item?.returnedHash !== hash) reasons.push("nwc_lookup_returned_hash_mismatch");
      if (amountMsat !== null && amountMsat !== expectedAmountSat * 1_000) reasons.push("nwc_lookup_amount_mismatch");
      if (state !== "FAILED" && amountMsat !== expectedAmountSat * 1_000) reasons.push("nwc_lookup_amount_missing");
      if (Array.isArray(item?.validationIssues) && item.validationIssues.length > 0) reasons.push("nwc_capture_validation_failed");
      const runStartedMs = safeTimestamp(runStartedAt) === null ? Number.NaN : Date.parse(runStartedAt);
      const settlementAt = item?.settledAt == null ? null : safeTimestamp(item.settledAt);
      settlementMs = settlementAt === null ? null : Date.parse(settlementAt);
      if (item?.settledAt != null && settlementAt === null) reasons.push("nwc_settlement_timestamp_invalid");
      if (state === "SETTLED" && item?.settledAt == null) reasons.push("nwc_settlement_timestamp_missing");
      if (state !== "SETTLED" && item?.settledAt != null) reasons.push("nwc_terminal_unpaid_settlement_timestamp_unexpected");
      if (settlementMs !== null) {
        const settlementEndMs = settlementMs + 1_000; // NWC epoch-second timestamps have whole-second precision.
        if (!Number.isFinite(settlementMs) || !Number.isFinite(runStartedMs) || settlementEndMs <= runStartedMs) reasons.push("nwc_settlement_predates_run");
        if (!Number.isFinite(dispatchMs) || settlementEndMs <= dispatchMs) reasons.push("nwc_settlement_predates_dispatch");
        if (Number.isFinite(observedMs) && settlementMs > observedMs) reasons.push("nwc_settlement_after_observation");
      }
    }
    if (item?.feesPaidMsat != null && strictInteger(item?.feesPaidMsat) === null) reasons.push("nwc_fee_invalid");
    return { item, evidenceType, state, amountMsat, observedMs, settlementMs };
  }).sort((a, b) => a.observedMs - b.observedMs);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].observedMs === normalized[index].observedMs) reasons.push("duplicate_nwc_lookup_timestamp");
    if (normalized[index - 1].state === "SETTLED" && normalized[index].evidenceType === "returned_record" && normalized[index].state !== "SETTLED") {
      reasons.push("nwc_settlement_state_contradiction");
    }
  }
  if (receiverOutcome?.reconciled === true && receiverOutcome.settled === false && normalized.some((item) => item.state === "SETTLED")) {
    reasons.push("nwc_receiver_settlement_contradiction");
  }
  const latest = normalized.at(-1);
  const receiverObservedAt = safeTimestamp(receiverOutcome?.latestObservedAt) === null ? Number.NaN : Date.parse(receiverOutcome.latestObservedAt);
  if (
    !latest || !Number.isFinite(latest.observedMs) ||
    (latest.evidenceType === "returned_record" && (!latest.state || latest.item?.returnedHash !== hash ||
      (latest.state !== "FAILED" && latest.amountMsat !== expectedAmountSat * 1_000))) ||
    (latest.evidenceType === "not_found" && latest.item?.errorCode !== "NOT_FOUND")
  ) {
    reasons.push("nwc_final_lookup_incomplete");
  }
  if (latest && Number.isFinite(receiverObservedAt) && latest.observedMs < receiverObservedAt) {
    reasons.push("nwc_lookup_stale_for_final_receiver_observation");
  }
  const receiverCompletedMs = safeTimestamp(receiverCompletedAt) === null ? Number.NaN : Date.parse(receiverCompletedAt);
  if (latest && (!Number.isFinite(receiverCompletedMs) || latest.observedMs < receiverCompletedMs)) {
    reasons.push("nwc_lookup_not_after_receiver_reconciliation_completion");
  }
  if (latest && receiverOutcome?.reconciled) {
    const receiverTerminalState = receiverOutcome.state;
    if (receiverOutcome.settled === true && (latest.evidenceType !== "returned_record" || latest.state !== "SETTLED")) reasons.push("nwc_receiver_settlement_contradiction");
    if (receiverOutcome.settled === false && latest.evidenceType === "returned_record" && !["CANCELED", "EXPIRED", "FAILED"].includes(latest.state)) reasons.push("nwc_receiver_terminal_unpaid_contradiction");
    if (receiverOutcome.settled === false && latest.evidenceType === "returned_record" &&
      ((receiverTerminalState === "CANCELED" && latest.state === "EXPIRED") || (receiverTerminalState === "EXPIRED" && latest.state === "CANCELED"))) {
      reasons.push("nwc_receiver_terminal_state_mismatch");
    }
  } else if (latest?.state === "SETTLED" && receiverOutcome?.state !== "SETTLED") {
    reasons.push("nwc_settlement_not_confirmed_by_receiver");
  }
  const completedMs = safeTimestamp(finalLookupCompletedAt) === null ? Number.NaN : Date.parse(finalLookupCompletedAt);
  if (normalized.some((item) => !Number.isFinite(item.observedMs) || !Number.isFinite(completedMs) || item.observedMs > completedMs)) {
    reasons.push("nwc_lookup_completion_before_observation");
  }
  if (normalized.some((item) => item.state === "SETTLED" && Number.isFinite(item.settlementMs) &&
    Number.isFinite(completedMs) && item.settlementMs > completedMs)) {
    reasons.push("nwc_settlement_after_completion");
  }
  return {
    id: expected.id,
    latest: latest?.item ?? null,
    valid: reasons.length === 0,
    reasonCodes: [...new Set(reasons)].sort(),
  };
}

export function classifyInvariant({ startingSpendableBudgetMsat, startingSpendableBudgetSats, outcomes }) {
  const budgetMsat = startingSpendableBudgetMsat !== undefined
    ? strictInteger(startingSpendableBudgetMsat)
    : (() => {
        const sats = strictInteger(startingSpendableBudgetSats);
        return sats === null || !Number.isSafeInteger(sats * 1_000) ? null : sats * 1_000;
      })();
  const validOutcomes = Array.isArray(outcomes) && outcomes.length === 2 && outcomes.every((outcome) => {
    const amount = strictInteger(outcome?.amountPaidSat);
    const amountMsat = strictInteger(outcome?.amountPaidMsat);
    if (outcome?.reconciled !== true || outcome?.terminal !== true || typeof outcome?.settled !== "boolean" || amount === null || amountMsat === null || amountMsat !== amount * 1_000) return false;
    return outcome.settled ? amount > 0 && amountMsat > 0 : amount === 0 && amountMsat === 0;
  });
  const totalSettledPrincipalMsat = validOutcomes
    ? outcomes.reduce((sum, outcome) => sum + (outcome.settled ? strictInteger(outcome.amountPaidMsat) : 0), 0)
    : null;
  const totalSettledPrincipalSats = totalSettledPrincipalMsat === null || totalSettledPrincipalMsat % 1_000 !== 0
    ? null
    : totalSettledPrincipalMsat / 1_000;
  if (!validOutcomes) {
    return {
      classification: "INCONCLUSIVE",
      totalSettledPrincipalSats: null,
      totalSettledPrincipalMsat: null,
      invariantHolds: null,
      reason: "independent_settlement_evidence_incomplete",
    };
  }
  if (budgetMsat === null) {
    return {
      classification: "INCONCLUSIVE",
      totalSettledPrincipalSats,
      totalSettledPrincipalMsat,
      invariantHolds: null,
      reason: "starting_spendable_budget_unverified",
    };
  }
  const invariantHolds = totalSettledPrincipalMsat <= budgetMsat;
  return {
    classification: invariantHolds ? "PASS" : "FAIL",
    totalSettledPrincipalSats,
    totalSettledPrincipalMsat,
    invariantHolds,
    reason: invariantHolds ? "settled_principal_within_starting_budget" : "settled_principal_exceeds_starting_budget",
  };
}

export function evaluateRunEvidence({ raceEvidence, bobEvidence } = {}) {
  const race = raceEvidence && typeof raceEvidence === "object" ? raceEvidence : {};
  const bob = bobEvidence && typeof bobEvidence === "object" ? bobEvidence : {};
  const reasons = [];
  const supplementaryReasons = [];
  const runId = race.runId;
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId) || bob.runId !== runId) reasons.push("run_id_missing_or_mismatched");
  if (
    race.schemaVersion !== 2 || race.test !== "phase4-two-payment-budget-race" || race.network !== "regtest" ||
    race.wallet !== "Alby Hub / Alice" || race.encryption !== "nip44" || race.encryptionVerified !== true
  ) reasons.push("race_identity_unverified");

  const attemptRecords = Array.isArray(race.attempts) ? race.attempts : [];
  const attempts = ["A", "B"].map((id) => attemptRecords.filter((item) => item?.id === id));
  if (attemptRecords.length !== 2 || attempts.some((values) => values.length !== 1)) reasons.push("attempt_set_missing_or_ambiguous");
  const expectedInvoices = ["A", "B"].map((id, index) => {
    const attempt = attempts[index]?.[0];
    return { id, paymentHash: safeHash(attempt?.requestedHash), amountSat: strictInteger(attempt?.expectedAmountSat) };
  });
  const expectedHashes = expectedInvoices.map((item) => item.paymentHash);
  if (expectedHashes.some((hash) => !hash) || new Set(expectedHashes).size !== 2 || expectedInvoices.some((item) => item.amountSat !== 700)) {
    reasons.push("dispatched_invoice_binding_invalid");
  }
  if (attemptRecords.some((item) => item?.runId !== runId || !safeHash(item?.requestedHash) ||
    (item?.paymentHash !== undefined && item.paymentHash !== item.requestedHash) || item?.expectedAmountSat !== 700)) {
    reasons.push("dispatched_attempt_run_or_hash_mismatch");
  }
  if (attempts.some(([item]) => !item || !["success", "error"].includes(item.result))) supplementaryReasons.push("nwc_payment_result_missing");

  const dispatchAtById = Object.fromEntries(["A", "B"].map((id, index) => [id, attempts[index]?.[0]?.dispatchedAt]));
  const controlledAttribution = race.testExclusiveInvoices === true && race.noOtherPayerPath === true;
  const lifecycleRecords = Array.isArray(race.invoiceLifecycle) ? race.invoiceLifecycle : [];
  if (lifecycleRecords.length !== 2 || race.requiredGraceSeconds !== REQUIRED_GRACE_SECONDS ||
      race.expectedInvoiceExpirySeconds !== EXPECTED_INVOICE_EXPIRY_SECONDS) reasons.push("invoice_lifecycle_set_or_grace_invalid");
  for (const expected of expectedInvoices) {
    const lifecycleMatches = lifecycleRecords.filter((item) => item?.id === expected.id);
    if (lifecycleMatches.length === 1) expected.expiresAtUnix = strictInteger(lifecycleMatches[0].expiresAtUnix);
  }
  for (const expected of expectedInvoices) {
    const matches = lifecycleRecords.filter((item) => item?.id === expected.id);
    const item = matches.length === 1 ? matches[0] : null;
    const attempt = attempts.find(([record]) => record?.id === expected.id)?.[0];
    const lifecycle = item ? validateInvoiceLifecycle({
      createdAt: item.createdAt,
      invoiceTimestampUnix: item.invoiceTimestampUnix,
      expirySeconds: item.expirySeconds,
      expiresAtUnix: item.expiresAtUnix,
      dispatchAt: item.dispatchAt,
      reconciliationDeadline: item.reconciliationDeadline,
      requiredGraceSeconds: item.requiredGraceSeconds,
      nowAt: item.dispatchAt,
    }) : { valid: false, issues: ["invoice_lifecycle_missing"] };
    if (!item || item.paymentHash !== expected.paymentHash || item.dispatchAt !== attempt?.dispatchedAt ||
        item.reconciliationDeadline !== race.reconciliationDeadline || !lifecycle.valid) {
      reasons.push("invoice_lifecycle_or_grace_invalid", ...lifecycle.issues);
    }
  }

  const initialCheck = validateInitialObservations({
    runId,
    expectedInvoices,
    observations: race.initialBobObservations,
    beforeAt: race.startingBudget?.capturedAt,
    dispatchAtById,
  });
  reasons.push(...initialCheck.reasons);

  const preparedAt = safeTimestamp(race.requestsPreparedAt) === null ? Number.NaN : Date.parse(race.requestsPreparedAt);
  const budgetAt = safeTimestamp(race.startingBudget?.capturedAt) === null ? Number.NaN : Date.parse(race.startingBudget.capturedAt);
  const barrierAt = safeTimestamp(race.barrierReleasedAt) === null ? Number.NaN : Date.parse(race.barrierReleasedAt);
  const deadlineAt = safeTimestamp(race.reconciliationDeadline) === null ? Number.NaN : Date.parse(race.reconciliationDeadline);
  const releaseMono = race.barrierReleaseMonotonicMs;
  const attemptA = attempts[0]?.[0];
  const attemptB = attempts[1]?.[0];
  const dispatchBindingValid =
    race.dispatchTimingBoundary === "nwc_client_call_start" &&
    Number.isFinite(preparedAt) && Number.isFinite(budgetAt) && Number.isFinite(barrierAt) && Number.isFinite(deadlineAt) &&
    budgetAt < preparedAt && preparedAt <= barrierAt && deadlineAt > barrierAt &&
    typeof releaseMono === "number" && Number.isFinite(releaseMono) &&
    [attemptA, attemptB].every((attempt) => {
      const dispatchedAt = safeTimestamp(attempt?.dispatchedAt) === null ? Number.NaN : Date.parse(attempt.dispatchedAt);
      return attempt?.barrierReleasedAt === race.barrierReleasedAt && Number.isFinite(dispatchedAt) && dispatchedAt >= barrierAt &&
        typeof attempt?.dispatchMonotonicMs === "number" && Number.isFinite(attempt.dispatchMonotonicMs) && attempt.dispatchMonotonicMs >= releaseMono;
    });
  let delta = null;
  let overlap = false;
  if (attemptA && attemptB && Number.isFinite(attemptA.dispatchMonotonicMs) && Number.isFinite(attemptB.dispatchMonotonicMs)) {
    delta = Number(Math.abs(attemptA.dispatchMonotonicMs - attemptB.dispatchMonotonicMs).toFixed(3));
    const responseTimesValid = [attemptA, attemptB].every((attempt) => {
      const dispatchedAt = safeTimestamp(attempt?.dispatchedAt) === null ? Number.NaN : Date.parse(attempt.dispatchedAt);
      const responseAt = safeTimestamp(attempt?.responseAt) === null ? Number.NaN : Date.parse(attempt.responseAt);
      return Number.isFinite(responseAt) && responseAt >= dispatchedAt &&
        typeof attempt?.responseMonotonicMs === "number" && Number.isFinite(attempt.responseMonotonicMs) &&
        attempt.responseMonotonicMs >= attempt.dispatchMonotonicMs;
    });
    if (responseTimesValid) {
      const firstResponse = Math.min(attemptA.responseMonotonicMs, attemptB.responseMonotonicMs);
      overlap = Math.max(attemptA.dispatchMonotonicMs, attemptB.dispatchMonotonicMs) < firstResponse;
    }
  }
  const dispatchDeltaValid = typeof race.dispatchDeltaMs === "number" && Number.isFinite(race.dispatchDeltaMs) && race.dispatchDeltaMs === delta;
  if (!dispatchBindingValid || !dispatchDeltaValid) reasons.push("dispatch_timing_invalid_or_serialized");
  if (!overlap) supplementaryReasons.push("dispatch_response_timing_incomplete_or_nonoverlapping");

  const startingBudgetCapture = validateCapturedBudget(race.startingBudget, { kind: "starting", runId });
  const startingBudget = startingBudgetCapture.normalized;
  reasons.push(...startingBudgetCapture.issues.map((issue) => `starting_${issue}`));
  const startingBudgetVerified = startingBudgetCapture.valid && startingBudget.valid && startingBudget.complete &&
    startingBudget.totalBudgetMsat === 1_000_000 && startingBudget.usedBudgetMsat === 0 &&
    startingBudget.remainingBudgetMsat === 1_000_000 && startingBudget.renewalPeriod === "never" &&
    race.startingBudget?.reportedRenewalPeriod === "never";
  if (!startingBudgetVerified) reasons.push("starting_budget_unverified_or_contradictory");

  const bobObservations = Array.isArray(bob.observations) ? bob.observations : [];
  if (!Array.isArray(bob.observations)) supplementaryReasons.push("bob_observation_container_invalid");
  const malformedBobEntries = bobObservations.filter((item) => !item || typeof item !== "object" || Array.isArray(item));
  if (malformedBobEntries.length > 0) supplementaryReasons.push("bob_observation_malformed_entry");
  const receiverRows = bobObservations.filter((item) => item && typeof item === "object" && !Array.isArray(item) && ["A", "B"].includes(item.id));
  const bobCompletedAt = safeTimestamp(bob.completedAt) === null ? Number.NaN : Date.parse(bob.completedAt);
  const lastBobObservationAt = bobObservations.reduce((latest, item) => {
    const observed = safeTimestamp(item?.observedAt) === null ? Number.NaN : Date.parse(item.observedAt);
    return Number.isFinite(observed) ? Math.max(latest, observed) : latest;
  }, Number.NEGATIVE_INFINITY);
  const queryAttempts = Array.isArray(bob.queryAttempts) ? bob.queryAttempts : [];
  const collection = validatePersistedCollectorEvidence({
    runId,
    runStartedAt: race.runStartedAt,
    expectedDeadline: race.reconciliationDeadline,
    expectedInvoices,
    startedAt: bob.startedAt,
    deadline: bob.deadline,
    completedAt: bob.completedAt,
    completionStatus: bob.completionStatus,
    queryAttempts,
    collectionSessions: bob.collectionSessions,
    observations: bob.observations,
  });
  if (
    bob.phase !== "final" || bob.runId !== runId || bob.reconciliationDeadline !== race.reconciliationDeadline ||
    bob.source !== "polar-n1-bob lncli lookupinvoice"
  ) reasons.push("bob_final_run_or_deadline_mismatch");
  if (!Number.isFinite(bobCompletedAt) || bobCompletedAt < lastBobObservationAt) supplementaryReasons.push("bob_completion_timestamp_missing_or_before_observation");
  if (!collection.valid) supplementaryReasons.push("bob_collector_completion_unverified", ...collection.issues);
  if (Array.isArray(bob.collectionIssues)) {
    supplementaryReasons.push(...bob.collectionIssues.filter((issue) =>
      issue === "collector_trailing_record_incomplete" || issue === "collector_journal_invalid"));
  }
  if (!collection.proofValid) reasons.push("bob_receiver_provenance_invalid");
  if (!controlledAttribution) reasons.push("receiver_same_second_attribution_not_controlled");
  const receiver = reconcileTwoInvoices({
    runId,
    expectedInvoices,
    bobObservations: receiverRows,
    barrierReleasedAt: race.barrierReleasedAt,
    reconciliationDeadline: race.reconciliationDeadline,
    dispatchedAtById: dispatchAtById,
    controlledAttribution,
    startingSpendableBudgetMsat: startingBudgetVerified ? startingBudget.remainingBudgetMsat : null,
  });
  reasons.push(...receiver.reasonCodes);
  const unpaidB = receiver.outcomes.find((outcome) => outcome.id === "B");
  if (unpaidB?.settled === false) {
    const bLifecycle = lifecycleRecords.filter((item) => item?.id === "B");
    const expiryMs = bLifecycle.length === 1 && Number.isSafeInteger(strictInteger(bLifecycle[0]?.expiresAtUnix))
      ? strictInteger(bLifecycle[0].expiresAtUnix) * 1_000
      : Number.NaN;
    const canceledObservationMs = safeTimestamp(unpaidB.latestObservedAt) === null ? Number.NaN : Date.parse(unpaidB.latestObservedAt);
    if (unpaidB.state !== "CANCELED" || !Number.isFinite(expiryMs) || !Number.isFinite(canceledObservationMs) || canceledObservationMs < expiryMs) {
      reasons.push("receiver_natural_expiry_not_observed_as_canceled");
    }
  }

  const nwcRecords = Array.isArray(race.nwcLookups) ? race.nwcLookups : [];
  const nwc = expectedInvoices.map((expected, index) => normalizeNwcHistory({
    runId,
    runStartedAt: race.runStartedAt,
    dispatchedAt: dispatchAtById[expected.id],
    expected,
    observations: nwcRecords,
    receiverOutcome: receiver.outcomes[index],
    barrierReleasedAt: race.barrierReleasedAt,
    reconciliationDeadline: race.reconciliationDeadline,
    receiverCompletedAt: bob.completedAt,
    finalLookupCompletedAt: race.finalNwcLookupCompletedAt,
  }));
  for (const item of nwc) supplementaryReasons.push(...item.reasonCodes);
  if (nwc.some((item) => !item.valid) || nwcRecords.some((item) => !expectedInvoices.some((expected) => expected.id === item?.id))) {
    supplementaryReasons.push("nwc_lookup_evidence_incomplete_or_contradictory");
  }

  for (const expected of expectedInvoices) {
    const attempt = attempts.find(([item]) => item?.id === expected.id)?.[0];
    if ((Array.isArray(attempt?.validationIssues) && attempt.validationIssues.length > 0) ||
        (attempt?.feesPaidMsat != null && strictInteger(attempt.feesPaidMsat) === null)) {
      supplementaryReasons.push("nwc_payment_capture_invalid");
    }
    const lookupRecords = nwcRecords.filter((item) => item?.id === expected.id && item?.evidenceType !== "not_found");
    for (const lookup of lookupRecords) {
      if (attempt?.feesPaidMsat != null && lookup?.feesPaidMsat != null && strictInteger(attempt.feesPaidMsat) !== strictInteger(lookup.feesPaidMsat)) {
        supplementaryReasons.push("nwc_fee_source_contradiction");
      }
    }
  }

  const postBudget = normalizeBudgetMsat(race.budgetAfter);
  const postBudgetPresent = race.budgetAfter !== null && race.budgetAfter !== undefined;
  const postBudgetMissingOnly = postBudget.issues.length > 0 && postBudget.issues.every((issue) => /^budget_(total|used|remaining)_missing$/.test(issue));
  const postCapture = postBudgetPresent ? validateCapturedBudget(race.budgetAfter, { kind: "final", runId }) : null;
  let postBudgetContradictory = postBudgetPresent && (postCapture?.issues.length > 0 || postBudget.issues.some((issue) => !/^budget_(total|used|remaining)_missing$/.test(issue)));

  const invariant = classifyInvariant({
    startingSpendableBudgetMsat: startingBudgetVerified ? startingBudget.remainingBudgetMsat : null,
    outcomes: receiver.outcomes,
  });
  const confirmedSettledPrincipalMsat = sumConfirmedSettledPrincipalMsat(receiver.outcomes);
  const settledPrincipalMsat = invariant.totalSettledPrincipalSats === null ? null : invariant.totalSettledPrincipalSats * 1_000;
  const settledAttemptFeesMsat = receiver.outcomes.filter((outcome) => outcome.settled === true).map((outcome) => {
    const attempt = attempts.find(([item]) => item?.id === outcome.id)?.[0];
    return strictInteger(attempt?.feesPaidMsat);
  });
  const finalBudgetTime = safeTimestamp(race.budgetAfter?.observedAt) === null ? Number.NaN : Date.parse(race.budgetAfter.observedAt);
  const bobCompleteTime = Number.isFinite(bobCompletedAt) ? bobCompletedAt : Number.NaN;
  const finalNwcTime = safeTimestamp(race.finalNwcLookupCompletedAt) === null ? Number.NaN : Date.parse(race.finalNwcLookupCompletedAt);
  if (!Number.isFinite(finalNwcTime) || finalNwcTime < bobCompleteTime) supplementaryReasons.push("final_nwc_lookup_completion_missing_or_stale");
  let postAccountingConsistent = false;
  if (postCapture && postCapture.valid && startingBudgetVerified && Number.isFinite(finalBudgetTime) && finalBudgetTime >= bobCompleteTime && finalBudgetTime >= finalNwcTime) {
    const authoritativeFees = receiver.outcomes.filter((outcome) => outcome.settled === true).map((outcome) => {
      const attempt = attempts.find(([item]) => item?.id === outcome.id)?.[0];
      const latestLookup = nwc.find((item) => item.id === outcome.id)?.latest;
      const paymentFee = strictInteger(attempt?.feesPaidMsat);
      const lookupFee = strictInteger(latestLookup?.feesPaidMsat);
      if (paymentFee !== null && lookupFee !== null && paymentFee !== lookupFee) return null;
      return paymentFee ?? lookupFee;
    });
    const feesKnown = authoritativeFees.every((fee) => fee !== null);
    const expectedUsedMsat = settledPrincipalMsat === null || !feesKnown ? null : settledPrincipalMsat + authoritativeFees.reduce((sum, fee) => sum + fee, 0);
    postAccountingConsistent = postBudget.totalBudgetMsat === startingBudget.totalBudgetMsat &&
      postBudget.renewalPeriod === startingBudget.renewalPeriod && expectedUsedMsat !== null &&
      postBudget.usedBudgetMsat === expectedUsedMsat &&
      postBudget.remainingBudgetMsat === postBudget.totalBudgetMsat - postBudget.usedBudgetMsat;
  }
  if (postBudgetPresent && startingBudgetVerified && !postAccountingConsistent) postBudgetContradictory = true;
  const extra = [];
  if (!postBudgetPresent) extra.push("post_race_budget_supplementary_missing");
  else if (!postBudget.complete || postBudgetMissingOnly) extra.push("post_race_budget_supplementary_incomplete");
  if (postBudgetContradictory) {
    const postBudgetIssueCodes = [...new Set([...postBudget.issues, ...(postCapture?.issues ?? [])])]
      .filter((issue) => typeof issue === "string");
    extra.push(...postBudgetIssueCodes.map((issue) => `post_race_${issue}`));
  }
  if (postBudgetPresent && !postAccountingConsistent) extra.push("post_race_budget_settlement_accounting_unresolved");
  const proofReasons = [...new Set(reasons)];
  const supplementary = [...new Set([...supplementaryReasons, ...extra])];
  const independentlyProvenFail = startingBudgetVerified && invariant.classification === "FAIL" &&
    proofReasons.length === 0 && collection.proofValid === true;
  let classification = independentlyProvenFail ? "FAIL" : invariant.classification;
  if (!independentlyProvenFail && (proofReasons.length > 0 || supplementary.length > 0)) classification = "INCONCLUSIVE";
  return {
    classification,
    totalSettledPrincipalSats: invariant.totalSettledPrincipalSats,
    totalSettledPrincipalMsat: invariant.totalSettledPrincipalMsat,
    invariantHolds: startingBudgetVerified ? invariant.invariantHolds : null,
    startingBudgetVerified,
    startingSpendableBudgetMsat: startingBudgetVerified ? startingBudget.remainingBudgetMsat : null,
    confirmedSettledPrincipalMsat,
    receiverOutcomes: receiver.outcomes,
    nwcOutcomes: nwc,
    postBudget: {
      present: postBudgetPresent,
      valid: postBudgetPresent && postCapture?.valid === true && postBudget.valid && postBudget.complete,
      accountingConsistent: postAccountingConsistent,
      totalBudgetMsat: postBudgetPresent ? postBudget.totalBudgetMsat : null,
      usedBudgetMsat: postBudgetPresent ? postBudget.usedBudgetMsat : null,
      remainingBudgetMsat: postBudgetPresent ? postBudget.remainingBudgetMsat : null,
      renewalPeriod: postBudgetPresent ? postBudget.renewalPeriod : null,
      issues: postBudgetPresent ? [...new Set([...postBudget.issues, ...(postCapture?.issues ?? [])])].sort() : ["post_race_budget_missing"],
    },
    reasonCodes: [...new Set([...proofReasons, ...supplementary])].sort(),
    missingOrInvalid: [...new Set([...proofReasons, ...supplementary])].sort(),
    proofReasonCodes: proofReasons.sort(),
    supplementaryReasonCodes: supplementary.sort(),
    collectorValidation: collection,
  };
}

export function sumSettledPrincipalSats(outcomes) {
  if (!Array.isArray(outcomes)) return null;
  let sum = 0;
  for (const outcome of outcomes) {
    if (outcome?.reconciled !== true || outcome?.terminal !== true || typeof outcome?.settled !== "boolean") return null;
    const amount = strictInteger(outcome.amountPaidSat);
    const amountMsat = strictInteger(outcome.amountPaidMsat);
    if (amount === null || amountMsat === null || amountMsat !== amount * 1_000 ||
      (outcome.settled && amount === 0) || (!outcome.settled && amount !== 0)) return null;
    if (outcome.settled) sum += amount;
  }
  return Number.isSafeInteger(sum) ? sum : null;
}

/** Sum only receiver settlements that are independently terminally confirmed. */
export function sumConfirmedSettledPrincipalMsat(outcomes) {
  if (!Array.isArray(outcomes)) return null;
  let sum = 0;
  let confirmedCount = 0;
  for (const outcome of outcomes) {
    if (outcome?.reconciled !== true || outcome?.terminal !== true) continue;
    const amountSat = strictInteger(outcome.amountPaidSat);
    const amountMsat = strictInteger(outcome.amountPaidMsat);
    if (typeof outcome.settled !== "boolean" || amountSat === null ||
      amountMsat === null || amountMsat !== amountSat * 1_000 ||
      (outcome.settled && amountSat === 0) || (!outcome.settled && amountSat !== 0)) return null;
    confirmedCount += 1;
    if (outcome.settled) sum += amountMsat;
  }
  return confirmedCount > 0 && Number.isSafeInteger(sum) ? sum : null;
}
