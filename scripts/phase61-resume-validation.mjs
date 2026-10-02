import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decodeBolt11 } from "nostr-core";
import { normalizeBudgetMsat, sanitizeReceiverObservation } from "./phase45-core.mjs";

export const PHASE61_RESUME_RUN_ID = "b542cedc-c9dc-4baf-8d87-58de1bb02a5b";
export const PHASE61_RESUME_INVOICES = Object.freeze([
  Object.freeze({ id: "A", paymentHash: "b8049cdedb7e23a789af18f34eea0ab5d5ab7fb2e961dbea4d6747ebc95863b7", amountSat: 700 }),
  Object.freeze({ id: "B", paymentHash: "dad7fdbf184e044dae616748997638bcf9c62ebb393008c52cf534c8d01a350f", amountSat: 700 }),
]);

const HASH_RE = /^[0-9a-f]{64}$/;

function strictNonNegativeInteger(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function validateResumeRun({ runConfig, invoiceFacts }) {
  const reasons = [];
  if (runConfig?.runId !== PHASE61_RESUME_RUN_ID) reasons.push("resume_run_id_mismatch");
  if (runConfig?.network !== "regtest") reasons.push("resume_network_mismatch");
  const configured = Array.isArray(runConfig?.expectedInvoices) ? runConfig.expectedInvoices : [];
  const facts = Array.isArray(invoiceFacts) ? invoiceFacts : [];
  if (configured.length !== 2 || facts.length !== 2) reasons.push("resume_invoice_count_invalid");

  for (const expected of PHASE61_RESUME_INVOICES) {
    const configMatches = configured.filter((item) => item?.id === expected.id);
    const factMatches = facts.filter((item) => item?.id === expected.id);
    if (configMatches.length !== 1 || factMatches.length !== 1) {
      reasons.push("resume_invoice_binding_missing_or_ambiguous");
      continue;
    }
    const config = configMatches[0];
    const fact = factMatches[0];
    if (config.paymentHash !== expected.paymentHash || config.amountSat !== expected.amountSat) {
      reasons.push("resume_run_config_hash_or_amount_mismatch");
    }
    if (
      fact.fileHash !== expected.paymentHash || fact.decodedHash !== expected.paymentHash ||
      fact.amountSat !== expected.amountSat || fact.network !== "regtest" ||
      fact.invoicePresent !== true
    ) reasons.push("resume_invoice_artifact_mismatch");
  }

  const ids = facts.map((item) => item?.id);
  const hashes = facts.map((item) => item?.fileHash);
  if (new Set(ids).size !== 2 || new Set(hashes).size !== 2 || hashes.some((hash) => !HASH_RE.test(hash ?? ""))) {
    reasons.push("resume_invoice_artifacts_not_unique");
  }
  return { valid: reasons.length === 0, reasonCodes: [...new Set(reasons)].sort() };
}

export function validateResumeBobLookups({ runId, expectedInvoices, lookups }) {
  const reasons = [];
  if (runId !== PHASE61_RESUME_RUN_ID) reasons.push("resume_run_id_mismatch");
  const invoices = Array.isArray(expectedInvoices) ? expectedInvoices : [];
  const records = Array.isArray(lookups) ? lookups : [];
  if (invoices.length !== 2 || records.length !== 2) reasons.push("resume_bob_lookup_count_invalid");

  for (const expected of PHASE61_RESUME_INVOICES) {
    const configured = invoices.filter((item) => item?.id === expected.id);
    const matching = records.filter((item) => item?.id === expected.id);
    if (configured.length !== 1 || matching.length !== 1) {
      reasons.push("resume_bob_lookup_missing_or_ambiguous");
      continue;
    }
    const lookup = matching[0]?.lookup;
    const returnedHash = typeof lookup?.r_hash === "string" ? lookup.r_hash.toLowerCase() : "";
    const requestedHash = configured[0]?.paymentHash;
    const amount = strictNonNegativeInteger(lookup?.value);
    const paid = strictNonNegativeInteger(lookup?.amt_paid_sat);
    if (
      requestedHash !== expected.paymentHash || configured[0]?.amountSat !== expected.amountSat ||
      returnedHash !== expected.paymentHash || lookup?.state !== "OPEN" ||
      lookup?.settled !== false || amount !== expected.amountSat || paid !== 0
    ) reasons.push("resume_bob_invoice_not_open_and_unpaid");
  }
  if (new Set(records.map((item) => item?.id)).size !== 2) reasons.push("resume_bob_lookup_duplicate_id");
  return { valid: reasons.length === 0, reasonCodes: [...new Set(reasons)].sort() };
}

export function validateResumeStartingBudget({ budgetResponse, appConfig }) {
  const budget = normalizeBudgetMsat(budgetResponse);
  const valid = Boolean(
    appConfig?.budgetRenewal === "never" &&
    budget.valid && budget.complete &&
    budget.totalBudgetMsat === 1_000_000 &&
    budget.usedBudgetMsat === 0 &&
    budget.remainingBudgetMsat === 1_000_000 &&
    (budget.renewalPeriod === null || budget.renewalPeriod === "never")
  );
  return {
    valid,
    totalBudgetMsat: budget.totalBudgetMsat,
    usedBudgetMsat: budget.usedBudgetMsat,
    remainingBudgetMsat: budget.remainingBudgetMsat,
    renewalPeriod: budget.renewalPeriod,
    reasonCodes: valid ? [] : ["resume_starting_budget_mismatch"],
  };
}

export function privateFileMetadataIsSafe({ uid, expectedUid, mode }) {
  return Number.isInteger(uid) && Number.isInteger(expectedUid) && uid === expectedUid && mode === 0o600;
}

function loadAndValidatePrivateArtifacts(privateDirectory) {
  const runConfigPath = `${privateDirectory}/phase6-run-config.json`;
  const runConfig = JSON.parse(readFileSync(runConfigPath, "utf8"));
  const expectedUid = Number(process.env.PHASE61_EXPECTED_UID);
  if (!Number.isInteger(expectedUid) || expectedUid < 0 || typeof process.getuid !== "function") {
    throw new Error("resume_expected_owner_unavailable");
  }

  const fileNames = [
    "phase6-run-config.json",
    "bob-invoice-a", "bob-invoice-b",
    "bob-payment-hash-a", "bob-payment-hash-b",
  ];
  for (const name of fileNames) {
    const stats = statSync(`${privateDirectory}/${name}`);
    if (!privateFileMetadataIsSafe({ uid: stats.uid, expectedUid, mode: stats.mode & 0o777 })) {
      throw new Error("resume_private_file_owner_or_mode_invalid");
    }
  }

  const invoiceFacts = ["A", "B"].map((id) => {
    const suffix = id.toLowerCase();
    const invoice = readFileSync(`${privateDirectory}/bob-invoice-${suffix}`, "utf8").trim();
    const fileHash = readFileSync(`${privateDirectory}/bob-payment-hash-${suffix}`, "utf8").trim().toLowerCase();
    let decoded = null;
    try { decoded = decodeBolt11(invoice); } catch {}
    return {
      id,
      fileHash,
      decodedHash: decoded?.paymentHash,
      amountSat: decoded?.amountSat,
      network: decoded?.network,
      invoicePresent: invoice.length > 0,
    };
  });
  const validation = validateResumeRun({ runConfig, invoiceFacts });
  if (!validation.valid) throw new Error(validation.reasonCodes.join(","));
  return { runId: runConfig.runId, expectedInvoices: runConfig.expectedInvoices };
}

async function main() {
  const mode = process.argv[2];
  const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
  if (mode === "artifacts") {
    const result = loadAndValidatePrivateArtifacts(privateDirectory);
    process.stdout.write(`${JSON.stringify({ resumeArtifactsVerified: true, runId: result.runId, invoiceCount: 2, amountsSat: [700, 700], secretsRedacted: true })}\n`);
    return;
  }
  if (mode === "bob-lookups") {
    const runConfig = JSON.parse(readFileSync(`${privateDirectory}/phase6-run-config.json`, "utf8"));
    const lookups = ["A", "B"].map((id) => ({
      id,
      lookup: JSON.parse(readFileSync(`${privateDirectory}/bob-lookup-initial-${id.toLowerCase()}.json`, "utf8")),
    }));
    const result = validateResumeBobLookups({ runId: runConfig.runId, expectedInvoices: runConfig.expectedInvoices, lookups });
    const observations = lookups.map(({ id, lookup }) => {
      const expected = runConfig.expectedInvoices.find((item) => item.id === id);
      return sanitizeReceiverObservation({
        runId: runConfig.runId,
        id,
        requestedHash: expected?.paymentHash,
        expectedAmountSat: expected?.amountSat,
        lookup,
        observedAt: new Date().toISOString(),
      });
    });
    process.stdout.write(`${JSON.stringify({ bobInvoicesVerifiedOpenUnpaid: result.valid, reasonCodes: result.reasonCodes, observations, secretsRedacted: true })}\n`);
    if (!result.valid) process.exitCode = 2;
    return;
  }
  throw new Error("resume_validation_mode_invalid");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ resumeValidation: "failed", errorCode: "RESUME_EVIDENCE_INVALID", secretsRedacted: true })}\n`);
    process.exitCode = 1;
  });
}
