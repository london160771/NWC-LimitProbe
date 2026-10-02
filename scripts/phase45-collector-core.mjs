import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const COMPLETION = new Set(["completed_deadline", "completed_terminal", "interrupted", "collector_error", "query_timeout"]);
const TERMINAL = new Set(["SETTLED", "CANCELED", "EXPIRED"]);

function isoMs(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : Number.NaN;
}

export function parseCollectorJournal(text) {
  if (typeof text !== "string") return { events: [], issues: ["collector_journal_invalid"] };
  const terminated = /\r?\n$/.test(text);
  const rows = text.split(/\r?\n/);
  if (terminated) rows.pop();
  const events = [];
  const issues = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    try {
      if (row.length === 0) throw new SyntaxError("empty_collector_record");
      events.push(JSON.parse(row));
    } catch (error) {
      const isFinalUnterminatedRow = !terminated && index === rows.length - 1;
      const message = typeof error?.message === "string" ? error.message : "";
      const position = / at position (\d+)/.exec(message);
      const isIncompleteTail = isFinalUnterminatedRow && (
        /Unterminated string|Unexpected end of JSON input/.test(message) ||
        (position !== null && Number(position[1]) >= row.length)
      );
      issues.push(isIncompleteTail ? "collector_trailing_record_incomplete" : "collector_journal_invalid");
      break;
    }
  }
  return { events, issues };
}

