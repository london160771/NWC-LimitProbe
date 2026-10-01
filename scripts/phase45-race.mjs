import {
  chmodSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { decodeBolt11, NWC } from "nostr-core";
import {
  dispatchTwoPayments,
  normalizeBudgetMsat,
  RECONCILIATION_POLL_INTERVAL_MS,
  RECONCILIATION_WINDOW_MS,
  safeErrorCode,
  sanitizeNwcLookup,
  sanitizeReceiverObservation,
  validateInitialObservations,
} from "./phase45-core.mjs";
import { markPostDispatchFailure, persistPrivateProgress } from "./phase45-progress.mjs";

const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
const progressFile = `${privateDirectory}/phase45-race-progress.json`;
const resultFile = `${privateDirectory}/phase45-race-results.json`;
const sentinelFile = `${privateDirectory}/phase6.1-payment-dispatch-started`;
const requiredScopes = ["get_balance", "get_info", "lookup_invoice", "pay_invoice"];

function invalidConfiguration() {
  const error = new Error("invalid_phase61_configuration");
  error.code = "BAD_REQUEST";
  return error;
}

let client = null;
let stage = "read_private_configuration";
let dispatchEverStarted = false;
let progress = null;
try {
  const appConfig = JSON.parse(readFileSync(`${privateDirectory}/app-config.json`, "utf8"));
  const runConfig = JSON.parse(readFileSync(`${privateDirectory}/phase6-run-config.json`, "utf8"));
  const initialBob = JSON.parse(readFileSync(`${privateDirectory}/bob-initial-evidence.json`, "utf8"));
  const actualScopes = Array.isArray(appConfig.scopes) ? [...appConfig.scopes].sort() : [];
  const runId = runConfig.runId;
  const expectedInvoices = runConfig.expectedInvoices;
  if (
    appConfig.name !== "LimitProbe Phase6.1 Race" ||
    appConfig.maxAmountSat !== 1_000 ||
    appConfig.maxAmountMsat !== 1_000_000 ||
    appConfig.budgetUsageSat !== 0 ||
    appConfig.budgetRenewal !== "never" ||
    JSON.stringify(actualScopes) !== JSON.stringify(requiredScopes) ||
    typeof runId !== "string" ||
    !Array.isArray(expectedInvoices) || expectedInvoices.length !== 2 ||
    initialBob.runId !== runId || initialBob.phase !== "initial"
  ) throw invalidConfiguration();

  const requests = ["A", "B"].map((id) => {
    const expected = expectedInvoices.find((item) => item.id === id);
    const suffix = id.toLowerCase();
    const invoice = readFileSync(`${privateDirectory}/bob-invoice-${suffix}`, "utf8").trim();
    const paymentHash = readFileSync(`${privateDirectory}/bob-payment-hash-${suffix}`, "utf8").trim().toLowerCase();
    const decoded = decodeBolt11(invoice);
    if (
      !invoice.startsWith("lnbcrt") || decoded?.network !== "regtest" || decoded?.amountSat !== 700 ||
      decoded?.paymentHash !== paymentHash || expected?.paymentHash !== paymentHash || expected?.amountSat !== 700
    ) throw invalidConfiguration();
    return { id, invoice, paymentHash, amountSat: 700 };
  });
  if (requests[0].paymentHash === requests[1].paymentHash || requests[0].invoice === requests[1].invoice) throw invalidConfiguration();

  const initialBobObservations = initialBob.observations;
  if (!Array.isArray(initialBobObservations)) throw invalidConfiguration();
  const connectionUrl = readFileSync(`${privateDirectory}/nwc-url`, "utf8").trim();
  if (!connectionUrl.startsWith("nostr+walletconnect://")) throw invalidConfiguration();
  client = new NWC(connectionUrl);
  client.replyTimeout = 30_000;
  client.publishTimeout = 5_000;

  stage = "connect";
  await client.connect();
  stage = "get_info";
  const info = await client.getInfo();
  if (info?.network !== "regtest" || client.encryption !== "nip44" || client.encryptionVerified !== true) throw invalidConfiguration();
  stage = "starting_budget";
  const budgetResponse = await client.getBudget();
  const budget = normalizeBudgetMsat(budgetResponse);
  const startingBudgetCapturedAt = new Date().toISOString();
  if (
    !budget.valid || !budget.complete || budget.totalBudgetMsat !== 1_000_000 ||
    budget.usedBudgetMsat !== 0 || budget.remainingBudgetMsat !== 1_000_000 ||
    budget.renewalPeriod !== null && budget.renewalPeriod !== "never"
  ) throw invalidConfiguration();
  const startingBudget = {
    totalBudgetMsat: budget.totalBudgetMsat,
    usedBudgetMsat: budget.usedBudgetMsat,
    remainingBudgetMsat: budget.remainingBudgetMsat,
    renewalPeriod: appConfig.budgetRenewal,
    reportedRenewalPeriod: budget.renewalPeriod,
    capturedAt: startingBudgetCapturedAt,
    runId,
    verified: true,
  };
  const initialValidation = validateInitialObservations({
    runId,
    expectedInvoices: requests.map(({ id, paymentHash, amountSat }) => ({ id, paymentHash, amountSat })),
    observations: initialBobObservations,
    beforeAt: startingBudgetCapturedAt,
  });
  if (!initialValidation.valid) throw invalidConfiguration();
  const sanitizedInitialBobObservations = initialBobObservations.map((item) => sanitizeReceiverObservation({
    runId,
    id: item.id,
    requestedHash: item.requestedHash,
    expectedAmountSat: item.expectedAmountSat,
    lookup: {
      r_hash: item.returnedHash,
      state: item.state,
      settled: item.settled,
      amt_paid_sat: item.amountPaidSat,
      settle_date: item.settleDateUnix,
    },
    observedAt: item.observedAt,
  }));
  const requestsPreparedAt = new Date().toISOString();

  progress = {
    schemaVersion: 2,
    test: "phase4-two-payment-budget-race",
    runId,
    runStartedAt: runConfig.createdAt,
    wallet: "Alby Hub / Alice",
    network: "regtest",
    relay: "ws://limitprobe-relay:8080",
    encryption: "nip44",
    encryptionVerified: true,
    requestsPreparedAt,
    startingBudget,
    initialBobObservations: sanitizedInitialBobObservations,
    reconciliationWindowMs: RECONCILIATION_WINDOW_MS,
    reconciliationPollIntervalMs: RECONCILIATION_POLL_INTERVAL_MS,
    reconciliationDeadline: null,
    barrierReleasedAt: null,
    barrierReleaseMonotonicMs: null,
    dispatchTimingBoundary: "nwc_client_call_start",
    dispatchDeltaMs: null,
    attempts: [],
    nwcLookups: [],
    budgetAfter: null,
    budgetAfterErrorCode: null,
    paymentMayHaveBeenDispatched: false,
    stage: "prepared",
  };

  stage = "concurrent_pay_invoice";
  const dispatch = await dispatchTwoPayments(
    requests,
    (invoice) => client.payInvoice(invoice),
    {
      runId,
      beforeRelease: () => {
        dispatchEverStarted = true;
        progress.paymentMayHaveBeenDispatched = true;
        progress.stage = "barrier_armed_payment_may_have_been_dispatched";
        writeFileSync(sentinelFile, `${runId}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        chmodSync(sentinelFile, 0o600);
        persistPrivateProgress(progressFile, progress);
      },
      onBothDispatched: ({ barrierReleasedAt, barrierReleaseMonotonicMs, attempts }) => {
        progress.barrierReleasedAt = barrierReleasedAt;
        progress.barrierReleaseMonotonicMs = barrierReleaseMonotonicMs;
        progress.reconciliationDeadline = new Date(Date.parse(barrierReleasedAt) + RECONCILIATION_WINDOW_MS).toISOString();
        progress.dispatchDeltaMs = Number(Math.abs(attempts[0].dispatchMonotonicMs - attempts[1].dispatchMonotonicMs).toFixed(3));
        progress.attempts = attempts.map((attempt) => ({
          ...attempt,
          responseAt: null,
          responseMonotonicMs: null,
          result: "unknown",
          errorCode: null,
          feesPaidMsat: null,
        }));
        progress.stage = "both_client_calls_started";
        persistPrivateProgress(progressFile, progress);
      },
    },
  );

  progress.barrierReleasedAt = dispatch.barrierReleasedAt;
  progress.barrierReleaseMonotonicMs = dispatch.barrierReleaseMonotonicMs;
  progress.reconciliationDeadline = new Date(Date.parse(dispatch.barrierReleasedAt) + RECONCILIATION_WINDOW_MS).toISOString();
  progress.dispatchDeltaMs = dispatch.dispatchDeltaMs;
  progress.attempts = dispatch.attempts;
  progress.stage = "dispatch_complete";
  persistPrivateProgress(progressFile, progress);

  stage = "nwc_lookup_invoice";
  const nwcLookups = await Promise.all(requests.map(async (request) => {
    try {
      const lookup = await client.lookupInvoice({ payment_hash: request.paymentHash });
      return sanitizeNwcLookup({
        runId, id: request.id, requestedHash: request.paymentHash,
        expectedAmountSat: request.amountSat, lookup,
      });
    } catch (error) {
      return sanitizeNwcLookup({
        runId, id: request.id, requestedHash: request.paymentHash,
        expectedAmountSat: request.amountSat, error,
      });
    }
  }));
  progress.nwcLookups = nwcLookups;
  progress.stage = "nwc_lookup_complete";
  persistPrivateProgress(progressFile, progress);

  stage = "budget_after_race";
  try {
    progress.budgetAfter = normalizeBudgetMsat(await client.getBudget());
  } catch (error) {
    progress.budgetAfter = null;
    progress.budgetAfterErrorCode = safeErrorCode(error);
  }
  progress.stage = "race_complete";
  persistPrivateProgress(progressFile, progress);
  persistPrivateProgress(resultFile, progress);
  process.stdout.write(`${JSON.stringify({
    test: progress.test,
    runId,
    barrierReleasedAt: progress.barrierReleasedAt,
    dispatchDeltaMs: progress.dispatchDeltaMs,
    attempts: progress.attempts.map(({ id, runId: attemptRunId, requestedHash, expectedAmountSat, barrierReleasedAt, dispatchedAt, responseAt, result, errorCode, feesPaidMsat }) => ({
      id, runId: attemptRunId, requestedHash, expectedAmountSat, barrierReleasedAt, dispatchedAt, responseAt, result, errorCode, feesPaidMsat,
    })),
    nwcLookups: progress.nwcLookups,
    progressPersisted: true,
    secretsRedacted: true,
  }, null, 2)}\n`);
} catch (error) {
  if (progress && dispatchEverStarted) {
    markPostDispatchFailure(progress, error);
    try { persistPrivateProgress(progressFile, progress); } catch {}
  }
  process.stderr.write(`${JSON.stringify({
    test: "phase4-two-payment-budget-race",
    runId: progress?.runId ?? null,
    stage,
    errorCode: safeErrorCode(error),
    paymentMayHaveBeenDispatched: dispatchEverStarted,
    durableProgressPresent: progress !== null,
    secretsRedacted: true,
  })}\n`);
  process.exitCode = 1;
} finally {
  client?.close();
}
