import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  reconcileTwoInvoices,
  safeErrorCode,
  sanitizeReceiverObservation,
} from "./phase45-core.mjs";

const phase = process.argv[2];
if (phase !== "initial" && phase !== "final") throw new Error("phase_must_be_initial_or_final");

const privateDirectory = process.env.PRIVATE_DIR ?? "/run/private";
const runConfig = JSON.parse(readFileSync(`${privateDirectory}/phase6-run-config.json`, "utf8"));
const ids = ["A", "B"];
const expectedInvoices = runConfig.expectedInvoices;

if (phase === "initial") {
  const observations = ids.map((id) => {
    const expected = expectedInvoices.find((item) => item.id === id);
    let lookup;
    try {
      lookup = JSON.parse(readFileSync(`${privateDirectory}/bob-lookup-initial-${id.toLowerCase()}.json`, "utf8"));
    } catch {
      lookup = null;
    }
    return sanitizeReceiverObservation({
      runId: runConfig.runId,
      id,
      requestedHash: expected?.paymentHash,
      expectedAmountSat: expected?.amountSat,
      lookup,
      observedAt: new Date().toISOString(),
    });
  });
  const evidence = {
    runId: runConfig.runId,
    phase: "initial",
    source: "polar-n1-bob lncli lookupinvoice",
    observations,
    capturedAt: new Date().toISOString(),
  };
  const target = `${privateDirectory}/bob-initial-evidence.json`;
  writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(target, 0o600);
  for (const id of ids) {
    const rawPath = `${privateDirectory}/bob-lookup-initial-${id.toLowerCase()}.json`;
    try { unlinkSync(rawPath); } catch {}
  }
  process.stdout.write(`${JSON.stringify({
    runId: evidence.runId,
    phase: evidence.phase,
    invoices: observations.map(({ id, requestedHash, returnedHash, state, settled, amountPaidSat, observedAt }) => ({
      id, requestedHash, returnedHash, state, settled, amountPaidSat, observedAt,
    })),
  }, null, 2)}\n`);
} else {
  const racePath = `${privateDirectory}/phase45-race-progress.json`;
  let race;
  try { race = JSON.parse(readFileSync(racePath, "utf8")); } catch { race = null; }
  const expectedRace = race && race.runId === runConfig.runId;
  let observations = [];
  try {
    const rawObservations = readFileSync(`${privateDirectory}/bob-final-observations.jsonl`, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    observations = rawObservations.map((item) => {
      const observation = sanitizeReceiverObservation({
        runId: item.runId,
        id: item.id,
        requestedHash: item.requestedHash,
        expectedAmountSat: item.expectedAmountSat,
        lookup: {
          r_hash: item.returnedHash,
          state: item.state,
          settled: item.settled,
          amt_paid_sat: item.amountPaidSat,
          settle_date: item.settleDateUnix,
        },
        observedAt: item.observedAt,
      });
      observation.errorCode = item.errorCode == null ? null : safeErrorCode(item.errorCode);
      return observation;
    });
  } catch {
    observations = [];
  }
  const reconciliationDeadline = expectedRace ? race.reconciliationDeadline : null;
  const result = reconcileTwoInvoices({
    runId: runConfig.runId,
    expectedInvoices,
    bobObservations: observations,
    barrierReleasedAt: expectedRace ? race.barrierReleasedAt : null,
    reconciliationDeadline,
    startingSpendableBudgetMsat: expectedRace ? race.startingBudget?.remainingBudgetMsat : null,
  });
  const evidence = {
    runId: runConfig.runId,
    phase: "final",
    source: "polar-n1-bob lncli lookupinvoice",
    reconciliationDeadline,
    completedAt: new Date().toISOString(),
    observations,
    bobClassification: expectedRace ? result.classification : "INCONCLUSIVE",
    reasonCodes: expectedRace ? result.reasonCodes : ["race_run_binding_missing"],
  };
  const target = `${privateDirectory}/bob-final-evidence.json`;
  writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(target, 0o600);
  process.stdout.write(`${JSON.stringify({
    runId: evidence.runId,
    phase: evidence.phase,
    observationCount: observations.length,
    reconciliationDeadline,
    bobClassification: evidence.bobClassification,
    reasonCodes: evidence.reasonCodes,
    rawInvoicesRedacted: true,
  }, null, 2)}\n`);
}
