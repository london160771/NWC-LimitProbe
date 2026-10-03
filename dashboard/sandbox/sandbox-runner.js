const STARTING_BUDGET_SATS = 1_000;
const ATTEMPT_AMOUNT_SATS = 700;

function createTwoPartyBarrier(clock) {
  let arrived = 0;
  let resolveRelease;
  let barrierReleasedAt;
  const released = new Promise((resolve) => { resolveRelease = resolve; });

  return {
    async wait() {
      arrived += 1;
      if (arrived === 2) {
        barrierReleasedAt = new Date(clock()).toISOString();
        resolveRelease();
      }
      await released;
      return barrierReleasedAt;
    },
  };
}

function newRunId() {
  if (typeof globalThis.crypto?.randomUUID !== "function") throw new Error("Secure run ID generation is unavailable.");
  return globalThis.crypto.randomUUID();
}

/** A browser-only simulation. It never calls NWC, Lightning, or Phase 6 execution code. */
export async function runSandboxSimulation({ runIdFactory = newRunId, wallClock = () => new Date(), monotonicClock = () => performance.now() } = {}) {
  const runId = runIdFactory();
  const startedAt = wallClock().toISOString();
  const available = { sats: STARTING_BUDGET_SATS };
  const barrier = createTwoPartyBarrier(wallClock);

  async function attempt(id) {
    const barrierReleasedAt = await barrier.wait();
    const dispatchedAtMonotonicMs = monotonicClock();
    const dispatchedAt = wallClock().toISOString();
    if (available.sats >= ATTEMPT_AMOUNT_SATS) {
      available.sats -= ATTEMPT_AMOUNT_SATS;
      return {
        id,
        requestedAmountSats: ATTEMPT_AMOUNT_SATS,
        dispatchedAt,
        dispatchedAtMonotonicMs,
        barrierReleasedAt,
        result: "SUCCESS",
        errorCode: null,
        receiverState: "SETTLED",
        settledAmountSats: ATTEMPT_AMOUNT_SATS,
        feeSats: 0,
      };
    }
    return {
      id,
      requestedAmountSats: ATTEMPT_AMOUNT_SATS,
      dispatchedAt,
      dispatchedAtMonotonicMs,
      barrierReleasedAt,
      result: "QUOTA_EXCEEDED",
      errorCode: "QUOTA_EXCEEDED",
      receiverState: "CANCELED",
      settledAmountSats: 0,
      feeSats: 0,
    };
  }

  const attempts = await Promise.all([attempt("A"), attempt("B")]);
  const dispatchTimes = attempts.map((item) => item.dispatchedAtMonotonicMs);
  const settledPrincipalSats = attempts.reduce((sum, item) => sum + item.settledAmountSats, 0);
  const invariantHolds = settledPrincipalSats <= STARTING_BUDGET_SATS;
  const hasExpectedOutcomes = attempts.filter((item) => item.result === "SUCCESS" && item.settledAmountSats > 0).length === 1
    && attempts.filter((item) => item.result === "QUOTA_EXCEEDED" && item.settledAmountSats === 0).length === 1;

  return {
    mode: "sandbox",
    runId,
    startedAt,
    barrierReleasedAt: attempts[0].barrierReleasedAt,
    startingBudgetSats: STARTING_BUDGET_SATS,
    attempts: attempts.map(({ dispatchedAtMonotonicMs: _internal, ...item }) => item),
    dispatchTimestamps: { A: attempts[0].dispatchedAt, B: attempts[1].dispatchedAt },
    dispatchDeltaMs: Number(Math.abs(dispatchTimes[1] - dispatchTimes[0]).toFixed(3)),
    settledPrincipalSats,
    remainingBudgetSats: available.sats,
    invariant: {
      expression: "settledPrincipalSats <= startingBudgetSats",
      holds: invariantHolds,
    },
    finalClassification: invariantHolds && hasExpectedOutcomes ? "PASS" : invariantHolds ? "INCONCLUSIVE" : "FAIL",
    generatedAt: wallClock().toISOString(),
    notice: "Simulation only. No NWC wallet, Lightning node, or live payment was used.",
  };
}
