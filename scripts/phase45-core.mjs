import { performance } from "node:perf_hooks";

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
const NWC_STATES = new Set([...RECEIVER_STATES, "NOT_FOUND"]);
const HASH_RE = /^[0-9a-f]{64}$/i;
const RUN_ID_RE = /^[A-Za-z0-9-]{1,80}$/;

export const RECONCILIATION_WINDOW_MS = 90_000;
export const RECONCILIATION_POLL_INTERVAL_MS = 2_000;
const FINAL_NWC_LOOKUP_GRACE_MS = 30_000;

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
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : null;
}

function safeHash(value) {
  return typeof value === "string" && HASH_RE.test(value) ? value.toLowerCase() : null;
}

function normalizeHashAliases(source, keys) {
  const present = keys.filter((key) => Object.hasOwn(source ?? {}, key));
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
  #armed;
  #released;

  constructor() {
    this.#armed = new Promise((resolve) => { this.#resolveArmed = resolve; });
    this.#released = new Promise((resolve) => { this.#resolveRelease = resolve; });
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
      const fee = strictInteger(response?.fees_paid ?? response?.fees_paid_msat ?? response?.feesPaidMsat);
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
        feesPaidMsat: fee,
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
      };
    }
  });

  await barrier.waitUntilArmed();
  beforeRelease();
  const barrierReleasedAt = safeTimestamp(wallClock());
  releasedMonotonicMs = monotonicClock();
  barrier.release(barrierReleasedAt);
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
  const present = keys.filter((key) => Object.hasOwn(source ?? {}, key));
  if (present.length === 0) return { value: null, issue: null };
  const values = present.map((key) => strictInteger(source[key], { allowNegative }));
  if (values.some((value) => value === null)) return { value: null, issue: "invalid_budget_number" };
  if (new Set(values).size !== 1) return { value: null, issue: "conflicting_budget_aliases" };
  return { value: values[0], issue: null };
}

/** Accept only budget field names that explicitly declare the millisatoshi unit. */
export function normalizeBudgetMsat(budget) {
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    return {
      totalBudgetMsat: null, usedBudgetMsat: null, remainingBudgetMsat: null,
      renewalPeriod: null, valid: false, complete: false, issues: ["budget_missing_or_invalid"],
    };
  }
  const unitlessBudgetKeys = ["total_budget", "used_budget", "remaining_budget"];
  const issues = unitlessBudgetKeys.some((key) => Object.hasOwn(budget, key)) ? ["budget_unit_unspecified"] : [];
  const total = normalizeAliases(budget, ["total_budget_msats", "total_budget_msat", "totalBudgetMsat", "totalBudgetMsats"]);
  const used = normalizeAliases(budget, ["used_budget_msats", "used_budget_msat", "usedBudgetMsat", "usedBudgetMsats"]);
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

  const renewalKeys = ["renewal_period", "renewalPeriod"].filter((key) => Object.hasOwn(budget, key));
  const renewalValues = renewalKeys.map((key) => budget[key]);
  const renewalPeriod = renewalValues.length && renewalValues.every((value) => value === "never") && new Set(renewalValues).size === 1
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

export function sanitizeReceiverObservation({ runId, id, requestedHash, expectedAmountSat, lookup, observedAt = new Date().toISOString() }) {
  const raw = lookup && typeof lookup === "object" && !Array.isArray(lookup) ? lookup : {};
  const state = safeState(raw.state, RECEIVER_STATES);
  const paid = normalizeAliases(raw, ["amt_paid_sat", "amountPaidSat"]);
  const settledDate = strictInteger(raw.settle_date ?? raw.settleDateUnix);
  return {
    runId: typeof runId === "string" && RUN_ID_RE.test(runId) ? runId : null,
    id: id === "A" || id === "B" ? id : null,
    requestedHash: safeHash(requestedHash),
    returnedHash: normalizeHashAliases(raw, ["r_hash", "payment_hash", "paymentHash"]),
    expectedAmountSat: strictInteger(expectedAmountSat),
    state,
    settled: typeof raw.settled === "boolean" ? raw.settled : null,
    amountPaidSat: paid.value,
    settleDateUnix: settledDate,
    settledAt: safeEpochSeconds(settledDate),
    observedAt: safeTimestamp(observedAt),
    errorCode: null,
  };
}

