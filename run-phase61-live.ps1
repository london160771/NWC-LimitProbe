#requires -Version 5.1
param(
    [switch]$ResumeExistingRun
)

$ErrorActionPreference = 'Stop'

$workspacePath = [System.IO.Path]::GetFullPath($PSScriptRoot)
if ($workspacePath -notmatch '^[A-Za-z]:\\') { throw 'The project must be in a drive-letter path accessible to WSL.' }
$driveLetter = $workspacePath.Substring(0, 1).ToLowerInvariant()
$linuxWorkspace = '/mnt/' + $driveLetter + $workspacePath.Substring(2).Replace('\', '/')
$workspaceBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($linuxWorkspace))
$wslExe = 'C:\Windows\System32\wsl.exe'

if (-not $ResumeExistingRun) {
    $phase61CreateAppScript = $linuxWorkspace + '/scripts/phase61-create-app.sh'
    $phase61CreateAppArgs = @('-d', 'Ubuntu', '--', 'bash', $phase61CreateAppScript)
    & $wslExe @phase61CreateAppArgs
    $createAppExitCode = $LASTEXITCODE
    if ($createAppExitCode -ne 0) {
        throw "Phase 6.1 app creation stopped with exit code $createAppExitCode. No race was started."
    }
}

$linuxScript = @'
set -Eeuo pipefail
set +x
umask 077
workspace_b64='__WORKSPACE_B64__'
workspace_dir="$(printf '%s' "$workspace_b64" | base64 -d)"
private_dir="/home/uk/.local/share/nwc-limitprobe-phase6-1"
phase23_dir="/home/uk/.local/share/nwc-limitprobe-phase2-3"
network="polar-network-1_default"
resume_existing_run='__RESUME_MODE__'
runner_uid="$(id -u)"
docker_run() { bash "$workspace_dir/scripts/phase61-docker-run.sh" "$@"; }
stage="private_setup"

fail() { printf 'PHASE61_FAILED stage=%s reason=%s\n' "$stage" "$1" >&2; exit 1; }
[[ "$runner_uid" == "$(id -u uk 2>/dev/null)" ]] || fail "runner_must_run_as_uk"
[[ -d "$private_dir" ]] || fail "fresh_app_helper_private_directory_missing"
[[ -s "$private_dir/phase61-app-ready" ]] || fail "fresh_app_helper_completion_marker_missing"
[[ "$(cat "$private_dir/phase61-app-ready" 2>/dev/null)" == "PHASE61_APP_READY" ]] || fail "fresh_app_helper_completion_marker_invalid"
[[ -s "$private_dir/nwc-url" && -s "$private_dir/app-config.json" ]] || fail "fresh_app_helper_outputs_missing"
[[ "$(stat -c '%a' "$private_dir" 2>/dev/null)" == "700" ]] || fail "private_directory_permissions_invalid"
[[ "$(stat -c '%a' "$private_dir/nwc-url" 2>/dev/null)" == "600" ]] || fail "nwc_url_permissions_invalid"
[[ "$(stat -c '%a' "$private_dir/app-config.json" 2>/dev/null)" == "600" ]] || fail "app_config_permissions_invalid"
[[ "$(stat -c '%u' "$private_dir/nwc-url" 2>/dev/null)" == "$runner_uid" ]] || fail "nwc_url_owner_invalid"
[[ "$(stat -c '%u' "$private_dir/app-config.json" 2>/dev/null)" == "$runner_uid" ]] || fail "app_config_owner_invalid"
trap 'rc=$?; if [[ $rc -ne 0 ]]; then printf "PHASE61_FAILED stage=%s exit=%s\n" "$stage" "$rc" >&2; fi' ERR
trap 'rm -f "$private_dir"/*.raw.json "$private_dir"/bob-addinvoice-*.json "$private_dir"/bob-lookup-initial-*.json' EXIT

[[ ! -e "$workspace_dir/reports/phase6.1-evidence.json" ]] || fail "phase61_report_already_exists_refusing_overwrite"
if [[ "$resume_existing_run" != "1" ]]; then
  for existing in phase6-run-config.json bob-invoice-a bob-invoice-b bob-payment-hash-a bob-payment-hash-b phase6.1-payment-dispatch-started; do
    [[ ! -e "$private_dir/$existing" ]] || fail "existing_phase61_run_state_requires_explicit_resume_mode"
  done