export function appendCollectorEvent(path, event) {
  if (!existsSync(path)) writeFileSync(path, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Validate the persisted, sanitized collector projection without trusting its issue summary. */
export function validatePersistedCollectorEvidence({
  runId, runStartedAt, expectedDeadline, expectedInvoices, startedAt, deadline, completedAt, completionStatus,
  queryAttempts = [], collectionSessions = [], observations = [],
}) {
  const issues = [];
  const proofInvalidIds = new Set();
  const expected = new Map((Array.isArray(expectedInvoices) ? expectedInvoices : []).map((item) => [item?.id, item]));
  const starts = new Map();
  const completions = new Map();
  const sessionIds = new Set();
  const sessions = Array.isArray(collectionSessions) ? collectionSessions : [];
  const receiverObservations = Array.isArray(observations) ? observations : [];
  if (!Array.isArray(observations)) issues.push("collector_observation_container_invalid");
  const runStartMs = isoMs(runStartedAt);
  const authoritativeDeadlineMs = isoMs(expectedDeadline);
  if (!Number.isFinite(runStartMs)) issues.push("collector_run_start_missing");
  for (const event of sessions) {
    if (!event || !/^[0-9a-f-]{36}$/i.test(event.sessionId ?? "") || event.runId !== runId ||
        !["collector_started", "collector_completed"].includes(event.recordType)) {
      issues.push("collector_session_binding_invalid");
      continue;
    }
    sessionIds.add(event.sessionId);
    if (event.recordType === "collector_started") {
      if (starts.has(event.sessionId)) issues.push("collector_session_duplicate_start");
      starts.set(event.sessionId, event);
    } else {
      if (completions.has(event.sessionId)) issues.push("collector_session_duplicate_completion");
      completions.set(event.sessionId, event);
    }
  }
  if (sessionIds.size === 0 || starts.size === 0) issues.push("collector_session_history_missing");
  for (const [sessionId, completion] of completions) {
    if (!starts.has(sessionId)) issues.push("collector_completion_without_start");
    if (!COMPLETION.has(completion.completionStatus)) issues.push("collector_completion_status_invalid");
  }
  const sessionBounds = new Map();
  for (const [sessionId, start] of starts) {
    const startMs = isoMs(start.startedAt);
    const deadlineMs = isoMs(start.deadline);
    const end = completions.get(sessionId);
    const endMs = end ? isoMs(end.completedAt) : Number.POSITIVE_INFINITY;
    const validStart = start.runId === runId && Number.isFinite(startMs) && Number.isFinite(deadlineMs) && deadlineMs > startMs &&
      Number.isFinite(runStartMs) && startMs >= runStartMs;
    if (!validStart || (end && (end.runId !== runId || end.deadline !== start.deadline || !Number.isFinite(endMs) || endMs < startMs))) {
      issues.push("collector_session_chronology_invalid");
    }
    if (Number.isFinite(authoritativeDeadlineMs) && deadlineMs !== authoritativeDeadlineMs) issues.push("collector_deadline_mismatch");
    if (!end) issues.push("collector_completion_missing");
    sessionBounds.set(sessionId, { startMs, deadlineMs, endMs, completion: end, validStart });
  }
  if (expected.size !== 2 || !["A", "B"].every((id) => /^[0-9a-f]{64}$/i.test(expected.get(id)?.paymentHash ?? "") && expected.get(id)?.amountSat === 700)) {
    issues.push("collector_expected_invoice_binding_invalid");
    proofInvalidIds.add("*");
  }
  const queryBySession = new Map();
  for (const query of Array.isArray(queryAttempts) ? queryAttempts : []) {
    const bounds = sessionBounds.get(query?.sessionId);
    const expectedInvoice = expected.get(query?.id);
    const attemptedMs = isoMs(query?.attemptedAt);
    const completedQueryMs = isoMs(query?.completedAt);
    if (!bounds || query?.runId !== runId || !expectedInvoice || query.requestedHash !== expectedInvoice.paymentHash ||
        !Number.isFinite(attemptedMs) || !Number.isFinite(completedQueryMs) || completedQueryMs < attemptedMs ||
        attemptedMs < bounds.startMs ||
        !["success", "query_timeout", "collector_error"].includes(query.status) ||
        (query.status === "success" ? query.errorCode != null : !["TIMEOUT", "OTHER"].includes(query.errorCode))) {
      issues.push("collector_query_chronology_or_binding_invalid");
      if (expectedInvoice) proofInvalidIds.add(query.id);
      continue;
    }
    if (!bounds.validStart) proofInvalidIds.add(query.id);
    if (bounds.completion && completedQueryMs > bounds.endMs) issues.push("collector_query_after_session_completion");
    const key = `${query.sessionId}:${query.id}`;
    const values = queryBySession.get(key) ?? [];
    values.push(query);
    queryBySession.set(key, values);
  }
  const validObservationsById = new Map([["A", []], ["B", []]]);
  for (const observation of receiverObservations) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      issues.push("collector_observation_malformed_entry");
      continue;
    }
    const bounds = sessionBounds.get(observation?.sessionId);
    const expectedInvoice = expected.get(observation?.id);
    const observedMs = isoMs(observation?.observedAt);
    const matchingQueries = (queryBySession.get(`${observation?.sessionId}:${observation?.id}`) ?? []).filter((query) =>
      query.status === "success" && Date.parse(query.attemptedAt) <= observedMs && Date.parse(query.completedAt) >= observedMs);
    const observationValid = Boolean(bounds?.validStart && expectedInvoice && observation?.runId === runId &&
      observation.requestedHash === expectedInvoice.paymentHash && observation.returnedHash === expectedInvoice.paymentHash &&
      observation.expectedAmountSat === expectedInvoice.amountSat && Number.isFinite(observedMs) &&
      observedMs >= bounds.startMs && matchingQueries.length === 1);
    if (!observationValid) {
      issues.push("collector_observation_chronology_or_binding_invalid");
      if (expectedInvoice) proofInvalidIds.add(observation.id);
      continue;
    }
    if (bounds.completion && observedMs > bounds.endMs) issues.push("collector_observation_after_session_completion");
    validObservationsById.get(observation.id).push(observation);
  }
  const latestStart = [...starts.entries()].sort((a, b) => isoMs(a[1].startedAt) - isoMs(b[1].startedAt)).at(-1);
  const latestSessionId = latestStart?.[0] ?? null;
  const topStartMs = isoMs(startedAt);
  const topDeadlineMs = isoMs(deadline);
  const topCompletedMs = isoMs(completedAt);
  const statusAllowed = COMPLETION.has(completionStatus);
  if (!latestSessionId || !Number.isFinite(topStartMs) || !Number.isFinite(topDeadlineMs) || deadline !== latestStart?.[1]?.deadline ||
      startedAt !== latestStart?.[1]?.startedAt || !statusAllowed) issues.push("collector_top_level_session_mismatch");
  if (Number.isFinite(authoritativeDeadlineMs) && topDeadlineMs !== authoritativeDeadlineMs) issues.push("collector_deadline_mismatch");
  const latestCompletion = latestSessionId ? completions.get(latestSessionId) : null;
  if (["completed_deadline", "completed_terminal"].includes(completionStatus) && !latestCompletion) {
    issues.push("collector_successful_completion_missing");
  }
  if (latestCompletion && (completedAt !== latestCompletion.completedAt || completionStatus !== latestCompletion.completionStatus)) {
    issues.push("collector_top_level_completion_mismatch");
  }
  if (["completed_deadline", "completed_terminal"].includes(completionStatus) && !Number.isFinite(topCompletedMs)) issues.push("collector_successful_completion_missing");
  if (completionStatus === "completed_deadline" && Number.isFinite(topCompletedMs) && Number.isFinite(topDeadlineMs) && topCompletedMs < topDeadlineMs) {
    issues.push("collector_deadline_completion_early");
  }
  if (completionStatus === "completed_terminal") {
    const terminalLatest = new Map();
    for (const observation of receiverObservations.filter((item) => item?.sessionId === latestSessionId)) {
      if (!observation || typeof observation !== "object") continue;
      const old = terminalLatest.get(observation.id);
      if (!old || isoMs(observation.observedAt) > isoMs(old.observedAt)) terminalLatest.set(observation.id, observation);
    }
    const pair = [terminalLatest.get("A"), terminalLatest.get("B")];
    const terminalShape = pair.every((item) => item && TERMINAL.has(item.state) && item.errorCode == null &&
      ((item.state === "SETTLED" && item.settled === true && item.amountPaidSat === 700 && item.amountPaidMsat === 700000 && Number.isSafeInteger(item.settleDateUnix)) ||
       (["CANCELED", "EXPIRED"].includes(item.state) && item.settled === false && item.amountPaidSat === 0 && item.amountPaidMsat === 0)));
    const terminalPair = pair[0]?.state === "SETTLED" && pair[1]?.state === "SETTLED";
    const expiresAtMs = Number.isSafeInteger(expected.get("B")?.expiresAtUnix) ? expected.get("B").expiresAtUnix * 1_000 : Number.NaN;
    const naturalCancellation = pair[1]?.state === "CANCELED" && Number.isFinite(expiresAtMs) &&
      Number.isFinite(isoMs(pair[1]?.observedAt)) && isoMs(pair[1].observedAt) >= expiresAtMs;
    const unpaidTerminalPair = pair[0] && TERMINAL.has(pair[0].state) && pair[1]?.state === "CANCELED" && naturalCancellation;
    if (!terminalShape || (!terminalPair && !unpaidTerminalPair) ||
        (Number.isFinite(topCompletedMs) && receiverObservations.some((item) => item?.sessionId === latestSessionId && isoMs(item?.observedAt) > topCompletedMs))) {
      issues.push("collector_terminal_completion_unproven");
    }
    if (!["A", "B"].every((id) => (queryBySession.get(`${latestSessionId}:${id}`) ?? []).some((query) => query.status === "success"))) {
      issues.push("collector_terminal_queries_incomplete");
    }
  }
  if (completionStatus === "completed_deadline") {
    if (sessions.some((event) => event?.recordType === "collector_completed" && event.completionStatus === "interrupted")) {
      issues.push("collector_prior_interruption_prevents_bounded_claim");
    }
    for (const id of ["A", "B"]) {
      const finalObservation = receiverObservations.filter((item) => item?.sessionId === latestSessionId && item?.id === id)
        .sort((a, b) => isoMs(a.observedAt) - isoMs(b.observedAt)).at(-1);
      const successfulAfterDeadline = (queryBySession.get(`${latestSessionId}:${id}`) ?? []).some((query) =>
        query.status === "success" && isoMs(query.completedAt) >= topDeadlineMs);
      if (!finalObservation || isoMs(finalObservation.observedAt) < topDeadlineMs || !successfulAfterDeadline) {
        issues.push("collector_deadline_evidence_missing");
      }
    }
  }
  // Completion status describes bounded-window completeness. For an independently
  // proven FAIL, only the bound session start, successful query, and receiver
  // observation provenance below are proof requirements; missing/interrupted/
  // failed completion remains a diagnostic and cannot erase observed settlement.
  const proofValid = expected.size === 2 && ["A", "B"].every((id) => {
    const latest = (validObservationsById.get(id) ?? [])
      .sort((a, b) => isoMs(a.observedAt) - isoMs(b.observedAt)).at(-1);
    if (!latest || proofInvalidIds.has("*") || proofInvalidIds.has(id) || !TERMINAL.has(latest.state) || latest.errorCode != null) return false;
    const paidSat = Number.isSafeInteger(latest.amountPaidSat) ? latest.amountPaidSat : null;
    const paidMsat = Number.isSafeInteger(latest.amountPaidMsat) ? latest.amountPaidMsat : null;
    return latest.state === "SETTLED"
      ? latest.settled === true && paidSat === expected.get(id).amountSat && paidMsat === paidSat * 1_000 && Number.isSafeInteger(latest.settleDateUnix)
      : latest.settled === false && paidSat === 0 && paidMsat === 0 && latest.settleDateUnix == null && latest.settledAt == null;
  });
  return {
    valid: issues.length === 0 && ["completed_deadline", "completed_terminal"].includes(completionStatus),
    proofValid,
    latestSessionId,
    issues: [...new Set(issues)].sort(),
  };
}

