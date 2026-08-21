import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8').replaceAll(
    '\r\n',
    '\n',
  )
}

function check(condition, message) {
  if (!condition) failures.push(message)
}

function has(text, value, message) {
  check(
    typeof value === 'string' ? text.includes(value) : value.test(text),
    message,
  )
}

function lacks(text, value, message) {
  check(
    typeof value === 'string' ? !text.includes(value) : !value.test(text),
    message,
  )
}

function sameMembers(actual, expected, message) {
  check(
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()),
    message,
  )
}

function section(text, start, end) {
  const header = new RegExp(`^${start}:\\n`, 'm').exec(text)
  if (!header) return ''
  const body = text.slice(header.index + header[0].length)
  const footer = end ? new RegExp(`^${end}:\\n`, 'm').exec(body) : undefined
  return footer ? body.slice(0, footer.index) : body
}

function serviceList(text, name) {
  const match = new RegExp(`^    ${name}:\\n((?:      - .+\\n)+)`, 'm').exec(
    text,
  )
  return match
    ? match[1]
        .trim()
        .split('\n')
        .map((line) => line.replace(/^\s*-\s*/, ''))
    : []
}

const dockerfile = read('apps/server/Dockerfile')
const entrypoint = read('apps/server/docker-entrypoint.sh')
const compose = read('deploy/compose.yaml')
const composeBuild = read('deploy/compose.build.yaml')
const envExample = read('deploy/.env.example')
const caddy = read('deploy/Caddyfile.example')
const nginx = read('deploy/nginx.conf.example')
const secretGenerator = read('deploy/generate-secrets.sh')
const assets = read('packages/agent/src/kernel/assets.ts')
const agentIndex = read('packages/agent/src/index.ts')
const gatewayState = read('packages/agent/src/gateway-state.ts')
const gatewayConfig = read('packages/agent/src/gateway-config.ts')
const publishWorkflow = read('.github/workflows/publish-container.yml')
const releaseWorkflow = read('.github/workflows/release.yml')
const dockerignore = read('.dockerignore')
const gitignore = read('.gitignore')

const nodeImage =
  'node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2'
const alpineImage =
  'alpine:3.20.10@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc'

check(
  dockerfile.split(nodeImage).length - 1 === 2,
  'Dockerfile must pin both Node stages by digest',
)
has(
  dockerfile,
  alpineImage,
  'Dockerfile must pin the Alpine kernel stage by digest',
)
has(
  dockerfile,
  'ARG MIHOMO_VERSION=v1.19.29',
  'Dockerfile must pin Mihomo v1.19.29',
)
has(
  dockerfile,
  '5612e698e96c8b8ad15abc4c0a4f098eba9234354b4f248cb97f2528e215b094',
  'Dockerfile must pin the amd64 Mihomo checksum',
)
has(
  dockerfile,
  '9a868b5e4e0ad91d9d71e1b41b0cfce78aaba44360c30df74a723f8e3926a86c',
  'Dockerfile must pin the arm64 Mihomo checksum',
)
has(
  dockerfile,
  'sha256sum -c -',
  'Dockerfile must verify the Mihomo archive checksum',
)
for (const forbidden of [
  'CONTROL_TOKEN',
  'CONTROL_PORT',
  'CLASH_API_BIND_ADDRESS',
  'CLASH_API_CORS_ORIGINS',
  'MIXED_PORT',
  'SOCKS_PORT_MIN',
  'SOCKS_PORT_MAX',
  ':latest',
]) {
  lacks(dockerfile, forbidden, `Dockerfile must not contain ${forbidden}`)
}
has(dockerfile, 'PORT=8080', 'Dockerfile must fix the Web port to 8080')
has(dockerfile, 'NITRO_HOST=127.0.0.1', 'Dockerfile must bind Web to loopback')
has(
  dockerfile,
  "fetch('http://127.0.0.1:8080/api/control/health')",
  'Dockerfile must health-check the loopback Web service',
)

