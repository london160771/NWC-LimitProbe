import { readFileSync } from "node:fs";
import { NWC } from "nostr-core";
import { captureBudgetSnapshot, safeErrorCode, sanitizeNwcLookup } from "./phase45-core.mjs";
import { persistPrivateProgress } from "./phase45-progress.mjs";

const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
const resultPath = `${privateDirectory}/phase45-race-results.json`;
let result;
try { result = JSON.parse(readFileSync(resultPath, "utf8")); } catch {
  result = JSON.parse(readFileSync(`${privateDirectory}/phase45-race-progress.json`, "utf8"));
}
const runConfig = JSON.parse(readFileSync(`${privateDirectory}/phase6-run-config.json`, "utf8"));
const bobEvidence = JSON.parse(readFileSync(`${privateDirectory}/bob-final-evidence.json`, "utf8"));
if (
  result.runId !== runConfig.runId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runConfig.runId ?? "") ||
  bobEvidence.runId !== result.runId || bobEvidence.phase !== "final" ||
  !["completed_deadline", "completed_terminal", "interrupted", "collector_error", "query_timeout"].includes(bobEvidence.completionStatus) ||
  !Number.isFinite(Date.parse(bobEvidence.completedAt)) ||
  !Array.isArray(runConfig.expectedInvoices) ||
  runConfig.expectedInvoices.length !== 2 ||
  !["A", "B"].every((id) => runConfig.expectedInvoices.some((invoice) =>
    invoice?.id === id && typeof invoice.paymentHash === "string" && /^[0-9a-f]{64}$/i.test(invoice.paymentHash) && invoice.amountSat === 700
  )) ||
  new Set(runConfig.expectedInvoices.map((invoice) => invoice.paymentHash)).size !== 2
) {
  throw new Error("run_binding_invalid");
}
let connectionUrl = "";
let client = null;
let connectionErrorCode = null;
try {
  connectionUrl = readFileSync(`${privateDirectory}/nwc-url`, "utf8").trim();
} catch {
  connectionErrorCode = "CONNECTION_FAILED";
}
if (!connectionErrorCode && !connectionUrl.startsWith("nostr+walletconnect://")) connectionErrorCode = "BAD_REQUEST";
if (!connectionErrorCode) {
  try {
    client = new NWC(connectionUrl);
    client.replyTimeout = 15_000;
    client.publishTimeout = 5_000;
    await client.connect();
  } catch (error) {
    connectionErrorCode = safeErrorCode(error);
  }
}
try {
  const observations = connectionErrorCode
    ? runConfig.expectedInvoices.map((invoice) => sanitizeNwcLookup({
        runId: result.runId,
        id: invoice.id,
        requestedHash: invoice.paymentHash,
        expectedAmountSat: invoice.amountSat,
        error: { code: connectionErrorCode === "NOT_FOUND" ? "CONNECTION_FAILED" : connectionErrorCode },
      }))
    : await Promise.all(runConfig.expectedInvoices.map(async (invoice) => {
        try {
          const lookup = await client.lookupInvoice({ payment_hash: invoice.paymentHash });
          return sanitizeNwcLookup({
            runId: result.runId,
            id: invoice.id,
            requestedHash: invoice.paymentHash,
            expectedAmountSat: invoice.amountSat,
            lookup,
          });
        } catch (error) {
          return sanitizeNwcLookup({
            runId: result.runId,
            id: invoice.id,
            requestedHash: invoice.paymentHash,
            expectedAmountSat: invoice.amountSat,
            error,
          });
        }
      }));
  result.nwcLookups = [...(Array.isArray(result.nwcLookups) ? result.nwcLookups : []), ...observations];
  result.finalNwcLookupCompletedAt = new Date().toISOString();
  result.finalBobEvidenceCompletedAt = bobEvidence.completedAt;
  result.stage = "final_nwc_lookup_started";
  persistPrivateProgress(resultPath, result);
  persistPrivateProgress(`${privateDirectory}/phase45-race-progress.json`, result);
  try {
    if (connectionErrorCode) throw Object.assign(new Error("final_lookup_connection_failed"), { code: connectionErrorCode });
    const rawBudget = await client.getBudget();
    result.budgetAfter = captureBudgetSnapshot(rawBudget, {
      kind: "final", runId: result.runId, observedAt: new Date().toISOString(),
    });
    result.budgetAfterErrorCode = null;
  } catch (error) {
    result.budgetAfter = null;
    result.budgetAfterErrorCode = safeErrorCode(error);
  }
  result.finalBudgetCapturedAt = result.budgetAfter?.observedAt ?? new Date().toISOString();
  result.stage = "final_nwc_lookup_and_budget_complete";
  persistPrivateProgress(resultPath, result);
  persistPrivateProgress(`${privateDirectory}/phase45-race-progress.json`, result);
  process.stdout.write(`${JSON.stringify({
    runId: result.runId,
    finalNwcLookups: observations.map(({ id, requestedHash, returnedHash, lookupState, amountMsat, observedAt, errorCode }) => ({
      id, requestedHash, returnedHash, lookupState, amountMsat, observedAt, errorCode,
    })),
    finalNwcConnectionErrorCode: connectionErrorCode,
    finalBudgetCapturedAt: result.finalBudgetCapturedAt,
    finalBudgetVerified: result.budgetAfter?.capturedValidationStatus === "valid",
    secretsRedacted: true,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    runId: result.runId,
    stage: "final_nwc_lookup",
    errorCode: safeErrorCode(error),
    secretsRedacted: true,
  })}\n`);
  process.exitCode = 1;
} finally {
  client?.close();
}
