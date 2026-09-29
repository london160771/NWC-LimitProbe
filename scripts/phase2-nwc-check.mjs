import { readFileSync } from "node:fs";
import { NWC } from "nostr-core";

const credentialFile = process.env.NWC_URL_FILE ?? "/run/secrets/nwc-url";
const connectionUrl = readFileSync(credentialFile, "utf8").trim();
if (!connectionUrl.startsWith("nostr+walletconnect://")) {
  throw new Error("NWC credential file is not a valid connection URI.");
}
const uri = new URL(connectionUrl);
const relayTarget = uri.searchParams.get("relay");
const relaySummary = relayTarget
  ? (() => {
      const relay = new URL(relayTarget);
      return `${relay.protocol}//${relay.host}`;
    })()
  : null;

const client = new NWC(connectionUrl);
client.replyTimeout = 10_000;
client.publishTimeout = 5_000;
let stage = "connect";

function safeErrorCode(error) {
  if (typeof error?.code === "string") return error.code;
  if (typeof error?.name === "string") return error.name;
  return "unknown_error";
}

function safeErrorMessage(error) {
  return String(error?.message ?? "")
    .replace(/nostr\+walletconnect:\/\/\S+/gi, "[NWC_URI_REDACTED]")
    .replace(/\b(?:lnbc|lntb|lnbcrt)[a-z0-9]+\b/gi, "[INVOICE_REDACTED]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[HEX_REDACTED]")
    .replace(/(secret|preimage|macaroon|password|token)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]")
    .slice(0, 240);
}

try {
  await client.connect();
  stage = "get_info";
  const info = await client.getInfo();
  stage = "get_balance";
  const balance = await client.getBalance();
  const methods = [...new Set(Array.isArray(info?.methods) ? info.methods : [])].sort();
  const requiredMethods = ["get_balance", "get_info", "lookup_invoice", "pay_invoice"];
  const missingMethods = requiredMethods.filter((method) => !methods.includes(method));
  let budgetQuery = "not_advertised";

  if (methods.includes("get_budget") && typeof client.getBudget === "function") {
    try {
      await client.getBudget();
      budgetQuery = "succeeded";
    } catch (error) {
      budgetQuery = `failed:${safeErrorCode(error)}`;
    }
  }

  const balanceMsat =
    balance?.balance ?? balance?.balance_msat ?? balance?.balanceMsat ?? null;
  const result = {
    test: "phase2-nwc-capabilities",
    connection: "connected",
    relay: relaySummary,
    encryption: client.encryption ?? null,
    encryptionVerified: client.encryptionVerified,
    network: info?.network ?? null,
    methods,
    requiredMethodsPresent: missingMethods.length === 0,
    missingMethods,
    payerBalanceMsat: balanceMsat,
    budgetMethod: budgetQuery,
    configuredConnectionBudget: { amount: 10_000, unit: "sat", renewal: "never" },
    connectionUriRedacted: true,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (missingMethods.length > 0) process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      test: "phase2-nwc-capabilities",
      connection: "failed",
      stage,
      relay: relaySummary,
      detectedEncryption: client.encryption ?? null,
      encryptionVerified: client.encryptionVerified,
      errorCode: safeErrorCode(error),
      errorMessage: safeErrorMessage(error),
      connectionUriRedacted: true,
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  client.close();
}
