#requires -Version 5.1
param()

$ErrorActionPreference = 'Stop'

$workspacePath = [System.IO.Path]::GetFullPath($PSScriptRoot)
if ($workspacePath -notmatch '^[A-Za-z]:\\') { throw 'The project must be in a drive-letter path accessible to WSL.' }
$driveLetter = $workspacePath.Substring(0, 1).ToLowerInvariant()
$linuxWorkspace = '/mnt/' + $driveLetter + $workspacePath.Substring(2).Replace('\', '/')
$workspaceBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($linuxWorkspace))
$wslExe = 'C:\Windows\System32\wsl.exe'

$linuxScript = @'
set -Eeuo pipefail
set +x
umask 077
workspace_b64='__WORKSPACE_B64__'
workspace_dir="$(printf '%s' "$workspace_b64" | base64 -d)"
private_dir="/home/uk/.local/share/nwc-limitprobe-phase6-2"
phase23_dir="/home/uk/.local/share/nwc-limitprobe-phase2-3"
network="polar-network-1_default"
runner_uid="$(id -u)"
docker_run() { bash "$workspace_dir/scripts/phase61-docker-run.sh" "$@"; }
stage="private_setup"

fail() { printf 'PHASE62_FAILED stage=%s reason=%s\n' "$stage" "$1" >&2; exit 1; }
[[ "$runner_uid" == "$(id -u uk 2>/dev/null)" ]] || fail "runner_must_run_as_uk"
if [[ ! -e "$private_dir" ]]; then mkdir -m 700 "$private_dir" 2>/dev/null || fail "private_directory_creation_failed"; fi
[[ -d "$private_dir" && ! -L "$private_dir" ]] || fail "private_directory_path_invalid"
[[ "$(stat -c '%a' "$private_dir" 2>/dev/null)" == "700" ]] || fail "private_directory_permissions_invalid"
trap 'rc=$?; if [[ $rc -ne 0 ]]; then printf "PHASE62_FAILED stage=%s exit=%s\n" "$stage" "$rc" >&2; fi' ERR
source "$workspace_dir/scripts/phase62-run-lock.sh" || fail "phase62_run_lock_helper_unavailable"
phase62_acquire_run_lock "$private_dir" || fail "phase62_run_already_locked_or_requires_lock_recovery"
trap 'rc=$?; trap - EXIT; if [[ $rc -ne 0 ]]; then printf "PHASE62_PRIVATE_EVIDENCE_PRESERVED=true\n" >&2; fi; phase62_release_run_lock || true; exit "$rc"' EXIT

[[ ! -e "$workspace_dir/reports/phase6.2-final-evidence.json" ]] || fail "phase62_report_already_exists_refusing_overwrite"
for existing in phase6-run-config.json phase62-invoice-creation-state.json bob-invoice-a bob-invoice-b bob-payment-hash-a bob-payment-hash-b phase6.2-payment-dispatch-started; do
  [[ ! -e "$private_dir/$existing" ]] || fail "existing_phase62_run_state_refusing_reuse"
done
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
mapfile -t polar_nodes < <(docker ps --filter "network=$network" --format '{{.Names}}' | grep -E '^polar-n[0-9]+-' | sort)
[[ "${#polar_nodes[@]}" -eq 3 ]] || fail "controlled_polar_node_set_not_exclusive"
[[ "${polar_nodes[0]} ${polar_nodes[1]} ${polar_nodes[2]}" == "polar-n1-alice polar-n1-backend1 polar-n1-bob" ]] || fail "unexpected_polar_payer_or_node_present"

alice_info="$(docker exec polar-n1-alice lncli --lnddir=/home/lnd/.lnd --network=regtest getinfo 2>/dev/null)" || fail "alice_lnd_unreachable"
bob_info="$(docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest getinfo 2>/dev/null)" || fail "bob_lnd_unreachable"
jq -e '(.synced_to_chain == true) and (.synced_to_graph == true) and any(.chains[]?; .network == "regtest")' <<<"$alice_info" >/dev/null || fail "alice_lnd_not_synced_to_chain_and_graph_on_regtest"
jq -e '(.synced_to_chain == true) and (.synced_to_graph == true) and any(.chains[]?; .network == "regtest")' <<<"$bob_info" >/dev/null || fail "bob_lnd_not_synced_to_chain_and_graph_on_regtest"
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
if ! bash "$workspace_dir/scripts/phase62-create-app.sh" >/dev/null 2>&1; then
  fail "fresh_phase62_app_creation_or_recovery_failed"
