#!/usr/bin/env bash
set -eu

usage() {
  cat <<'EOF'
Usage: bash deploy/smoke.sh --image <local-image> [--evidence <jsonl-path>]

Runs the gateway smoke test with a fresh Compose project, temporary secrets and
volume. The image must already exist locally; this script never pulls it.

Options:
  --image <image>       Required local image tag or digest
  --evidence <path>     Preserve JSONL evidence at this path
  --help                Show this help

Optional environment:
  SMOKE_NODE_URL        Explicit real node URL/content for the live node probe
EOF
}

IMAGE=''
REQUESTED_EVIDENCE=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --image)
      [ "$#" -ge 2 ] || { echo 'Missing value for --image' >&2; exit 1; }
      IMAGE=$2
      shift 2
      ;;
    --evidence)
      [ "$#" -ge 2 ] || { echo 'Missing value for --evidence' >&2; exit 1; }
      REQUESTED_EVIDENCE=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$IMAGE" ] || [[ "$IMAGE" == -* ]] || [[ "$IMAGE" =~ [[:space:]] ]]; then
  echo 'A valid --image value is required.' >&2
  exit 1
fi
if [ -n "$REQUESTED_EVIDENCE" ] && { [[ "$REQUESTED_EVIDENCE" == *$'\n'* ]] || [[ "$REQUESTED_EVIDENCE" == *$'\r'* ]]; }; then
  echo 'Invalid --evidence path.' >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BASE_COMPOSE="$SCRIPT_DIR/compose.yaml"
NODE_SMOKE="$SCRIPT_DIR/smoke-gateway.mjs"
GATEWAY_PORTS=(10001 10002 10003 10004 10005 10006 10007 10008 10009 10010)
TEMP_PARENT=${TMPDIR:-/tmp}
TEMP_DIR=$(mktemp -d "$TEMP_PARENT/socks-gateway-smoke.XXXXXX")
TEMP_BASENAME=${TEMP_DIR##*/}
PROJECT_SUFFIX=$(printf '%s' "${TEMP_BASENAME#socks-gateway-smoke.}" | tr '[:upper:]' '[:lower:]')
PROJECT="socks-gateway-smoke-$PROJECT_SUFFIX"
SECRETS_DIR="$TEMP_DIR/secrets"
OVERRIDE_COMPOSE="$TEMP_DIR/smoke.override.yaml"
PRESERVE_EVIDENCE=0
COMPOSE_AVAILABLE=0

if [ -n "$REQUESTED_EVIDENCE" ]; then
  EVIDENCE=$REQUESTED_EVIDENCE
  EVIDENCE_PARENT=$(dirname -- "$EVIDENCE")
  if [ ! -d "$EVIDENCE_PARENT" ]; then
    echo 'The --evidence parent directory does not exist.' >&2
    rmdir -- "$TEMP_DIR"
    exit 1
  fi
  PRESERVE_EVIDENCE=1
else
  EVIDENCE="$TEMP_DIR/evidence.jsonl"
fi

record() {
  check=$1
  status=$2
  summary=$3
  printf '{"check":"%s","status":"%s","summary":"%s"}\n' \
    "$check" "$status" "$summary" >> "$EVIDENCE"
  printf '%-7s %s: %s\n' "$status" "$check" "$summary"
}

COMPOSE_ARGS=(
  --project-directory "$SCRIPT_DIR"
  -p "$PROJECT"
  -f "$BASE_COMPOSE"
  -f "$OVERRIDE_COMPOSE"
)

cleanup() {
  original_status=$?
  cleanup_status=0
  trap - EXIT INT TERM
  set +e
  if [ "$COMPOSE_AVAILABLE" -eq 1 ]; then
    if docker compose "${COMPOSE_ARGS[@]}" down -v --remove-orphans >/dev/null 2>&1; then
      record 'compose-cleanup' 'pass' 'temporary containers and volume were removed'
    else
      record 'compose-cleanup' 'fail' 'temporary Compose cleanup failed'
      cleanup_status=1
    fi
  fi
  if [ "$PRESERVE_EVIDENCE" -eq 0 ] && [ -f "$EVIDENCE" ]; then
    echo 'Evidence (temporary):'
    cat "$EVIDENCE"
  elif [ "$PRESERVE_EVIDENCE" -eq 1 ]; then
    printf 'Evidence: %s\n' "$EVIDENCE"
  fi
  case "$TEMP_BASENAME" in
    socks-gateway-smoke.*)
      rm -rf -- "$TEMP_DIR"
      ;;
    *)
      echo 'Refusing to remove an unexpected temporary path.' >&2
      cleanup_status=1
      ;;
  esac
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