sameMembers(
  [...entrypoint.matchAll(/^load_secret ([A-Z_]+) /gm)].map(
    (match) => match[1],
  ),
  ['ADMIN_PASSWORD', 'GATEWAY_MASTER_KEY', 'CLASH_SECRET'],
  'entrypoint must load exactly three secrets',
)
has(entrypoint, 'export PORT=8080', 'entrypoint must force port 8080')
has(
  entrypoint,
  'export NITRO_HOST=127.0.0.1',
  'entrypoint must force the loopback bind',
)
for (const forbidden of ['CONTROL_TOKEN', 'CONTROL_PORT']) {
  lacks(entrypoint, forbidden, `entrypoint must not contain ${forbidden}`)
}

sameMembers(
  [...section(compose, 'services', 'secrets').matchAll(/^  ([\w-]+):$/gm)].map(
    (match) => match[1],
  ),
  ['gateway'],
  'Compose must define exactly one gateway service',
)
has(compose, 'network_mode: host', 'Compose gateway must use host networking')
has(
  compose,
  "image: '${GATEWAY_IMAGE:?",
  'Compose image must require GATEWAY_IMAGE',
)
has(compose, 'cap_drop: [ALL]', 'Compose gateway must drop all capabilities')
has(compose, 'read_only: true', 'Compose gateway filesystem must be read-only')
has(
  compose,
  'no-new-privileges:true',
  'Compose gateway must disable privilege escalation',
)
sameMembers(
  serviceList(compose, 'secrets'),
  ['admin_password', 'gateway_master_key', 'clash_secret'],
  'Compose gateway must mount exactly three secrets',
)
sameMembers(
  serviceList(compose, 'volumes'),
  ['gateway-data:/data'],
  'Compose gateway must mount only /data',
)
sameMembers(
  serviceList(compose, 'tmpfs'),
  ['/tmp:size=64m,mode=1777'],
  'Compose gateway must use only the /tmp scratch tmpfs',
)
sameMembers(
  [...section(compose, 'secrets', 'volumes').matchAll(/^  ([\w-]+):$/gm)].map(
    (match) => match[1],
  ),
  ['admin_password', 'gateway_master_key', 'clash_secret'],
  'Compose must define exactly three secrets',
)
sameMembers(
  [...section(compose, 'volumes').matchAll(/^  ([\w-]+):$/gm)].map(
    (match) => match[1],
  ),
  ['gateway-data'],
  'Compose must define exactly one data volume',
)
for (const forbidden of [
  /^\s+ports:/m,
  /^\s+expose:/m,
  /^\s+cap_add:/m,
  /^\s+privileged:/m,
  'CONTROL_TOKEN',
  'CONTROL_PORT',
  'CLASH_API_BIND_ADDRESS',
  'CLASH_API_CORS_ORIGINS',
  'DEFAULT_BACKEND_URL',
  'PUBLIC_DIRECT_ACCESS',
  'MIXED_PORT',
  'SOCKS_PORT_MIN',
  'SOCKS_PORT_MAX',
  ':latest',
]) {
  lacks(
    compose,
    forbidden,
    `Compose contains forbidden deployment setting ${String(forbidden)}`,
  )
}

lacks(
  composeBuild,
  'MIHOMO_VERSION',
  'Compose build must not override the pinned Mihomo version',
)
has(
  envExample,
  /^GATEWAY_IMAGE=\S+@sha256:(?:[0-9a-f]{64}|REPLACE_WITH_PUBLISHED_IMAGE_DIGEST)$/m,
  'env example must use a 64-hex image digest or the explicit replacement placeholder',
)
lacks(envExample, ':latest', 'env example must not use latest')
sameMembers(
  [...envExample.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]),
  ['GATEWAY_IMAGE', 'SESSION_COOKIE_SECURE', 'TZ'],
  'env example must expose only the supported deployment settings',
)

