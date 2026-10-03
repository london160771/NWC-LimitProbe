const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Project only the sandbox schema; this evidence is never passed to the live evaluator. */
export function createSandboxEvidence(simulation, generatedAt = new Date().toISOString()) {
  if (!simulation || simulation.mode !== "sandbox" || !UUID_PATTERN.test(simulation.runId ?? "")) {
    throw new TypeError("Invalid sandbox simulation evidence.");
  }
  if (!Array.isArray(simulation.attempts) || simulation.attempts.length !== 2
    || simulation.attempts.some((attempt, index) => attempt.id !== ["A", "B"][index]
      || attempt.requestedAmountSats !== 700
      || ![0, 700].includes(attempt.settledAmountSats)
      || !["SUCCESS", "QUOTA_EXCEEDED"].includes(attempt.result)
      || typeof attempt.dispatchedAt !== "string" || Number.isNaN(Date.parse(attempt.dispatchedAt)))
    || simulation.startingBudgetSats !== 1_000
    || typeof simulation.barrierReleasedAt !== "string" || Number.isNaN(Date.parse(simulation.barrierReleasedAt))
    || !Number.isFinite(simulation.dispatchDeltaMs) || simulation.dispatchDeltaMs < 0) {
    throw new TypeError("Sandbox attempts are incomplete or invalid.");
  }
  const settledPrincipalSats = simulation.attempts.reduce((sum, attempt) => sum + attempt.settledAmountSats, 0);
  const invariantHolds = settledPrincipalSats <= simulation.startingBudgetSats;
  const expectedOutcomes = simulation.attempts.filter((attempt) => attempt.result === "SUCCESS"
    && attempt.settledAmountSats === 700 && attempt.receiverState === "SETTLED").length === 1
    && simulation.attempts.filter((attempt) => attempt.result === "QUOTA_EXCEEDED"
      && attempt.settledAmountSats === 0 && attempt.receiverState === "CANCELED").length === 1;
  const classification = !invariantHolds ? "FAIL" : expectedOutcomes ? "PASS" : "INCONCLUSIVE";

  return {
    mode: "sandbox",
    runId: simulation.runId,
    generatedAt,
    startingBudgetSats: simulation.startingBudgetSats,
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
    remainingBudgetSats: simulation.startingBudgetSats - settledPrincipalSats,
    invariant: {
      expression: "settledPrincipalSats <= startingBudgetSats",
      holds: invariantHolds,
    },
    finalClassification: classification,
    notice: "Sandbox Test — simulation only; no NWC wallet, Lightning node, or live payment was used.",
  };
}
