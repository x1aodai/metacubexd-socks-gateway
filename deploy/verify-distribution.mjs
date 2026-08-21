import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function read(relativePath) {
  const path = resolve(root, relativePath)
  if (!existsSync(path)) {
    failures.push(`required distribution file is missing: ${relativePath}`)
    return ''
  }
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
}

function check(condition, message) {
  if (!condition) failures.push(message)
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
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

function jobNames(workflow) {
  const jobs = /^jobs:\n/m.exec(workflow)
  if (!jobs) return []
  return [
    ...workflow.slice(jobs.index + jobs[0].length).matchAll(/^  ([\w-]+):$/gm),
  ].map((match) => match[1])
}

const license = read('LICENSE')
const notice = read('NOTICE')
const mihomoLicense = read('third_party/mihomo/LICENSE')
const mihomoSource = read('third_party/mihomo/SOURCE.md')
const nodeVersion = read('.node-version').trim()
const dockerfile = read('apps/server/Dockerfile')
const agentAssets = read('packages/agent/src/kernel/assets.ts')
const unitWorkflow = read('.github/workflows/unit-tests.yml')
const e2eWorkflow = read('.github/workflows/e2e.yml')
const publishWorkflow = read('.github/workflows/publish-container.yml')
const releaseWorkflow = read('.github/workflows/release.yml')

check(
  sha256(license) ===
    'cd0735ba06f26a0008bbca399890c7ca87fe129aacc302c2e33fb03e60a4e8c3',
  'root MetaCubeX MIT license must remain byte-for-byte unchanged apart from CRLF normalization',
)
for (const token of [
  'MetaCubeXD',
  'x1aodai/metacubexd-socks-gateway',
  'b69d26fe',
])
  has(notice, token, `NOTICE must identify ${token}`)
check(
  sha256(mihomoLicense) ===
    '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
  'Mihomo GPLv3 license must match the v1.19.29 source exactly apart from CRLF normalization',
)
has(mihomoSource, 'github.com/MetaCubeX/mihomo', 'Mihomo source URL is missing')
has(mihomoSource, 'v1.19.29', 'Mihomo source tag must be v1.19.29')

check(nodeVersion === '22.23.1', '.node-version must pin Node 22.23.1')
for (const [name, workflow] of [
  ['unit', unitWorkflow],
  ['e2e', e2eWorkflow],
  ['publish', publishWorkflow],
]) {
  has(
    workflow,
    'node-version-file: .node-version',
    `${name} workflow must use .node-version`,
  )
  lacks(
    workflow,
    /node-version:\s*(?:latest|lts)/,
    `${name} workflow must not use a floating Node release`,
  )
  lacks(
    workflow,
    /uses:\s*\S+@latest/,
    `${name} workflow must not use latest actions`,
  )
}

const qualityCommands = [
  'pnpm install --frozen-lockfile',
  'pnpm test',
  'pnpm typecheck',
  'pnpm lint',
  'pnpm build',
  'node deploy/verify-contract.mjs',
  'node deploy/verify-distribution.mjs',
]
for (const [name, workflow] of [
  ['unit workflow', unitWorkflow],
  ['publish quality gate', publishWorkflow],
])
  for (const command of qualityCommands)
    has(workflow, `run: ${command}`, `${name} must run: ${command}`)

sameMembers(
  jobNames(unitWorkflow),
  ['unit-test'],
  'unit workflow must contain one root quality job',
)
sameMembers(
  jobNames(e2eWorkflow),
  ['e2e-test'],
  'e2e workflow must contain one browser job',
)
for (const command of [
  'pnpm install --frozen-lockfile',
  'pnpm --filter @metacubexd/ui exec playwright install --with-deps chromium',
  'pnpm --filter @metacubexd/ui build',
  'pnpm --filter @metacubexd/ui test:e2e',
])
  has(e2eWorkflow, `run: ${command}`, `e2e workflow must run: ${command}`)

sameMembers(
  jobNames(releaseWorkflow),
  ['release-please'],
  'release workflow must only run release-please',
)
has(
  releaseWorkflow,
  'googleapis/release-please-action@v5',
  'release workflow must run release-please',
)
for (const forbidden of [
  'ghcr.io',
  'docker/',
  'packages: write',
  'push: true',
  'MIHOMO_VERSION',
])
  lacks(
    releaseWorkflow,
    forbidden,
    `release workflow must not contain ${forbidden}`,
  )

sameMembers(
  jobNames(publishWorkflow),
  ['publish', 'quality'],
  'publish workflow needs quality and publish jobs',
)
has(
  publishWorkflow,
  'needs: quality',
  'container publishing must wait for the quality job',
)
has(publishWorkflow, /^\s{6}- main$/m, 'container publishing must run on main')
has(
  publishWorkflow,
  /^\s{6}- ['"]v\*['"]$/m,
  'container publishing must run on v* tags',
)
has(
  publishWorkflow,
  /^  workflow_dispatch:\s*$/m,
  'container publishing must support manual dispatch',
)
lacks(
  publishWorkflow,
  'gateway-v1.271.0',
  'container publishing must not keep the temporary branch trigger',
)
has(publishWorkflow, 'push: true', 'publish workflow must push the image')
has(publishWorkflow, 'sbom: true', 'published images must retain an SBOM')
has(
  publishWorkflow,
  'provenance: mode=max',
  'published images must retain provenance',
)

const workflowsDir = resolve(root, '.github/workflows')
const ghcrPublishers = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .filter((name) => {
    const workflow = read(`.github/workflows/${name}`)
    return (
      workflow.includes('ghcr.io') ||
      workflow.includes('docker/build-push-action') ||
      /^\s+push:\s*true\s*$/m.test(workflow)
    )
  })
sameMembers(
  ghcrPublishers,
  ['publish-container.yml'],
  'publish-container must be the only GHCR publisher',
)

const versions = [
  /ARG MIHOMO_VERSION=(v\S+)/.exec(dockerfile)?.[1],
  /MIHOMO_VERSION[^\n]*['"](v[^'"]+)['"]/.exec(agentAssets)?.[1],
  /MIHOMO_VERSION=(v\S+)/.exec(publishWorkflow)?.[1],
]
check(
  versions.every((version) => version === 'v1.19.29'),
  'Mihomo must be pinned to v1.19.29 everywhere',
)

for (const [source, destination] of [
  ['LICENSE', '/usr/share/licenses/metacubexd/LICENSE'],
  ['NOTICE', '/usr/share/doc/metacubexd/NOTICE'],
  ['third_party/mihomo/LICENSE', '/usr/share/licenses/mihomo/LICENSE'],
  ['third_party/mihomo/SOURCE.md', '/usr/share/doc/mihomo/SOURCE.md'],
])
  has(
    dockerfile,
    `COPY ${source} ${destination}`,
    `image must copy ${source} to ${destination}`,
  )

const { values } = parseArgs({
  options: { image: { type: 'string' } },
  strict: true,
})
if (values.image !== undefined) {
  const image = values.image.trim()
  if (!image || image.startsWith('-')) {
    failures.push(
      'image reference must be non-empty and must not start with a dash',
    )
  } else {
    const localImage = spawnSync('docker', ['image', 'inspect', image], {
      encoding: 'utf8',
    })
    check(
      localImage.status === 0,
      'image verification requires the requested image to exist locally',
    )

    if (localImage.status === 0) {
      const licenseCheck = spawnSync(
        'docker',
        [
          'run',
          '--pull=never',
          '--rm',
          '--entrypoint',
          '/bin/sh',
          image,
          '-ec',
          'for path in /usr/share/licenses/metacubexd/LICENSE /usr/share/doc/metacubexd/NOTICE /usr/share/licenses/mihomo/LICENSE /usr/share/doc/mihomo/SOURCE.md; do test -r "$path" -a -s "$path"; done',
        ],
        { encoding: 'utf8' },
      )
      check(
        licenseCheck.status === 0,
        'image license and source files must be readable and non-empty',
      )

      const versionCheck = spawnSync(
        'docker',
        [
          'run',
          '--pull=never',
          '--rm',
          '--entrypoint',
          '/usr/local/bin/mihomo',
          image,
          '-v',
        ],
        { encoding: 'utf8' },
      )
      check(
        versionCheck.status === 0,
        'image Mihomo version command must succeed',
      )
      check(
        `${versionCheck.stdout ?? ''}\n${versionCheck.stderr ?? ''}`.includes(
          '1.19.29',
        ),
        'image must contain Mihomo v1.19.29',
      )
    }
  }
}

if (failures.length === 0) {
  console.log('gateway distribution contract: pass')
} else {
  console.error(`gateway distribution contract: fail (${failures.length})`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
}