fi
[[ -s "$private_dir/phase62-app-ready" && "$(cat "$private_dir/phase62-app-ready" 2>/dev/null)" == "PHASE62_APP_READY" ]] || fail "fresh_app_helper_completion_marker_invalid"
[[ -s "$private_dir/nwc-url" && -s "$private_dir/app-config.json" ]] || fail "fresh_app_helper_outputs_missing"
[[ "$(stat -c '%a' "$private_dir/nwc-url" 2>/dev/null)" == "600" && "$(stat -c '%a' "$private_dir/app-config.json" 2>/dev/null)" == "600" ]] || fail "fresh_app_private_file_permissions_invalid"
[[ "$(stat -c '%u' "$private_dir/nwc-url" 2>/dev/null)" == "$runner_uid" && "$(stat -c '%u' "$private_dir/app-config.json" 2>/dev/null)" == "$runner_uid" ]] || fail "fresh_app_private_file_owner_invalid"
if ! jq -e '.name == "LimitProbe-Phase62-Final" and .maxAmountSat == 1000 and .maxAmountMsat == 1000000 and .budgetUsageSat == 0 and .budgetRenewal == "never" and ((.scopes | sort) == ["get_balance","get_info","lookup_invoice","pay_invoice"])' "$private_dir/app-config.json" >/dev/null 2>&1; then
  fail "fresh_app_helper_configuration_invalid"
fi
printf '{"freshNwcConnectionCreated":true,"appName":"LimitProbe-Phase62-Final","budgetSats":1000,"renewal":"never","scopes":["get_balance","get_info","lookup_invoice","pay_invoice"],"uriPrinted":false}\n'

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

stage="create_two_fresh_bob_invoices"
invoice_setup() {
  docker_run --rm -e PRIVATE_DIR=/run/private -e NWC_LIMITPROBE_SINGLE_PAYER_CONFIRMED=1 -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private" -w /app node:22-bookworm node scripts/phase45-invoice-setup.mjs "$@"
}
invoice_setup intent A >/dev/null 2>&1 || fail "invoice_a_intent_not_persisted"
if ! timeout --signal=TERM --kill-after=2s 20s docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest addinvoice --amt=700 --expiry=120 >"$private_dir/bob-addinvoice-a.json" 2>/dev/null; then
  invoice_setup failed A >/dev/null 2>&1 || true
  fail "bob_invoice_a_creation_failed_partial_state_preserved"
fi
date -u '+%Y-%m-%dT%H:%M:%S.%3NZ' >"$private_dir/bob-addinvoice-a.acquired-at"
chmod 600 "$private_dir/bob-addinvoice-a.json" "$private_dir/bob-addinvoice-a.acquired-at"
invoice_setup capture A >"$private_dir/invoice-capture-a.json" 2>/dev/null || { invoice_setup failed A >/dev/null 2>&1 || true; fail "invoice_a_receipt_capture_failed_partial_state_preserved"; }
invoice_setup intent B >/dev/null 2>&1 || fail "invoice_b_intent_not_persisted"
if ! timeout --signal=TERM --kill-after=2s 20s docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest addinvoice --amt=700 --expiry=120 >"$private_dir/bob-addinvoice-b.json" 2>/dev/null; then
  invoice_setup failed B >/dev/null 2>&1 || true
  fail "bob_invoice_b_creation_failed_a_evidence_preserved"
