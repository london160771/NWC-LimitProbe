#!/usr/bin/env bash
set -euo pipefail

private_dir="${PRIVATE_DIR:-/home/uk/.local/share/nwc-limitprobe-phase6-1}"
workspace_dir="${WORKSPACE_DIR:-$(pwd)}"
node_image="${NODE_IMAGE:-node:22-bookworm}"
network="${POLAR_NETWORK:-polar-network-1_default}"
poll_seconds=2

command -v docker >/dev/null 2>&1 || { echo 'docker_cli_missing' >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo 'jq_missing' >&2; exit 2; }
test -f "$private_dir/phase6-run-config.json" || { echo 'run_config_missing' >&2; exit 2; }
test -f "$private_dir/phase45-race-progress.json" || { echo 'race_progress_missing' >&2; exit 2; }

run_id="$(jq -r '.runId // empty' "$private_dir/phase6-run-config.json")"
deadline="$(jq -r '.reconciliationDeadline // empty' "$private_dir/phase45-race-progress.json")"
deadline_ms="$(date -u -d "$deadline" +%s%3N 2>/dev/null || true)"
if [[ -z "$run_id" || -z "$deadline_ms" ]]; then
  echo 'run_binding_or_deadline_invalid' >&2
  exit 2
fi

observations="$private_dir/bob-final-observations.jsonl"
: > "$observations"
chmod 600 "$observations"

query_one() {
  local id="$1"
  local lower hash
  lower="${id,,}"
  hash="$(tr -d '\r\n' < "$private_dir/bob-payment-hash-$lower")"
  docker exec polar-n1-bob lncli --lnddir=/home/lnd/.lnd --network=regtest lookupinvoice "$hash" 2>/dev/null \
    | docker run --rm -i -v "$workspace_dir:/app:ro" -w /app "$node_image" \
        node scripts/phase45-sanitize-bob-observation.mjs \
        --run-id "$run_id" --id "$id" --hash "$hash" --amount 700 \
    >> "$observations" || true
}

while (( $(date -u +%s%3N) < deadline_ms )); do
  query_one A
  query_one B
  if (( $(date -u +%s%3N) < deadline_ms )); then sleep "$poll_seconds"; fi
done

# This final pair is the deadline observation; sanitization happens in the pipe
# before any output is persisted to the private evidence file.
query_one A
query_one B
chmod 600 "$observations"

docker run --rm -v "$workspace_dir:/app:ro" -v "$private_dir:/run/private" -w /app "$node_image" \
  node scripts/phase45-parse-bob-lookups.mjs final