export function sanitizeNwcLookup({ runId, id, requestedHash, expectedAmountSat, lookup, error, observedAt = new Date().toISOString() }) {
  const raw = lookup && typeof lookup === "object" && !Array.isArray(lookup) ? lookup : {};
  const amount = normalizeAliases(raw, ["amount", "amount_msat", "amountMsat"]);
  const fee = normalizeAliases(raw, ["fees_paid", "fees_paid_msat", "feesPaidMsat"]);
  const settledAtValue = strictInteger(raw.settled_at ?? raw.settledAtUnix);
  return {
    runId: typeof runId === "string" && RUN_ID_RE.test(runId) ? runId : null,
    id: id === "A" || id === "B" ? id : null,
    requestedHash: safeHash(requestedHash),
    returnedHash: normalizeHashAliases(raw, ["payment_hash", "paymentHash"]),
    expectedAmountSat: strictInteger(expectedAmountSat),
    lookupState: safeState(raw.state, NWC_STATES),
    amountMsat: amount.value,
    feesPaidMsat: fee.value,
    settledAt: safeEpochSeconds(settledAtValue),
    observedAt: safeTimestamp(observedAt),
    errorCode: error ? safeErrorCode(error) : null,
  };
}

export function validateInitialObservations({ runId, expectedInvoices, observations, beforeAt }) {
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
    const at = safeTimestamp(item?.observedAt) === null ? Number.NaN : Date.parse(item.observedAt);
    if (
      item?.runId !== runId || item?.requestedHash !== hash || item?.returnedHash !== hash ||
      item?.expectedAmountSat !== strictInteger(invoice?.amountSat) || item?.state !== "OPEN" ||
      item?.settled !== false || item?.amountPaidSat !== 0 || !Number.isFinite(at) || at >= beforeMs
    ) reasons.push("initial_receiver_observation_stale_or_mismatched");
  }
  if (records.length !== 2) reasons.push("initial_receiver_observation_count_invalid");
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
}

function normalizeReceiverObservationHistory({ runId, expected, observations, barrierReleasedAt, reconciliationDeadline }) {
  const id = expected.id;
  const hash = safeHash(expected.paymentHash);
  const amountSat = strictInteger(expected.amountSat);
  const releaseMs = safeTimestamp(barrierReleasedAt) === null ? Number.NaN : Date.parse(barrierReleasedAt);
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
      strictInteger(item?.amountPaidSat) === null || !Number.isFinite(observedMs) ||
      observedMs < releaseMs || observedMs > deadlineMs + deadlineGraceMs
    ) reasons.push("receiver_observation_mismatched_or_out_of_window");
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
    if (state === "SETTLED" && (item?.settled !== true || paid !== amountSat)) reasons.push("receiver_settlement_amount_or_flag_mismatch");
    if (["CANCELED", "EXPIRED"].includes(state) && (item?.settled !== false || paid !== 0)) reasons.push("receiver_terminal_unpaid_evidence_invalid");
    if (["OPEN", "ACCEPTED", "PENDING"].includes(state) && (item?.settled !== false || paid !== 0)) reasons.push("receiver_pending_evidence_invalid");
    if (state === "SETTLED" && item?.settleDateUnix !== null) {
      const settleSec = strictInteger(item?.settleDateUnix);
      if (settleSec === null || settleSec <= Math.floor(releaseMs / 1_000) || settleSec * 1_000 > entry.observedMs + 1_000) {
        reasons.push("receiver_settlement_time_out_of_chronology");
      }
    }
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
      settleDateUnix: reconciled && settled ? strictInteger(latest.item.settleDateUnix) : null,
      settledAt: reconciled && settled ? safeTimestamp(latest.item.settledAt) : null,
      latestObservedAt: latest?.item?.observedAt ?? null,
      observationCount: records.length,
      reasonCodes: [...new Set(reasons)].sort(),
    },
    reasons,
  };
}