for (const [name, proxy] of [
  ['Caddy', caddy],
  ['Nginx', nginx],
]) {
  has(
    proxy,
    '127.0.0.1:8080',
    `${name} must proxy only the loopback Web service`,
  )
  lacks(proxy, '9090', `${name} must not expose the Mihomo Controller`)
  lacks(proxy, '/mihomo', `${name} must not proxy the Mihomo Controller`)
  lacks(proxy, 'CLASH_SECRET', `${name} must not handle the Controller secret`)
}

sameMembers(
  [...secretGenerator.matchAll(/^write_secret ([a-z_]+) /gm)].map(
    (match) => match[1],
  ),
  ['admin_password', 'gateway_master_key', 'clash_secret'],
  'secret generator must create exactly three secrets',
)
lacks(
  secretGenerator,
  'control_token',
  'secret generator must not create a control token',
)

has(assets, "'v1.19.29'", 'Agent assets must pin Mihomo v1.19.29')
has(
  publishWorkflow,
  'MIHOMO_VERSION=v1.19.29',
  'Container publishing must pin Mihomo v1.19.29',
)
lacks(
  `${publishWorkflow}\n${releaseWorkflow}`,
  /MIHOMO_VERSION=(?!v1\.19\.29\b)/,
  'Every container publishing path must use Mihomo v1.19.29',
)
has(
  agentIndex,
  "const CONTROLLER_URL = '127.0.0.1:9090'",
  'Agent Controller must be fixed to loopback:9090',
)
const gatewayPorts =
  /GATEWAY_PORTS\s*=\s*\[([\s\S]*?)\]/.exec(gatewayState)?.[1].match(/\d+/g) ??
  []
sameMembers(
  gatewayPorts,
  [
    '10001',
    '10002',
    '10003',
    '10004',
    '10005',
    '10006',
    '10007',
    '10008',
    '10009',
    '10010',
  ],
  'Agent must define exactly the ten fixed SOCKS ports',
)
has(gatewayConfig, "type: 'socks'", 'Gateway listeners must be SOCKS-only')
has(gatewayConfig, "listen: '0.0.0.0'", 'SOCKS listeners must bind on IPv4')
has(gatewayConfig, 'udp: false', 'SOCKS listeners must disable UDP')
has(gatewayConfig, 'ipv6: false', 'Gateway configuration must disable IPv6')
has(gatewayConfig, "'MATCH,REJECT'", 'Gateway routing must fail closed')
lacks(
  gatewayConfig,
  "'DIRECT'",
  'Gateway configuration must not generate DIRECT',
)

for (const port of Array.from({ length: 20 }, (_, index) => 1080 + index)) {
  lacks(
    `${dockerfile}\n${entrypoint}\n${compose}`,
    String(port),
    `legacy port ${port} must be absent`,
  )
}

for (const path of [
  'apps/server/compose.yaml',
  'docs/docker-compose.yml',
  'docs/config.yaml',
  'deploy/nginx.remote-waf.conf.example',
  'deploy/public.env.example',
  'deploy/waf.env.example',
]) {
  check(
    !existsSync(resolve(root, path)),
    `legacy deployment file must be deleted: ${path}`,
  )
}

for (const path of ['.env', 'deploy/secrets', 'data', '.runtime']) {
  has(dockerignore, path, `.dockerignore must exclude ${path}`)
}
for (const path of ['deploy/secrets/', 'data/', '.runtime/']) {
  has(gitignore, path, `.gitignore must exclude ${path}`)
}

has(
  compose,
  /^name:\s*metacubexd-gateway\s*$/m,
  'compose keeps the historical project name so upgrades reuse the existing data volume',
)

if (failures.length === 0) {
  console.log('gateway deployment contract: pass')
} else {
  console.error(`gateway deployment contract: fail (${failures.length})`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
}
