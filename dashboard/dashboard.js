import { runSandboxSimulation } from "./sandbox/sandbox-runner.js";
import { createSandboxEvidence } from "./sandbox/sandbox-evidence.js";

const EXPECTED_RUN_ID = "5519e35b-96c5-4e25-8bbc-668d41dea845";
const number = new Intl.NumberFormat("en-US");
const byId = (id) => document.getElementById(id);
const setText = (id, value) => { const element = byId(id); if (element) element.textContent = String(value); };

function formatSats(value) {
  return Number.isSafeInteger(value) && value >= 0 ? number.format(value) : "—";
}

function formatPaidAmount(value) {
  if (!Number.isSafeInteger(value) || value < 0) return "—";
  return value % 1000 === 0 ? `${number.format(value / 1000)} sats` : `${number.format(value)} msat`;
}

function latestReceiverObservation(observations, id) {
  return (Array.isArray(observations) ? observations : [])
    .filter((item) => item?.id === id && typeof item.observedAt === "string")
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
    .at(-1) ?? null;
}

function setOutcome(id, result, receiver) {
  const pill = byId(`attempt-${id.toLowerCase()}-state`);
  const detail = byId(`attempt-${id.toLowerCase()}-detail`);
  const row = byId(`attempt-${id.toLowerCase()}`);
  if (!pill || !detail || !row) return;

  let label = "UNRESOLVED";
  let description = "Receiver evidence unavailable";
  let tone = "is-unknown";
  if (receiver?.state === "SETTLED" && receiver.settled === true && receiver.amountPaidSat > 0) {
    label = "SETTLED";
    description = `${formatSats(receiver.amountPaidSat)} sats · Bob LND`;
    tone = "";
  } else if (receiver?.state === "CANCELED" && receiver.settled === false && receiver.amountPaidSat === 0 && result?.errorCode === "QUOTA_EXCEEDED") {
    label = "BLOCKED";
    description = "QUOTA_EXCEEDED · unpaid";
    tone = "is-blocked";
  } else if (typeof receiver?.state === "string") {
    label = receiver.state;
    description = `${formatSats(receiver.amountPaidSat)} sats · Bob LND`;
  }
  pill.textContent = label;
  pill.className = `outcome-pill ${tone}`.trim();
  detail.textContent = description;
  row.dataset.outcome = tone === "is-blocked" ? "blocked" : tone ? "unknown" : "settled";
}

function setReceiverProof(id, receiver) {
  const suffix = id.toLowerCase();
  const state = receiver?.state ?? "UNRESOLVED";
  setText(`proof-${suffix}-state`, state);
  setText(`proof-${suffix}-amount`, `${formatPaidAmount(receiver?.amountPaidMsat)} · ${receiver?.settled === true ? "settled" : "unpaid"}`);
  setText(`proof-${suffix}-mark`, receiver?.state === "SETTLED" && receiver?.settled === true ? "✓" : receiver?.state === "CANCELED" && receiver?.settled === false ? "✓" : "·");
}