fi
date -u '+%Y-%m-%dT%H:%M:%S.%3NZ' >"$private_dir/bob-addinvoice-b.acquired-at"
chmod 600 "$private_dir/bob-addinvoice-b.json" "$private_dir/bob-addinvoice-b.acquired-at"
invoice_setup capture B >"$private_dir/invoice-capture-b.json" 2>/dev/null || { invoice_setup failed B >/dev/null 2>&1 || true; fail "invoice_b_receipt_capture_failed_partial_state_preserved"; }
jq -n --slurpfile config "$private_dir/phase6-run-config.json" '{invoicesCreated:2,runId:$config[0].runId,invoices:[$config[0].invoices[]|{id,paymentHash,amountSat}],network:"regtest",invoiceExpirySeconds:120,requiredGraceSeconds:30,invoicesCreatedForRun:true,noOtherPayerPathVerified:$config[0].noOtherPayerPathVerified,bolt11Redacted:true}' >"$private_dir/invoice-capture.json"
chmod 600 "$private_dir/invoice-capture.json"
jq -e '.invoicesCreated == 2 and .network == "regtest" and .invoiceExpirySeconds == 120 and .requiredGraceSeconds == 30 and .invoicesCreatedForRun == true and .noOtherPayerPathVerified == true and .bolt11Redacted == true and (.invoices | length == 2) and ([.invoices[] | select(.amountSat == 700 and (.paymentHash | test("^[0-9a-f]{64}$")))] | length == 2) and ([.invoices[].paymentHash] | unique | length == 2)' "$private_dir/invoice-capture.json" >/dev/null || fail "two_distinct_700_sat_regtest_invoices_not_verified"
cat "$private_dir/invoice-capture.json"

stage="verify_bob_initial_unpaid_state"
hash_a="$(cat "$private_dir/bob-payment-hash-a")"
hash_b="$(cat "$private_dir/bob-payment-hash-b")"
timeout 8s docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice "$hash_a" >"$private_dir/bob-lookup-initial-a.json" 2>/dev/null || fail "bob_initial_lookup_a_failed_or_timed_out"
date -u '+%Y-%m-%dT%H:%M:%S.%3NZ' >"$private_dir/bob-lookup-initial-a.acquired-at"
timeout 8s docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice "$hash_b" >"$private_dir/bob-lookup-initial-b.json" 2>/dev/null || fail "bob_initial_lookup_b_failed_or_timed_out"
date -u '+%Y-%m-%dT%H:%M:%S.%3NZ' >"$private_dir/bob-lookup-initial-b.acquired-at"
chmod 600 "$private_dir/bob-lookup-initial-a.json" "$private_dir/bob-lookup-initial-b.json" "$private_dir/bob-lookup-initial-a.acquired-at" "$private_dir/bob-lookup-initial-b.acquired-at"
if ! docker_run --rm -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private" -w /app node:22-bookworm node scripts/phase45-parse-bob-lookups.mjs initial >"$private_dir/bob-initial-capture.raw.json" 2>/dev/null; then
  rm -f "$private_dir/bob-initial-capture.raw.json"
  fail "bob_initial_evidence_capture_failed"
fi
jq '{runId,phase,invoices:[.invoices[]|{id,requestedHash,returnedHash,state,settled,amountPaidSat,observedAt,acquiredAt}]}' "$private_dir/bob-initial-capture.raw.json" >"$private_dir/bob-initial-summary.json"
chmod 600 "$private_dir/bob-initial-summary.json"
rm -f "$private_dir/bob-initial-capture.raw.json"
jq -e --arg a "$hash_a" --arg b "$hash_b" '.phase == "initial" and (.invoices | length == 2) and ([.invoices[] | select(.state == "OPEN" and .settled == false and .amountPaidSat == 0 and .requestedHash == .returnedHash)] | length == 2) and ([.invoices[].requestedHash] | sort == ([$a,$b] | sort))' "$private_dir/bob-initial-summary.json" >/dev/null || fail "both_bob_invoices_not_valid_and_unpaid_before_dispatch"
cat "$private_dir/bob-initial-summary.json"

