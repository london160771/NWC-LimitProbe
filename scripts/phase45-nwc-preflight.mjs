import { readFileSync } from "node:fs";
import { NWC } from "nostr-core";
import { normalizeBudgetMsat } from "./phase45-core.mjs";

const connectionFile = process.env.NWC_URL_FILE ?? "/run/private/nwc-url";
const connectionUrl = readFileSync(connectionFile, "utf8").trim();
const appConfigFile = process.env.APP_CONFIG_FILE ?? "/run/private/app-config.json";
const appConfig = JSON.parse(readFileSync(appConfigFile, "utf8"));
const requiredScopes = ["get_balance", "get_info", "lookup_invoice", "pay_invoice"];
const scopes = Array.isArray(appConfig.scopes) ? [...appConfig.scopes].sort() : [];
const appConfigVerified =
  appConfig.name === "LimitProbe Phase4 Race" &&
  appConfig.maxAmountSat === 1_000 &&
  appConfig.maxAmountMsat === 1_000_000 &&
  appConfig.budgetUsageSat === 0 &&
  appConfig.budgetRenewal === "never" &&
  JSON.stringify(scopes) === JSON.stringify(requiredScopes);
if (!connectionUrl.startsWith("nostr+walletconnect://")) {
  throw new Error("nwc_connection_file_invalid");
}

const client = new NWC(connectionUrl);
client.replyTimeout = 15_000;
client.publishTimeout = 5_000;

function errorCode(error) {
  const candidate = error?.code ?? error?.name ?? "unknown_error";
  const value = String(candidate);
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "unknown_error";
}

let stage = "connect";
try {
  await client.connect();
  stage = "get_info";
  const info = await client.getInfo();
  stage = "get_balance";
  const balance = await client.getBalance();
  stage = "get_budget";
  const budgetResponse = await client.getBudget();
  const budget = normalizeBudgetMsat(budgetResponse);
  const methods = [...new Set(Array.isArray(info?.methods) ? info.methods : [])].sort();
  const requiredMethods = [
    "get_balance",
    "get_budget",
    "get_info",
    "lookup_invoice",
    "pay_invoice",
  ];
  const missingMethods = requiredMethods.filter((method) => !methods.includes(method));
  const balanceMsat = Number(
    balance?.balance ?? balance?.balance_msat ?? balance?.balanceMsat,
  );
  const totalBudgetSat =
    budget.totalBudgetMsat !== null && budget.totalBudgetMsat % 1000 === 0
      ? budget.totalBudgetMsat / 1000
      : null;
  const remainingBudgetSat =
    budget.remainingBudgetMsat !== null && budget.remainingBudgetMsat % 1000 === 0
      ? budget.remainingBudgetMsat / 1000
      : null;
  const renewalOkay = budget.renewalPeriod === null || budget.renewalPeriod === "never";
  const ready =
    appConfigVerified &&
    client.encryption === "nip44" &&
    client.encryptionVerified === true &&
    info?.network === "regtest" &&
    missingMethods.length === 0 &&
    Number.isFinite(balanceMsat) &&
    budget.totalBudgetMsat === 1_000_000 &&
    budget.remainingBudgetMsat === 1_000_000 &&
    budget.usedBudgetMsat === 0 &&
    renewalOkay;

  process.stdout.write(
    `${JSON.stringify(
      {
        test: "phase4-fresh-nwc-preflight",
        connection: "connected",
        encryption: client.encryption ?? null,
        encryptionVerified: client.encryptionVerified === true,
        network: info?.network ?? null,
        methods,
        appConfigVerified,
        configuredScopes: scopes,
        requiredMethodsPresent: missingMethods.length === 0,
        missingMethods,
        balanceMsat: Number.isFinite(balanceMsat) ? balanceMsat : null,
        budgetTotalMsat: budget.totalBudgetMsat,
        budgetUsedMsat: budget.usedBudgetMsat,
        budgetRemainingMsat: budget.remainingBudgetMsat,
        budgetTotalSat: totalBudgetSat,
        budgetRemainingSat: remainingBudgetSat,
        budgetRenewal: appConfig.budgetRenewal,
        budgetRenewalNwc: budget.renewalPeriod,
        budgetVerified: ready,
        secretsRedacted: true,
      },
      null,
      2,
    )}\n`,
  );
  if (!ready) process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      test: "phase4-fresh-nwc-preflight",
      connection: "failed",
      stage,
      encryption: client.encryption ?? null,
      encryptionVerified: client.encryptionVerified === true,
      errorCode: errorCode(error),
      secretsRedacted: true,
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  client.close();
}
