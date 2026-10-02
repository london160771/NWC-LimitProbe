#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
id="$1"; hash="$2"; run_id="$3"; session_id="$4"; journal="$5"; workspace_dir="$6"; node_image="$7"
private_dir="$(dirname "$journal")"
attempted_at="$(date -u '+%Y-%m-%dT%H:%M:%S.%3NZ')"
tmp="$(mktemp "$private_dir/.bob-query.XXXXXX")"
chmod 600 "$tmp"
status=collector_error
error=OTHER
if set -o pipefail && docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice "$hash" 2>/dev/null \
  | bash "$workspace_dir/scripts/phase61-docker-run.sh" --rm -i -v "$workspace_dir:/app:ro" -w /app "$node_image" \
      node scripts/phase45-sanitize-bob-observation.mjs --run-id "$run_id" --id "$id" --hash "$hash" --amount 700 >"$tmp" 2>/dev/null; then
  if jq -e --arg run "$run_id" --arg hash "$hash" --arg id "$id" '.runId == $run and .requestedHash == $hash and .returnedHash == $hash and .id == $id and .state != null and .errorCode == null and (.amountPaidSat | type == "number") and (.amountPaidMsat | type == "number") and (.observedAt | type == "string")' "$tmp" >/dev/null 2>&1; then
    status=success
    error=""
    jq -c --arg sid "$session_id" '{recordType:"receiver_observation",sessionId:$sid} + .' "$tmp" >>"$journal"
    chmod 600 "$journal"
  fi
fi
completed_at="$(date -u '+%Y-%m-%dT%H:%M:%S.%3NZ')"
jq -cn --arg sid "$session_id" --arg run "$run_id" --arg id "$id" --arg hash "$hash" --arg attempted "$attempted_at" --arg completed "$completed_at" --arg status "$status" --arg error "$error" \
  '{recordType:"query_attempt",sessionId:$sid,runId:$run,id:$id,requestedHash:$hash,attemptedAt:$attempted,completedAt:$completed,status:$status,errorCode:(if $error == "" then null else $error end)}' >>"$journal"
chmod 600 "$journal"
rm -f "$tmp"
if [[ "$status" == success ]]; then printf 'QUERY_SUCCESS\n'; else printf 'QUERY_ERROR\n'; fi