fi
command -v docker >/dev/null 2>&1 || fail "docker_cli_missing"
command -v jq >/dev/null 2>&1 || fail "jq_missing"
command -v curl >/dev/null 2>&1 || fail "curl_missing"

stage="docker_and_polar_topology"
docker info >/dev/null 2>&1 || fail "docker_engine_unavailable"
docker network inspect "$network" >/dev/null 2>&1 || fail "existing_polar_network_unavailable"
verify_container() {
  local name="$1" state attached
  state="$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null)" || return 1
  [[ "$state" == "running" ]] || return 1
  attached="$(docker inspect --format '{{if index .NetworkSettings.Networks "polar-network-1_default"}}yes{{else}}no{{end}}' "$name" 2>/dev/null)" || return 1
  [[ "$attached" == "yes" ]]
}
for container in polar-n1-backend1 polar-n1-alice polar-n1-bob limitprobe-albyhub limitprobe-relay; do
  verify_container "$container" || fail "required_existing_container_unhealthy_or_detached"
done

alice_info="$(docker exec polar-n1-alice lncli --lnddir=/home/lnd/.lnd --network=regtest getinfo 2>/dev/null)" || fail "alice_lnd_unreachable"
bob_info="$(docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest getinfo 2>/dev/null)" || fail "bob_lnd_unreachable"
jq -e '(.synced_to_chain == true) and any(.chains[]?; .network == "regtest")' <<<"$alice_info" >/dev/null || fail "alice_lnd_not_synced_on_regtest"
jq -e '(.synced_to_chain == true) and any(.chains[]?; .network == "regtest")' <<<"$bob_info" >/dev/null || fail "bob_lnd_not_synced_on_regtest"
bob_pubkey="$(jq -er '.identity_pubkey | strings' <<<"$bob_info")" || fail "bob_identity_unavailable"
active_count="$(docker exec polar-n1-alice lncli --lnddir=/home/lnd/.lnd --network=regtest listchannels 2>/dev/null | jq --arg bob "$bob_pubkey" '[.channels[]? | select(.active == true and .remote_pubkey == $bob)] | length' 2>/dev/null)" || fail "alice_channel_query_failed"
[[ "$active_count" =~ ^[0-9]+$ && "$active_count" -ge 1 ]] || fail "existing_alice_bob_channel_not_active"
hub_http="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:8080/ 2>/dev/null)" || fail "alby_hub_http_unreachable"
[[ "$hub_http" =~ ^[23][0-9][0-9]$ ]] || fail "alby_hub_http_not_responding"
printf '{"polarNetwork":"verified","backend":"running","aliceLnd":"healthy_regtest_synced","bobLnd":"healthy_regtest_synced","aliceBobActiveChannels":%s,"albyHubHttp":"%s","relay":"running","requiredContainersAttached":true}\n' "$active_count" "$hub_http"

stage="read_only_existing_nwc_environment_check"
old_nwc_file="$phase23_dir/nwc-output/nwc-url"
[[ -s "$old_nwc_file" ]] || fail "read_only_phase2_nwc_health_credential_missing"
if ! docker_run --rm --network "$network" -v "$workspace_dir:/app:ro" -v "$old_nwc_file:/run/secrets/nwc-url:ro" -w /app node:22-bookworm node scripts/phase2-nwc-check.mjs >"$private_dir/phase2-health.raw.json" 2>/dev/null; then
  rm -f "$private_dir/phase2-health.raw.json"
  fail "read_only_phase2_nwc_health_check_failed"
fi
if ! jq -e '.connection == "connected" and .relay == "ws://limitprobe-relay:8080" and .encryption == "nip44" and .encryptionVerified == true and .network == "regtest" and .requiredMethodsPresent == true' "$private_dir/phase2-health.raw.json" >/dev/null 2>&1; then
  rm -f "$private_dir/phase2-health.raw.json"
  fail "read_only_phase2_nwc_health_check_not_ready"
fi
jq '{test,connection,relay,encryption,encryptionVerified,network,methods,requiredMethodsPresent}' "$private_dir/phase2-health.raw.json" >"$private_dir/environment-nwc-health.json"
chmod 600 "$private_dir/environment-nwc-health.json"
rm -f "$private_dir/phase2-health.raw.json"
cat "$private_dir/environment-nwc-health.json"

