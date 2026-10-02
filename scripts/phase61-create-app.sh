#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
[[ "$(id -u)" == "$(id -u uk 2>/dev/null)" ]] || { printf 'PHASE61_USER_MISMATCH\n' >&2; exit 2; }

private_dir="/home/uk/.local/share/nwc-limitprobe-phase6-1"
token_file="/home/uk/.local/share/nwc-limitprobe-phase2-3/hub-cli/token.jwt"
hub_url="http://127.0.0.1:8080"
app_name="LimitProbe-Phase61-Race"
create_stdout="$private_dir/hub-create-app.stdout.json"
create_stderr="$private_dir/hub-create-app.stderr"
list_before_stdout="$private_dir/hub-list-before.stdout.json"
list_before_stderr="$private_dir/hub-list-before.stderr"
list_after_stdout="$private_dir/hub-apps-current-v2.stdout.json"
list_after_stderr="$private_dir/hub-apps-current-v2.stderr"
nwc_file="$private_dir/nwc-url"
app_config_file="$private_dir/app-config.json"
ready_file="$private_dir/phase61-app-ready"
mode="${1:-auto}"

fail() {
  printf 'PHASE61_APP_FAILED code=%s\n' "$1" >&2
  exit 1
}

case "$mode" in
  auto|--recover-existing) ;;
  *) fail "INVALID_MODE" ;;
esac
[[ "$#" -le 1 ]] || fail "INVALID_MODE"

command -v jq >/dev/null 2>&1 || fail "JQ_MISSING"
command -v npx >/dev/null 2>&1 || fail "NPX_MISSING"
command -v python3 >/dev/null 2>&1 || fail "PYTHON_MISSING"
command -v flock >/dev/null 2>&1 || fail "FLOCK_MISSING"
[[ -r "$token_file" ]] || fail "HUB_TOKEN_FILE_UNAVAILABLE"

lock_file="/tmp/nwc-limitprobe-phase61-app-create.lock"
exec 9>>"$lock_file" 2>/dev/null || fail "APP_CREATION_LOCK_UNAVAILABLE"
flock -n 9 2>/dev/null || fail "APP_CREATION_ALREADY_RUNNING"

private_parent="${private_dir%/*}"
mkdir -p "$private_parent" 2>/dev/null || fail "PRIVATE_PARENT_CREATION_FAILED"
if [[ -e "$private_dir" ]]; then
  [[ -d "$private_dir" && ! -L "$private_dir" ]] || fail "PRIVATE_PHASE61_PATH_INVALID"
  [[ "$(stat -c '%a' "$private_dir" 2>/dev/null)" == "700" ]] || fail "PRIVATE_DIRECTORY_PERMISSIONS_INVALID"
  shopt -s nullglob dotglob
  existing_entries=("$private_dir"/*)
  shopt -u nullglob dotglob
  for existing_entry in "${existing_entries[@]}"; do
    case "${existing_entry##*/}" in
      environment-nwc-health.json|fresh-nwc-preflight.json|hub-create-app.stdout.json|hub-create-app.stderr|hub-list-before.stdout.json|hub-list-before.stderr|hub-list-after.stdout.json|hub-list-after.stderr|hub-apps-current.stdout.json|hub-apps-current.stderr|hub-apps-current-v2.stdout.json|hub-apps-current-v2.stderr|nwc-url|app-config.json|phase61-app-ready) ;;
      *) fail "PRIVATE_PHASE61_STATE_AMBIGUOUS_REFUSING_REUSE" ;;
    esac
    [[ ! -L "$existing_entry" ]] || fail "PRIVATE_PHASE61_SYMLINK_REFUSING_REUSE"
  done
else
  mkdir -m 700 "$private_dir" 2>/dev/null || fail "PRIVATE_DIRECTORY_CREATION_FAILED"
fi

hub_token="$(cat "$token_file" 2>/dev/null)" || fail "HUB_TOKEN_READ_FAILED"
[[ -n "$hub_token" ]] || fail "HUB_TOKEN_EMPTY"

hub_cli() {
  WSLENV="${WSLENV:+$WSLENV:}HUB_URL:HUB_TOKEN" HUB_URL="$hub_url" HUB_TOKEN="$hub_token" npx -y @getalby/hub-cli@0.6.0 --url "$hub_url" "$@"
}

validate_create_capture() {
  [[ -s "$create_stdout" && -e "$create_stderr" ]] || return 1
  [[ "$(stat -c '%a' "$create_stdout" 2>/dev/null)" == "600" ]] || return 1
  [[ "$(stat -c '%a' "$create_stderr" 2>/dev/null)" == "600" ]] || return 1
  jq -e --arg name "$app_name" '
    .name == $name and
    (.pairingUri | type == "string" and startswith("nostr+walletconnect://"))
  ' "$create_stdout" >/dev/null 2>&1
}

