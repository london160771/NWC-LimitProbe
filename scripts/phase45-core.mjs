import { performance } from "node:perf_hooks";

const ERROR_CODE = /^[A-Za-z0-9_-]{1,64}$/;

export class TwoPartyBarrier {
  #arrivals = 0;
  #releasedAt = null;
  #resolveArmed;
  #resolveRelease;
  #armed;
  #released;

  constructor() {
    this.#armed = new Promise((resolve) => {
      this.#resolveArmed = resolve;
    });
    this.#released = new Promise((resolve) => {
      this.#resolveRelease = resolve;
    });
  }

  arriveAndWait() {
    if (this.#releasedAt !== null) throw new Error("barrier_already_released");
    if (this.#arrivals >= 2) throw new Error("barrier_has_two_participants");
    this.#arrivals += 1;
    if (this.#arrivals === 2) this.#resolveArmed();
    return this.#released;
  }

  waitUntilArmed() {
    return this.#armed;
  }

  release(timestamp) {
    if (this.#arrivals !== 2) throw new Error("barrier_not_fully_armed");
    if (this.#releasedAt !== null) throw new Error("barrier_already_released");
    if (typeof timestamp !== "string" || timestamp.length === 0) {
      throw new Error("barrier_release_timestamp_required");
    }
    this.#releasedAt = timestamp;
    this.#resolveRelease(timestamp);
    return timestamp;
  }

  get arrivals() {
    return this.#arrivals;
  }

  get releasedAt() {
    return this.#releasedAt;
  }
}

function safeErrorCode(error) {
  const candidate = error?.code ?? error?.error?.code ?? error?.name ?? "unknown_error";
  const code = String(candidate);
  return ERROR_CODE.test(code) ? code : "unknown_error";
}

export async function dispatchTwoPayments(
  requests,
  payInvoice,
  {
    wallClock = () => new Date().toISOString(),
    monotonicClock = () => performance.now(),
    beforeRelease = () => undefined,
  } = {},
) {
  if (!Array.isArray(requests) || requests.length !== 2) {
    throw new Error("exactly_two_requests_required");
  }
  if (typeof payInvoice !== "function") throw new Error("pay_invoice_function_required");

  const barrier = new TwoPartyBarrier();
  const jobs = requests.map(async (request) => {
    await barrier.arriveAndWait();
    const dispatchedAt = wallClock();
    const dispatchMonotonicMs = monotonicClock();

    try {
      const response = await payInvoice(request.invoice, request);
      const feeValue = response?.fees_paid ?? response?.fees_paid_msat ?? null;
      return {
        id: request.id,
        paymentHash: request.paymentHash,
        barrierReleasedAt: barrier.releasedAt,
        dispatchedAt,
        dispatchMonotonicMs,
        responseAt: wallClock(),
        result: "success",
        errorCode: null,
        feesPaidMsat:
          typeof feeValue === "number" && Number.isFinite(feeValue) ? feeValue : null,
      };
    } catch (error) {
      return {
        id: request.id,
        paymentHash: request.paymentHash,
        barrierReleasedAt: barrier.releasedAt,
        dispatchedAt,
        dispatchMonotonicMs,
        responseAt: wallClock(),
        result: "error",
        errorCode: safeErrorCode(error),
        feesPaidMsat: null,
      };
    }
  });

  await barrier.waitUntilArmed();
  beforeRelease();
  const barrierReleasedAt = wallClock();
  barrier.release(barrierReleasedAt);
  const attempts = await Promise.all(jobs);
  const dispatchDeltaMs = Number(
    Math.abs(attempts[0].dispatchMonotonicMs - attempts[1].dispatchMonotonicMs).toFixed(3),
  );

  return {
    barrierReleasedAt,
    dispatchDeltaMs,
    attempts: attempts.map(({ dispatchMonotonicMs: _internal, ...attempt }) => attempt),
  };
}

function safeNonnegativeInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

export function normalizeBudgetMsat(budget) {
  const totalBudgetMsat = safeNonnegativeInteger(
    budget?.total_budget_msats ?? budget?.total_budget ?? budget?.totalBudgetMsat,
  );
  const explicitUsed = safeNonnegativeInteger(
    budget?.used_budget_msats ?? budget?.used_budget ?? budget?.usedBudgetMsat,
  );
  const explicitRemaining = safeNonnegativeInteger(
    budget?.remaining_budget_msats ?? budget?.remaining_budget ?? budget?.remainingBudgetMsat,
  );
  const usedBudgetMsat =
    explicitUsed ??
    (totalBudgetMsat !== null && explicitRemaining !== null
      ? totalBudgetMsat - explicitRemaining
      : null);
  const remainingBudgetMsat =
    explicitRemaining ??
    (totalBudgetMsat !== null && usedBudgetMsat !== null
      ? totalBudgetMsat - usedBudgetMsat
      : null);
  return {
    totalBudgetMsat,
    usedBudgetMsat,
    remainingBudgetMsat,
    renewalPeriod:
      typeof (budget?.renewal_period ?? budget?.renewalPeriod) === "string"
        ? budget.renewal_period ?? budget.renewalPeriod
        : null,
  };
}

export function sumSettledPrincipalSats(outcomes) {
  return outcomes.reduce((total, outcome) => {
    if (outcome?.reconciled !== true || outcome?.settled !== true) return total;
    const amount = safeNonnegativeInteger(outcome.amountPaidSat);
    return amount === null ? Number.NaN : total + amount;
  }, 0);
}

export function classifyInvariant({ startingSpendableBudgetSats, outcomes }) {
  const budget = safeNonnegativeInteger(startingSpendableBudgetSats);
  if (
    budget === null ||
    !Array.isArray(outcomes) ||
    outcomes.length !== 2 ||
    outcomes.some((outcome) => {
      if (
        outcome?.reconciled !== true ||
        typeof outcome?.settled !== "boolean" ||
        safeNonnegativeInteger(outcome.amountPaidSat) === null
      ) {
        return true;
      }
      return outcome.settled
        ? safeNonnegativeInteger(outcome.amountPaidSat) === 0
        : safeNonnegativeInteger(outcome.amountPaidSat) !== 0;
    })
  ) {
    return {
      classification: "INCONCLUSIVE",
      totalSettledPrincipalSats: null,
      reason: "independent_settlement_evidence_incomplete",
    };
  }

  const totalSettledPrincipalSats = sumSettledPrincipalSats(outcomes);
  return totalSettledPrincipalSats <= budget
    ? {
        classification: "PASS",
        totalSettledPrincipalSats,
        reason: "settled_principal_within_starting_budget",
      }
    : {
        classification: "FAIL",
        totalSettledPrincipalSats,
        reason: "settled_principal_exceeds_starting_budget",
      };
}

export function reconcileTwoInvoices({
  expectedInvoices,
  bobLookups,
  startingSpendableBudgetSats,
}) {
  const lookups = new Map(
    (Array.isArray(bobLookups) ? bobLookups : []).map((lookup) => [
      String(lookup?.r_hash ?? lookup?.paymentHash ?? "").toLowerCase(),
      lookup,
    ]),
  );
  const expectedList = Array.isArray(expectedInvoices) ? expectedInvoices : [];
  const expectedHashes = expectedList.map((expected) =>
    String(expected?.paymentHash ?? "").toLowerCase(),
  );
  const expectedHashesUnique = new Set(expectedHashes).size === expectedHashes.length;
  const outcomes = expectedList.map((expected) => {
    const hash = String(expected?.paymentHash ?? "").toLowerCase();
    const lookup = lookups.get(hash);
    const state = String(lookup?.state ?? "").toUpperCase();
    const settled = lookup?.settled;
    const amountPaidSat = safeNonnegativeInteger(lookup?.amt_paid_sat ?? lookup?.amountPaidSat);
    const amountExpectedSat = safeNonnegativeInteger(expected?.amountSat);
    const hashMatches = Boolean(hash) &&
      String(lookup?.r_hash ?? lookup?.paymentHash ?? "").toLowerCase() === hash;
    const settledLookup =
      settled === true &&
      (state === "SETTLED" || state === "") &&
      amountPaidSat !== null &&
      amountExpectedSat !== null &&
      amountPaidSat === amountExpectedSat;
    const unpaidLookup =
      settled === false &&
      ["OPEN", "CANCELED", "EXPIRED"].includes(state) &&
      amountPaidSat === 0;
    const reconciled = expectedHashesUnique && hashMatches && (settledLookup || unpaidLookup);
    const settleDateUnix = safeNonnegativeInteger(lookup?.settle_date ?? lookup?.settleDateUnix);

    return {
      id: expected?.id ?? null,
      paymentHash: hash || null,
      reconciled,
      settled: reconciled && settled === true,
      state: reconciled ? state : "UNRECONCILED",
      amountPaidSat: reconciled ? amountPaidSat : null,
      settleDateUnix: reconciled && settled === true ? settleDateUnix || null : null,
      settledAt:
        reconciled && settled === true && settleDateUnix
          ? new Date(settleDateUnix * 1000).toISOString()
          : null,
      reason: reconciled ? null : "bob_lookup_missing_mismatched_or_ambiguous",
    };
  });
  const invariant = classifyInvariant({ startingSpendableBudgetSats, outcomes });
  return { outcomes, ...invariant };
}
