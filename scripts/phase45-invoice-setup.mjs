import { chmodSync, existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { decodeBolt11 } from "nostr-core";
import {
  assertNormalInvoiceSetupMayStart,
  buildPhase62RunConfig,
  beginInvoiceSetup,
  markInvoiceSetupPartial,
  normalizeInvoiceAcquiredAt,
  recordInvoiceReceipt,
  setInvoiceIntent,
} from "./phase45-invoice-setup-core.mjs";

const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
const [action, id] = process.argv.slice(2);
const statePath = `${privateDirectory}/phase62-invoice-creation-state.json`;
const runConfigPath = `${privateDirectory}/phase6-run-config.json`;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;

function persist(value) {
  const temp = `${statePath}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temp, 0o600);
  renameSync(temp, statePath);
  chmodSync(statePath, 0o600);
}

if (action === "intent" && id === "A") {
  assertNormalInvoiceSetupMayStart(state, existsSync(runConfigPath) ? true : null);
  const next = beginInvoiceSetup(null, randomUUID());
  persist(next);
} else if (action === "intent" && id === "B") {
  if (!state || state.status !== "partial_ambiguous" || !state.receipts?.A) throw new Error("invoice_setup_partial_state_refused");
  persist(setInvoiceIntent(state, "B"));
} else if (action === "failed" && (id === "A" || id === "B")) {
  if (!state) throw new Error("invoice_setup_intent_missing");
  persist(markInvoiceSetupPartial(state, id));
} else if (action === "abandon" && typeof id === "string") {
  if (!state || state.setupId !== id || state.status === "complete") throw new Error("invoice_setup_abandon_binding_invalid");
  persist({ ...state, status: "abandoned_preserved", abandonedAt: new Date().toISOString() });
} else if (action === "capture" && (id === "A" || id === "B")) {
  if (!state || state.intentId !== id) throw new Error("invoice_creation_intent_mismatch");
  const suffix = id.toLowerCase();
  const rawPath = `${privateDirectory}/bob-addinvoice-${suffix}.json`;
  const acquiredPath = `${privateDirectory}/bob-addinvoice-${suffix}.acquired-at`;
  const raw = JSON.parse(readFileSync(rawPath, "utf8"));
  const invoice = raw?.payment_request;
  const decoded = typeof invoice === "string" ? decodeBolt11(invoice) : null;
  const paymentHash = String(raw?.r_hash ?? "").toLowerCase();
  const acquiredAt = readFileSync(acquiredPath, "utf8").trim();
  const createdAt = normalizeInvoiceAcquiredAt(acquiredAt);
  const now = Date.now();
  if (typeof invoice !== "string" || !invoice.startsWith("lnbcrt") || decoded?.network !== "regtest" ||
      decoded?.amountSat !== 700 || decoded?.expiry !== 120 || !/^[0-9a-f]{64}$/.test(paymentHash) ||
      decoded?.paymentHash !== paymentHash || !Number.isSafeInteger(decoded?.timestamp) ||
      Math.abs(Math.floor(now / 1000) - decoded.timestamp) > 30 || decoded.expiresAt !== decoded.timestamp + 120 ||
      createdAt === null) throw new Error("invoice_capture_validation_failed");
  const invoicePath = `${privateDirectory}/bob-invoice-${suffix}`;
  const hashPath = `${privateDirectory}/bob-payment-hash-${suffix}`;
  const next = recordInvoiceReceipt(state, {
    id, paymentHash, amountSat: decoded.amountSat, createdAt,
    invoiceTimestampUnix: decoded.timestamp, expirySeconds: decoded.expiry, expiresAtUnix: decoded.expiresAt,
  });
  persist(next);
  writeFileSync(invoicePath, `${invoice}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(invoicePath, 0o600);
  writeFileSync(hashPath, `${paymentHash}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(hashPath, 0o600);
  if (next.status === "complete") {
    if (existsSync(runConfigPath)) throw new Error("run_config_already_exists");
    const runConfig = buildPhase62RunConfig(next, {
      runId: randomUUID(),
      createdAt: new Date().toISOString(),
      noOtherPayerPathVerified: process.env.NWC_LIMITPROBE_SINGLE_PAYER_CONFIRMED === "1",
    });
    writeFileSync(runConfigPath, `${JSON.stringify(runConfig, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(runConfigPath, 0o600);
  }
  unlinkSync(rawPath);
  unlinkSync(acquiredPath);
  process.stdout.write(`${JSON.stringify({ invoiceCaptured: true, id, paymentHash, amountSat: 700, invoiceSecretRedacted: true })}\n`);
} else {
  throw new Error("invoice_setup_action_invalid");
}