validate_empty_before_capture() {
  [[ -s "$list_before_stdout" && -e "$list_before_stderr" ]] || return 1
  [[ "$(stat -c '%a' "$list_before_stdout" 2>/dev/null)" == "600" ]] || return 1
  [[ "$(stat -c '%a' "$list_before_stderr" 2>/dev/null)" == "600" ]] || return 1
  jq -e --arg name "$app_name" '
    (.apps | type) == "array" and
    ([.apps[] | select(.name == $name)] | length) == 0
  ' "$list_before_stdout" >/dev/null 2>&1
}

validate_metadata() {
  local source="$1"
  jq -e --arg name "$app_name" '
    if (.apps | type) != "array" then false
    else
      [.apps[] | select(.name == $name)] as $apps |
      ($apps | length) == 1 and
      $apps[0].maxAmountSat == 1000 and
      $apps[0].maxAmountMsat == 1000000 and
      $apps[0].budgetUsageSat == 0 and
      $apps[0].budgetRenewal == "never" and
      ($apps[0].scopes | type) == "array" and
      ($apps[0].scopes | sort) == ["get_balance","get_info","lookup_invoice","pay_invoice"]
    end
  ' "$source" >/dev/null 2>&1
}

validate_uri_file() {
  local source="$1"
  python3 - "$source" >/dev/null 2>&1 <<'PY'
import re
import sys
from urllib.parse import parse_qs, urlsplit

value = open(sys.argv[1], "r", encoding="utf-8").read()
if not value.endswith("\n") or value.count("\n") != 1:
    raise SystemExit(1)
uri = value[:-1]
parts = urlsplit(uri)
query = parse_qs(parts.query, strict_parsing=True)
if parts.scheme != "nostr+walletconnect":
    raise SystemExit(1)
if not re.fullmatch(r"[0-9a-fA-F]{64}", parts.netloc):
    raise SystemExit(1)
if len(query.get("relay", [])) != 1 or len(query.get("secret", [])) != 1:
    raise SystemExit(1)
if not re.fullmatch(r"[0-9a-fA-F]{64}", query["secret"][0]):
    raise SystemExit(1)
PY
}

save_uri_without_overwrite() {
  if [[ -e "$nwc_file" ]]; then
    [[ -f "$nwc_file" && ! -L "$nwc_file" ]] || return 1
    [[ "$(stat -c '%a' "$nwc_file" 2>/dev/null)" == "600" ]] || return 1
    jq -er --arg name "$app_name" '
      select(.name == $name) | .pairingUri
    ' "$create_stdout" 2>/dev/null | cmp -s "$nwc_file" - || return 1
  else
    if ! (set -o noclobber; jq -er --arg name "$app_name" 'select(.name == $name) | .pairingUri' "$create_stdout" >"$nwc_file") 2>/dev/null; then
      return 1
    fi
    chmod 600 "$nwc_file" 2>/dev/null || return 1
  fi
  validate_uri_file "$nwc_file"
}