umask 077
mkdir -p "$SECRETS_DIR"
: > "$EVIDENCE"

random_hex() {
  bytes=$1
  LC_ALL=C od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
}

SMOKE_ADMIN_PASSWORD=$(random_hex 24)
SMOKE_BOUND_PASSWORD=$(random_hex 24)
SMOKE_UNBOUND_PASSWORD=$(random_hex 24)
GATEWAY_MASTER_KEY=$(random_hex 32)
CLASH_SECRET=$(random_hex 32)
printf '%s\n' "$SMOKE_ADMIN_PASSWORD" > "$SECRETS_DIR/admin_password"
printf '%s\n' "$GATEWAY_MASTER_KEY" > "$SECRETS_DIR/gateway_master_key"
printf '%s\n' "$CLASH_SECRET" > "$SECRETS_DIR/clash_secret"
chmod 600 "$SECRETS_DIR"/*

export GATEWAY_IMAGE=$IMAGE
export SMOKE_ADMIN_PASSWORD SMOKE_BOUND_PASSWORD SMOKE_UNBOUND_PASSWORD
export SMOKE_SECRETS_DIR=$SECRETS_DIR

cat > "$OVERRIDE_COMPOSE" <<'YAML'
services:
  gateway:
    restart: "no"
secrets:
  admin_password:
    file: "${SMOKE_SECRETS_DIR}/admin_password"
  gateway_master_key:
    file: "${SMOKE_SECRETS_DIR}/gateway_master_key"
  clash_secret:
    file: "${SMOKE_SECRETS_DIR}/clash_secret"
YAML

if [ ! -f "$BASE_COMPOSE" ] || [ ! -f "$NODE_SMOKE" ]; then
  record 'smoke-inputs' 'fail' 'required smoke or Compose file is missing'
  exit 1
fi
if [ "$(uname -s 2>/dev/null || true)" != 'Linux' ]; then
  record 'linux-runtime' 'not-run' 'the smoke test requires Linux host networking'
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  record 'node-runtime' 'not-run' 'Node.js is unavailable on the smoke host'
  exit 0
fi
if ! command -v docker >/dev/null 2>&1; then
  record 'docker-runtime' 'not-run' 'Docker is unavailable on the smoke host'
  exit 0
fi
if ! docker compose version >/dev/null 2>&1; then
  record 'compose-runtime' 'not-run' 'Docker Compose is unavailable on the smoke host'
  exit 0
fi
COMPOSE_AVAILABLE=1

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  record 'local-container-image' 'fail' 'the requested image is not present locally'
  exit 1
fi
record 'local-container-image' 'pass' 'the requested image is present locally'

if ! docker compose "${COMPOSE_ARGS[@]}" config --quiet; then
  record 'compose-contract' 'fail' 'the smoke Compose configuration is invalid'
  exit 1
fi
record 'compose-contract' 'pass' 'the smoke Compose configuration is valid'

if node "$NODE_SMOKE" --phase preflight --evidence "$EVIDENCE"; then
  :
else
  preflight_status=$?
  if [ "$preflight_status" -eq 2 ]; then exit 0; fi
  exit "$preflight_status"
fi

if ! docker compose "${COMPOSE_ARGS[@]}" up -d --pull never gateway; then
  record 'compose-start' 'fail' 'the local image did not start'
  exit 1
fi
record 'compose-start' 'pass' 'the local image started without pulling'

node "$NODE_SMOKE" \
  --phase wait-health \
  --evidence "$EVIDENCE" \
  --timeout-ms 90000

node "$NODE_SMOKE" \
  --phase before-restart \
  --evidence "$EVIDENCE" \
  --timeout-ms 45000

check_tcp_bindings() {
  stage=$1
  tcp_files=()
  [ -r /proc/net/tcp ] && tcp_files+=(/proc/net/tcp)
  [ -r /proc/net/tcp6 ] && tcp_files+=(/proc/net/tcp6)
  if [ "${#tcp_files[@]}" -eq 0 ]; then
    record "tcp-bindings-$stage" 'not-run' 'procfs TCP socket tables are unavailable'
    return
  fi

  tcp_addresses() {
    port=$1
    hex_port=$(printf '%04X' "$port")
    awk -v wanted="$hex_port" '
      FNR > 1 {
        split($2, address, ":")
        if (toupper(address[2]) == wanted && toupper($4) == "0A")
          print toupper(address[1])
      }
    ' "${tcp_files[@]}"
  }

  if [ "$(tcp_addresses 8080)" != '0100007F' ] || \
     [ "$(tcp_addresses 9090)" != '0100007F' ]; then
    printf 'Unexpected web/controller TCP binds: 8080=%s 9090=%s\n' \
      "$(tcp_addresses 8080)" "$(tcp_addresses 9090)" >&2
    record "tcp-bindings-$stage" 'fail' 'web or controller is not loopback-only'
    return 1
  fi
  for port in "${GATEWAY_PORTS[@]}"; do
    addresses=$(tcp_addresses "$port")
    if [ -z "$addresses" ] || ! printf '%s\n' "$addresses" | awk '
      $0 != "00000000" && $0 != "00000000000000000000000000000000" {
        exit 1
      }
    '; then
      printf 'Unexpected managed TCP bind: port=%s addresses=%s\n' \
        "$port" "${addresses:-none}" >&2
      record "tcp-bindings-$stage" 'fail' 'a managed SOCKS port has the wrong TCP bind'
      return 1
    fi
  done
  record "tcp-bindings-$stage" 'pass' 'web and controller are loopback-only and ten TCP SOCKS listeners are active'
}

check_no_udp() {
  stage=$1
  udp_files=()
  [ -r /proc/net/udp ] && udp_files+=(/proc/net/udp)
  [ -r /proc/net/udp6 ] && udp_files+=(/proc/net/udp6)
  if [ "${#udp_files[@]}" -eq 0 ]; then
    record "udp-listeners-$stage" 'not-run' 'procfs UDP socket tables are unavailable'
    return
  fi
  for port in "${GATEWAY_PORTS[@]}"; do
    hex_port=$(printf '%04X' "$port")
    if awk -v wanted="$hex_port" '
      {
        split($2, address, ":")
        if (toupper(address[2]) == wanted) found = 1
      }
      END { exit(found ? 0 : 1) }
    ' "${udp_files[@]}"; then
      record "udp-listeners-$stage" 'fail' 'a managed port has a UDP socket'
      return 1
    fi
  done
  record "udp-listeners-$stage" 'pass' 'managed ports have no UDP sockets'
}

check_tcp_bindings 'before-restart'
check_no_udp 'before-restart'

if ! docker compose "${COMPOSE_ARGS[@]}" restart gateway; then
  record 'compose-restart' 'fail' 'the gateway container did not restart'
  exit 1
fi
record 'compose-restart' 'pass' 'the gateway container restarted'

node "$NODE_SMOKE" \
  --phase wait-health \
  --evidence "$EVIDENCE" \
  --timeout-ms 90000

node "$NODE_SMOKE" \
  --phase after-restart \
  --evidence "$EVIDENCE" \
  --timeout-ms 45000

check_tcp_bindings 'after-restart'
check_no_udp 'after-restart'
record 'gateway-smoke' 'pass' 'all runnable gateway smoke checks passed'