stage="synchronized_payment_race"
[[ ! -e "$private_dir/phase6.2-payment-dispatch-started" ]] || fail "dispatch_sentinel_already_exists_refusing_retry"
race_exit=0
docker_run --rm --network "$network" -e DISPATCH_SENTINEL_FILE=/run/private/phase6.2-payment-dispatch-started -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private" -w /app node:22-bookworm node scripts/phase45-race.mjs >"$private_dir/race-cli-summary.raw.json" 2>/dev/null || race_exit=$?
[[ -e "$private_dir/phase6.2-payment-dispatch-started" ]] || { rm -f "$private_dir/race-cli-summary.raw.json"; fail "race_stopped_before_dispatch_no_payment_was_released"; }
if [[ -s "$private_dir/race-cli-summary.raw.json" ]]; then
  jq '{runId,barrierReleasedAt,dispatchDeltaMs,attempts:[.attempts[]?|{id,requestedHash,expectedAmountSat,barrierReleasedAt,dispatchedAt,responseAt,result,errorCode,feesPaidMsat}],nwcLookups:[.nwcLookups[]?|{id,requestedHash,returnedHash,lookupState,amountMsat,feesPaidMsat,observedAt,errorCode}],progressPersisted}' "$private_dir/race-cli-summary.raw.json" >"$private_dir/race-cli-summary.json" 2>/dev/null || true
  [[ ! -s "$private_dir/race-cli-summary.json" ]] || cat "$private_dir/race-cli-summary.json"
fi
rm -f "$private_dir/race-cli-summary.raw.json"
if [[ "$race_exit" -ne 0 ]]; then printf 'PHASE62_NOTICE race_process_exit=%s; dispatch_may_have_occurred_reconciling_without_retry\n' "$race_exit" >&2; fi

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
if [[ "$reconcile_exit" -ne 0 ]]; then printf 'PHASE62_NOTICE bob_reconciliation_exit=%s; report_will_preserve_incomplete_evidence\n' "$reconcile_exit" >&2; fi

stage="post_reconciliation_nwc_lookup"
nwc_lookup_exit=0
docker_run --rm --network "$network" -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private" -w /app node:22-bookworm node scripts/phase45-nwc-final-lookup.mjs >"$private_dir/final-nwc-lookup.raw.json" 2>/dev/null || nwc_lookup_exit=$?
if [[ -s "$private_dir/final-nwc-lookup.raw.json" ]]; then
  jq '{runId,finalNwcLookups:[.finalNwcLookups[]?|{id,requestedHash,returnedHash,lookupState,amountMsat,observedAt,errorCode}],secretsRedacted}' "$private_dir/final-nwc-lookup.raw.json" >"$private_dir/final-nwc-lookup-summary.json" 2>/dev/null || true
  [[ ! -s "$private_dir/final-nwc-lookup-summary.json" ]] || cat "$private_dir/final-nwc-lookup-summary.json"
fi
rm -f "$private_dir/final-nwc-lookup.raw.json"
if [[ "$nwc_lookup_exit" -ne 0 ]]; then printf 'PHASE62_NOTICE final_nwc_lookup_exit=%s; report_will_preserve_incomplete_evidence\n' "$nwc_lookup_exit" >&2; fi

stage="phase62_evidence_generation"
if ! docker_run --rm -v "$workspace_dir:/app:ro" -v "$workspace_dir/reports:/app/reports" -v "$private_dir:/run/private:ro" -w /app node:22-bookworm node scripts/phase6-evidence-report.mjs --race /run/private/phase45-race-results.json --race-progress /run/private/phase45-race-progress.json --run-config /run/private/phase6-run-config.json --bob /run/private/bob-final-evidence.json --out reports/phase6.2-final-evidence.json >"$private_dir/report-command-summary.raw.json" 2>/dev/null; then
  rm -f "$private_dir/report-command-summary.raw.json"
  fail "phase62_report_generation_failed"
fi
jq '{reportWritten,reportVersion,finalClassification,evidenceComplete,output}' "$private_dir/report-command-summary.raw.json" >"$private_dir/report-command-summary.json"
chmod 600 "$private_dir/report-command-summary.json"
rm -f "$private_dir/report-command-summary.raw.json"
cat "$private_dir/report-command-summary.json"
jq '{runId,barrierReleasedAt,dispatchDeltaMs,independentlySettledPrincipalSats,postRaceBudget,invariant,finalClassification,evidenceCompleteness}' "$workspace_dir/reports/phase6.2-final-evidence.json"
printf 'PHASE62_COMPLETE report=reports/phase6.2-final-evidence.json\n'
'@

$linuxScript = $linuxScript.Replace('__WORKSPACE_B64__', $workspaceBase64)
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
    throw "Phase 6.2 runner stopped with exit code $exitCode. No automatic payment retry was attempted."
}
