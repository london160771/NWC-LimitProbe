import {
  chmodSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { decodeBolt11, NWC } from "nostr-core";
import { dispatchTwoPayments, normalizeBudgetMsat } from "./phase45-core.mjs";

const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
const appConfig = JSON.parse(readFileSync(`${privateDirectory}/app-config.json`, "utf8"));
const initialBob = JSON.parse(readFileSync(`${privateDirectory}/bob-initial-lookups.json`, "utf8"));
const sentinelFile = `${privateDirectory}/phase45-payment-dispatch-started`;
const resultFile = `${privateDirectory}/phase45-race-results.json`;
const requiredScopes = ["get_balance", "get_info", "lookup_invoice", "pay_invoice"];
const actualScopes = Array.isArray(appConfig.scopes) ? [...appConfig.scopes].sort() : [];

if (
  appConfig.name !== "LimitProbe Phase4 Race" ||
  appConfig.maxAmountSat !== 1_000 ||
  appConfig.maxAmountMsat !== 1_000_000 ||
  appConfig.budgetUsageSat !== 0 ||
  appConfig.budgetRenewal !== "never" ||
  JSON.stringify(actualScopes) !== JSON.stringify(requiredScopes)
) {
  throw new Error("fresh_app_configuration_changed");
}
if (
  initialBob?.phase !== "initial" ||
  initialBob?.allValidAndUnpaid !== true ||
  !Array.isArray(initialBob.invoices) ||
  initialBob.invoices.length !== 2
) {
  throw new Error("both_bob_invoices_must_be_verified_unpaid_before_dispatch");
}

const requests = ["a", "b"].map((id) => {
  const invoice = readFileSync(`${privateDirectory}/bob-invoice-${id}`, "utf8").trim();
  const paymentHash = readFileSync(`${privateDirectory}/bob-payment-hash-${id}`, "utf8")
    .trim()
    .toLowerCase();
  const decoded = decodeBolt11(invoice);
  if (
    !invoice.startsWith("lnbcrt") ||
    decoded?.network !== "regtest" ||
    decoded?.amountSat !== 700 ||
    decoded?.paymentHash !== paymentHash
  ) {
    throw new Error(`invoice_${id}_no_longer_matches_preflight`);
  }
  return { id: id.toUpperCase(), invoice, paymentHash, amountSat: 700 };
});
if (
  requests[0].paymentHash === requests[1].paymentHash ||
  requests[0].invoice === requests[1].invoice
) {
  throw new Error("race_requires_two_distinct_invoices");
}

const connectionUrl = readFileSync(`${privateDirectory}/nwc-url`, "utf8").trim();
if (!connectionUrl.startsWith("nostr+walletconnect://")) {
  throw new Error("nwc_connection_file_invalid");
}
const client = new NWC(connectionUrl);
client.replyTimeout = 30_000;
client.publishTimeout = 5_000;

function errorCode(error) {
  const candidate = error?.code ?? error?.error?.code ?? error?.name ?? "unknown_error";
  const value = String(candidate);
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "unknown_error";
}

function safeLookup(lookup) {
  if (!lookup || typeof lookup !== "object") return null;
  return {
    state: typeof lookup.state === "string" ? lookup.state : null,
    paymentHash:
      typeof lookup.payment_hash === "string"
        ? lookup.payment_hash.toLowerCase()
        : typeof lookup.paymentHash === "string"
          ? lookup.paymentHash.toLowerCase()
          : null,
    amountMsat:
      Number.isFinite(Number(lookup.amount)) ? Number(lookup.amount) : null,
    feesPaidMsat:
      Number.isFinite(Number(lookup.fees_paid)) ? Number(lookup.fees_paid) : null,
    settledAt: Number.isFinite(Number(lookup.settled_at)) ? Number(lookup.settled_at) : null,
  };
}

let stage = "connect";
try {
  await client.connect();
  stage = "budget_before_dispatch";
  const info = await client.getInfo();
  const before = normalizeBudgetMsat(await client.getBudget());
  const startingBudgetCapturedAt = new Date().toISOString();
  const startBudgetReady =
    client.encryption === "nip44" &&
    client.encryptionVerified === true &&
    info?.network === "regtest" &&
    before.totalBudgetMsat === 1_000_000 &&
    before.usedBudgetMsat === 0 &&
    before.remainingBudgetMsat === 1_000_000 &&
    (before.renewalPeriod === null || before.renewalPeriod === "never");
  if (!startBudgetReady) throw new Error("starting_spendable_budget_not_1000_sat");

  const requestsPreparedAt = new Date().toISOString();
  stage = "concurrent_pay_invoice";
  const dispatch = await dispatchTwoPayments(
    requests,
    (invoice) => client.payInvoice(invoice),
    {
      beforeRelease: () => {
        writeFileSync(sentinelFile, `${new Date().toISOString()}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        chmodSync(sentinelFile, 0o600);
      },
    },
  );

  stage = "nwc_lookup_invoice";
  const nwcLookups = [];
  for (const attempt of requests) {
    try {
      const lookup = await client.lookupInvoice({ payment_hash: attempt.paymentHash });
      nwcLookups.push({ id: attempt.id, paymentHash: attempt.paymentHash, ...safeLookup(lookup), errorCode: null });
    } catch (error) {
      nwcLookups.push({
        id: attempt.id,
        paymentHash: attempt.paymentHash,
        state: null,
        amountMsat: null,
        feesPaidMsat: null,
        settledAt: null,
        errorCode: errorCode(error),
      });
    }
  }

  stage = "budget_after_race";
  let afterBudget = null;
  let afterBudgetErrorCode = null;
  try {
    afterBudget = normalizeBudgetMsat(await client.getBudget());
  } catch (error) {
    afterBudgetErrorCode = errorCode(error);
  }

  const result = {
    schemaVersion: 1,
    test: "phase4-two-payment-budget-race",
    wallet: "Alby Hub / Alice",
    network: "regtest",
    relay: "ws://limitprobe-relay:8080",
    encryption: client.encryption,
    encryptionVerified: client.encryptionVerified === true,
    requestsPreparedAt,
    startingBudgetCapturedAt,
    startingBudget: {
      totalMsat: before.totalBudgetMsat,
      usedMsat: before.usedBudgetMsat,
      spendableMsat: before.remainingBudgetMsat,
      spendableSats: before.remainingBudgetMsat / 1000,
      renewal: appConfig.budgetRenewal,
    },
    barrierReleasedAt: dispatch.barrierReleasedAt,
    dispatchDeltaMs: dispatch.dispatchDeltaMs,
    attempts: dispatch.attempts,
    nwcLookups,
    budgetAfter: afterBudget,
    budgetAfterErrorCode: afterBudgetErrorCode,
    preimagesRedacted: true,
    invoicesRedacted: true,
    connectionUriRedacted: true,
  };
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(resultFile, 0o600);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      test: "phase4-two-payment-budget-race",
      stage,
      errorCode: errorCode(error),
      paymentMayHaveBeenDispatched: stage === "concurrent_pay_invoice",
      secretsRedacted: true,
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  client.close();
}
