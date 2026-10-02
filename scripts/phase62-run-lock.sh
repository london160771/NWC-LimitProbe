#!/usr/bin/env bash

phase62_acquire_run_lock() {
  if [[ "$#" -ne 1 || -z "$1" ]]; then return 2; fi
  PHASE62_RUN_LOCK_DIR="${1}.lifecycle.lock"
  if ! mkdir -m 700 "$PHASE62_RUN_LOCK_DIR" 2>/dev/null; then
    PHASE62_RUN_LOCK_DIR=""
    return 1
  fi
  PHASE62_RUN_LOCK_OWNER="$$"
  if ! (set -o noclobber; printf '%s\n' "$PHASE62_RUN_LOCK_OWNER" >"$PHASE62_RUN_LOCK_DIR/pid") 2>/dev/null; then
    rmdir "$PHASE62_RUN_LOCK_DIR" 2>/dev/null || true
    PHASE62_RUN_LOCK_DIR=""
    PHASE62_RUN_LOCK_OWNER=""
    return 1
  fi
  chmod 600 "$PHASE62_RUN_LOCK_DIR/pid" || {
    rm -f "$PHASE62_RUN_LOCK_DIR/pid"
    rmdir "$PHASE62_RUN_LOCK_DIR" 2>/dev/null || true
    PHASE62_RUN_LOCK_DIR=""
    PHASE62_RUN_LOCK_OWNER=""
    return 1
  }
}

phase62_release_run_lock() {
  [[ -n "${PHASE62_RUN_LOCK_DIR:-}" && -n "${PHASE62_RUN_LOCK_OWNER:-}" ]] || return 1
  [[ -d "$PHASE62_RUN_LOCK_DIR" && ! -L "$PHASE62_RUN_LOCK_DIR" && -f "$PHASE62_RUN_LOCK_DIR/pid" && ! -L "$PHASE62_RUN_LOCK_DIR/pid" ]] || return 1
  [[ "$(cat "$PHASE62_RUN_LOCK_DIR/pid" 2>/dev/null)" == "$PHASE62_RUN_LOCK_OWNER" && "$PHASE62_RUN_LOCK_OWNER" == "$$" ]] || return 1
  rm -f "$PHASE62_RUN_LOCK_DIR/pid" || return 1
  rmdir "$PHASE62_RUN_LOCK_DIR" || return 1
  PHASE62_RUN_LOCK_DIR=""
  PHASE62_RUN_LOCK_OWNER=""
}
