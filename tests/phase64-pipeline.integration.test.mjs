import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { evaluateRunEvidence, prepareInitialReceiverObservations, sanitizeNwcLookup } from "../scripts/phase45-core.mjs";
import { buildPhase62RunConfig, beginInvoiceSetup, recordInvoiceReceipt } from "../scripts/phase45-invoice-setup-core.mjs";
import { buildEvidenceReport } from "../scripts/phase6-evidence-report.mjs";
import { HASH_A, HASH_B, makeEvidence, RUN_ID } from "./phase61-evidence-fixture.mjs";

const BASH = ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"].find(existsSync);
const parser = join(process.cwd(), "scripts", "phase45-parse-bob-lookups.mjs");
const expectedInvoices = makeEvidence().raceEvidence.invoiceLifecycle.map((item) => ({
  id: item.id, paymentHash: item.paymentHash, amountSat: 700, expiresAtUnix: item.expiresAtUnix,
}));
const iso = (value) => new Date(value).toISOString();

function tempDirectory(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }
function runParser(phase, directory) {
  return spawnSync(process.execPath, [parser, phase], { encoding: "utf8", env: { ...process.env, PRIVATE_DIR: directory }, timeout: 5_000 });
}
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }

function runJournalReport(directory, raceEvidence, bobEvidence, { corruptAtIndex = null, trailing = null } = {}) {
  writeJson(join(directory, "phase6-run-config.json"), { runId: RUN_ID, expectedInvoices });
  writeJson(join(directory, "phase45-race-progress.json"), raceEvidence);
  const journalRows = [
    ...bobEvidence.collectionSessions.filter((item) => item.recordType === "collector_started"),
    ...bobEvidence.queryAttempts.map((item) => ({ recordType: "query_attempt", ...item })),
    ...bobEvidence.observations.map((item) => ({ recordType: "receiver_observation", ...item })),
    ...bobEvidence.collectionSessions.filter((item) => item.recordType === "collector_completed"),
  ];
  if (corruptAtIndex !== null) journalRows.splice(corruptAtIndex, 0, "{middle-corruption}");
  let journalText = `${journalRows.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n")}\n`;
  if (trailing !== null) journalText += trailing;
  writeFileSync(join(directory, "bob-final-observations.jsonl"), journalText, { mode: 0o600 });
  const parsed = runParser("final", directory);
  assert.equal(parsed.status, 0, parsed.stderr);
  const bob = JSON.parse(readFileSync(join(directory, "bob-final-evidence.json"), "utf8"));
  const report = buildEvidenceReport({ raceEvidence, bobEvidence: bob, generatedAt: "2026-10-02T00:00:00.000Z" });
  return { bob, report };
}