export function summarizeCollectorSession(events, sessionId, expectedInvoices = [], { runStartedAt = null, expectedDeadline = null } = {}) {
  const sessionEvents = (Array.isArray(events) ? events : []).filter((event) => event?.sessionId === sessionId);
  const started = sessionEvents.find((event) => event?.recordType === "collector_started");
  const completed = [...sessionEvents].reverse().find((event) => event?.recordType === "collector_completed");
  const runEvents = (Array.isArray(events) ? events : []).filter((event) => event?.runId === started?.runId);
  const queryAttempts = runEvents.filter((event) => event?.recordType === "query_attempt");
  const sessionQueryAttempts = sessionEvents.filter((event) => event?.recordType === "query_attempt");
  const observations = runEvents.filter((event) => event?.recordType === "receiver_observation");
  const sessionObservations = sessionEvents.filter((event) => event?.recordType === "receiver_observation");
  const expectedById = new Map((Array.isArray(expectedInvoices) ? expectedInvoices : []).map((invoice) => [invoice?.id, invoice]));
  const status = completed && COMPLETION.has(completed.completionStatus) ? completed.completionStatus : "interrupted";
  const issues = [];
  if (!started || typeof started.runId !== "string" || typeof started.deadline !== "string") issues.push("collector_start_missing_or_invalid");
  if (!completed) issues.push("collector_completion_missing");
  if (completed && (!started || completed.runId !== started.runId || completed.deadline !== started.deadline)) issues.push("collector_completion_binding_mismatch");
  if (completed && !COMPLETION.has(completed.completionStatus)) issues.push("collector_completion_status_invalid");
  const startedMs = isoMs(started?.startedAt);
  const deadlineMs = isoMs(started?.deadline);
  const completedMs = isoMs(completed?.completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(deadlineMs) || deadlineMs <= startedMs) issues.push("collector_start_missing_or_invalid");
  if (completed && (!Number.isFinite(completedMs) || !Number.isFinite(startedMs) || completedMs < startedMs)) {
    issues.push("collector_completion_timestamp_invalid");
  }
  if (expectedById.size !== 2 || !["A", "B"].every((id) => /^[0-9a-f]{64}$/i.test(expectedById.get(id)?.paymentHash ?? "") && expectedById.get(id)?.amountSat === 700)) {
    issues.push("collector_expected_invoice_binding_invalid");
  }
  const lastById = new Map();
  for (const item of sessionObservations) {
    if (item?.runId === started?.runId && ["A", "B"].includes(item.id)) lastById.set(item.id, item);
  }
  if (status === "completed_terminal" && !["A", "B"].every((id) => {
    const item = lastById.get(id);
    const paidSat = Number.isSafeInteger(item?.amountPaidSat) ? item.amountPaidSat : null;
    const paidMsat = Number.isSafeInteger(item?.amountPaidMsat) ? item.amountPaidMsat : null;
    const expected = expectedById.get(id);
    const settledShape = item?.state === "SETTLED" && item?.settled === true && paidSat === item?.expectedAmountSat &&
      paidMsat === paidSat * 1_000 && Number.isSafeInteger(item?.settleDateUnix) && item.settleDateUnix > 0 && Number.isFinite(isoMs(item?.settledAt));
    const unpaidShape = ["CANCELED", "EXPIRED"].includes(item?.state) && item?.settled === false && paidSat === 0 &&
      paidMsat === 0 && item?.settleDateUnix == null && item?.settledAt == null;
    return TERMINAL.has(item?.state) && item?.errorCode == null && item?.requestedHash === expected?.paymentHash &&
      item?.returnedHash === expected?.paymentHash && item?.expectedAmountSat === expected?.amountSat &&
      (settledShape || unpaidShape);
  })) {
    issues.push("collector_terminal_condition_unproven");
  }
  if (status === "completed_terminal") {
    const attemptA = lastById.get("A");
    const attemptB = lastById.get("B");
    const independentlyProvenFail = attemptA?.state === "SETTLED" && attemptB?.state === "SETTLED";
    const expiresAtMs = Number.isSafeInteger(expectedById.get("B")?.expiresAtUnix) ? expectedById.get("B").expiresAtUnix * 1_000 : Number.NaN;
    const naturalCancellation = attemptB?.state === "CANCELED" && Number.isFinite(expiresAtMs) &&
      Number.isFinite(isoMs(attemptB?.observedAt)) && isoMs(attemptB.observedAt) >= expiresAtMs;
    const expectedTerminalPair = attemptB?.state === "CANCELED" && naturalCancellation && TERMINAL.has(attemptA?.state);
    if (!expectedTerminalPair && !independentlyProvenFail) issues.push("collector_terminal_condition_unproven");
  }
  if (status === "completed_deadline") {
    if (!Number.isFinite(completedMs) || !Number.isFinite(deadlineMs) || completedMs < deadlineMs) {
      issues.push("collector_deadline_completion_early");
    }
    for (const id of ["A", "B"]) {
      const finalObs = [...sessionObservations].reverse().find((item) => item?.id === id && item?.runId === started?.runId);
      const finalAttempt = [...sessionQueryAttempts].reverse().find((item) => item?.id === id);
      const expected = expectedById.get(id);
      if (!finalObs || !Number.isFinite(isoMs(finalObs.observedAt)) || isoMs(finalObs.observedAt) < deadlineMs || finalObs.errorCode != null ||
        finalObs.requestedHash !== expected?.paymentHash || finalObs.returnedHash !== expected?.paymentHash || finalObs.expectedAmountSat !== expected?.amountSat ||
        !finalAttempt || finalAttempt.status !== "success" || finalAttempt.requestedHash !== expected?.paymentHash ||
        !Number.isFinite(isoMs(finalAttempt.completedAt)) || isoMs(finalAttempt.completedAt) < deadlineMs) {
        issues.push("collector_deadline_condition_unproven");
      }
    }
  }
  if (status === "completed_terminal" && ["A", "B"].some((id) => {
    const finalAttempt = [...sessionQueryAttempts].reverse().find((item) => item?.id === id);
    return !finalAttempt || finalAttempt.status !== "success" || finalAttempt.requestedHash !== expectedById.get(id)?.paymentHash;
  })) issues.push("collector_terminal_queries_incomplete");
  if (status === "completed_terminal") {
    const finalEventTimes = [
      ...sessionObservations.map((event) => isoMs(event?.observedAt)),
      ...sessionQueryAttempts.map((event) => isoMs(event?.completedAt)),
    ].filter(Number.isFinite);
    if (!Number.isFinite(completedMs) || finalEventTimes.some((at) => at > completedMs)) issues.push("collector_terminal_completion_early");
  }
  if (status === "completed_deadline" && runEvents.some((event) => event?.recordType === "collector_completed" && event?.completionStatus === "interrupted")) {
    issues.push("collector_prior_interruption_prevents_bounded_claim");
  }
  const sessions = runEvents.filter((event) => ["collector_started", "collector_completed"].includes(event?.recordType)).map((event) => ({
    sessionId: typeof event.sessionId === "string" && /^[0-9a-f-]{36}$/i.test(event.sessionId) ? event.sessionId : null,
    runId: event.runId,
    recordType: event.recordType,
    startedAt: event.recordType === "collector_started" ? event.startedAt ?? null : null,
    completedAt: event.recordType === "collector_completed" ? event.completedAt ?? null : null,
    deadline: event.deadline ?? null,
    completionStatus: COMPLETION.has(event.completionStatus) ? event.completionStatus : null,
  }));
  const summarizedQueries = queryAttempts.map((event) => ({
    sessionId: typeof event.sessionId === "string" && /^[0-9a-f-]{36}$/i.test(event.sessionId) ? event.sessionId : null,
    runId: event.runId,
    id: ["A", "B"].includes(event.id) ? event.id : null,
    requestedHash: /^[0-9a-f]{64}$/i.test(event.requestedHash ?? "") ? event.requestedHash.toLowerCase() : null,
    attemptedAt: event.attemptedAt ?? null,
    completedAt: event.completedAt ?? null,
    status: ["success", "query_timeout", "collector_error"].includes(event.status) ? event.status : "collector_error",
    errorCode: event.errorCode === "TIMEOUT" ? "TIMEOUT" : event.errorCode == null ? null : "OTHER",
  }));
  const persistedValidation = validatePersistedCollectorEvidence({
    runId: started?.runId,
    runStartedAt,
    expectedDeadline: expectedDeadline ?? started?.deadline,
    expectedInvoices,
    startedAt: started?.startedAt,
    deadline: started?.deadline,
    completedAt: completed?.completedAt,
    completionStatus: status,
    queryAttempts: summarizedQueries,
    collectionSessions: sessions,
    observations,
  });
  issues.push(...persistedValidation.issues);
  return {
    startedAt: started?.startedAt ?? null,
    deadline: started?.deadline ?? null,
    completedAt: completed?.completedAt ?? null,
    completionStatus: status,
    queryAttempts: summarizedQueries,
    observations,
    sessions,
    proofValid: persistedValidation.proofValid,
    valid: issues.length === 0 && ["completed_deadline", "completed_terminal"].includes(status),
    issues: [...new Set(issues)].sort(),
  };
}
