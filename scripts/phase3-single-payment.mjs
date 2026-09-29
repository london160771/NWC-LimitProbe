import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { NWC } from "nostr-core";

const secretDirectory = process.env.LIMITPROBE_SECRET_DIR ?? "/run/secrets";
const connectionUrl = readFileSync(`${secretDirectory}/nwc-url`, "utf8").trim();
const invoice = readFileSync(`${secretDirectory}/bob-invoice`, "utf8").trim();
const paymentHash = readFileSync(`${secretDirectory}/bob-payment-hash`, "utf8").trim();
const requestedPrincipalSat = Number(process.env.REQUESTED_PRINCIPAL_SAT ?? "1000");

if (!connectionUrl.startsWith("nostr+walletconnect://") || !invoice || !/^[0-9a-f]{64}$/i.test(paymentHash)) {
  throw new Error("Required local NWC or receiver invoice input is invalid.");
}

const client = new NWC(connectionUrl);
client.replyTimeout = 30_000;
client.publishTimeout = 5_000;

function safeErrorCode(error) {
  if (typeof error?.code === "string") return error.code;
  if (typeof error?.name === "string") return error.name;
  return "unknown_error";
}

function terminal(state) {
  return ["settled", "failed", "expired"].includes(state);
}

let report;
try {
  await client.connect();
  const info = await client.getInfo();
  const methods = Array.isArray(info?.methods) ? info.methods : [];
  const missingMethods = ["lookup_invoice", "pay_invoice"].filter((method) => !methods.includes(method));
  if (missingMethods.length > 0) {
    throw Object.assign(new Error("Required NWC capability missing."), { code: "MISSING_CAPABILITY" });
  }

  const payerBalance = await client.getBalance();
  const dispatchTimestamp = new Date().toISOString();
  const dispatchStart = performance.now();
  let payResponse;
  let payErrorCode = null;
  let feesPaidMsat = null;
  try {
    const paymentResponse = await client.payInvoice(invoice);
    feesPaidMsat = paymentResponse?.fees_paid ?? paymentResponse?.feesPaidMsat ?? null;
    payResponse = "success";
  } catch (error) {
    payResponse = "error";
    payErrorCode = safeErrorCode(error);
  }
  const responseTimestamp = new Date().toISOString();
  const payDurationMs = Math.round(performance.now() - dispatchStart);

  client.replyTimeout = 5_000;
  const maxLookupAttempts = 5;
  const lookupIntervalMs = 1_000;
  const lookupObservations = [];
  let finalLookup = null;
  let lookupErrorCode = null;

  for (let attempt = 1; attempt <= maxLookupAttempts; attempt += 1) {
    try {
      const observation = await client.lookupInvoice({ payment_hash: paymentHash });
      finalLookup = observation;
      lookupObservations.push({
        attempt,
        observedAt: new Date().toISOString(),
        type: observation?.type ?? null,
        state: observation?.state ?? null,
        amountMsat: observation?.amount ?? observation?.amount_msat ?? null,
        feesPaidMsat: observation?.fees_paid ?? observation?.feesPaidMsat ?? null,
        settledAt: observation?.settled_at ?? observation?.settledAt ?? null,
      });
      lookupErrorCode = null;
      if (terminal(observation?.state)) break;
    } catch (error) {
      lookupErrorCode = safeErrorCode(error);
      lookupObservations.push({
        attempt,
        observedAt: new Date().toISOString(),
        errorCode: lookupErrorCode,
      });
    }
    if (attempt < maxLookupAttempts) {
      await new Promise((resolve) => setTimeout(resolve, lookupIntervalMs));
    }
  }

  report = {
    test: "phase3-single-nwc-payment",
    network: info?.network ?? null,
    requestedPrincipalSat,
    payerBalanceBeforeMsat:
      payerBalance?.balance ?? payerBalance?.balance_msat ?? payerBalance?.balanceMsat ?? null,
    dispatchTimestamp,
    responseTimestamp,
    payResponse,
    payErrorCode,
    payDurationMs,
    feesPaidMsat,
    lookup: {
      attempts: lookupObservations.length,
      maxAttempts: maxLookupAttempts,
      intervalMs: lookupIntervalMs,
      finalState: finalLookup?.state ?? null,
      finalType: finalLookup?.type ?? null,
      settledAmountMsat:
        finalLookup?.amount ?? finalLookup?.amount_msat ?? null,
      feesPaidMsat:
        finalLookup?.fees_paid ?? finalLookup?.feesPaidMsat ?? null,
      settledAt: finalLookup?.settled_at ?? finalLookup?.settledAt ?? null,
      finalErrorCode: lookupErrorCode,
      observations: lookupObservations,
    },
    paymentHash,
    invoiceRedacted: true,
    preimageRedacted: true,
    connectionUriRedacted: true,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (finalLookup?.state !== "settled") process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      test: "phase3-single-nwc-payment",
      status: "failed_before_reconciliation",
      errorCode: safeErrorCode(error),
      invoiceRedacted: true,
      preimageRedacted: true,
      connectionUriRedacted: true,
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  client.close();
}