function renderEvidence(report) {
  if (report.runId !== EXPECTED_RUN_ID) throw new Error("The evidence file is for a different run.");
  if (!["PASS", "FAIL", "INCONCLUSIVE"].includes(report.finalClassification)) throw new Error("The evidence classification is invalid.");

  const attempts = new Map((Array.isArray(report.attempts) ? report.attempts : []).map((attempt) => [attempt.id, attempt]));
  const observations = report.reconciliation?.bobObservations;
  const receiverA = latestReceiverObservation(observations, "A");
  const receiverB = latestReceiverObservation(observations, "B");
  const attemptA = attempts.get("A");
  const attemptB = attempts.get("B");
  const cap = report.configuredBudgetSats;
  const amountA = attemptA?.requestedAmountSats;
  const amountB = attemptB?.requestedAmountSats;
  const settledSats = report.independentlySettledPrincipalSats;
  const remainingMsat = report.postRaceBudget?.remainingBudgetMsat;
  const remaining = Number.isSafeInteger(remainingMsat) && remainingMsat % 1000 === 0 ? remainingMsat / 1000 : null;
  const complete = report.evidenceCompleteness?.complete === true;
  const invariant = report.invariant?.holds === true;
  const classification = report.finalClassification;

  setText("classification", classification);
  setText("board-result", classification);
  setText("evidence-badge", classification);
  setText("run-id", `RUN ${report.runId}`);
  setText("load-message", complete ? "Receiver evidence and budget reconciliation complete" : "Evidence is incomplete");
  setText("limit-value", formatSats(cap));
  setText("wallet-limit", formatSats(cap));
  setText("spent-limit", formatSats(cap));
  setText("request-count", formatSats(report.requestCount));
  setText("attempt-amount", formatSats(amountA));
  setText("dispatch-delta", Number.isFinite(report.dispatchDeltaMs) ? report.dispatchDeltaMs.toFixed(3) : "—");
  setText("barrier-delta", `${Number.isFinite(report.dispatchDeltaMs) ? report.dispatchDeltaMs.toFixed(3) : "—"} ms apart`);
  setText("attempt-a-amount", `${formatSats(amountA)} sats`);
  setText("attempt-b-amount", `${formatSats(amountB)} sats`);
  setText("spent-total", formatSats(settledSats));
  setText("latest-delta", Number.isFinite(report.dispatchDeltaMs) ? report.dispatchDeltaMs.toFixed(3) : "—");
  setText("latest-settled", formatSats(settledSats));
  setText("latest-remaining", formatSats(remaining));
  setText("proof-total", formatSats(settledSats));
  setText("evidence-check", complete ? "✓" : "!");
  setText("invariant-check", invariant ? "✓" : "!");
  setText("invariant-state", invariant ? "HELD" : "NOT PROVEN");
  setText("evidence-title", complete ? "Ground truth lives at the receiver." : "Receiver proof is incomplete.");

  setOutcome("A", attemptA?.nwcResult, receiverA);
  setOutcome("B", attemptB?.nwcResult, receiverB);
  setReceiverProof("A", receiverA);
  setReceiverProof("B", receiverB);

  const spentRatio = Number.isSafeInteger(settledSats) && Number.isSafeInteger(cap) && cap > 0
    ? Math.max(0, Math.min(100, (settledSats / cap) * 100))
    : 0;
  const meter = byId("spent-fill");
  meter.max = Number.isSafeInteger(cap) && cap > 0 ? cap : 100;
  meter.value = Number.isSafeInteger(settledSats) && settledSats >= 0 ? settledSats : 0;
  meter.setAttribute("aria-label", `${formatSats(settledSats)} sats independently settled from a ${formatSats(cap)} sat wallet limit (${spentRatio.toFixed(0)} percent)`);
  byId("main").dataset.state = complete ? "ready" : "incomplete";
  byId("main").dataset.classification = classification.toLowerCase();
  byId("evidence-badge").dataset.classification = classification.toLowerCase();
  byId("classification").dataset.classification = classification.toLowerCase();
}

try {
  const response = await fetch("/reports/phase6.2-final-evidence.json", { cache: "no-store" });
  if (!response.ok) throw new Error("The committed evidence report could not be loaded.");
  const report = await response.json();
  renderEvidence(report);
} catch (error) {
  const message = error instanceof Error ? error.message : "Evidence is unavailable.";
  setText("classification", "—");
  setText("run-id", "No run was classified");
  setText("load-message", message);
  byId("main").dataset.state = "error";
}

const sandboxStepKeys = ["prepare", "budget", "invoices", "dispatch", "reconcile", "evidence", "classification"];
const sandboxStepText = {
  prepare: "Preparing sandbox",
  budget: "Applying the 1,000 sat spending limit",
  invoices: "Creating two simulated payment attempts",
  dispatch: "Dispatching both attempts at one barrier",
  reconcile: "Reconciling simulated outcomes",
  evidence: "Generating redacted sandbox evidence",
};
let latestSandboxEvidence = null;
let sandboxDownloadUrl = null;
let sandboxRunning = false;

