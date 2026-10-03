export const MAX_SANDBOX_SATS = 1_000_000;

const BEHAVIORS = new Set(["enforce_limit", "allow_overspend"]);

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

function parseSats(value, field) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return { error: `${field} must be a whole number of sats.` };
    if (value < 1) return { error: `${field} must be at least 1 sat.` };
    if (value > MAX_SANDBOX_SATS) return { error: `${field} cannot exceed ${MAX_SANDBOX_SATS.toLocaleString("en-US")} sats.` };
    return { value };
  }
  if (typeof value !== "string" || value.length === 0) return { error: `${field} is required.` };
  if (!/^\d+$/.test(value)) return { error: `${field} must be a positive whole number of sats.` };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return { error: `${field} must be a safe whole number of sats.` };
  if (parsed < 1) return { error: `${field} must be at least 1 sat.` };
  if (parsed > MAX_SANDBOX_SATS) return { error: `${field} cannot exceed ${MAX_SANDBOX_SATS.toLocaleString("en-US")} sats.` };
  return { value: parsed };
}

/** Validate untrusted form values and return only canonical sandbox configuration. */
export function validateSandboxConfiguration(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, errors: { configuration: "Enter a valid sandbox configuration." } };
  }
  const budget = parseSats(input.startingBudgetSats, "Spending limit");
  const amountA = parseSats(input.attemptAmountSats?.A, "Payment A amount");
  const amountB = parseSats(input.attemptAmountSats?.B, "Payment B amount");
  const errors = {};
  if (budget.error) errors.startingBudgetSats = budget.error;
  if (amountA.error) errors.attemptAmountA = amountA.error;
  if (amountB.error) errors.attemptAmountB = amountB.error;
  if (typeof input.behavior !== "string" || !BEHAVIORS.has(input.behavior)) {
    errors.behavior = "Choose a supported spending behavior.";
  }
  if (Object.keys(errors).length) return { valid: false, errors };
  return {
    valid: true,
    configuration: {
      startingBudgetSats: budget.value,
      attemptAmountSats: { A: amountA.value, B: amountB.value },
      behavior: input.behavior,
      maxInputSats: MAX_SANDBOX_SATS,
      tieBreak: "A_then_B_after_shared_barrier",
    },
  };
}

/** A browser-only simulation. It never calls NWC, Lightning, or Phase 6 execution code. */
export async function runSandboxSimulation({
  configuration,
  runIdFactory = newRunId,
  wallClock = () => new Date(),
  monotonicClock = () => performance.now(),
} = {}) {
  const validation = validateSandboxConfiguration(configuration);
  if (!validation.valid) throw new TypeError("Invalid sandbox configuration.");
  const config = validation.configuration;
  const runId = runIdFactory();
  const startedAt = wallClock().toISOString();
  let settledPrincipalSats = 0;
  const barrier = createTwoPartyBarrier(wallClock);

  async function attempt(id) {
    const barrierReleasedAt = await barrier.wait();
    const dispatchedAtMonotonicMs = monotonicClock();
    const dispatchedAt = wallClock().toISOString();
    const requestedAmountSats = config.attemptAmountSats[id];
    const fitsBudget = settledPrincipalSats + requestedAmountSats <= config.startingBudgetSats;
    const allowed = config.behavior === "allow_overspend" || fitsBudget;

    if (allowed) {
      settledPrincipalSats += requestedAmountSats;
      return {
        id,
        requestedAmountSats,
        dispatchedAt,
        dispatchedAtMonotonicMs,
        barrierReleasedAt,
        result: "SUCCESS",
        errorCode: null,
        receiverState: "SETTLED",
        settledAmountSats: requestedAmountSats,
        feeSats: 0,
      };
    }
    return {
      id,
      requestedAmountSats,
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

  // Both calls wait on the same barrier. A stable A-then-B tie-break keeps the browser fixture reproducible.
  const attempts = await Promise.all([attempt("A"), attempt("B")]);
  const dispatchTimes = attempts.map((item) => item.dispatchedAtMonotonicMs);
  const overspendSats = Math.max(0, settledPrincipalSats - config.startingBudgetSats);
  const invariantHolds = overspendSats === 0;

  return {
    mode: "sandbox",
    runId,
    startedAt,
    configuration: config,
    barrierReleasedAt: attempts[0].barrierReleasedAt,
    startingBudgetSats: config.startingBudgetSats,
    attempts: attempts.map(({ dispatchedAtMonotonicMs: _internal, ...item }) => item),
    dispatchTimestamps: { A: attempts[0].dispatchedAt, B: attempts[1].dispatchedAt },
    dispatchDeltaMs: Number(Math.abs(dispatchTimes[1] - dispatchTimes[0]).toFixed(3)),
    settledPrincipalSats,
    overspendSats,
    remainingBudgetSats: invariantHolds ? config.startingBudgetSats - settledPrincipalSats : null,
    invariant: {
      expression: "settledPrincipalSats <= startingBudgetSats",
      holds: invariantHolds,
    },
    finalClassification: invariantHolds ? "PASS" : "FAIL",
    generatedAt: wallClock().toISOString(),
    notice: "Simulation only. No NWC wallet, Lightning node, or live payment was used.",
  };
}
