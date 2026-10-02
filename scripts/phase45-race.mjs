import {
  existsSync,
  chmodSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { decodeBolt11, NWC } from "nostr-core";
import {
  dispatchTwoPayments,
  captureBudgetSnapshot,
  normalizeBudgetMsat,
  RECONCILIATION_POLL_INTERVAL_MS,
  RECONCILIATION_WINDOW_MS,
  safeErrorCode,
  sanitizeNwcLookup,
  prepareInitialReceiverObservations,
  validateInitialObservations,
  validateInvoiceLifecycle,
  REQUIRED_GRACE_SECONDS,
  EXPECTED_INVOICE_EXPIRY_SECONDS,
} from "./phase45-core.mjs";
import { markPostDispatchFailure, persistPrivateProgress } from "./phase45-progress.mjs";
import {
  PHASE61_RESUME_INVOICES,
  PHASE61_RESUME_RUN_ID,
  validateResumeStartingBudget,
} from "./phase61-resume-validation.mjs";

const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
const progressFile = `${privateDirectory}/phase45-race-progress.json`;
const resultFile = `${privateDirectory}/phase45-race-results.json`;
const sentinelFile = process.env.DISPATCH_SENTINEL_FILE ?? `${privateDirectory}/phase6.1-payment-dispatch-started`;
const requiredScopes = ["get_balance", "get_info", "lookup_invoice", "pay_invoice"];
const RESUME_INITIAL_EVIDENCE_MAX_AGE_MS = 60_000;

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
  const resumeMode = process.argv[2] === "--resume-existing-run";
  if (process.argv.length > (resumeMode ? 4 : 2) || (!resumeMode && process.argv.length > 2)) throw invalidConfiguration();
  const resumeExpectedRunId = resumeMode ? process.argv[3] : null;
  const appConfig = JSON.parse(readFileSync(`${privateDirectory}/app-config.json`, "utf8"));
  const runConfig = JSON.parse(readFileSync(`${privateDirectory}/phase6-run-config.json`, "utf8"));
  const initialBob = JSON.parse(readFileSync(`${privateDirectory}/bob-initial-evidence.json`, "utf8"));
  const actualScopes = Array.isArray(appConfig.scopes) ? [...appConfig.scopes].sort() : [];
  const runId = runConfig.runId;
  const expectedInvoices = runConfig.expectedInvoices;
  if (
    !["LimitProbe-Phase61-Race", "LimitProbe-Phase62-Final"].includes(appConfig.name) ||
    appConfig.maxAmountSat !== 1_000 ||
    appConfig.maxAmountMsat !== 1_000_000 ||
    appConfig.budgetUsageSat !== 0 ||
    appConfig.budgetRenewal !== "never" ||
    JSON.stringify(actualScopes) !== JSON.stringify(requiredScopes) ||
    typeof runId !== "string" ||
    runConfig.network !== "regtest" ||
    runConfig.invoiceExpirySeconds !== EXPECTED_INVOICE_EXPIRY_SECONDS ||
    runConfig.requiredGraceSeconds !== REQUIRED_GRACE_SECONDS ||
    !Array.isArray(expectedInvoices) || expectedInvoices.length !== 2 ||
    initialBob.runId !== runId || initialBob.phase !== "initial"
  ) throw invalidConfiguration();
  if (resumeMode) {
    const capturedAtMs = typeof initialBob.capturedAt === "string" ? Date.parse(initialBob.capturedAt) : Number.NaN;
    if (
      resumeExpectedRunId !== PHASE61_RESUME_RUN_ID || runId !== PHASE61_RESUME_RUN_ID ||
      existsSync(sentinelFile) || existsSync(progressFile) || existsSync(resultFile) ||
      !Number.isFinite(capturedAtMs) || Date.now() - capturedAtMs < 0 ||
      Date.now() - capturedAtMs > RESUME_INITIAL_EVIDENCE_MAX_AGE_MS
    ) throw invalidConfiguration();
  }

  const requests = ["A", "B"].map((id) => {
    const expected = expectedInvoices.find((item) => item.id === id);
    const suffix = id.toLowerCase();
    const invoice = readFileSync(`${privateDirectory}/bob-invoice-${suffix}`, "utf8").trim();
    const paymentHash = readFileSync(`${privateDirectory}/bob-payment-hash-${suffix}`, "utf8").trim().toLowerCase();
    const decoded = decodeBolt11(invoice);
    const remainingInvoiceLifetimeSeconds = Number.isSafeInteger(decoded?.expiresAt)
      ? decoded.expiresAt - Math.floor(Date.now() / 1_000)
      : null;
    if (
      !invoice.startsWith("lnbcrt") || decoded?.network !== "regtest" || decoded?.amountSat !== 700 ||
      decoded?.expiry !== 120 || remainingInvoiceLifetimeSeconds === null || remainingInvoiceLifetimeSeconds < 15 ||
      decoded?.paymentHash !== paymentHash || expected?.paymentHash !== paymentHash || expected?.amountSat !== 700
    ) throw invalidConfiguration();
    return { id, invoice, paymentHash, amountSat: 700, expiresAtUnix: decoded.expiresAt };
  });
  if (requests[0].paymentHash === requests[1].paymentHash || requests[0].invoice === requests[1].invoice) throw invalidConfiguration();
  if (resumeMode && requests.some((request) => {
    const required = PHASE61_RESUME_INVOICES.find((item) => item.id === request.id);
    return !required || request.paymentHash !== required.paymentHash || request.amountSat !== required.amountSat;
  })) throw invalidConfiguration();

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
  const resumeBudget = validateResumeStartingBudget({ budgetResponse, appConfig });
  if (!resumeBudget.valid || !budget.valid || !budget.complete) throw invalidConfiguration();
  if (resumeMode) {
    const capturedAtMs = Date.parse(initialBob.capturedAt);
    if (Date.now() - capturedAtMs < 0 || Date.now() - capturedAtMs > RESUME_INITIAL_EVIDENCE_MAX_AGE_MS) {
      throw invalidConfiguration();
    }
  }
  const startingBudget = captureBudgetSnapshot(budgetResponse, { kind: "starting", runId, observedAt: startingBudgetCapturedAt });
  startingBudget.renewalPeriod = appConfig.budgetRenewal;
  startingBudget.reportedRenewalPeriod = budget.renewalPeriod;
  startingBudget.verified = startingBudget.valid && startingBudget.complete;
  const initialPrepared = prepareInitialReceiverObservations({
    runId,
    expectedInvoices: requests.map(({ id, paymentHash, amountSat }) => ({ id, paymentHash, amountSat })),
    observations: initialBobObservations,
    beforeAt: startingBudgetCapturedAt,
  });
  if (!initialPrepared.valid) throw invalidConfiguration();
  const sanitizedInitialBobObservations = initialPrepared.observations;
  const invoiceLifecycle = requests.map((request) => {
    const receipt = runConfig.invoices?.find((item) => item.id === request.id);
    return {
      id: request.id,
      paymentHash: request.paymentHash,
      createdAt: receipt?.createdAt ?? null,
      invoiceTimestampUnix: receipt?.invoiceTimestampUnix ?? null,
      expirySeconds: receipt?.expirySeconds ?? null,
      expiresAtUnix: request.expiresAtUnix,
      dispatchAt: null,
      reconciliationDeadline: null,
      requiredGraceSeconds: REQUIRED_GRACE_SECONDS,
    };
  });
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
    testExclusiveInvoices: runConfig.invoicesCreatedForRun === true,
    noOtherPayerPath: runConfig.noOtherPayerPathVerified === true,
    requestsPreparedAt,
    startingBudget,
    initialBobObservations: sanitizedInitialBobObservations,
    invoiceLifecycle,
    requiredGraceSeconds: REQUIRED_GRACE_SECONDS,
    expectedInvoiceExpirySeconds: EXPECTED_INVOICE_EXPIRY_SECONDS,
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
        const dispatchCheckAt = new Date().toISOString();
        const dispatchNowUnix = Math.floor(Date.now() / 1_000);
        if (requests.some((request) => request.expiresAtUnix - dispatchNowUnix < 15)) throw invalidConfiguration();
        const dispatchFreshness = validateInitialObservations({
          runId,
          expectedInvoices: requests.map(({ id, paymentHash, amountSat }) => ({ id, paymentHash, amountSat })),
          observations: sanitizedInitialBobObservations,
          beforeAt: dispatchCheckAt,
          dispatchAtById: { A: dispatchCheckAt, B: dispatchCheckAt },
        });
        if (!dispatchFreshness.valid) throw invalidConfiguration();
        const candidateDeadline = new Date(Date.now() + RECONCILIATION_WINDOW_MS).toISOString();
        for (const lifecycle of invoiceLifecycle) {
          lifecycle.dispatchAt = dispatchCheckAt;
          lifecycle.reconciliationDeadline = candidateDeadline;
          const result = validateInvoiceLifecycle({
            createdAt: lifecycle.createdAt,
            invoiceTimestampUnix: lifecycle.invoiceTimestampUnix,
            expirySeconds: lifecycle.expirySeconds,
            expiresAtUnix: lifecycle.expiresAtUnix,
            dispatchAt: dispatchCheckAt,
            reconciliationDeadline: candidateDeadline,
            requiredGraceSeconds: REQUIRED_GRACE_SECONDS,
            nowAt: dispatchCheckAt,
          });
          if (!result.valid) throw invalidConfiguration();
        }
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
        for (const lifecycle of progress.invoiceLifecycle) {
          lifecycle.reconciliationDeadline = progress.reconciliationDeadline;
          const dispatched = attempts.find((item) => item.id === lifecycle.id);
          lifecycle.dispatchAt = dispatched?.dispatchedAt ?? lifecycle.dispatchAt;
          const validation = validateInvoiceLifecycle({
            createdAt: lifecycle.createdAt,
            invoiceTimestampUnix: lifecycle.invoiceTimestampUnix,
            expirySeconds: lifecycle.expirySeconds,
            expiresAtUnix: lifecycle.expiresAtUnix,
            dispatchAt: lifecycle.dispatchAt,
            reconciliationDeadline: lifecycle.reconciliationDeadline,
            requiredGraceSeconds: REQUIRED_GRACE_SECONDS,
            nowAt: lifecycle.dispatchAt,
          });
          if (!validation.valid) throw invalidConfiguration();
        }
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

  progress.stage = "race_complete_waiting_for_receiver_reconciliation";
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