export function reconcileTwoInvoices({ runId, expectedInvoices, bobObservations, barrierReleasedAt, reconciliationDeadline, startingSpendableBudgetMsat, startingSpendableBudgetSats }) {
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

function normalizeNwcHistory({ runId, expected, observations, receiverOutcome, barrierReleasedAt, reconciliationDeadline }) {
  const records = (Array.isArray(observations) ? observations : []).filter((item) => item?.id === expected.id);
  const reasons = [];
  if (records.length === 0) reasons.push("nwc_lookup_missing");
  const hash = safeHash(expected.paymentHash);
  const expectedAmountSat = strictInteger(expected.amountSat);
  const releaseMs = safeTimestamp(barrierReleasedAt) === null ? Number.NaN : Date.parse(barrierReleasedAt);
  const deadlineMs = safeTimestamp(reconciliationDeadline) === null ? Number.NaN : Date.parse(reconciliationDeadline);
  const deadlineGraceMs = FINAL_NWC_LOOKUP_GRACE_MS;
  const normalized = records.map((item) => {
    const state = safeState(item?.lookupState, NWC_STATES);
    const observedMs = safeTimestamp(item?.observedAt) === null ? Number.NaN : Date.parse(item.observedAt);
    const amountMsat = strictInteger(item?.amountMsat);
    if (item?.runId !== runId || item?.requestedHash !== hash || item?.expectedAmountSat !== expectedAmountSat) {
      reasons.push("nwc_lookup_run_or_request_binding_mismatch");
    }
    if (item?.returnedHash != null && item.returnedHash !== hash) reasons.push("nwc_lookup_returned_hash_mismatch");
    if (!Number.isFinite(observedMs) || observedMs < releaseMs || observedMs > deadlineMs + deadlineGraceMs) {
      reasons.push("nwc_lookup_out_of_window");
    }
    if (state && amountMsat !== null && amountMsat !== expectedAmountSat * 1_000) reasons.push("nwc_lookup_amount_mismatch");
    if (item?.feesPaidMsat != null && strictInteger(item?.feesPaidMsat) === null) reasons.push("nwc_fee_invalid");
    return { item, state, amountMsat, observedMs };
  }).sort((a, b) => a.observedMs - b.observedMs);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].observedMs === normalized[index].observedMs) reasons.push("duplicate_nwc_lookup_timestamp");
    if (normalized[index - 1].state === "SETTLED" && normalized[index].state && normalized[index].state !== "SETTLED") {
      reasons.push("nwc_settlement_state_contradiction");
    }
  }
  const latest = normalized.at(-1);
  const receiverObservedAt = safeTimestamp(receiverOutcome?.latestObservedAt) === null ? Number.NaN : Date.parse(receiverOutcome.latestObservedAt);
  if (
    !latest || !latest.state || latest.item?.errorCode != null || latest.item?.returnedHash !== hash ||
    latest.amountMsat !== expectedAmountSat * 1_000 || !Number.isFinite(latest.observedMs)
  ) {
    reasons.push("nwc_final_lookup_incomplete");
  }
  if (latest && Number.isFinite(receiverObservedAt) && latest.observedMs < receiverObservedAt) {
    reasons.push("nwc_lookup_stale_for_final_receiver_observation");
  }
  if (latest && receiverOutcome?.reconciled) {
    const receiverTerminalState = receiverOutcome.state;
    if (receiverOutcome.settled === true && latest.state !== "SETTLED") reasons.push("nwc_receiver_settlement_contradiction");
    if (receiverOutcome.settled === false && !["CANCELED", "EXPIRED"].includes(latest.state)) reasons.push("nwc_receiver_terminal_unpaid_contradiction");
    if (receiverOutcome.settled === false && receiverTerminalState === "CANCELED" && latest.state === "EXPIRED") reasons.push("nwc_receiver_terminal_state_mismatch");
  } else if (latest?.state === "SETTLED" && receiverOutcome?.state !== "SETTLED") {
    reasons.push("nwc_settlement_not_confirmed_by_receiver");
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
    if (outcome?.reconciled !== true || outcome?.terminal !== true || typeof outcome?.settled !== "boolean" || amount === null) return false;
    return outcome.settled ? amount > 0 : amount === 0;
  });
  const totalSettledPrincipalSats = validOutcomes
    ? outcomes.reduce((sum, outcome) => sum + (outcome.settled ? strictInteger(outcome.amountPaidSat) : 0), 0)
    : null;
  if (!validOutcomes) {
    return {
      classification: "INCONCLUSIVE",
      totalSettledPrincipalSats: null,
      invariantHolds: null,
      reason: "independent_settlement_evidence_incomplete",
    };
  }
  if (budgetMsat === null) {
    return {
      classification: "INCONCLUSIVE",
      totalSettledPrincipalSats,
      invariantHolds: null,
      reason: "starting_spendable_budget_unverified",
    };
  }
  const totalMsat = totalSettledPrincipalSats * 1_000;
  const invariantHolds = totalMsat <= budgetMsat;
  return {
    classification: invariantHolds ? "PASS" : "FAIL",
    totalSettledPrincipalSats,
    invariantHolds,
    reason: invariantHolds ? "settled_principal_within_starting_budget" : "settled_principal_exceeds_starting_budget",
  };
}

