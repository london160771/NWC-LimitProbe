import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { appendCollectorEvent, parseCollectorJournal, summarizeCollectorSession, validatePersistedCollectorEvidence } from "../scripts/phase45-collector-core.mjs";
import { buildEvidenceReport } from "../scripts/phase6-evidence-report.mjs";
import { GENERATED_AT, HASH_A, HASH_B, makeEvidence, RUN_ID } from "./phase61-evidence-fixture.mjs";

const deadline = makeEvidence().bobEvidence.reconciliationDeadline;
const started = "2026-10-01T10:00:01.100Z";
const session = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const expectedInvoices = makeEvidence().raceEvidence.invoiceLifecycle.map(({ id, paymentHash, expiresAtUnix }) => ({
  id, paymentHash, amountSat: 700, expiresAtUnix,
}));
const runStartedAt = makeEvidence().raceEvidence.runStartedAt;
const summarize = (events, sessionId = session) => summarizeCollectorSession(events, sessionId, expectedInvoices, { runStartedAt, expectedDeadline: deadline });
const observation = (id, hash, state, at) => ({
  recordType: "receiver_observation", sessionId: session, runId: RUN_ID, id,
  requestedHash: hash, returnedHash: hash, expectedAmountSat: 700,
  state, settled: state === "SETTLED", amountPaidSat: state === "SETTLED" ? 700 : 0,
  amountPaidMsat: state === "SETTLED" ? 700_000 : 0,
  settleDateUnix: state === "SETTLED" ? 1790848861 : null,
  settledAt: state === "SETTLED" ? "2026-10-01T10:01:01.000Z" : null,
  errorCode: null, observedAt: at,
});
const query = (id, hash, status, at) => ({
  recordType: "query_attempt", sessionId: session, runId: RUN_ID, id, requestedHash: hash,
  attemptedAt: at, completedAt: at, status, errorCode: status === "query_timeout" ? "TIMEOUT" : status === "success" ? null : "OTHER",
});
function journal(completionStatus, { observations = [], queries = [], completedAt = deadline } = {}) {
  return [
    { recordType: "collector_started", sessionId: session, runId: RUN_ID, startedAt: started, deadline },
    ...queries,
    ...observations,
    ...(completionStatus ? [{ recordType: "collector_completed", sessionId: session, runId: RUN_ID, deadline, completedAt, completionStatus }] : []),
  ];
}

test("query timeout is durably distinguished from a clean bounded completion", () => {
  const events = journal("query_timeout", {
    queries: [query("A", HASH_A, "query_timeout", deadline), query("B", HASH_B, "success", deadline)],
  });
  const summary = summarize(events);
  assert.equal(summary.completionStatus, "query_timeout");
  assert.equal(summary.queryAttempts[0].errorCode, "TIMEOUT");
  assert.equal(summary.valid, false);
});

test("collector errors and interrupted sessions remain explicit", () => {
  const failed = summarize(journal("collector_error", {
    queries: [query("A", HASH_A, "collector_error", deadline)],
  }));
  assert.equal(failed.completionStatus, "collector_error");
  const interrupted = summarize(journal(null));
  assert.equal(interrupted.completionStatus, "interrupted");
  assert.ok(interrupted.issues.includes("collector_completion_missing"));
});

