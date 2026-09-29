import { chmodSync, writeFileSync } from "node:fs";
import { decodeBolt11 } from "nostr-core";

const outputDirectory = process.env.BOB_INVOICE_OUTPUT_DIR ?? "/run/invoice";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let invoice;
try {
  invoice = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  throw new Error("Bob invoice output was not valid JSON.");
}

const paymentRequest = invoice?.payment_request;
const paymentHash = String(invoice?.r_hash ?? "").toLowerCase();
const decoded = typeof paymentRequest === "string" ? decodeBolt11(paymentRequest) : null;
const amountSat = decoded?.amountSat ?? 0;
if (
  typeof paymentRequest !== "string" ||
  !paymentRequest.startsWith("lnbcrt") ||
  !/^[0-9a-f]{64}$/.test(paymentHash) ||
  amountSat !== 1000 ||
  decoded?.network !== "regtest" ||
  decoded.paymentHash !== paymentHash
) {
  throw new Error("Bob invoice did not match the expected 1,000 sat local regtest invoice.");
}

for (const [name, value] of [
  ["bob-invoice", paymentRequest],
  ["bob-payment-hash", paymentHash],
]) {
  const path = `${outputDirectory}/${name}`;
  writeFileSync(path, `${value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

process.stdout.write("bob_invoice_saved=true; amount_sat=1000; secrets_redacted=true\n");