export function evaluateRunEvidence({ raceEvidence, bobEvidence } = {}) {
  const race = raceEvidence && typeof raceEvidence === "object" ? raceEvidence : {};
  const bob = bobEvidence && typeof bobEvidence === "object" ? bobEvidence : {};
  const reasons = [];
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
  if (attemptRecords.some((item, index) => item?.runId !== runId || item?.paymentHash !== item?.requestedHash || item?.expectedAmountSat !== 700)) {
    reasons.push("dispatched_attempt_run_or_hash_mismatch");
  }
  if (attempts.some(([item]) => !item || !["success", "error"].includes(item.result))) reasons.push("nwc_payment_result_missing");

  const initialCheck = validateInitialObservations({
    runId,
    expectedInvoices,
    observations: race.initialBobObservations,
    beforeAt: race.startingBudget?.capturedAt,
  });
  reasons.push(...initialCheck.reasons);

  const preparedAt = safeTimestamp(race.requestsPreparedAt) === null ? Number.NaN : Date.parse(race.requestsPreparedAt);
  const budgetAt = safeTimestamp(race.startingBudget?.capturedAt) === null ? Number.NaN : Date.parse(race.startingBudget.capturedAt);
  const barrierAt = safeTimestamp(race.barrierReleasedAt) === null ? Number.NaN : Date.parse(race.barrierReleasedAt);
  const deadlineAt = safeTimestamp(race.reconciliationDeadline) === null ? Number.NaN : Date.parse(race.reconciliationDeadline);
  const releaseMono = race.barrierReleaseMonotonicMs;
  const attemptA = attempts[0]?.[0];
  const attemptB = attempts[1]?.[0];
  const timingValid =
    race.dispatchTimingBoundary === "nwc_client_call_start" &&
    Number.isFinite(preparedAt) && Number.isFinite(budgetAt) && Number.isFinite(barrierAt) && Number.isFinite(deadlineAt) &&
    budgetAt < preparedAt && preparedAt <= barrierAt && deadlineAt > barrierAt &&
    typeof releaseMono === "number" && Number.isFinite(releaseMono) &&
    [attemptA, attemptB].every((attempt) => {
      const dispatchedAt = safeTimestamp(attempt?.dispatchedAt) === null ? Number.NaN : Date.parse(attempt.dispatchedAt);
      const responseAt = safeTimestamp(attempt?.responseAt) === null ? Number.NaN : Date.parse(attempt.responseAt);
      return attempt?.barrierReleasedAt === race.barrierReleasedAt && Number.isFinite(dispatchedAt) && Number.isFinite(responseAt) &&
        dispatchedAt >= barrierAt && responseAt >= dispatchedAt &&
        typeof attempt?.dispatchMonotonicMs === "number" && Number.isFinite(attempt.dispatchMonotonicMs) && attempt.dispatchMonotonicMs >= releaseMono &&
        typeof attempt?.responseMonotonicMs === "number" && Number.isFinite(attempt.responseMonotonicMs) && attempt.responseMonotonicMs >= attempt.dispatchMonotonicMs;
    });
  let delta = null;
  let overlap = false;
  if (attemptA && attemptB && typeof attemptA.dispatchMonotonicMs === "number" && typeof attemptB.dispatchMonotonicMs === "number") {
    delta = Number(Math.abs(attemptA.dispatchMonotonicMs - attemptB.dispatchMonotonicMs).toFixed(3));
    const firstResponse = Math.min(attemptA.responseMonotonicMs, attemptB.responseMonotonicMs);
    overlap = Math.max(attemptA.dispatchMonotonicMs, attemptB.dispatchMonotonicMs) < firstResponse;
  }
  if (!timingValid || !overlap || typeof race.dispatchDeltaMs !== "number" || race.dispatchDeltaMs !== delta) reasons.push("dispatch_timing_invalid_or_serialized");

  const startingBudget = normalizeBudgetMsat(race.startingBudget);
  if (race.startingBudget?.runId !== runId) reasons.push("starting_budget_run_id_mismatch");
  const startingBudgetVerified = startingBudget.valid && startingBudget.complete &&
    startingBudget.totalBudgetMsat === 1_000_000 && startingBudget.usedBudgetMsat === 0 &&
    startingBudget.remainingBudgetMsat === 1_000_000 && startingBudget.renewalPeriod === "never";
  if (!startingBudgetVerified) reasons.push("starting_budget_unverified_or_contradictory");

  const bobObservations = Array.isArray(bob.observations) ? bob.observations : [];
  const bobCompletedAt = safeTimestamp(bob.completedAt) === null ? Number.NaN : Date.parse(bob.completedAt);
  const lastBobObservationAt = bobObservations.reduce((latest, item) => {
    const observed = safeTimestamp(item?.observedAt) === null ? Number.NaN : Date.parse(item.observedAt);
    return Number.isFinite(observed) ? Math.max(latest, observed) : latest;
  }, Number.NEGATIVE_INFINITY);
  if (
    bob.phase !== "final" || bob.runId !== runId || bob.reconciliationDeadline !== race.reconciliationDeadline ||
    bob.source !== "polar-n1-bob lncli lookupinvoice" || !Number.isFinite(bobCompletedAt) || bobCompletedAt < lastBobObservationAt
  ) reasons.push("bob_final_run_or_deadline_mismatch");
  const receiver = reconcileTwoInvoices({
    runId,
    expectedInvoices,
    bobObservations,
    barrierReleasedAt: race.barrierReleasedAt,
    reconciliationDeadline: race.reconciliationDeadline,
    startingSpendableBudgetMsat: startingBudgetVerified ? startingBudget.remainingBudgetMsat : null,
  });
  reasons.push(...receiver.reasonCodes);

  const nwcRecords = Array.isArray(race.nwcLookups) ? race.nwcLookups : [];
  const nwc = expectedInvoices.map((expected, index) => normalizeNwcHistory({
    runId,
    expected,
    observations: nwcRecords,
    receiverOutcome: receiver.outcomes[index],
    barrierReleasedAt: race.barrierReleasedAt,
    reconciliationDeadline: race.reconciliationDeadline,
  }));
  for (const item of nwc) reasons.push(...item.reasonCodes);
  if (nwc.some((item) => !item.valid) || nwcRecords.some((item) => !expectedInvoices.some((expected) => expected.id === item?.id))) {
    reasons.push("nwc_lookup_evidence_incomplete_or_contradictory");
  }

  const postBudget = normalizeBudgetMsat(race.budgetAfter);
  const postBudgetPresent = race.budgetAfter !== null && race.budgetAfter !== undefined;
  const postBudgetMissingOnly = postBudget.issues.length > 0 && postBudget.issues.every((issue) => /^budget_(total|used|remaining)_missing$/.test(issue));
  const postBudgetContradictory = postBudgetPresent && postBudget.issues.some((issue) => !/^budget_(total|used|remaining)_missing$/.test(issue));

  const invariant = classifyInvariant({
    startingSpendableBudgetMsat: startingBudgetVerified ? startingBudget.remainingBudgetMsat : null,
    outcomes: receiver.outcomes,
  });
  const blockingReasons = [...new Set(reasons)].filter((reason) => reason !== "post_race_budget_supplementary_missing_or_contradictory");
  const extra = [];
  if (!postBudgetPresent) extra.push("post_race_budget_supplementary_missing");
  else if (!postBudget.complete || postBudgetMissingOnly) extra.push("post_race_budget_supplementary_incomplete");
  if (postBudgetContradictory) extra.push(...postBudget.issues.map((issue) => `post_race_${issue}`));
  let classification = invariant.classification;
  if (blockingReasons.length > 0) classification = "INCONCLUSIVE";
  else if (classification !== "FAIL" && postBudgetContradictory) classification = "INCONCLUSIVE";
  return {
    classification,
    totalSettledPrincipalSats: invariant.totalSettledPrincipalSats,
    invariantHolds: startingBudgetVerified ? invariant.invariantHolds : null,
    startingBudgetVerified,
    startingSpendableBudgetMsat: startingBudgetVerified ? startingBudget.remainingBudgetMsat : null,
    receiverOutcomes: receiver.outcomes,
    nwcOutcomes: nwc,
    postBudget: {
      present: postBudgetPresent,
      valid: postBudgetPresent && postBudget.valid && postBudget.complete,
      totalBudgetMsat: postBudgetPresent ? postBudget.totalBudgetMsat : null,
      usedBudgetMsat: postBudgetPresent ? postBudget.usedBudgetMsat : null,
      remainingBudgetMsat: postBudgetPresent ? postBudget.remainingBudgetMsat : null,
      renewalPeriod: postBudgetPresent ? postBudget.renewalPeriod : null,
      issues: postBudgetPresent ? postBudget.issues : ["post_race_budget_missing"],
    },
    reasonCodes: [...new Set([...blockingReasons, ...extra])].sort(),
    missingOrInvalid: [...new Set([...blockingReasons, ...extra])].sort(),
  };
}

export function sumSettledPrincipalSats(outcomes) {
  if (!Array.isArray(outcomes)) return null;
  let sum = 0;
  for (const outcome of outcomes) {
    if (outcome?.reconciled !== true || outcome?.terminal !== true || typeof outcome?.settled !== "boolean") return null;
    const amount = strictInteger(outcome.amountPaidSat);
    if (amount === null || (outcome.settled && amount === 0) || (!outcome.settled && amount !== 0)) return null;
    if (outcome.settled) sum += amount;
  }
  return Number.isSafeInteger(sum) ? sum : null;
}
