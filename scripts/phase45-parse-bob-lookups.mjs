import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { reconcileTwoInvoices } from "./phase45-core.mjs";

const phase = process.argv[2];
if (phase !== "initial" && phase !== "final") {
  throw new Error("phase_must_be_initial_or_final");
}

const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
const attempts = ["a", "b"].map((id) => {
  const paymentHash = readFileSync(`${privateDirectory}/bob-payment-hash-${id}`, "utf8")
    .trim()
    .toLowerCase();
  const file = `${privateDirectory}/bob-lookup-${phase}-${id}.json`;
  let lookup = null;
  let lookupCode = null;
  try {
    lookup = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    lookupCode = "bob_lookup_unavailable_or_invalid";
  }
  return { id: id.toUpperCase(), paymentHash, lookup, lookupCode, file };
});

if (phase === "initial") {
  const invoices = attempts.map(({ id, paymentHash, lookup, lookupCode }) => {
    const state = String(lookup?.state ?? "").toUpperCase();
    const settled = lookup?.settled;
    const amountPaidSat = Number(lookup?.amt_paid_sat ?? NaN);
    const hashMatches = String(lookup?.r_hash ?? "").toLowerCase() === paymentHash;
    const validInitial =
      lookupCode === null &&
      hashMatches &&
      settled === false &&
      amountPaidSat === 0 &&
      state === "OPEN";
    return {
      id,
      paymentHash,
      hashMatches,
      state: state || "UNKNOWN",
      settled: settled === true,
      amountPaidSat: Number.isFinite(amountPaidSat) ? amountPaidSat : null,
      validInitial,
      lookupCode,
    };
  });
  const evidence = {
    phase: "initial",
    invoices,
    allValidAndUnpaid: invoices.length === 2 && invoices.every(({ validInitial }) => validInitial),
  };
  writeFileSync(`${privateDirectory}/bob-initial-lookups.json`, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  for (const attempt of attempts) if (attempt.lookup) unlinkSync(attempt.file);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.allValidAndUnpaid) process.exitCode = 2;
} else {
  const expectedInvoices = attempts.map(({ id, paymentHash }) => ({
    id,
    paymentHash,
    amountSat: 700,
  }));
  const bobLookups = attempts.flatMap(({ lookup }) => (lookup ? [lookup] : []));
  const result = reconcileTwoInvoices({
    expectedInvoices,
    bobLookups,
    startingSpendableBudgetSats: 1_000,
  });
  const evidence = {
    phase: "final",
    source: "polar-n1-bob lncli lookupinvoice",
    ...result,
    preimagesRedacted: true,
  };
  writeFileSync(`${privateDirectory}/bob-final-evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  for (const attempt of attempts) if (attempt.lookup) unlinkSync(attempt.file);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (evidence.classification === "INCONCLUSIVE") process.exitCode = 2;
}
