#!/usr/bin/env bash
set -Eeuo pipefail
set +x
[[ "$(id -u)" == "$(id -u uk 2>/dev/null)" ]] || { echo 'run_as_uk_required' >&2; exit 2; }

private_dir="${PRIVATE_DIR:-/home/uk/.local/share/nwc-limitprobe-phase6-1}"
workspace_dir="${WORKSPACE_DIR:-$(pwd)}"
node_image="${NODE_IMAGE:-node:22-bookworm}"
poll_seconds=2
query_timeout_seconds=15
observations="$private_dir/bob-final-observations.jsonl"
session_id="$(cat /proc/sys/kernel/random/uuid)"
run_id=""
deadline=""
completion_status=""
session_active=0
timeout_seen=0
query_error_seen=0

command -v docker >/dev/null 2>&1 || { echo 'docker_cli_missing' >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo 'jq_missing' >&2; exit 2; }
command -v timeout >/dev/null 2>&1 || { echo 'timeout_command_missing' >&2; exit 2; }
test -f "$private_dir/phase6-run-config.json" || { echo 'run_config_missing' >&2; exit 2; }
test -f "$private_dir/phase45-race-progress.json" || { echo 'race_progress_missing' >&2; exit 2; }

run_id="$(jq -er '.runId | strings' "$private_dir/phase6-run-config.json")"
deadline="$(jq -er '.reconciliationDeadline | strings' "$private_dir/phase45-race-progress.json")"
deadline_ms="$(date -u -d "$deadline" +%s%3N 2>/dev/null || true)"
[[ "$run_id" =~ ^[0-9a-fA-F-]{36}$ && -n "$deadline_ms" ]] || { echo 'run_binding_or_deadline_invalid' >&2; exit 2; }
for id in A B; do
  suffix="${id,,}"
  saved_hash="$(tr -d '\r\n' < "$private_dir/bob-payment-hash-$suffix")"
  configured_hash="$(jq -er --arg id "$id" '.expectedInvoices[] | select(.id == $id) | .paymentHash' "$private_dir/phase6-run-config.json")"
  dispatched_hash="$(jq -er --arg id "$id" '.attempts[] | select(.id == $id) | .requestedHash' "$private_dir/phase45-race-progress.json")"
  [[ "$saved_hash" =~ ^[0-9a-f]{64}$ && "$saved_hash" == "$configured_hash" && "$saved_hash" == "$dispatched_hash" ]] || { echo 'collector_invoice_binding_invalid' >&2; exit 2; }
done

touch "$observations"
chmod 600 "$observations"
jq -s 'all(.[]; type == "object" and (.recordType | type == "string"))' "$observations" >/dev/null 2>&1 || { echo 'collector_journal_invalid' >&2; exit 2; }

now_iso() { date -u '+%Y-%m-%dT%H:%M:%S.%3NZ'; }
append_event() { printf '%s\n' "$1" >> "$observations"; chmod 600 "$observations"; }
finish_session() {
  local rc="$1" status="$completion_status" at
  [[ "$session_active" -eq 1 ]] || return 0
  [[ -n "$status" ]] || { if [[ "$rc" -eq 130 || "$rc" -eq 143 ]]; then status=interrupted; else status=collector_error; fi; }
  at="$(now_iso)"
  append_event "$(jq -cn --arg sid "$session_id" --arg run "$run_id" --arg deadline "$deadline" --arg at "$at" --arg status "$status" '{recordType:"collector_completed",sessionId:$sid,runId:$run,deadline:$deadline,completedAt:$at,completionStatus:$status}')"
  session_active=0
}
on_exit() { rc=$?; finish_session "$rc"; }
on_signal() { completion_status=interrupted; exit 130; }
trap on_exit EXIT
trap on_signal INT TERM

# Retain every earlier event. Mark abandoned sessions interrupted before resuming.
unfinished="$(jq -s -r '[.[] | select(.recordType == "collector_started") | .sessionId] as $starts | [.[] | select(.recordType == "collector_completed") | .sessionId] as $ends | $starts - $ends | .[]' "$observations")"
while IFS= read -r old_session; do
  [[ -n "$old_session" ]] || continue
  old_started_run="$(jq -s -r --arg sid "$old_session" '[.[] | select(.recordType == "collector_started" and .sessionId == $sid)][0].runId // empty' "$observations")"
  old_deadline="$(jq -s -r --arg sid "$old_session" '[.[] | select(.recordType == "collector_started" and .sessionId == $sid)][0].deadline // empty' "$observations")"
  [[ "$old_started_run" == "$run_id" && "$old_deadline" == "$deadline" ]] || { echo 'collector_restart_binding_mismatch' >&2; exit 2; }
  at="$(now_iso)"
  append_event "$(jq -cn --arg sid "$old_session" --arg run "$run_id" --arg deadline "$deadline" --arg at "$at" '{recordType:"collector_completed",sessionId:$sid,runId:$run,deadline:$deadline,completedAt:$at,completionStatus:"interrupted"}')"
done <<< "$unfinished"

started_at="$(now_iso)"
append_event "$(jq -cn --arg sid "$session_id" --arg run "$run_id" --arg started "$started_at" --arg deadline "$deadline" --argjson poll "$poll_seconds" --argjson timeout "$query_timeout_seconds" '{recordType:"collector_started",sessionId:$sid,runId:$run,startedAt:$started,deadline:$deadline,pollIntervalSeconds:$poll,queryTimeoutSeconds:$timeout}')"
session_active=1