test("A: collector journal -> Bob parser -> evaluator -> report preserves independently proven FAIL", () => {
  const directory = tempDirectory("limitprobe-phase64-a-");
  try {
    const { raceEvidence, bobEvidence } = makeEvidence({ settledA: true, settledB: true });
    writeJson(join(directory, "phase6-run-config.json"), { runId: RUN_ID, expectedInvoices });
    writeJson(join(directory, "phase45-race-progress.json"), raceEvidence);
    const journal = [
      ...bobEvidence.collectionSessions,
      ...bobEvidence.queryAttempts.map((item) => ({ recordType: "query_attempt", ...item })),
      ...bobEvidence.observations.map((item) => ({ recordType: "receiver_observation", ...item })),
    ];
    writeFileSync(join(directory, "bob-final-observations.jsonl"), `${journal.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
    const parsed = runParser("final", directory);
    assert.equal(parsed.status, 0, parsed.stderr);
    const bob = JSON.parse(readFileSync(join(directory, "bob-final-evidence.json"), "utf8"));
    assert.equal(bob.observations.every((item) => item.sessionId === bob.collectionSessions[0].sessionId), true);
    const report = buildEvidenceReport({ raceEvidence, bobEvidence: bob, generatedAt: "2026-10-02T00:00:00.000Z" });
    assert.equal(report.independentlySettledPrincipalMsat, 1_400_000);
    assert.equal(report.finalClassification, "FAIL");
    assert.notEqual(report.runState.stage, "unknown");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("truncated trailing collector append preserves proven FAIL and records a diagnostic", () => {
  const directory = tempDirectory("limitprobe-phase66-tail-fail-");
  try {
    const { raceEvidence, bobEvidence } = makeEvidence({ settledA: true, settledB: true });
    const { bob, report } = runJournalReport(directory, raceEvidence, bobEvidence, {
      trailing: '{"recordType":"receiver_observation"',
    });
    assert.equal(bob.observations.length, bobEvidence.observations.length);
    assert.ok(bob.collectionIssues.includes("collector_trailing_record_incomplete"));
    assert.equal(report.finalClassification, "FAIL");
    assert.ok(report.reconciliation.collection.issues.includes("collector_trailing_record_incomplete"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("truncated trailing collector append blocks PASS while preserving observations", () => {
  const directory = tempDirectory("limitprobe-phase66-tail-pass-");
  try {
    const { raceEvidence, bobEvidence } = makeEvidence();
    const { bob, report } = runJournalReport(directory, raceEvidence, bobEvidence, {
      trailing: '{"recordType":"receiver_observation"',
    });
    assert.equal(bob.observations.length, bobEvidence.observations.length);
    assert.ok(bob.collectionIssues.includes("collector_trailing_record_incomplete"));
    assert.equal(report.finalClassification, "INCONCLUSIVE");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("middle journal corruption stops at the damaged row and preserves only prior proof", () => {
  const firstDirectory = tempDirectory("limitprobe-phase66-middle-incomplete-");
  const secondDirectory = tempDirectory("limitprobe-phase66-middle-fail-");
  try {
    const incomplete = makeEvidence({ settledA: true, settledB: true });
    const stoppedEarly = runJournalReport(firstDirectory, incomplete.raceEvidence, incomplete.bobEvidence, { corruptAtIndex: 2 });
    assert.equal(stoppedEarly.bob.observations.length, 0);
    assert.ok(stoppedEarly.bob.collectionIssues.includes("collector_journal_invalid"));
    assert.equal(stoppedEarly.report.finalClassification, "INCONCLUSIVE");

    const provenFail = makeEvidence({ settledA: true, settledB: true });
    const eventsBeforeCompletion = 1 + provenFail.bobEvidence.queryAttempts.length + provenFail.bobEvidence.observations.length;
    const preservedPrefix = runJournalReport(secondDirectory, provenFail.raceEvidence, provenFail.bobEvidence, {
      corruptAtIndex: eventsBeforeCompletion,
    });
    assert.equal(preservedPrefix.bob.observations.length, provenFail.bobEvidence.observations.length);
    assert.ok(preservedPrefix.bob.collectionIssues.includes("collector_journal_invalid"));
    assert.equal(preservedPrefix.report.finalClassification, "FAIL");
  } finally {
    rmSync(firstDirectory, { recursive: true, force: true });
    rmSync(secondDirectory, { recursive: true, force: true });
  }
});

test("B: initial Bob acquisition -> parser -> race preparation does not restamp a stalled lookup", () => {
  const directory = tempDirectory("limitprobe-phase64-b-");
  try {
    const now = Date.now();
    writeJson(join(directory, "phase6-run-config.json"), { runId: RUN_ID, expectedInvoices });
    for (const [id, hash, acquiredAt] of [["a", HASH_A, iso(now - 40_000)], ["b", HASH_B, iso(now - 1_000)]]) {
      writeJson(join(directory, `bob-lookup-initial-${id}.json`), {
        r_hash: hash, state: "OPEN", settled: false, amt_paid_sat: 0, amt_paid_msat: 0, settle_date: 0,
      });
      writeFileSync(join(directory, `bob-lookup-initial-${id}.acquired-at`), `${acquiredAt}\n`, { mode: 0o600 });
    }
    const parsed = runParser("initial", directory);
    assert.equal(parsed.status, 0, parsed.stderr);
    const initial = JSON.parse(readFileSync(join(directory, "bob-initial-evidence.json"), "utf8"));
    const dispatchAtById = { A: iso(now + 2_000), B: iso(now + 2_001) };
    const prepared = prepareInitialReceiverObservations({
      runId: RUN_ID, expectedInvoices, observations: initial.observations, beforeAt: iso(now), dispatchAtById,
    });
    assert.equal(prepared.valid, false);
    assert.ok(prepared.reasons.includes("initial_receiver_observation_stale_before_dispatch"));
    assert.equal(prepared.observations[0].acquiredAt, iso(now - 40_000));
    const { raceEvidence, bobEvidence } = makeEvidence();
    raceEvidence.initialBobObservations = prepared.observations;
    const evaluation = evaluateRunEvidence({ raceEvidence, bobEvidence });
    assert.equal(evaluation.classification, "INCONCLUSIVE");
    assert.ok(evaluation.proofReasonCodes.includes("initial_receiver_observation_stale_or_mismatched"));
    const report = buildEvidenceReport({ raceEvidence, bobEvidence, generatedAt: "2026-10-02T00:00:00.000Z" });
    assert.equal(report.finalClassification, "INCONCLUSIVE");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("C: raw NWC capture -> sanitizer -> evaluator -> report preserves NOT_FOUND semantics", () => {
  const { raceEvidence, bobEvidence } = makeEvidence({ settledA: true, settledB: false, terminalB: "CANCELED" });
  const settledAtSeconds = Math.floor(Date.parse(raceEvidence.nwcLookups.find((item) => item.id === "A").settledAt) / 1_000);
  raceEvidence.nwcLookups = [
    sanitizeNwcLookup({ runId: RUN_ID, id: "A", requestedHash: HASH_A, expectedAmountSat: 700,
      lookup: { payment_hash: HASH_A, state: "SETTLED", amount: 700_000, fees_paid: 0, settled_at: settledAtSeconds },
      observedAt: "2026-10-01T10:02:33.000Z" }),
    sanitizeNwcLookup({ runId: RUN_ID, id: "B", requestedHash: HASH_B, expectedAmountSat: 700,
      lookup: {}, error: "NOT_FOUND", observedAt: "2026-10-01T10:02:33.000Z" }),
  ];
  let report = buildEvidenceReport({ raceEvidence, bobEvidence, generatedAt: "2026-10-02T00:00:00.000Z" });
  assert.equal(report.finalClassification, "PASS");
  assert.equal(report.reconciliation.nwcLookups.find((item) => item.id === "B").evidenceType, "not_found");

  raceEvidence.nwcLookups[1] = sanitizeNwcLookup({ runId: RUN_ID, id: "B", requestedHash: HASH_B, expectedAmountSat: 700,
    lookup: { state: "OPEN" }, error: "NOT_FOUND", observedAt: "2026-10-01T10:02:33.000Z" });
  report = buildEvidenceReport({ raceEvidence, bobEvidence, generatedAt: "2026-10-02T00:00:00.000Z" });
  assert.equal(report.finalClassification, "INCONCLUSIVE");
});

test("D: invoice setup -> persisted run config -> evaluator enforces the authoritative lifecycle", () => {
  const { raceEvidence, bobEvidence } = makeEvidence();
  const lifecycle = raceEvidence.invoiceLifecycle;
  let state = beginInvoiceSetup(null, RUN_ID);
  state = recordInvoiceReceipt(state, { ...lifecycle[0], id: "A", amountSat: 700 });
  state = recordInvoiceReceipt(state, { ...lifecycle[1], id: "B", amountSat: 700 });
  const config = JSON.parse(JSON.stringify(buildPhase62RunConfig(state, {
    runId: RUN_ID, createdAt: raceEvidence.runStartedAt, noOtherPayerPathVerified: true,
  })));
  assert.equal(config.status, undefined);
  raceEvidence.expectedInvoiceExpirySeconds = config.invoiceExpirySeconds;
  raceEvidence.requiredGraceSeconds = config.requiredGraceSeconds;
  raceEvidence.invoiceLifecycle = config.invoices.map((item) => ({
    ...item,
    dispatchAt: raceEvidence.attempts.find((attempt) => attempt.id === item.id).dispatchedAt,
    reconciliationDeadline: raceEvidence.reconciliationDeadline,
    requiredGraceSeconds: config.requiredGraceSeconds,
  }));
  raceEvidence.invoicesCreatedForRun = config.invoicesCreatedForRun;
  raceEvidence.testExclusiveInvoices = config.invoicesCreatedForRun;
  raceEvidence.noOtherPayerPath = config.noOtherPayerPathVerified;
  const evaluation = evaluateRunEvidence({ raceEvidence, bobEvidence });
  assert.equal(evaluation.classification, "PASS");
  const stale = structuredClone(raceEvidence);
  stale.invoiceLifecycle[1].requiredGraceSeconds = 29;
  assert.equal(evaluateRunEvidence({ raceEvidence: stale, bobEvidence }).classification, "INCONCLUSIVE");
});

test("E: lifecycle lock spans mocked app-helper setup without creating an app", { skip: !BASH }, () => {
  const directory = tempDirectory("limitprobe-phase64-e-");
  const bash = (args, options = {}) => spawnSync(BASH, args, { encoding: "utf8", timeout: 8_000, ...options });
  const cygpath = (value) => {
    const result = bash(["-lc", "cygpath -u \"$1\"", "_", value]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const posixDirectory = cygpath(directory);
  const privateDirectory = `${posixDirectory}/private`;
  const tokenFile = `${posixDirectory}/token.jwt`;
  const uri = `nostr+walletconnect://${"a".repeat(64)}?relay=ws%3A%2F%2Flocalhost%3A8080&secret=${"b".repeat(64)}`;
  try {
    writeFileSync(join(directory, "token.jwt"), "fixture-auth-value\n", { mode: 0o600 });
    const bashEnvWin = join(directory, "test-bash-env");
    writeFileSync(bashEnvWin, `
jq() {
  case "$*" in
    *'select(.name == $name) | .pairingUri'*) printf '%s\\n' "$NWC_FIXTURE_URI" ;;
    *'maxAmountSat'*) printf '%s\\n' '{"name":"LimitProbe-Phase62-Final","maxAmountSat":1000,"maxAmountMsat":1000000,"budgetUsageSat":0,"budgetRenewal":"never","scopes":["get_balance","get_info","lookup_invoice","pay_invoice"]}' ;;
    *) return 0 ;;
  esac
}
python3() { return 0; }
flock() { return 0; }
chmod() { return 0; }
mkdir() { if [[ "$1" == -m ]]; then shift 2; fi; command mkdir "$@"; }
stat() { local p="$3"; if [[ -d "$p" ]]; then printf '700\\n'; else printf '600\\n'; fi; }
npx() {
  case " $* " in
    *" list-apps "*)
      local n=0; [[ ! -f "$NWC_TEST_LIST_COUNT" ]] || n="$(cat "$NWC_TEST_LIST_COUNT")"; n=$((n+1)); printf '%s' "$n" >"$NWC_TEST_LIST_COUNT"
      if [[ $n -eq 1 ]]; then printf '%s\\n' '{"apps":[]}'; else printf '%s\\n' '{"apps":[{"name":"LimitProbe-Phase62-Final","maxAmountSat":1000,"maxAmountMsat":1000000,"budgetUsageSat":0,"budgetRenewal":"never","scopes":["get_balance","get_info","lookup_invoice","pay_invoice"]}]}'; fi ;;
    *" create-app "*) printf '{"name":"LimitProbe-Phase62-Final","pairingUri":"%s"}\\n' "$NWC_FIXTURE_URI" ;;
    *) return 2 ;;
  esac
}
`, { mode: 0o600 });
    const bashEnv = cygpath(bashEnvWin);
    const helper = cygpath(join(process.cwd(), "scripts", "phase62-create-app.sh"));
    const lockHelper = cygpath(join(process.cwd(), "scripts", "phase62-run-lock.sh"));
    const uidResult = bash(["-lc", "id -u"]);
    assert.equal(uidResult.status, 0);
    const env = {
      ...process.env,
      BASH_ENV: bashEnv,
      PHASE62_EXPECTED_UID: uidResult.stdout.trim(),
      PHASE62_PRIVATE_DIR: privateDirectory,
      PHASE62_TOKEN_FILE: tokenFile,
      PHASE62_HUB_URL: "http://127.0.0.1:8080",
      PHASE62_APP_LOCK_FILE: `${posixDirectory}/app.lock`,
      NWC_FIXTURE_URI: uri,
      NWC_TEST_LIST_COUNT: `${posixDirectory}/list-count`,
    };
    const lifecycleScript = `
      mkdir -m 700 "$2" || exit 19
      source "$1"
      phase62_acquire_run_lock "$2" || exit 20
      bash "$3" >/dev/null 2>&1 || exit 21
      bash -c 'source "$1"; phase62_acquire_run_lock "$2" && exit 22; printf LOCK_REFUSED' _ "$1" "$2" || exit 23
      phase62_release_run_lock || exit 24
      printf SETUP_OK
    `;
    const held = bash(["-c", lifecycleScript, "_", lockHelper, privateDirectory, helper], { env });
    assert.equal(held.status, 0, held.stderr);
    assert.match(held.stdout, /LOCK_REFUSED/);
    assert.match(held.stdout, /SETUP_OK/);
    assert.equal(readFileSync(join(directory, "private", "phase62-app-ready"), "utf8").trim(), "PHASE62_APP_READY");
    const createdCapture = readFileSync(join(directory, "private", "hub-create-app.stdout.json"), "utf8");
    assert.equal(createdCapture.includes(uri), true);
    assert.equal(held.stdout.includes(uri), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("malformed Bob evidence reports deterministically without crashing or hiding proven FAIL", () => {
  for (const malformed of [{}, null, [null, { id: "X", errorCode: "secret-shaped synthetic evidence" }]]) {
    const evidence = makeEvidence();
    evidence.bobEvidence.observations = malformed;
    const first = buildEvidenceReport({ ...evidence, generatedAt: "2026-10-02T00:00:00.000Z" });
    const second = buildEvidenceReport({ ...evidence, generatedAt: "2026-10-02T00:00:00.000Z" });
    assert.equal(first.finalClassification, "INCONCLUSIVE");
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first).includes("secret-shaped synthetic evidence"), false);
  }

  const provenFail = makeEvidence({ settledA: true, settledB: true });
  provenFail.bobEvidence.observations.push(null, {});
  const failReport = buildEvidenceReport({ ...provenFail, generatedAt: "2026-10-02T00:00:00.000Z" });
  assert.equal(failReport.finalClassification, "FAIL");
  assert.equal(JSON.stringify(failReport).includes("[object Object]"), false);
});
