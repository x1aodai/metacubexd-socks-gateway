#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
secrets_dir="$script_dir/secrets"
mkdir -p "$secrets_dir"
chmod 700 "$secrets_dir"

write_secret() {
  target="$secrets_dir/$1"
  value="$2"
  if [ -e "$target" ]; then
    echo "Refusing to overwrite existing secret: $target" >&2
    exit 1
  fi
  umask 077
  printf '%s\n' "$value" > "$target"
  chmod 600 "$target"
}

admin_password="$(openssl rand -base64 24 | tr -d '\n')"
write_secret admin_password "$admin_password"
write_secret gateway_master_key "$(openssl rand -hex 32)"
write_secret control_token "$(openssl rand -hex 32)"
write_secret clash_secret "$(openssl rand -hex 32)"

printf '\nInitial administrator password (shown once):\n%s\n\n' "$admin_password"
echo 'Store it in a password manager, then run: docker compose up -d --build'