function updateSandboxProgress(activeIndex) {
  const steps = [...byId("sandbox-progress").children];
  steps.forEach((step, index) => {
    step.classList.toggle("is-complete", index < activeIndex);
    step.classList.toggle("is-active", index === activeIndex);
    if (index === activeIndex) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
}

function finishSandboxProgress(evidence) {
  const steps = [...byId("sandbox-progress").children];
  steps.forEach((step) => {
    step.classList.remove("is-active");
    step.classList.add("is-complete");
    step.removeAttribute("aria-current");
  });
  steps.at(-1).lastElementChild.textContent = `${evidence.finalClassification} classification`;
}

function renderSandboxEvidence(evidence) {
  latestSandboxEvidence = evidence;
  byId("sandbox-classification").textContent = evidence.finalClassification;
  byId("sandbox-run-id").textContent = `RUN ${evidence.runId}`;
  byId("sandbox-attempt-a").textContent = evidence.attempts[0].simulatedPaymentResult === "SUCCESS" ? "SETTLED" : evidence.attempts[0].simulatedPaymentResult;
  byId("sandbox-attempt-b").textContent = evidence.attempts[1].simulatedPaymentResult === "SUCCESS" ? "SETTLED" : evidence.attempts[1].simulatedPaymentResult;
  byId("sandbox-settled").textContent = formatSats(evidence.settledPrincipalSats);
  byId("sandbox-remaining").textContent = formatSats(evidence.remainingBudgetSats);
  byId("sandbox-invariant").textContent = evidence.invariant.holds ? "Spending invariant held" : "Spending invariant failed";
  byId("sandbox-invariant-mark").textContent = evidence.invariant.holds ? "✓" : "!";
  byId("sandbox-stage").dataset.classification = evidence.finalClassification.toLowerCase();
  byId("sandbox-classification").dataset.classification = evidence.finalClassification.toLowerCase();
  byId("sandbox-empty").hidden = true;
  byId("sandbox-results").hidden = false;
  byId("view-sandbox-evidence").hidden = false;
  byId("download-sandbox-evidence").hidden = false;
  byId("sandbox-evidence-json").textContent = JSON.stringify(evidence, null, 2);

  if (sandboxDownloadUrl) URL.revokeObjectURL(sandboxDownloadUrl);
  sandboxDownloadUrl = URL.createObjectURL(new Blob([JSON.stringify(evidence, null, 2)], { type: "application/json" }));
  const download = byId("download-sandbox-evidence");
  download.href = sandboxDownloadUrl;
  download.download = `limitprobe-sandbox-${evidence.runId}.json`;
}

function pauseForProgress() {
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  return new Promise((resolve) => globalThis.setTimeout(resolve, reducedMotion ? 45 : 115));
}

async function runSandbox() {
  if (sandboxRunning) return;
  sandboxRunning = true;
  document.querySelectorAll("[data-run-sandbox]").forEach((button) => { button.disabled = true; });
  document.querySelectorAll("[data-run-sandbox]").forEach((button) => { button.firstChild.textContent = "Running Sandbox… "; });
  byId("sandbox-stage").dataset.state = "running";
  delete byId("sandbox-stage").dataset.classification;
  byId("sandbox-progress").querySelectorAll("li").forEach((step) => {
    step.classList.remove("is-active", "is-complete");
    delete step.dataset.state;
    step.removeAttribute("aria-current");
  });
  byId("sandbox-progress").lastElementChild.lastElementChild.textContent = "PASS / FAIL / INCONCLUSIVE";
  byId("sandbox-empty").hidden = false;
  byId("sandbox-results").hidden = true;
  byId("view-sandbox-evidence").hidden = true;
  byId("download-sandbox-evidence").hidden = true;
  latestSandboxEvidence = null;
  if (sandboxDownloadUrl) {
    URL.revokeObjectURL(sandboxDownloadUrl);
    sandboxDownloadUrl = null;
  }
  byId("sandbox-status").textContent = "Starting an isolated browser simulation. No live wallet calls will be made.";
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!reducedMotion) byId("sandbox-test").scrollIntoView({ behavior: "smooth", block: "start" });

  let simulation;
  let evidence;
  try {
    for (let index = 0; index < sandboxStepKeys.length - 1; index += 1) {
      const key = sandboxStepKeys[index];
      updateSandboxProgress(index);
      byId("sandbox-status").textContent = sandboxStepText[key];
      await pauseForProgress();
      if (key === "dispatch") simulation = await runSandboxSimulation();
      if (key === "reconcile" && simulation) byId("sandbox-status").textContent = `${simulation.attempts.filter((attempt) => attempt.result === "SUCCESS").length} settled · ${simulation.attempts.filter((attempt) => attempt.result === "QUOTA_EXCEEDED").length} blocked by the simulated limit`;
      if (key === "evidence") evidence = createSandboxEvidence(simulation);
    }
    updateSandboxProgress(sandboxStepKeys.length - 1);
    if (!evidence) throw new Error("Sandbox evidence was not generated.");
    renderSandboxEvidence(evidence);
    finishSandboxProgress(evidence);
    byId("sandbox-status").textContent = `${evidence.finalClassification} · Sandbox Test complete. Simulation only.`;
    byId("sandbox-stage").dataset.state = "complete";
  } catch {
    const finalStep = byId("sandbox-progress").lastElementChild;
    finalStep.classList.add("is-active");
    finalStep.dataset.state = "error";
    byId("sandbox-status").textContent = "INCONCLUSIVE · The sandbox could not complete this run. Try again.";
    byId("sandbox-stage").dataset.state = "error";
  } finally {
    document.querySelectorAll("[data-run-sandbox]").forEach((button) => {
      button.disabled = false;
      button.firstChild.textContent = "Run Sandbox Test ";
    });
    sandboxRunning = false;
  }
}

document.querySelectorAll("[data-run-sandbox]").forEach((button) => button.addEventListener("click", runSandbox));
byId("view-sandbox-evidence").addEventListener("click", () => {
  if (!latestSandboxEvidence) return;
  byId("sandbox-evidence-json").textContent = JSON.stringify(latestSandboxEvidence, null, 2);
  byId("sandbox-evidence-dialog").showModal();
});
byId("close-sandbox-evidence").addEventListener("click", () => byId("sandbox-evidence-dialog").close());
byId("sandbox-evidence-dialog").addEventListener("click", (event) => {
  if (event.target === byId("sandbox-evidence-dialog")) byId("sandbox-evidence-dialog").close();
});
