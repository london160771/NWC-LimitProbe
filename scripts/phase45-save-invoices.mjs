import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { decodeBolt11 } from "nostr-core";

const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
const ids = ["a", "b"];
const expectedExpirySeconds = 120;
const prepared = ids.map((id) => {
  let raw;
  try {
    raw = JSON.parse(readFileSync(`${privateDirectory}/bob-addinvoice-${id}.json`, "utf8"));
  } catch {
    throw new Error(`bob_addinvoice_${id}_output_invalid`);
  }

  const invoice = raw?.payment_request;
  const paymentHash = String(raw?.r_hash ?? "").toLowerCase();
  let decoded = null;
  try { decoded = typeof invoice === "string" ? decodeBolt11(invoice) : null; } catch {}
  if (
    typeof invoice !== "string" ||
    !invoice.startsWith("lnbcrt") ||
    !/^[0-9a-f]{64}$/.test(paymentHash) ||
    decoded?.network !== "regtest" ||
    decoded?.amountSat !== 700 ||
    decoded?.expiry !== expectedExpirySeconds ||
    !Number.isSafeInteger(decoded?.timestamp) || Math.abs(Math.floor(Date.now() / 1_000) - decoded.timestamp) > 30 ||
    decoded?.paymentHash !== paymentHash
  ) {
    throw new Error(`bob_invoice_${id}_validation_failed`);
  }
  return { id, invoice, paymentHash, amountSat: decoded.amountSat };
});

if (
  prepared[0].paymentHash === prepared[1].paymentHash ||
  prepared[0].invoice === prepared[1].invoice
) {
  throw new Error("two_distinct_invoices_required");
}

for (const attempt of prepared) {
  for (const [suffix, value] of [
    ["invoice", attempt.invoice],
    ["payment-hash", attempt.paymentHash],
  ]) {
    const path = `${privateDirectory}/bob-${suffix}-${attempt.id}`;
    writeFileSync(path, `${value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
  }
}

const runConfig = {
  runId: randomUUID(),
  createdAt: new Date().toISOString(),
  network: "regtest",
  invoicesCreatedForRun: true,
  noOtherPayerPathVerified: process.env.NWC_LIMITPROBE_SINGLE_PAYER_CONFIRMED === "1",
  invoiceExpirySeconds: expectedExpirySeconds,
  invoices: prepared.map(({ id, paymentHash, amountSat }) => ({
    id: id.toUpperCase(),
    paymentHash,
    amountSat,
    invoiceIssuedAtUnix: decodeBolt11(prepared.find((item) => item.id === id).invoice).timestamp,
    invoiceExpiresAtUnix: decodeBolt11(prepared.find((item) => item.id === id).invoice).expiresAt,
  })),
  expectedInvoices: prepared.map(({ id, paymentHash, amountSat }) => ({
    id: id.toUpperCase(),
    paymentHash,
    amountSat,
  })),
};
const runConfigPath = `${privateDirectory}/phase6-run-config.json`;
writeFileSync(runConfigPath, `${JSON.stringify(runConfig, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
chmodSync(runConfigPath, 0o600);

for (const id of ids) unlinkSync(`${privateDirectory}/bob-addinvoice-${id}.json`);

process.stdout.write(
  `${JSON.stringify({
    invoicesCreated: prepared.length,
    runId: runConfig.runId,
    invoices: prepared.map(({ id, paymentHash, amountSat }) => ({ id, paymentHash, amountSat })),
    network: "regtest",
    invoiceExpirySeconds: expectedExpirySeconds,
    invoicesCreatedForRun: runConfig.invoicesCreatedForRun,
    noOtherPayerPathVerified: runConfig.noOtherPayerPathVerified,
    bolt11Redacted: true,
  })}\n`,
);