save_app_config_without_overwrite() {
  if [[ -e "$app_config_file" ]]; then
    [[ -f "$app_config_file" && ! -L "$app_config_file" ]] || return 1
    [[ "$(stat -c '%a' "$app_config_file" 2>/dev/null)" == "600" ]] || return 1
    jq -e --arg name "$app_name" '
      .name == $name and .maxAmountSat == 1000 and .maxAmountMsat == 1000000 and
      .budgetUsageSat == 0 and .budgetRenewal == "never" and
      ((.scopes | sort) == ["get_balance","get_info","lookup_invoice","pay_invoice"])
    ' "$app_config_file" >/dev/null 2>&1 || return 1
  else
    if ! (set -o noclobber; jq --arg name "$app_name" '
      .apps[] | select(.name == $name) |
      {name,maxAmountSat,maxAmountMsat,budgetUsageSat,budgetRenewal,scopes:(.scopes | sort)}
    ' "$list_after_stdout" >"$app_config_file") 2>/dev/null; then
      return 1
    fi
    chmod 600 "$app_config_file" 2>/dev/null || return 1
  fi
}

if [[ -s "$create_stdout" ]]; then
  validate_create_capture || fail "EXISTING_CREATE_CAPTURE_INVALID"
  validate_empty_before_capture || fail "EXISTING_PRECREATE_CAPTURE_INVALID"
elif [[ "$mode" == "--recover-existing" ]]; then
  fail "RECOVERY_CAPTURE_MISSING"
else
  [[ ! -e "$create_stderr" && ! -e "$list_before_stdout" && ! -e "$list_before_stderr" && ! -e "$list_after_stdout" && ! -e "$list_after_stderr" && ! -e "$nwc_file" && ! -e "$app_config_file" && ! -e "$ready_file" ]] || fail "PARTIAL_CREATE_STATE_REFUSING_REUSE"
  : >"$list_before_stdout" 2>/dev/null || fail "LIST_CAPTURE_CREATE_FAILED"
  : >"$list_before_stderr" 2>/dev/null || fail "LIST_CAPTURE_CREATE_FAILED"
  if ! hub_cli list-apps >"$list_before_stdout" 2>"$list_before_stderr"; then
    fail "HUB_LIST_APPS_FAILED"
  fi
  chmod 600 "$list_before_stdout" "$list_before_stderr" 2>/dev/null || fail "LIST_CAPTURE_PERMISSIONS_FAILED"
  if ! jq -e --arg name "$app_name" '(.apps | type) == "array" and ([.apps[] | select(.name == $name)] | length) == 0' "$list_before_stdout" >/dev/null 2>&1; then
    fail "APP_ALREADY_EXISTS_OR_LIST_RESPONSE_INVALID"
  fi
  [[ ! -e "$create_stdout" && ! -e "$create_stderr" ]] || fail "CREATE_CAPTURE_EXISTS_REFUSING_OVERWRITE"
  : >"$create_stdout" 2>/dev/null || fail "CREATE_CAPTURE_CREATE_FAILED"
  : >"$create_stderr" 2>/dev/null || fail "CREATE_CAPTURE_CREATE_FAILED"
  if ! hub_cli create-app \
    --name "$app_name" \
    --scopes "pay_invoice,get_balance,get_info,lookup_invoice" \
    --max-amount 1000 \
    --budget-renewal never \
    >"$create_stdout" 2>"$create_stderr"; then
    chmod 600 "$create_stdout" "$create_stderr" 2>/dev/null || true
    fail "HUB_CREATE_APP_FAILED"
  fi
  chmod 600 "$create_stdout" "$create_stderr" 2>/dev/null || fail "CREATE_CAPTURE_PERMISSIONS_FAILED"
  validate_create_capture || fail "CREATE_APP_RESPONSE_INVALID_OR_PAIRING_URI_MISSING"
fi

if [[ -e "$list_after_stdout" || -e "$list_after_stderr" ]]; then
  [[ -s "$list_after_stdout" && -e "$list_after_stderr" ]] || fail "PARTIAL_APP_METADATA_CAPTURE_REFUSING_REUSE"
  [[ "$(stat -c '%a' "$list_after_stdout" 2>/dev/null)" == "600" ]] || fail "APP_METADATA_CAPTURE_PERMISSIONS_INVALID"
  [[ "$(stat -c '%a' "$list_after_stderr" 2>/dev/null)" == "600" ]] || fail "APP_METADATA_CAPTURE_PERMISSIONS_INVALID"
else
  : >"$list_after_stdout" 2>/dev/null || fail "APP_METADATA_CAPTURE_CREATE_FAILED"
  : >"$list_after_stderr" 2>/dev/null || fail "APP_METADATA_CAPTURE_CREATE_FAILED"
  if ! hub_cli list-apps >"$list_after_stdout" 2>"$list_after_stderr"; then
    chmod 600 "$list_after_stdout" "$list_after_stderr" 2>/dev/null || true
    fail "HUB_APP_METADATA_LOOKUP_FAILED"
  fi
  chmod 600 "$list_after_stdout" "$list_after_stderr" 2>/dev/null || fail "APP_METADATA_CAPTURE_PERMISSIONS_FAILED"
fi
validate_metadata "$list_after_stdout" || fail "APP_METADATA_MISMATCH"

save_uri_without_overwrite || fail "NWC_URI_RECOVERY_OR_VALIDATION_FAILED"
save_app_config_without_overwrite || fail "APP_CONFIG_RECOVERY_OR_VALIDATION_FAILED"

if [[ -e "$ready_file" ]]; then
  [[ -f "$ready_file" && ! -L "$ready_file" && "$(stat -c '%a' "$ready_file" 2>/dev/null)" == "600" ]] || fail "APP_READY_MARKER_INVALID"
  [[ "$(cat "$ready_file" 2>/dev/null)" == "PHASE61_APP_READY" ]] || fail "APP_READY_MARKER_INVALID"
else
  (set -o noclobber; printf 'PHASE61_APP_READY\n' >"$ready_file") 2>/dev/null || fail "APP_READY_MARKER_CREATE_FAILED"
  chmod 600 "$ready_file" 2>/dev/null || fail "APP_READY_MARKER_PERMISSIONS_FAILED"
fi

unset hub_token
printf 'PHASE61_APP_READY\n'
