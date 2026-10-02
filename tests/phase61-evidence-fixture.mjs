import { captureBudgetSnapshot, sanitizeNwcLookup, sanitizeReceiverObservation } from "../scripts/phase45-core.mjs";

export const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const GENERATED_AT = "2026-10-01T10:01:33.000Z";

const iso = (milliseconds) => new Date(milliseconds).toISOString();
const capturedAtMs = Date.parse("2026-10-01T10:00:00.600Z");
const releaseMs = Date.parse("2026-10-01T10:00:01.000Z");
const deadlineMs = releaseMs + 150_000;

export function makeEvidence({
  settledA = true,
  settledB = false,
  terminalB = "CANCELED",
  missingNwc = false,
} = {}) {
  const expectedInvoices = [
    { id: "A", paymentHash: HASH_A, amountSat: 700 },
    { id: "B", paymentHash: HASH_B, amountSat: 700 },
  ];
  const initialBobObservations = expectedInvoices.map((invoice, index) => sanitizeReceiverObservation({
    runId: RUN_ID,
    id: invoice.id,
    requestedHash: invoice.paymentHash,
    expectedAmountSat: invoice.amountSat,
    lookup: {
      r_hash: invoice.paymentHash,
      settled: false,
      state: "OPEN",
      amt_paid_sat: 0,
      amt_paid_msat: 0,
      settle_date: 0,
    },
    observedAt: iso(capturedAtMs - 200 + index * 50),
  }));
  const raceEvidence = {
    schemaVersion: 2,
    test: "phase4-two-payment-budget-race",
    runId: RUN_ID,
    runStartedAt: iso(capturedAtMs - 500),
    wallet: "Alby Hub / Alice",
    network: "regtest",
    relay: "ws://limitprobe-relay:8080",
    encryption: "nip44",
    encryptionVerified: true,
    startingBudget: {
      ...captureBudgetSnapshot({ total_budget_msats: 1_000_000, used_budget_msats: 0, remaining_budget_msats: 1_000_000, renewal_period: "never" }, { kind: "starting", runId: RUN_ID, observedAt: iso(capturedAtMs) }),
      renewalPeriod: "never",
      reportedRenewalPeriod: "never",
      capturedAt: iso(capturedAtMs),
    },
    testExclusiveInvoices: true,
    noOtherPayerPath: true,
    requestsPreparedAt: iso(capturedAtMs + 200),
    initialBobObservations,
    barrierReleasedAt: iso(releaseMs),
    barrierReleaseMonotonicMs: 100,
    dispatchTimingBoundary: "nwc_client_call_start",
    reconciliationDeadline: iso(deadlineMs),
    reconciliationWindowMs: 150_000,
    reconciliationPollIntervalMs: 2_000,
    dispatchDeltaMs: 1,
    stage: "final_nwc_lookup_and_budget_complete",
    attempts: [
      {
        runId: RUN_ID,
        id: "A",
        requestedHash: HASH_A,
        paymentHash: HASH_A,
        expectedAmountSat: 700,
        barrierReleasedAt: iso(releaseMs),
        dispatchedAt: iso(releaseMs + 1),
        dispatchMonotonicMs: 101,
        responseAt: iso(releaseMs + 10_000),
        responseMonotonicMs: 200,
        result: "success",
        errorCode: null,
        feesPaidMsat: 0,
      },
      {
        runId: RUN_ID,
        id: "B",
        requestedHash: HASH_B,
        paymentHash: HASH_B,
        expectedAmountSat: 700,
        barrierReleasedAt: iso(releaseMs),
        dispatchedAt: iso(releaseMs + 2),
        dispatchMonotonicMs: 102,
        responseAt: iso(releaseMs + 11_000),
        responseMonotonicMs: 210,
        result: "error",
        errorCode: "QUOTA_EXCEEDED",
        feesPaidMsat: null,
      },
    ],
    requiredGraceSeconds: 30,
    expectedInvoiceExpirySeconds: 120,
    invoiceLifecycle: ["A", "B"].map((id, index) => {
      const createdAt = iso(capturedAtMs - 300 + index * 100);
      const invoiceTimestampUnix = Math.floor(Date.parse(createdAt) / 1_000);
      const expiresAtUnix = invoiceTimestampUnix + 120;
      const dispatchedAt = iso(releaseMs + index + 1);
      return {
        id,
        paymentHash: index === 0 ? HASH_A : HASH_B,
        createdAt,
        invoiceTimestampUnix,
        expirySeconds: 120,
        expiresAtUnix,
        dispatchAt: dispatchedAt,
        reconciliationDeadline: iso(deadlineMs),
        requiredGraceSeconds: 30,
      };
    }),
    nwcLookups: [],
    finalNwcLookupCompletedAt: iso(deadlineMs + 2_100),
    budgetAfter: {
      ...captureBudgetSnapshot({
        total_budget_msats: 1_000_000,
        used_budget_msats: settledA && settledB ? 1_400_000 : settledA || settledB ? 700_000 : 0,
        remaining_budget_msats: settledA && settledB ? -400_000 : settledA || settledB ? 300_000 : 1_000_000,
        renewal_period: "never",
      }, { kind: "final", runId: RUN_ID, observedAt: iso(deadlineMs + 2_200) }),
    },
  };

  const finalBobObservations = expectedInvoices.flatMap((invoice) => {
    const isSettled = invoice.id === "A" ? settledA : settledB;
    const finalState = isSettled ? "SETTLED" : invoice.id === "B" ? terminalB : "CANCELED";
    const base = {
      r_hash: invoice.paymentHash,
      settled: false,
      state: "OPEN",
      amt_paid_sat: 0,
      amt_paid_msat: 0,
      settle_date: 0,
    };
    const openObservation = sanitizeReceiverObservation({
      runId: RUN_ID,
      id: invoice.id,
      requestedHash: invoice.paymentHash,
      expectedAmountSat: invoice.amountSat,
      lookup: base,
      observedAt: iso(releaseMs + 5_000),
    });
    const settleSeconds = Math.floor((releaseMs + 10_000) / 1_000);
    const finalObservation = sanitizeReceiverObservation({
      runId: RUN_ID,
      id: invoice.id,
      requestedHash: invoice.paymentHash,
      expectedAmountSat: invoice.amountSat,
      lookup: {
        r_hash: invoice.paymentHash,
        settled: isSettled,
        state: finalState,
        amt_paid_sat: isSettled ? invoice.amountSat : 0,
        amt_paid_msat: isSettled ? invoice.amountSat * 1_000 : 0,
        settle_date: isSettled ? settleSeconds : 0,
      },
      observedAt: iso(deadlineMs + 1_000),
    });
    return [openObservation, finalObservation];
  });
  const states = new Map(finalBobObservations.filter((item) => item.observedAt === iso(deadlineMs + 1_000)).map((item) => [item.id, item.state]));
  for (const invoice of expectedInvoices) {
    if (missingNwc) continue;
    const lookupState = states.get(invoice.id);
    raceEvidence.nwcLookups.push(sanitizeNwcLookup({
      runId: RUN_ID,
      id: invoice.id,
      requestedHash: invoice.paymentHash,
      expectedAmountSat: invoice.amountSat,
      lookup: {
        payment_hash: invoice.paymentHash,
        state: lookupState,
        amount: 700_000,
        fees_paid: invoice.id === "A" && (invoice.id === "A" ? settledA : settledB) ? 0 : undefined,
        settled_at: lookupState === "SETTLED" ? Math.floor((releaseMs + 10_000) / 1_000) : 0,
      },
      observedAt: iso(deadlineMs + 2_000),
    }));
  }
  const bobEvidence = {
    runId: RUN_ID,
    phase: "final",
    source: "polar-n1-bob lncli lookupinvoice",
    reconciliationDeadline: iso(deadlineMs),
    startedAt: iso(releaseMs + 100),
    deadline: iso(deadlineMs),
    completedAt: iso(deadlineMs + 1_500),
    completionStatus: "completed_deadline",
    queryAttempts: expectedInvoices.flatMap((invoice) => [
      { sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", runId: RUN_ID, id: invoice.id, requestedHash: invoice.paymentHash, attemptedAt: iso(releaseMs + 4_900), completedAt: iso(releaseMs + 5_100), status: "success", errorCode: null },
      { sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", runId: RUN_ID, id: invoice.id, requestedHash: invoice.paymentHash, attemptedAt: iso(deadlineMs + 900), completedAt: iso(deadlineMs + 1_100), status: "success", errorCode: null },
    ]),
    collectionIssues: [],
    collectionSessions: [
      { sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", runId: RUN_ID, recordType: "collector_started", startedAt: iso(releaseMs + 100), completedAt: null, deadline: iso(deadlineMs), completionStatus: null },
      { sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", runId: RUN_ID, recordType: "collector_completed", startedAt: null, completedAt: iso(deadlineMs + 1_500), deadline: iso(deadlineMs), completionStatus: "completed_deadline" },
    ],
    observations: finalBobObservations.map((item) => ({ ...item, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })),
  };
  return { raceEvidence, bobEvidence };
}
