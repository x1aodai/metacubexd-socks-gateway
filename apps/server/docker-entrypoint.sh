#!/bin/sh
set -eu
umask 077

load_secret() {
  variable_name="$1"
  file_path="$2"
  [ -z "$file_path" ] && return
  if [ ! -r "$file_path" ]; then
    echo "Secret file for $variable_name is not readable" >&2
    exit 1
  fi
  value="$(sed -n '1p' "$file_path")"
  export "$variable_name=$value"
}

load_secret ADMIN_PASSWORD "${ADMIN_PASSWORD_FILE:-}"
load_secret GATEWAY_MASTER_KEY "${GATEWAY_MASTER_KEY_FILE:-}"
load_secret CLASH_SECRET "${CLASH_SECRET_FILE:-}"

export DATA_DIR=/data
export PORT=8080
export NITRO_HOST=127.0.0.1
mkdir -p "$DATA_DIR"

exec node /app/server/index.mjs
