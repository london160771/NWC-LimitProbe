import { sanitizeNwcLookup, sanitizeReceiverObservation } from "../scripts/phase45-core.mjs";

export const RUN_ID = "phase61-test-run";
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const GENERATED_AT = "2026-10-01T10:01:33.000Z";

const iso = (milliseconds) => new Date(milliseconds).toISOString();
const capturedAtMs = Date.parse("2026-10-01T10:00:00.600Z");
const releaseMs = Date.parse("2026-10-01T10:00:01.000Z");
const deadlineMs = releaseMs + 90_000;

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
      totalBudgetMsat: 1_000_000,
      usedBudgetMsat: 0,
      remainingBudgetMsat: 1_000_000,
      renewalPeriod: "never",
      capturedAt: iso(capturedAtMs),
      runId: RUN_ID,
    },
    requestsPreparedAt: iso(capturedAtMs + 200),
    initialBobObservations,
    barrierReleasedAt: iso(releaseMs),
    barrierReleaseMonotonicMs: 100,
    dispatchTimingBoundary: "nwc_client_call_start",
    reconciliationDeadline: iso(deadlineMs),
    reconciliationWindowMs: 90_000,
    reconciliationPollIntervalMs: 2_000,
    dispatchDeltaMs: 1,
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
    nwcLookups: [],
    budgetAfter: {
      totalBudgetMsat: 1_000_000,
      usedBudgetMsat: settledA && settledB ? 1_400_000 : settledA || settledB ? 700_000 : 0,
      remainingBudgetMsat: settledA && settledB ? -400_000 : settledA || settledB ? 300_000 : 1_000_000,
      renewalPeriod: "never",
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
    completedAt: iso(deadlineMs + 1_500),
    observations: finalBobObservations,
  };
  return { raceEvidence, bobEvidence };
}
