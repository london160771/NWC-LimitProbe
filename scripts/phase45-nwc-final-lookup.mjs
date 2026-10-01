import { readFileSync } from "node:fs";
import { NWC } from "nostr-core";
import { safeErrorCode, sanitizeNwcLookup } from "./phase45-core.mjs";
import { persistPrivateProgress } from "./phase45-progress.mjs";

const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
const resultPath = `${privateDirectory}/phase45-race-results.json`;
let result;
try { result = JSON.parse(readFileSync(resultPath, "utf8")); } catch {
  result = JSON.parse(readFileSync(`${privateDirectory}/phase45-race-progress.json`, "utf8"));
}
const runConfig = JSON.parse(readFileSync(`${privateDirectory}/phase6-run-config.json`, "utf8"));
if (
  result.runId !== runConfig.runId ||
  !/^[A-Za-z0-9-]{1,80}$/.test(runConfig.runId ?? "") ||
  !Array.isArray(runConfig.expectedInvoices) ||
  runConfig.expectedInvoices.length !== 2 ||
  !["A", "B"].every((id) => runConfig.expectedInvoices.some((invoice) =>
    invoice?.id === id && typeof invoice.paymentHash === "string" && /^[0-9a-f]{64}$/i.test(invoice.paymentHash) && invoice.amountSat === 700
  )) ||
  new Set(runConfig.expectedInvoices.map((invoice) => invoice.paymentHash)).size !== 2
) {
  throw new Error("run_binding_invalid");
}
const connectionUrl = readFileSync(`${privateDirectory}/nwc-url`, "utf8").trim();
let client = null;
try {
  if (!connectionUrl.startsWith("nostr+walletconnect://")) {
    const error = new Error("connection_file_invalid");
    error.code = "BAD_REQUEST";
    throw error;
  }
  client = new NWC(connectionUrl);
  client.replyTimeout = 15_000;
  client.publishTimeout = 5_000;
  await client.connect();
  const observations = await Promise.all(runConfig.expectedInvoices.map(async (invoice) => {
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
  result.stage = "final_nwc_lookup_complete";
  persistPrivateProgress(resultPath, result);
  persistPrivateProgress(`${privateDirectory}/phase45-race-progress.json`, result);
  process.stdout.write(`${JSON.stringify({
    runId: result.runId,
    finalNwcLookups: observations.map(({ id, requestedHash, returnedHash, lookupState, amountMsat, observedAt, errorCode }) => ({
      id, requestedHash, returnedHash, lookupState, amountMsat, observedAt, errorCode,
    })),
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
