import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  reconcileTwoInvoices,
  safeErrorCode,
  sanitizeReceiverObservation,
} from "./phase45-core.mjs";
import { parseCollectorJournal, summarizeCollectorSession } from "./phase45-collector-core.mjs";

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
    let acquiredAt = null;
    try {
      lookup = JSON.parse(readFileSync(`${privateDirectory}/bob-lookup-initial-${id.toLowerCase()}.json`, "utf8"));
      acquiredAt = readFileSync(`${privateDirectory}/bob-lookup-initial-${id.toLowerCase()}.acquired-at`, "utf8").trim();
    } catch {
      lookup = null;
    }
    return sanitizeReceiverObservation({
      runId: runConfig.runId,
      id,
      requestedHash: expected?.paymentHash,
      expectedAmountSat: expected?.amountSat,
      lookup,
      observedAt: acquiredAt,
      acquiredAt,
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
    try { unlinkSync(`${privateDirectory}/bob-lookup-initial-${id.toLowerCase()}.acquired-at`); } catch {}
  }
  process.stdout.write(`${JSON.stringify({
    runId: evidence.runId,
    phase: evidence.phase,
    invoices: observations.map(({ id, requestedHash, returnedHash, state, settled, amountPaidSat, observedAt, acquiredAt }) => ({
      id, requestedHash, returnedHash, state, settled, amountPaidSat, observedAt, acquiredAt,
    })),
  }, null, 2)}\n`);
} else {
  const racePath = `${privateDirectory}/phase45-race-progress.json`;
  let race;
  try { race = JSON.parse(readFileSync(racePath, "utf8")); } catch { race = null; }
  const expectedRace = race && race.runId === runConfig.runId;
  let observations = [];
  let collection = null;
  let journalIssues = [];
  try {
    const parsedJournal = parseCollectorJournal(readFileSync(`${privateDirectory}/bob-final-observations.jsonl`, "utf8"));
    const journal = parsedJournal.events;
    journalIssues = parsedJournal.issues;
    const latestStart = [...journal].reverse().find((event) => event?.recordType === "collector_started");
    collection = latestStart ? summarizeCollectorSession(journal, latestStart.sessionId, expectedInvoices, {
      runStartedAt: expectedRace ? race.runStartedAt : null,
      expectedDeadline: expectedRace ? race.reconciliationDeadline : null,
    }) : null;
    if (collection && journalIssues.length > 0) {
      collection.issues = [...new Set([...collection.issues, ...journalIssues])].sort();
      collection.completionStatus = "interrupted";
    }
    observations = (collection?.observations ?? []).map((item) => {
      const observation = sanitizeReceiverObservation({
        runId: item.runId,
        sessionId: item.sessionId,
        id: item.id,
        requestedHash: item.requestedHash,
        expectedAmountSat: item.expectedAmountSat,
        lookup: {
          r_hash: item.returnedHash,
          state: item.state,
          settled: item.settled,
          amt_paid_sat: item.amountPaidSat,
          amt_paid_msat: item.amountPaidMsat,
          ...(item.settleDateUnix == null ? {} : { settle_date: item.settleDateUnix }),
          ...(item.settledAt == null ? {} : { settledAt: item.settledAt }),
          errorCode: item.errorCode,
        },
        observedAt: item.observedAt,
      });
    observation.errorCode = item.errorCode == null ? null : safeErrorCode(item.errorCode);
      observation.acquiredAt = item.acquiredAt ?? item.observedAt;
      observation.validationIssues = [...new Set([...(observation.validationIssues ?? []), ...(Array.isArray(item.validationIssues) ? item.validationIssues : [])])].sort();
      return observation;
    });
  } catch {
    observations = [];
    journalIssues = ["collector_journal_invalid"];
  }
  const reconciliationDeadline = expectedRace ? race.reconciliationDeadline : null;
  const result = reconcileTwoInvoices({
    runId: runConfig.runId,
    expectedInvoices,
    bobObservations: observations,
    barrierReleasedAt: expectedRace ? race.barrierReleasedAt : null,
    reconciliationDeadline,
    dispatchedAtById: Object.fromEntries((race?.attempts ?? []).map((item) => [item.id, item.dispatchedAt])),
    controlledAttribution: race?.testExclusiveInvoices === true && race?.noOtherPayerPath === true,
    startingSpendableBudgetMsat: expectedRace ? race.startingBudget?.remainingBudgetMsat : null,
  });
  const evidence = {
    runId: runConfig.runId,
    phase: "final",
    source: "polar-n1-bob lncli lookupinvoice",
    reconciliationDeadline,
    startedAt: collection?.startedAt ?? null,
    deadline: collection?.deadline ?? reconciliationDeadline,
    completedAt: collection?.completedAt ?? null,
    completionStatus: collection?.completionStatus ?? "collector_error",
    queryAttempts: collection?.queryAttempts ?? [],
    collectionSessions: collection?.sessions ?? [],
    collectionIssues: collection?.issues ?? [...new Set(["collector_evidence_missing", ...journalIssues])].sort(),
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