stage="hub_authentication_and_fresh_app_creation"
if ! jq -e '.name == "LimitProbe-Phase61-Race" and .maxAmountSat == 1000 and .maxAmountMsat == 1000000 and .budgetUsageSat == 0 and .budgetRenewal == "never" and ((.scopes | sort) == ["get_balance","get_info","lookup_invoice","pay_invoice"])' "$private_dir/app-config.json" >/dev/null 2>&1; then
  fail "fresh_app_helper_configuration_invalid"
fi
printf '{"freshNwcConnectionCreated":true,"appName":"LimitProbe-Phase61-Race","budgetSats":1000,"renewal":"never","scopes":["get_balance","get_info","lookup_invoice","pay_invoice"],"uriPrinted":false}\n'

stage="fresh_nwc_read_only_preflight"
if ! docker_run --rm --network "$network" -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private:ro" -w /app node:22-bookworm node scripts/phase45-nwc-preflight.mjs >"$private_dir/fresh-preflight.raw.json" 2>/dev/null; then
  if [[ -s "$private_dir/fresh-preflight.raw.json" ]]; then
    jq '{test,relay,connection,encryption,encryptionVerified,network,methods,appConfigVerified,configuredScopes,requiredMethodsPresent,missingMethods,budgetTotalMsat,budgetUsedMsat,budgetRemainingMsat,budgetTotalSat,budgetRemainingSat,budgetRenewal,budgetRenewalNwc,budgetVerified,secretsRedacted}' "$private_dir/fresh-preflight.raw.json" >"$private_dir/fresh-nwc-preflight.json" 2>/dev/null || true
    [[ ! -s "$private_dir/fresh-nwc-preflight.json" ]] || cat "$private_dir/fresh-nwc-preflight.json"
  fi
  rm -f "$private_dir/fresh-preflight.raw.json"
  fail "fresh_nwc_preflight_command_failed_no_invoices_created"
fi
jq '{test,relay,connection,encryption,encryptionVerified,network,methods,appConfigVerified,configuredScopes,requiredMethodsPresent,missingMethods,budgetTotalMsat,budgetUsedMsat,budgetRemainingMsat,budgetTotalSat,budgetRemainingSat,budgetRenewal,budgetRenewalNwc,budgetVerified,secretsRedacted}' "$private_dir/fresh-preflight.raw.json" >"$private_dir/fresh-nwc-preflight.json"
chmod 600 "$private_dir/fresh-nwc-preflight.json"
rm -f "$private_dir/fresh-preflight.raw.json"
cat "$private_dir/fresh-nwc-preflight.json"
jq -e '.connection == "connected" and .encryption == "nip44" and .encryptionVerified == true and .network == "regtest" and .appConfigVerified == true and .requiredMethodsPresent == true and .budgetVerified == true and .budgetTotalMsat == 1000000 and .budgetUsedMsat == 0 and .budgetRemainingMsat == 1000000 and .budgetTotalSat == 1000 and .budgetRemainingSat == 1000 and .budgetRenewal == "never" and (.configuredScopes == ["get_balance","get_info","lookup_invoice","pay_invoice"])' "$private_dir/fresh-nwc-preflight.json" >/dev/null || fail "fresh_nwc_preflight_failed_no_invoices_created"

