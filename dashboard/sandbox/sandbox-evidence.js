import { validateSandboxConfiguration } from "./sandbox-runner.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function validTimestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

/** Project only the sandbox schema; this evidence is never passed to the live evaluator. */
export function createSandboxEvidence(simulation, generatedAt = new Date().toISOString()) {
  if (!simulation || typeof simulation !== "object" || simulation.mode !== "sandbox"
    || typeof simulation.runId !== "string" || !UUID_PATTERN.test(simulation.runId)) {
    throw new TypeError("Invalid sandbox simulation evidence.");
  }
  const validation = validateSandboxConfiguration(simulation.configuration);
  if (!validation.valid || !validTimestamp(generatedAt)
    || !validTimestamp(simulation.startedAt) || !validTimestamp(simulation.generatedAt)
    || !Array.isArray(simulation.attempts) || simulation.attempts.length !== 2
    || !validTimestamp(simulation.barrierReleasedAt)
    || !Number.isFinite(simulation.dispatchDeltaMs) || simulation.dispatchDeltaMs < 0
    || !simulation.dispatchTimestamps || !validTimestamp(simulation.dispatchTimestamps.A)
    || !validTimestamp(simulation.dispatchTimestamps.B)) {
    throw new TypeError("Sandbox attempts are incomplete or invalid.");
  }

  const configuration = validation.configuration;
  if (simulation.startingBudgetSats !== configuration.startingBudgetSats) {
    throw new TypeError("Sandbox budget does not match its configuration.");
  }
  const attemptsValid = simulation.attempts.every((attempt, index) => {
    const id = ["A", "B"][index];
    const amount = configuration.attemptAmountSats[id];
    if (!attempt || typeof attempt !== "object" || attempt.id !== id
      || attempt.requestedAmountSats !== amount || !validTimestamp(attempt.dispatchedAt)
      || attempt.dispatchedAt !== simulation.dispatchTimestamps[id]
      || attempt.barrierReleasedAt !== simulation.barrierReleasedAt
      || !Number.isSafeInteger(attempt.settledAmountSats) || attempt.settledAmountSats < 0
      || !Number.isSafeInteger(attempt.feeSats) || attempt.feeSats < 0) return false;
    const settled = attempt.result === "SUCCESS" && attempt.errorCode === null
      && attempt.receiverState === "SETTLED" && attempt.settledAmountSats === amount;
    const blocked = configuration.behavior === "enforce_limit" && attempt.result === "QUOTA_EXCEEDED"
      && attempt.errorCode === "QUOTA_EXCEEDED" && attempt.receiverState === "CANCELED"
      && attempt.settledAmountSats === 0;
    return settled || blocked;
  });
  if (!attemptsValid) throw new TypeError("Sandbox attempt outcomes do not match the configured simulation.");

  const settledPrincipalSats = simulation.attempts.reduce((sum, attempt) => sum + attempt.settledAmountSats, 0);
  const overspendSats = Math.max(0, settledPrincipalSats - configuration.startingBudgetSats);
  const invariantHolds = overspendSats === 0;
  const remainingBudgetSats = invariantHolds ? configuration.startingBudgetSats - settledPrincipalSats : null;
  if (simulation.settledPrincipalSats !== settledPrincipalSats
    || simulation.overspendSats !== overspendSats
    || simulation.invariant?.holds !== invariantHolds
    || simulation.remainingBudgetSats !== remainingBudgetSats
    || simulation.finalClassification !== (invariantHolds ? "PASS" : "FAIL")) {
    throw new TypeError("Sandbox classification does not match its simulated outcomes.");
  }

  return {
    mode: "sandbox",
    runId: simulation.runId,
    generatedAt,
    configuration,
    startingBudgetSats: configuration.startingBudgetSats,
    attempts: simulation.attempts.map((attempt) => ({
      id: attempt.id,
      requestedAmountSats: attempt.requestedAmountSats,
      dispatchTimestamp: attempt.dispatchedAt,
      simulatedPaymentResult: attempt.result,
      simulatedErrorCode: attempt.errorCode,
      simulatedReceiverState: attempt.receiverState,
      simulatedSettledSats: attempt.settledAmountSats,
      simulatedFeeSats: attempt.feeSats,
    })),
    barrierReleasedAt: simulation.barrierReleasedAt,
    dispatchTimestamps: { A: simulation.dispatchTimestamps.A, B: simulation.dispatchTimestamps.B },
    dispatchDeltaMs: simulation.dispatchDeltaMs,
    settledPrincipalSats,
    overspendSats,
    remainingBudgetSats,
    invariant: {
      expression: "settledPrincipalSats <= startingBudgetSats",
      holds: invariantHolds,
    },
    finalClassification: invariantHolds ? "PASS" : "FAIL",
    notice: "Sandbox Test — simulation only; no NWC wallet, Lightning node, or live payment was used.",
  };
}
