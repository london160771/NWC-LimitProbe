import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNormalInvoiceSetupMayStart,
  beginInvoiceSetup,
  markInvoiceSetupPartial,
  recordInvoiceReceipt,
  setInvoiceIntent,
} from "../scripts/phase45-invoice-setup-core.mjs";

const receipt = (id, char) => ({
  id, paymentHash: char.repeat(64), amountSat: 700,
  createdAt: "2026-10-01T12:00:00.000Z", invoiceTimestampUnix: 1790856000,
  expirySeconds: 120, expiresAtUnix: 1790856120,
});

test("invoice setup persists A-only evidence and refuses a duplicate pair after interruption", () => {
  const started = beginInvoiceSetup(null, "setup-a");
  const afterA = recordInvoiceReceipt(started, receipt("A", "a"));
  assert.equal(afterA.status, "partial_ambiguous");
  assert.equal(afterA.receipts.A.paymentHash, "a".repeat(64));
  assert.throws(() => assertNormalInvoiceSetupMayStart(afterA, null), /refuses_new_pair/);
  assert.throws(() => beginInvoiceSetup(afterA, "setup-b"), /already_exists/);
});

test("B creation failure retains the A receipt and blocks normal restart", () => {
  const afterA = recordInvoiceReceipt(beginInvoiceSetup(null, "setup-b"), receipt("A", "a"));
  const beforeB = setInvoiceIntent(afterA, "B");
  const failedB = markInvoiceSetupPartial(beforeB, "B");
  assert.equal(failedB.status, "partial_ambiguous");
  assert.equal(failedB.failedId, "B");
  assert.deepEqual(Object.keys(failedB.receipts), ["A"]);
  assert.throws(() => assertNormalInvoiceSetupMayStart(failedB, null), /refuses_new_pair/);
});

test("a receipt cannot be written twice or out of invoice order", () => {
  const afterA = recordInvoiceReceipt(beginInvoiceSetup(null, "setup-c"), receipt("A", "a"));
  assert.throws(() => recordInvoiceReceipt(afterA, receipt("A", "c")), /invalid_or_duplicate/);
  assert.throws(() => recordInvoiceReceipt(setInvoiceIntent(afterA, "B"), receipt("A", "c")), /invalid_or_duplicate/);
  const afterB = recordInvoiceReceipt(setInvoiceIntent(afterA, "B"), receipt("B", "b"));
  assert.equal(afterB.status, "complete");
  assert.equal(afterB.receipts.A.paymentHash, "a".repeat(64));
  assert.equal(afterB.receipts.B.paymentHash, "b".repeat(64));
});