if [[ "$resume_existing_run" == "1" ]]; then
  stage="resume_existing_run_artifact_validation"
  expected_run_id="b542cedc-c9dc-4baf-8d87-58de1bb02a5b"
  for stale in \
    phase6.1-payment-dispatch-started phase45-race-progress.json phase45-race-results.json \
    bob-initial-evidence.json bob-final-evidence.json bob-final-observations.jsonl \
    bob-lookup-initial-a.json bob-lookup-initial-b.json resume-artifact-validation.json \
    resume-bob-validation.json reports/phase6.1-evidence.json; do
    case "$stale" in
      reports/*) [[ ! -e "$workspace_dir/$stale" ]] || fail "resume_state_already_advanced_refusing_retry" ;;
      *) [[ ! -e "$private_dir/$stale" ]] || fail "resume_state_already_advanced_refusing_retry" ;;
    esac
  done
  artifact_exit=0
  docker_run --rm -e "PHASE61_EXPECTED_UID=$runner_uid" -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private:ro" -w /app node:22-bookworm node scripts/phase61-resume-validation.mjs artifacts >"$private_dir/resume-artifact-validation.raw.json" 2>/dev/null || artifact_exit=$?
  if [[ -s "$private_dir/resume-artifact-validation.raw.json" ]]; then
    jq '{resumeArtifactsVerified,runId,invoiceCount,amountsSat,errorCode,secretsRedacted}' "$private_dir/resume-artifact-validation.raw.json" >"$private_dir/resume-artifact-validation.json" 2>/dev/null || true
    chmod 600 "$private_dir/resume-artifact-validation.json" 2>/dev/null || true
    rm -f "$private_dir/resume-artifact-validation.raw.json"
    [[ ! -s "$private_dir/resume-artifact-validation.json" ]] || cat "$private_dir/resume-artifact-validation.json"
  fi
  [[ "$artifact_exit" -eq 0 ]] || fail "resume_run_config_or_invoice_binding_invalid"
  jq -e --arg run "$expected_run_id" '.resumeArtifactsVerified == true and .runId == $run and .invoiceCount == 2 and .amountsSat == [700,700] and .secretsRedacted == true' "$private_dir/resume-artifact-validation.json" >/dev/null || fail "resume_run_artifacts_not_verified"
else
  stage="create_two_fresh_bob_invoices"
  docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest addinvoice --amt=700 >"$private_dir/bob-addinvoice-a.json" 2>/dev/null || fail "bob_invoice_a_creation_failed"
  docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest addinvoice --amt=700 >"$private_dir/bob-addinvoice-b.json" 2>/dev/null || fail "bob_invoice_b_creation_failed"
  chmod 600 "$private_dir/bob-addinvoice-a.json" "$private_dir/bob-addinvoice-b.json"
  if ! docker_run --rm -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private" -w /app node:22-bookworm node scripts/phase45-save-invoices.mjs >"$private_dir/invoice-capture.raw.json" 2>/dev/null; then
    rm -f "$private_dir/invoice-capture.raw.json" "$private_dir/bob-addinvoice-a.json" "$private_dir/bob-addinvoice-b.json"
    fail "fresh_invoice_validation_failed"
  fi
  jq '{invoicesCreated,runId,invoices:[.invoices[]|{id,paymentHash,amountSat}],network,bolt11Redacted}' "$private_dir/invoice-capture.raw.json" >"$private_dir/invoice-capture.json"
  chmod 600 "$private_dir/invoice-capture.json"
  rm -f "$private_dir/invoice-capture.raw.json"
  jq -e '.invoicesCreated == 2 and .network == "regtest" and .bolt11Redacted == true and (.invoices | length == 2) and ([.invoices[] | select(.amountSat == 700 and (.paymentHash | test("^[0-9a-f]{64}$")))] | length == 2) and ([.invoices[].paymentHash] | unique | length == 2)' "$private_dir/invoice-capture.json" >/dev/null || fail "two_distinct_700_sat_regtest_invoices_not_verified"
  cat "$private_dir/invoice-capture.json"
fi

stage="verify_bob_initial_unpaid_state"
hash_a="$(cat "$private_dir/bob-payment-hash-a")"
hash_b="$(cat "$private_dir/bob-payment-hash-b")"
docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice "$hash_a" >"$private_dir/bob-lookup-initial-a.json" 2>/dev/null || fail "bob_initial_lookup_a_failed"
docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice "$hash_b" >"$private_dir/bob-lookup-initial-b.json" 2>/dev/null || fail "bob_initial_lookup_b_failed"
chmod 600 "$private_dir/bob-lookup-initial-a.json" "$private_dir/bob-lookup-initial-b.json"
if [[ "$resume_existing_run" == "1" ]]; then
  bob_exit=0
  docker_run --rm -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private:ro" -w /app node:22-bookworm node scripts/phase61-resume-validation.mjs bob-lookups >"$private_dir/resume-bob-validation.raw.json" 2>/dev/null || bob_exit=$?
  if [[ -s "$private_dir/resume-bob-validation.raw.json" ]]; then
    jq '{bobInvoicesVerifiedOpenUnpaid,reasonCodes,observations:[.observations[]?|{runId,id,requestedHash,returnedHash,expectedAmountSat,state,settled,amountPaidSat,observedAt}],errorCode,secretsRedacted}' "$private_dir/resume-bob-validation.raw.json" >"$private_dir/resume-bob-validation.json" 2>/dev/null || true
    chmod 600 "$private_dir/resume-bob-validation.json" 2>/dev/null || true
    rm -f "$private_dir/resume-bob-validation.raw.json"
    [[ ! -s "$private_dir/resume-bob-validation.json" ]] || cat "$private_dir/resume-bob-validation.json"
  fi
  [[ "$bob_exit" -eq 0 ]] || fail "resume_bob_invoices_not_open_and_unpaid"
  jq -e '.bobInvoicesVerifiedOpenUnpaid == true and .reasonCodes == [] and .secretsRedacted == true' "$private_dir/resume-bob-validation.json" >/dev/null || fail "resume_bob_unpaid_state_not_verified"
fi
if ! docker_run --rm -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private" -w /app node:22-bookworm node scripts/phase45-parse-bob-lookups.mjs initial >"$private_dir/bob-initial-capture.raw.json" 2>/dev/null; then
  rm -f "$private_dir/bob-initial-capture.raw.json" "$private_dir/bob-lookup-initial-a.json" "$private_dir/bob-lookup-initial-b.json"
  fail "bob_initial_evidence_capture_failed"
fi
jq '{runId,phase,invoices:[.invoices[]|{id,requestedHash,returnedHash,state,settled,amountPaidSat,observedAt}]}' "$private_dir/bob-initial-capture.raw.json" >"$private_dir/bob-initial-summary.json"
chmod 600 "$private_dir/bob-initial-summary.json"
rm -f "$private_dir/bob-initial-capture.raw.json"
jq -e --arg a "$hash_a" --arg b "$hash_b" '.phase == "initial" and (.invoices | length == 2) and ([.invoices[] | select(.state == "OPEN" and .settled == false and .amountPaidSat == 0 and .requestedHash == .returnedHash)] | length == 2) and ([.invoices[].requestedHash] | sort == ([$a,$b] | sort))' "$private_dir/bob-initial-summary.json" >/dev/null || fail "both_bob_invoices_not_valid_and_unpaid_before_dispatch"
cat "$private_dir/bob-initial-summary.json"

stage="synchronized_payment_race"
[[ ! -e "$private_dir/phase6.1-payment-dispatch-started" ]] || fail "dispatch_sentinel_already_exists_refusing_retry"
race_exit=0
if [[ "$resume_existing_run" == "1" ]]; then
  docker_run --rm --network "$network" -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private" -w /app node:22-bookworm node scripts/phase45-race.mjs --resume-existing-run "$expected_run_id" >"$private_dir/race-cli-summary.raw.json" 2>/dev/null || race_exit=$?
else
  docker_run --rm --network "$network" -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private" -w /app node:22-bookworm node scripts/phase45-race.mjs >"$private_dir/race-cli-summary.raw.json" 2>/dev/null || race_exit=$?
fi
[[ -e "$private_dir/phase6.1-payment-dispatch-started" ]] || { rm -f "$private_dir/race-cli-summary.raw.json"; fail "race_stopped_before_dispatch_no_payment_was_released"; }
if [[ -s "$private_dir/race-cli-summary.raw.json" ]]; then
  jq '{runId,barrierReleasedAt,dispatchDeltaMs,attempts:[.attempts[]?|{id,requestedHash,expectedAmountSat,barrierReleasedAt,dispatchedAt,responseAt,result,errorCode,feesPaidMsat}],nwcLookups:[.nwcLookups[]?|{id,requestedHash,returnedHash,lookupState,amountMsat,feesPaidMsat,observedAt,errorCode}],progressPersisted}' "$private_dir/race-cli-summary.raw.json" >"$private_dir/race-cli-summary.json" 2>/dev/null || true
  [[ ! -s "$private_dir/race-cli-summary.json" ]] || cat "$private_dir/race-cli-summary.json"
fi
rm -f "$private_dir/race-cli-summary.raw.json"
if [[ "$race_exit" -ne 0 ]]; then printf 'PHASE61_NOTICE race_process_exit=%s; dispatch_may_have_occurred_reconciling_without_retry\n' "$race_exit" >&2; fi

stage="bounded_bob_reconciliation"
reconcile_exit=0
PRIVATE_DIR="$private_dir" WORKSPACE_DIR="$workspace_dir" bash "$workspace_dir/scripts/phase45-reconcile-bob.sh" >"$private_dir/bob-reconcile-cli-summary.raw.json" 2>/dev/null || reconcile_exit=$?
if [[ -s "$private_dir/bob-reconcile-cli-summary.raw.json" ]]; then
  jq '{runId,phase,observationCount,reconciliationDeadline,bobClassification,reasonCodes,rawInvoicesRedacted}' "$private_dir/bob-reconcile-cli-summary.raw.json" >"$private_dir/bob-reconcile-cli-summary.json" 2>/dev/null || true
  [[ ! -s "$private_dir/bob-reconcile-cli-summary.json" ]] || cat "$private_dir/bob-reconcile-cli-summary.json"
fi
rm -f "$private_dir/bob-reconcile-cli-summary.raw.json"
if [[ ! -s "$private_dir/bob-final-evidence.json" ]]; then
  docker_run --rm -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private" -w /app node:22-bookworm node scripts/phase45-parse-bob-lookups.mjs final >"$private_dir/bob-reconcile-fallback.raw.json" 2>/dev/null || true
  rm -f "$private_dir/bob-reconcile-fallback.raw.json"
fi
if [[ "$reconcile_exit" -ne 0 ]]; then printf 'PHASE61_NOTICE bob_reconciliation_exit=%s; report_will_preserve_incomplete_evidence\n' "$reconcile_exit" >&2; fi

stage="post_reconciliation_nwc_lookup"
nwc_lookup_exit=0
docker_run --rm --network "$network" -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private" -w /app node:22-bookworm node scripts/phase45-nwc-final-lookup.mjs >"$private_dir/final-nwc-lookup.raw.json" 2>/dev/null || nwc_lookup_exit=$?
if [[ -s "$private_dir/final-nwc-lookup.raw.json" ]]; then
  jq '{runId,finalNwcLookups:[.finalNwcLookups[]?|{id,requestedHash,returnedHash,lookupState,amountMsat,observedAt,errorCode}],secretsRedacted}' "$private_dir/final-nwc-lookup.raw.json" >"$private_dir/final-nwc-lookup-summary.json" 2>/dev/null || true
  [[ ! -s "$private_dir/final-nwc-lookup-summary.json" ]] || cat "$private_dir/final-nwc-lookup-summary.json"
fi
rm -f "$private_dir/final-nwc-lookup.raw.json"
if [[ "$nwc_lookup_exit" -ne 0 ]]; then printf 'PHASE61_NOTICE final_nwc_lookup_exit=%s; report_will_preserve_incomplete_evidence\n' "$nwc_lookup_exit" >&2; fi

stage="phase61_evidence_generation"
if ! docker_run --rm -v "$workspace_dir:/app:ro" -v "$workspace_dir/reports:/app/reports" -v "$private_dir:/run/private:ro" -w /app node:22-bookworm node scripts/phase6-evidence-report.mjs --race /run/private/phase45-race-results.json --bob /run/private/bob-final-evidence.json --out reports/phase6.1-evidence.json >"$private_dir/report-command-summary.raw.json" 2>/dev/null; then
  rm -f "$private_dir/report-command-summary.raw.json"
  fail "phase61_report_generation_failed"
fi
jq '{reportWritten,reportVersion,finalClassification,evidenceComplete,output}' "$private_dir/report-command-summary.raw.json" >"$private_dir/report-command-summary.json"
chmod 600 "$private_dir/report-command-summary.json"
rm -f "$private_dir/report-command-summary.raw.json"
cat "$private_dir/report-command-summary.json"
jq '{runId,barrierReleasedAt,dispatchDeltaMs,independentlySettledPrincipalSats,postRaceBudget,invariant,finalClassification,evidenceCompleteness}' "$workspace_dir/reports/phase6.1-evidence.json"
printf 'PHASE61_COMPLETE report=reports/phase6.1-evidence.json\n'
'@

$linuxScript = $linuxScript.Replace('__WORKSPACE_B64__', $workspaceBase64)
$resumeValue = if ($ResumeExistingRun) { '1' } else { '0' }
$linuxScript = $linuxScript.Replace('__RESUME_MODE__', $resumeValue)
$payloadBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($linuxScript))
$bashCommand = "printf '%s' '$payloadBase64' | base64 -d | bash"
$wslArgs = @(
    '-d',
    'Ubuntu',
    '--',
    'bash',
    '-lc',
    $bashCommand
)

& $wslExe @wslArgs
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "Phase 6.1 runner stopped with exit code $exitCode. No automatic payment retry was attempted."
}
