#!/usr/bin/env bash
set -euo pipefail

# Bind-mounted Phase 6.1 artifacts must be owned by WSL user uk.
# File writers still set mode 0600; this wrapper prevents Docker's root default.
uk_uid="$(id -u uk)"
uk_gid="$(id -g uk)"
if [[ "$(id -u)" != "$uk_uid" ]]; then
  printf 'PHASE61_DOCKER_USER_MISMATCH\n' >&2
  exit 2
fi
exec docker run --user "$uk_uid:$uk_gid" "$@"
