import { readFileSync } from "node:fs";

const paymentHash = readFileSync(
  process.env.PAYMENT_HASH_FILE ?? "/run/secrets/bob-payment-hash",
  "utf8",
).trim().toLowerCase();
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let invoice;
try {
  invoice = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  throw new Error("Bob lookup_invoice output was not valid JSON.");
}

const returnedHash = String(invoice?.r_hash ?? "").toLowerCase();
const hashMatches = !returnedHash || returnedHash === paymentHash;
const settleDateUnix = Number(invoice?.settle_date ?? 0);
const amountPaidSat = Number(invoice?.amt_paid_sat ?? 0);
const invoiceSettled = invoice?.settled === true;
const amountMatches = amountPaidSat === 1000;
const settled = invoiceSettled && amountMatches && hashMatches;

process.stdout.write(
  `${JSON.stringify(
    {
      test: "phase3-bob-independent-settlement",
      source: "polar-n1-bob lncli lookupinvoice",
      paymentHash,
      hashMatches,
      settled,
      amountMatches,
      amountPaidSat,
      settleDateUnix: settleDateUnix || null,
      settledAt: settleDateUnix ? new Date(settleDateUnix * 1000).toISOString() : null,
      preimageRedacted: true,
    },
    null,
    2,
  )}\n`,
);

if (!settled) process.exitCode = 2;
