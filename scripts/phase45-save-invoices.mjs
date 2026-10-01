import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { decodeBolt11 } from "nostr-core";

const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
const ids = ["a", "b"];
const prepared = ids.map((id) => {
  let raw;
  try {
    raw = JSON.parse(readFileSync(`${privateDirectory}/bob-addinvoice-${id}.json`, "utf8"));
  } catch {
    throw new Error(`bob_addinvoice_${id}_output_invalid`);
  }

  const invoice = raw?.payment_request;
  const paymentHash = String(raw?.r_hash ?? "").toLowerCase();
  const decoded = typeof invoice === "string" ? decodeBolt11(invoice) : null;
  if (
    typeof invoice !== "string" ||
    !invoice.startsWith("lnbcrt") ||
    !/^[0-9a-f]{64}$/.test(paymentHash) ||
    decoded?.network !== "regtest" ||
    decoded?.amountSat !== 700 ||
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

for (const id of ids) unlinkSync(`${privateDirectory}/bob-addinvoice-${id}.json`);

process.stdout.write(
  `${JSON.stringify({
    invoicesCreated: prepared.length,
    invoices: prepared.map(({ id, paymentHash, amountSat }) => ({ id, paymentHash, amountSat })),
    network: "regtest",
    bolt11Redacted: true,
  })}\n`,
);