test("restart appends to the existing observation journal without truncating it", () => {
  const directory = mkdtempSync(join(tmpdir(), "nwc-collector-journal-"));
  const path = join(directory, "observations.jsonl");
  try {
    const first = { recordType: "collector_started", sessionId: session, runId: RUN_ID, startedAt: started, deadline };
    appendCollectorEvent(path, first);
    const firstLine = readFileSync(path, "utf8").split(/\r?\n/)[0];
    const second = { recordType: "collector_completed", sessionId: session, runId: RUN_ID, completedAt: deadline, deadline, completionStatus: "interrupted" };
    appendCollectorEvent(path, second);
    const contents = readFileSync(path, "utf8");
    assert.equal(contents.split(/\r?\n/).filter(Boolean).length, 2);
    assert.equal(contents.split(/\r?\n/)[0], firstLine);
    const parsed = parseCollectorJournal(contents);
    assert.equal(parsed.events.length, 2);
    assert.deepEqual(parsed.issues, []);
    if (process.platform !== "win32") assert.equal((statSync(path).mode & 0o777).toString(8), "600");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("journal parser preserves complete events before only an incomplete unterminated tail", () => {
  const first = { recordType: "collector_started", sessionId: session, runId: RUN_ID, startedAt: started, deadline };
  const second = { recordType: "query_attempt", sessionId: session, runId: RUN_ID, id: "A", requestedHash: HASH_A };
  const parsed = parseCollectorJournal(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n{"recordType":"receiver_observation"`);
  assert.deepEqual(parsed.events, [first, second]);
  assert.deepEqual(parsed.issues, ["collector_trailing_record_incomplete"]);
});

test("journal corruption in the middle stops parsing and is not skipped", () => {
  const first = { recordType: "collector_started", sessionId: session, runId: RUN_ID, startedAt: started, deadline };
  const later = { recordType: "collector_completed", sessionId: session, runId: RUN_ID, completedAt: deadline, deadline, completionStatus: "completed_terminal" };
  const parsed = parseCollectorJournal(`${JSON.stringify(first)}\n{invalid}\n${JSON.stringify(later)}\n`);
  assert.deepEqual(parsed.events, [first]);
  assert.deepEqual(parsed.issues, ["collector_journal_invalid"]);
});

test("saved c39 collector records with live 9-digit timestamps retain valid receiver provenance", () => {
  const runId = "c39c3771-bf56-49af-b465-ea0fe7e71e3b";
  const sessionId = "a2f5625a-e890-4d51-aca9-745b024049bb";
  const hashA = "e0e857dd5f31471a4f26ee51578d622d3e1f45f6af6f6213fe921f7976c2ffc3";
  const hashB = "4e7baada53e011eaf88998a91f3f157bd7d51948fe1dc5838356fa4d1b2b2706";
  const liveDeadline = "2026-10-02T22:33:49.641Z";
  const liveStartedAt = "2026-10-02T22:31:21.298859200Z";
  const liveCompletedAt = "2026-10-02T22:33:59.928970524Z";
  const invoices = [
    { id: "A", paymentHash: hashA, amountSat: 700 },
    { id: "B", paymentHash: hashB, amountSat: 700 },
  ];
  const events = [
    { recordType: "collector_started", sessionId, runId, startedAt: liveStartedAt, deadline: liveDeadline },
    {
      recordType: "query_attempt", sessionId, runId, id: "A", requestedHash: hashA,
      attemptedAt: "2026-10-02T22:33:55.636998004Z", completedAt: "2026-10-02T22:33:57.651808667Z",
      status: "success", errorCode: null,
    },
    {
      recordType: "receiver_observation", sessionId, runId, id: "A", requestedHash: hashA, returnedHash: hashA,
      expectedAmountSat: 700, state: "CANCELED", settled: false, amountPaidSat: 0, amountPaidMsat: 0,
      settleDateUnix: null, settledAt: null, observedAt: "2026-10-02T22:33:57.169Z", errorCode: null,
    },
    {
      recordType: "query_attempt", sessionId, runId, id: "B", requestedHash: hashB,
      attemptedAt: "2026-10-02T22:33:57.831488863Z", completedAt: "2026-10-02T22:33:59.742370528Z",
      status: "success", errorCode: null,
    },
    {
      recordType: "receiver_observation", sessionId, runId, id: "B", requestedHash: hashB, returnedHash: hashB,
      expectedAmountSat: 700, state: "SETTLED", settled: true, amountPaidSat: 700, amountPaidMsat: 700_000,
      settleDateUnix: 1_790_980_280, settledAt: "2026-10-02T22:31:20.000Z",
      observedAt: "2026-10-02T22:33:59.264Z", errorCode: null,
    },
    { recordType: "collector_completed", sessionId, runId, deadline: liveDeadline, completedAt: liveCompletedAt, completionStatus: "completed_deadline" },
  ];
  const serialized = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const parsed = parseCollectorJournal(serialized);
  const summary = summarizeCollectorSession(parsed.events, sessionId, invoices, {
    runStartedAt: "2026-10-02T22:31:05.321Z",
    expectedDeadline: liveDeadline,
  });

  assert.deepEqual(parsed.issues, []);
  assert.equal(summary.valid, true);
  assert.equal(summary.proofValid, true);
  assert.equal(summary.startedAt, liveStartedAt);
  assert.equal(summary.completedAt, liveCompletedAt);
  assert.equal(summary.queryAttempts[0].attemptedAt, events[1].attemptedAt);
});

test("deadline completion is rejected when either final query ended early", () => {
  const beforeDeadline = "2026-10-01T10:01:30.900Z";
  const events = journal("completed_deadline", {
    completedAt: deadline,
    observations: [observation("A", HASH_A, "SETTLED", beforeDeadline), observation("B", HASH_B, "OPEN", beforeDeadline)],
    queries: [query("A", HASH_A, "success", beforeDeadline), query("B", HASH_B, "success", beforeDeadline)],
  });
  const summary = summarize(events);
  assert.equal(summary.valid, false);
  assert.ok(summary.issues.includes("collector_deadline_condition_unproven"));
});

test("deadline proof cannot borrow an earlier session observation after restart", () => {
  const previousSession = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const events = [
    ...journal("interrupted", {
      observations: [observation("A", HASH_A, "SETTLED", deadline), observation("B", HASH_B, "CANCELED", deadline)],
      queries: [query("A", HASH_A, "success", deadline), query("B", HASH_B, "success", deadline)],
    }).map((event) => ({ ...event, sessionId: previousSession })),
    ...journal("completed_deadline", {
      queries: [query("A", HASH_A, "success", deadline), query("B", HASH_B, "success", deadline)],
      completedAt: "2026-10-01T10:01:32.000Z",
    }),
  ];
  const summary = summarize(events);
  assert.equal(summary.valid, false);
  assert.ok(summary.issues.includes("collector_deadline_condition_unproven"));
  assert.ok(summary.issues.includes("collector_prior_interruption_prevents_bounded_claim"));
});

test("terminal completion requires matching, complete receiver amount evidence", () => {
  const events = journal("completed_terminal", {
    observations: [observation("A", HASH_A, "SETTLED", deadline), observation("B", HASH_B, "CANCELED", deadline)],
    queries: [query("A", HASH_A, "success", deadline), query("B", HASH_B, "success", deadline)],
    completedAt: "2026-10-01T10:01:32.000Z",
  });
  const terminalB = events.find((event) => event.recordType === "receiver_observation" && event.id === "B");
  terminalB.returnedHash = HASH_A;
  const summary = summarize(events);
  assert.equal(summary.valid, false);
  assert.ok(summary.issues.includes("collector_terminal_condition_unproven"));

  const reverseWinner = journal("completed_terminal", {
    observations: [observation("A", HASH_A, "CANCELED", deadline), observation("B", HASH_B, "SETTLED", deadline)],
    queries: [query("A", HASH_A, "success", deadline), query("B", HASH_B, "success", deadline)],
    completedAt: "2026-10-01T10:01:32.000Z",
  });
  const reverseSummary = summarize(reverseWinner);
  assert.equal(reverseSummary.valid, false);
  assert.ok(reverseSummary.issues.includes("collector_terminal_condition_unproven"));
});

test("terminal collection waits for Bob CANCELED after B invoice expiry", () => {
  const at = "2026-10-01T10:01:59.000Z";
  const events = journal("completed_terminal", {
    observations: [observation("A", HASH_A, "SETTLED", at), observation("B", HASH_B, "CANCELED", at)],
    queries: [query("A", HASH_A, "success", at), query("B", HASH_B, "success", at)],
    completedAt: "2026-10-01T10:02:01.000Z",
  });
  const summary = summarize(events);
  assert.equal(summary.valid, false);
  assert.ok(summary.issues.includes("collector_terminal_condition_unproven"));

  const expired = journal("completed_terminal", {
    observations: [observation("A", HASH_A, "SETTLED", deadline), observation("B", HASH_B, "EXPIRED", deadline)],
    queries: [query("A", HASH_A, "success", deadline), query("B", HASH_B, "success", deadline)],
    completedAt: "2026-10-01T10:02:32.000Z",
  });
  const expiredSummary = summarize(expired);
  assert.equal(expiredSummary.valid, false);
  assert.ok(expiredSummary.issues.includes("collector_terminal_condition_unproven"));
});

test("partial collector status makes a report INCONCLUSIVE", () => {
  const evidence = makeEvidence();
  evidence.bobEvidence.completionStatus = "interrupted";
  const report = buildEvidenceReport({ ...evidence, generatedAt: GENERATED_AT });
  assert.equal(report.finalClassification, "INCONCLUSIVE");
});

test("persisted collector validation derives chronology and ignores empty issue summaries", () => {
  const bob = makeEvidence().bobEvidence;
  const input = (patch = {}) => validatePersistedCollectorEvidence({
    runId: RUN_ID,
    runStartedAt,
    expectedDeadline: bob.reconciliationDeadline,
    expectedInvoices,
    startedAt: bob.startedAt,
    deadline: bob.deadline,
    completedAt: bob.completedAt,
    completionStatus: bob.completionStatus,
    queryAttempts: bob.queryAttempts,
    collectionSessions: bob.collectionSessions,
    observations: bob.observations,
    ...patch,
  });
  assert.equal(input().valid, true);
  assert.equal(input({ collectionSessions: [] }).valid, false);
  assert.ok(input({ collectionSessions: [] }).issues.includes("collector_session_history_missing"));
  assert.ok(input({ collectionSessions: [], completionStatus: "completed_deadline" }).issues.includes("collector_successful_completion_missing"));
  const completionBeforeQuery = structuredClone(bob.collectionSessions);
  completionBeforeQuery.find((event) => event.recordType === "collector_completed").completedAt = "2026-10-01T10:02:32.000Z";
  assert.equal(input({ collectionSessions: completionBeforeQuery, completedAt: "2026-10-01T10:02:32.000Z" }).valid, false);

  const afterCompletion = structuredClone(bob.queryAttempts);
  afterCompletion[0].attemptedAt = "2026-10-01T11:02:31.000Z";
  afterCompletion[0].completedAt = "2026-10-01T11:02:32.000Z";
  assert.equal(input({ queryAttempts: afterCompletion }).valid, false);
  assert.ok(input({ queryAttempts: afterCompletion }).issues.includes("collector_query_after_session_completion"));

  const startAtDeadline = structuredClone(bob.collectionSessions);
  startAtDeadline.find((event) => event.recordType === "collector_started").startedAt = bob.deadline;
  assert.equal(input({ collectionSessions: startAtDeadline, startedAt: bob.deadline }).valid, false);

  const terminalAtDeadline = structuredClone(bob.collectionSessions);
  terminalAtDeadline.find((event) => event.recordType === "collector_started").startedAt = bob.deadline;
  terminalAtDeadline.find((event) => event.recordType === "collector_completed").completionStatus = "completed_terminal";
  assert.equal(input({ collectionSessions: terminalAtDeadline, startedAt: bob.deadline, completionStatus: "completed_terminal" }).valid, false);

  const mismatch = structuredClone(bob.queryAttempts);
  mismatch[0].sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  assert.equal(input({ queryAttempts: mismatch }).valid, false);

  const noCompletionRecord = bob.collectionSessions.filter((event) => event.recordType !== "collector_completed");
  assert.equal(input({ collectionSessions: noCompletionRecord }).valid, false);
});

test("completed_deadline cannot be claimed before the declared deadline", () => {
  const bob = makeEvidence().bobEvidence;
  const events = structuredClone(bob.collectionSessions);
  events.find((event) => event.recordType === "collector_completed").completedAt = "2026-10-01T10:02:30.999Z";
  const checked = validatePersistedCollectorEvidence({
    runId: RUN_ID, expectedInvoices, startedAt: bob.startedAt, deadline: bob.deadline,
    completedAt: "2026-10-01T10:02:30.999Z", completionStatus: "completed_deadline",
    queryAttempts: bob.queryAttempts, collectionSessions: events, observations: bob.observations,
  });
  assert.equal(checked.valid, false);
  assert.ok(checked.issues.includes("collector_deadline_completion_early"));
});
