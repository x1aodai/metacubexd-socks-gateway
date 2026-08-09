#!/bin/sh
set -eu

# Docker secrets are preferred over clear-text environment variables. The
# corresponding plain variable remains supported for local development.
load_secret() {
  variable_name="$1"
  file_variable_name="${variable_name}_FILE"
  eval "file_path=\${$file_variable_name:-}"
  eval "current_value=\${$variable_name:-}"
  if [ -n "$file_path" ]; then
    if [ ! -r "$file_path" ]; then
      echo "Secret file for $variable_name is not readable: $file_path" >&2
      exit 1
    fi
    current_value="$(sed -n '1p' "$file_path")"
    export "$variable_name=$current_value"
  fi
}

load_secret ADMIN_PASSWORD
load_secret GATEWAY_MASTER_KEY
load_secret CONTROL_TOKEN
load_secret CLASH_SECRET

# Ensure the persisted data directory exists and is writable.
# mihomo's home (geo/fakeip caches), profiles/, and active.yaml all live here.
mkdir -p "${DATA_DIR:-/data}/profiles"

# Nitro's node-server binds NITRO_PORT/PORT (default 3000). Map the documented
# CONTROL_PORT onto it so the dashboard/control server listens where the README,
# compose, EXPOSE and HEALTHCHECK all promise (default 8080) — see #2056.
export PORT="${CONTROL_PORT:-8080}"
export NITRO_HOST="${NITRO_HOST:-127.0.0.1}"

# Hand off to the Nitro node server as PID-1's child (tini reaps the kernel
# subprocess this server spawns).
exec node /app/server/index.mjs