query_one() {
  local id="$1" lower hash attempted completed tmp rc query_status error_code result
  lower="${id,,}"
  hash="$(tr -d '\r\n' < "$private_dir/bob-payment-hash-$lower")"
  if [[ ! "$hash" =~ ^[0-9a-f]{64}$ ]]; then
    attempted="$(now_iso)"; completed="$attempted"; query_error_seen=1
    append_event "$(jq -cn --arg sid "$session_id" --arg run "$run_id" --arg id "$id" --arg at "$attempted" '{recordType:"query_attempt",sessionId:$sid,runId:$run,id:$id,requestedHash:null,attemptedAt:$at,completedAt:$at,status:"collector_error",errorCode:"OTHER"}')"
    return 1
  fi
  attempted="$(now_iso)"
  tmp="$(mktemp "$private_dir/.bob-safe.XXXXXX")"
  chmod 600 "$tmp"
  set +e
  timeout --signal=TERM --kill-after=2s 15s bash "$workspace_dir/scripts/phase45-query-bob.sh" "$id" "$hash" "$run_id" "$session_id" "$observations" "$workspace_dir" "$node_image" >"$tmp" 2>/dev/null
  rc=$?
  set -e
  completed="$(now_iso)"
  result="$(cat "$tmp" 2>/dev/null || true)"
  if [[ "$rc" -eq 0 && "$result" == "QUERY_SUCCESS" ]]; then
    query_status="success"
    error_code=""
  else
    if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
      query_status=query_timeout; error_code=TIMEOUT; timeout_seen=1
    else
      query_status=collector_error; error_code=OTHER; query_error_seen=1
    fi
    if [[ "$rc" -ne 0 ]]; then
      append_event "$(jq -cn --arg sid "$session_id" --arg run "$run_id" --arg id "$id" --arg attempted "$attempted" --arg completed "$completed" --arg status "$query_status" --arg error "$error_code" --arg hash "$hash" '{recordType:"query_attempt",sessionId:$sid,runId:$run,id:$id,requestedHash:$hash,attemptedAt:$attempted,completedAt:$completed,status:$status,errorCode:$error}')"
    fi
  fi
  rm -f "$tmp"
  [[ "$query_status" == "success" ]]
}

latest_are_terminal() {
  local hash_a hash_b expires_at_b expires_at_b_iso
  hash_a="$(tr -d '\r\n' < "$private_dir/bob-payment-hash-a")"
  hash_b="$(tr -d '\r\n' < "$private_dir/bob-payment-hash-b")"
  expires_at_b="$(jq -er '.expectedInvoices[] | select(.id == "B") | .expiresAtUnix | numbers' "$private_dir/phase6-run-config.json")"
  expires_at_b_iso="$(date -u -d "@$expires_at_b" '+%Y-%m-%dT%H:%M:%S.000Z')"
  jq -s -e --arg sid "$session_id" --arg run "$run_id" --arg a "$hash_a" --arg b "$hash_b" --arg expiry "$expires_at_b_iso" '
    [ .[] | select(.recordType == "receiver_observation" and .sessionId == $sid and .runId == $run) ]
    | group_by(.id) | map(sort_by(.observedAt) | last)
    | select(length == 2 and all(.[];
        .errorCode == null and .expectedAmountSat == 700 and .requestedHash == .returnedHash and
        ((.id == "A" and .requestedHash == $a) or (.id == "B" and .requestedHash == $b)) and
        ((.state == "SETTLED" and .settled == true and .amountPaidSat == 700 and .amountPaidMsat == 700000 and (.settleDateUnix | type == "number" and . > 0) and (.settledAt | type == "string")) or
         ((.state == "CANCELED" or .state == "EXPIRED") and .settled == false and .amountPaidSat == 0 and .amountPaidMsat == 0 and .settleDateUnix == null and .settledAt == null))
      ))
    | (map(select(.id == "A"))[0]) as $attempt_a
    | (map(select(.id == "B"))[0]) as $attempt_b
    | (($attempt_a.state == "SETTLED" and $attempt_b.state == "CANCELED" and $attempt_b.observedAt >= $expiry) or
       ($attempt_a.state == "SETTLED" and $attempt_b.state == "SETTLED"))
  ' "$observations" >/dev/null 2>&1
}

while (( $(date -u +%s%3N) < deadline_ms )); do
  query_one A || true
  query_one B || true
  if latest_are_terminal; then completion_status=completed_terminal; break; fi
  if (( $(date -u +%s%3N) < deadline_ms )); then sleep "$poll_seconds"; fi
done

if [[ -z "$completion_status" ]]; then
  query_one A || true
  query_one B || true
  if latest_are_terminal; then
    completion_status=completed_terminal
  elif [[ "$timeout_seen" -eq 1 ]]; then
    completion_status=query_timeout
  elif [[ "$query_error_seen" -eq 1 ]]; then
    completion_status=collector_error
  else
    completion_status=completed_deadline
  fi
fi

finish_session 0
docker_run() { bash "$workspace_dir/scripts/phase61-docker-run.sh" "$@"; }
docker_run --rm -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private" -w /app "$node_image" \
  node scripts/phase45-parse-bob-lookups.mjs final
