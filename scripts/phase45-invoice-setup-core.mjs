import { randomUUID } from "node:crypto";
import { EXPECTED_INVOICE_EXPIRY_SECONDS, REQUIRED_GRACE_SECONDS } from "./phase45-core.mjs";

const IDS = ["A", "B"];

export function normalizeInvoiceAcquiredAt(value) {
  const match = typeof value === "string"
    ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{3,9})Z$/.exec(value)
    : null;
  if (!match) return null;
  const millisecondTimestamp = `${match[1]}.${match[2].slice(0, 3)}Z`;
  const parsed = Date.parse(millisecondTimestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== millisecondTimestamp) return null;
  return millisecondTimestamp;
}

export function beginInvoiceSetup(existingState = null, setupId = randomUUID()) {
  if (existingState !== null) throw new Error("invoice_setup_state_already_exists");
  return {
    schemaVersion: 1,
    setupId,
    status: "creating",
    intentId: "A",
    createdAt: new Date().toISOString(),
    receipts: {},
  };
}

export function setInvoiceIntent(state, id) {
  if (!state || !["creating", "partial_ambiguous"].includes(state.status) || !IDS.includes(id)) throw new Error("invoice_setup_state_invalid");
  const expected = Object.keys(state.receipts ?? {}).length === 0 ? "A" : "B";
  if (id !== expected || (id === "B" && !state.receipts.A)) throw new Error("invoice_setup_order_invalid");
  return { ...state, intentId: id, status: "creating" };
}

export function recordInvoiceReceipt(state, { id, paymentHash, amountSat, createdAt, invoiceTimestampUnix, expirySeconds, expiresAtUnix }) {
  if (!state || !["creating", "partial_ambiguous"].includes(state.status) || state.intentId !== id || !IDS.includes(id) ||
      !/^[0-9a-f]{64}$/i.test(paymentHash ?? "") || amountSat !== 700 || typeof createdAt !== "string" ||
      !Number.isSafeInteger(invoiceTimestampUnix) || !Number.isSafeInteger(expirySeconds) || !Number.isSafeInteger(expiresAtUnix) ||
      expiresAtUnix !== invoiceTimestampUnix + expirySeconds || state.receipts?.[id]) throw new Error("invoice_receipt_invalid_or_duplicate");
  const receipts = { ...state.receipts, [id]: { id, paymentHash: paymentHash.toLowerCase(), amountSat, createdAt, invoiceTimestampUnix, expirySeconds, expiresAtUnix } };
  const complete = IDS.every((key) => receipts[key]);
  return { ...state, receipts, status: complete ? "complete" : "partial_ambiguous", intentId: complete ? null : "B" };
}

export function markInvoiceSetupPartial(state, id) {
  if (!state || !IDS.includes(id) || state.intentId !== id) throw new Error("invoice_setup_failure_binding_invalid");
  return { ...state, status: "partial_ambiguous", failedId: id };
}

export function assertNormalInvoiceSetupMayStart(existingState, existingRunConfig) {
  if (existingState !== null || existingRunConfig !== null) throw new Error("existing_invoice_setup_refuses_new_pair");
  return true;
}

export function buildPhase62RunConfig(state, {
  runId = randomUUID(),
  createdAt = new Date().toISOString(),
  noOtherPayerPathVerified,
} = {}) {
  const invoices = ["A", "B"].map((id) => state?.receipts?.[id]);
  if (state?.status !== "complete" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId) ||
      typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) || noOtherPayerPathVerified !== true ||
      invoices.some((item, index) => item?.id !== IDS[index] || !/^[0-9a-f]{64}$/i.test(item.paymentHash ?? "") ||
        item.amountSat !== 700 || item.expirySeconds !== EXPECTED_INVOICE_EXPIRY_SECONDS ||
        item.expiresAtUnix !== item.invoiceTimestampUnix + EXPECTED_INVOICE_EXPIRY_SECONDS) ||
      new Set(invoices.map((item) => item.paymentHash)).size !== 2) {
    throw new Error("invoice_run_config_binding_invalid");
  }
  return {
    runId,
    createdAt,
    network: "regtest",
    invoicesCreatedForRun: true,
    noOtherPayerPathVerified: true,
    invoiceExpirySeconds: EXPECTED_INVOICE_EXPIRY_SECONDS,
    requiredGraceSeconds: REQUIRED_GRACE_SECONDS,
    invoices,
    expectedInvoices: invoices.map(({ id, paymentHash, amountSat, expiresAtUnix }) => ({ id, paymentHash, amountSat, expiresAtUnix })),
  };
}
