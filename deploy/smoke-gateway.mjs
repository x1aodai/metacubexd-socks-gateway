#!/usr/bin/env node

import { appendFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import process from 'node:process'

const REQUIRED_PORTS = [
  8080,
  9090,
  ...Array.from({ length: 10 }, (_, i) => 10001 + i),
]
const GATEWAY_PORTS = Array.from({ length: 10 }, (_, i) => 10001 + i)
const BASE_URL = 'http://127.0.0.1:8080'
const FAIL_CLOSED_CANARY_ADDRESS = [127, 0, 0, 2]
const FAIL_CLOSED_CANARY_HOST = FAIL_CLOSED_CANARY_ADDRESS.join('.')
const FAIL_CLOSED_CANARY_MARKER = Buffer.from('gateway-canary-reached')
const BOUND_USERNAME = 'smoke-bound'
const UNBOUND_USERNAME = 'smoke-unbound'
const UNREACHABLE_NAMES = ['smoke-unreachable-a', 'smoke-unreachable-b']
const VALID_PHASES = new Set([
  'preflight',
  'wait-health',
  'before-restart',
  'after-restart',
])

const USAGE = `Usage:
  node deploy/smoke-gateway.mjs --phase <phase> --evidence <path> [options]

Phases:
  preflight       Verify 127.0.0.1:8080, :9090 and :10001-:10010 are free
  wait-health     Wait for the public loopback health endpoint
  before-restart  Configure and exercise the complete gateway contract
  after-restart   Verify persisted nodes, accounts, routes and listeners

Options:
  --timeout-ms <ms>   Per-operation timeout, 1000-300000 (default: 30000)
  --help              Show this help

Environment for before-restart/after-restart:
  SMOKE_ADMIN_PASSWORD, SMOKE_BOUND_PASSWORD, SMOKE_UNBOUND_PASSWORD
  SMOKE_NODE_URL is optional; its live node check is otherwise not-run.
`

class SmokeFailure extends Error {
  constructor(check) {
    super(`smoke check failed: ${check}`)
    this.check = check
  }
}

class SmokeNotRun extends Error {}

function parseArgs(argv) {
  const result = {
    phase: '',
    evidence: '',
    timeoutMs: 30_000,
    help: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      result.help = true
      continue
    }
    const value = argv[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`missing value for ${argument}`)
    if (argument === '--phase') result.phase = value
    else if (argument === '--evidence') result.evidence = value
    else if (argument === '--timeout-ms') result.timeoutMs = Number(value)
    else throw new Error(`unknown option: ${argument}`)
  }
  if (result.help) return result
  if (!VALID_PHASES.has(result.phase)) throw new Error('invalid --phase')
  if (!result.evidence || /[\r\n\0]/.test(result.evidence))
    throw new Error('invalid --evidence')
  if (
    !Number.isInteger(result.timeoutMs) ||
    result.timeoutMs < 1_000 ||
    result.timeoutMs > 300_000
  )
    throw new Error('invalid --timeout-ms')
  return result
}

class Reporter {
  constructor(path) {
    this.path = path
  }

  record(check, status, summary) {
    if (!['pass', 'fail', 'not-run'].includes(status))
      throw new Error('invalid evidence status')
    appendFileSync(
      this.path,
      `${JSON.stringify({ check, status, summary })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    process.stdout.write(`${status.padEnd(7)} ${check}: ${summary}\n`)
  }

  async check(check, passSummary, failSummary, action) {
    try {
      const result = await action()
      this.record(check, 'pass', passSummary)
      return result
    } catch {
      this.record(check, 'fail', failSummary)
      throw new SmokeFailure(check)
    }
  }
}

function requiredSecret(name) {
  const value = process.env[name]
  if (!value || value.length < 12 || value.length > 256)
    throw new Error(`missing or invalid ${name}`)
  return value
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

function listen(server, options) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options)
  })
}

async function canBind(port, host = '127.0.0.1') {
  const server = createServer()
  try {
    await listen(server, { host, port, exclusive: true })
    await closeServer(server)
    return true
  } catch {
    server.close()
    return false
  }
}

async function allocateClosedPorts(count) {
  const servers = []
  try {
    for (let index = 0; index < count; index++) {
      const server = createServer()
      await listen(server, { host: '127.0.0.1', port: 0, exclusive: true })
      servers.push(server)
    }
    return servers.map((server) => {
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('ephemeral port allocation failed')
      return address.port
    })
  } finally {
    await Promise.all(servers.map((server) => closeServer(server)))
  }
}

async function connectSocket(port, host = '127.0.0.1', timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('socket timeout'))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

class SocketReader {
  constructor(socket, timeoutMs) {
    this.socket = socket
    this.timeoutMs = timeoutMs
    this.iterator = socket[Symbol.asyncIterator]()
    this.buffer = Buffer.alloc(0)
  }

  async read(length) {
    while (this.buffer.length < length) {
      let timer
      let next
      try {
        next = await Promise.race([
          this.iterator.next(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('socket read timeout')),
              this.timeoutMs,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
      if (next.done) throw new Error('socket closed')
      this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)])
    }
    const result = this.buffer.subarray(0, length)
    this.buffer = this.buffer.subarray(length)
    return result
  }
}

async function socksAuth(port, username, password, expected, timeoutMs) {
  const socket = await connectSocket(port, '127.0.0.1', timeoutMs)
  const reader = new SocketReader(socket, timeoutMs)
  try {
    socket.write(Buffer.from([0x05, 0x01, 0x02]))
    const greeting = await reader.read(2)
    if (greeting[0] !== 0x05 || greeting[1] !== 0x02)
      throw new Error('SOCKS username/password method was not selected')
    const user = Buffer.from(username, 'utf8')
    const secret = Buffer.from(password, 'utf8')
    if (user.length < 1 || user.length > 255 || secret.length > 255)
      throw new Error('SOCKS credential length is invalid')
    socket.write(
      Buffer.concat([
        Buffer.from([0x01, user.length]),
        user,
        Buffer.from([secret.length]),
        secret,
      ]),
    )
    const authentication = await reader.read(2)
    if (authentication[0] !== 0x01)
      throw new Error('SOCKS authentication response version was invalid')
    const accepted = authentication[1] === 0x00
    if (accepted !== expected) throw new Error('unexpected SOCKS auth result')
    return { socket, reader }
  } catch (error) {
    socket.destroy()
    throw error
  }
}

async function expectAnonymousRejected(port, timeoutMs) {
  const socket = await connectSocket(port, '127.0.0.1', timeoutMs)
  const reader = new SocketReader(socket, timeoutMs)
  try {
    socket.write(Buffer.from([0x05, 0x01, 0x00]))
    const reply = await reader.read(2)
    if (reply[0] !== 0x05)
      throw new Error('SOCKS method response version was invalid')
    if (reply[1] === 0x00)
      throw new Error('anonymous SOCKS authentication was accepted')
    if (reply[1] !== 0x02 && reply[1] !== 0xff)
      throw new Error('SOCKS server selected an unexpected method')
  } finally {
    socket.destroy()
  }
}

async function expectAuth(port, username, password, expected, timeoutMs) {
  const session = await socksAuth(port, username, password, expected, timeoutMs)
  session.socket.destroy()
}

async function expectConnectionRejected(port, host, timeoutMs) {
  let socket
  try {
    socket = await connectSocket(port, host, timeoutMs)
  } catch {
    return
  }
  socket.destroy()
  throw new Error('unexpected TCP connection was accepted')
}

async function socksConnect(port, username, password, targetPort, timeoutMs) {
  const { socket, reader } = await socksAuth(
    port,
    username,
    password,
    true,
    timeoutMs,
  )
  try {
    socket.write(
      Buffer.from([
        0x05,
        0x01,
        0x00,
        0x01,
        ...FAIL_CLOSED_CANARY_ADDRESS,
        (targetPort >> 8) & 0xff,
        targetPort & 0xff,
      ]),
    )
    let reply
    try {
      reply = await reader.read(4)
    } catch {
      return false
    }
    if (reply[0] !== 0x05 || reply[1] !== 0x00) return false
    const addressLength =
      reply[3] === 0x01
        ? 4
        : reply[3] === 0x04
          ? 16
          : reply[3] === 0x03
            ? (await reader.read(1))[0]
            : -1
    if (addressLength < 0) throw new Error('invalid SOCKS reply address')
    await reader.read(addressLength + 2)
    let marker
    try {
      marker = await reader.read(FAIL_CLOSED_CANARY_MARKER.length)
    } catch (error) {
      if (error instanceof Error && error.message === 'socket read timeout')
        throw error
      return false
    }
    if (!marker.equals(FAIL_CLOSED_CANARY_MARKER))
      throw new Error('SOCKS canary returned unexpected data')
    return true
  } finally {
    socket.destroy()
  }
}

class ApiClient {
  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs
    this.cookie = ''
    this.csrf = ''
  }

  async request(path, options = {}) {
    const method = options.method ?? 'GET'
    const headers = { accept: 'application/json' }
    if (this.cookie) headers.cookie = this.cookie
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && this.csrf)
      headers['x-csrf-token'] = options.csrf ?? this.csrf
    return fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
    })
  }

  async json(path, options = {}) {
    const response = await this.request(path, options)
    if (!response.ok) {
      await response.arrayBuffer().catch(() => {})
      throw new Error(`API request failed with ${response.status}`)
    }
    return response.json()
  }

  async login(password) {
    const response = await this.request('/api/auth/login', {
      method: 'POST',
      body: { password },
    })
    if (!response.ok) throw new Error('administrator login failed')
    const body = await response.json()
    const getSetCookie = response.headers.getSetCookie
    const rawCookie =
      typeof getSetCookie === 'function'
        ? getSetCookie.call(response.headers)[0]
        : response.headers.get('set-cookie')
    this.cookie = rawCookie?.split(';', 1)[0] ?? ''
    this.csrf = typeof body.csrfToken === 'string' ? body.csrfToken : ''
    if (!this.cookie || !this.csrf || body.authenticated !== true)
      throw new Error('administrator session is incomplete')
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function expectedRoute(portId, nodeIds) {
  if (portId === 2)
    return [
      { mode: 'manual', nodeIds: [nodeIds[0]] },
      { mode: 'manual', nodeIds: [nodeIds[1]] },
    ]
  if (portId === 3) return [{ mode: 'auto', nodeIds: [...nodeIds] }]
  if (portId === 4) return [{ mode: 'failover', nodeIds: [...nodeIds] }]
  return [{ mode: 'manual', nodeIds: [nodeIds[0]] }]
}

function assertPortStructures(ports, nodeIds, credentialId) {
  if (!Array.isArray(ports) || ports.length !== 10)
    throw new Error('gateway does not expose ten ports')
  for (let index = 0; index < ports.length; index++) {
    const port = ports[index]
    if (
      port.id !== index + 1 ||
      port.port !== GATEWAY_PORTS[index] ||
      port.enabled !== true ||
      !sameJson(port.credentialIds, [credentialId]) ||
      !sameJson(port.hops, expectedRoute(port.id, nodeIds))
    )
      throw new Error('gateway port structure differs from smoke fixture')
  }
}

async function waitForHealth(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await client.request('/api/control/health', {
        timeoutMs: Math.min(2_000, timeoutMs),
      })
      if (response.ok) {
        const body = await response.json()
        if (body?.ok === true) return
      }
    } catch {
      // The container is still starting.
    }
    await delay(250)
  }
  throw new Error('health endpoint timeout')
}

async function runPreflight(reporter) {
  const unavailable = []
  for (const port of REQUIRED_PORTS) {
    const host = port >= 10001 && port <= 10010 ? '0.0.0.0' : '127.0.0.1'
    if (!(await canBind(port, host))) unavailable.push(port)
  }
  if (unavailable.length > 0) {
    reporter.record(
      'loopback-port-preflight',
      'not-run',
      'required loopback ports are already occupied',
    )
    process.stderr.write(
      `not-run: occupied loopback ports: ${unavailable.join(', ')}\n`,
    )
    throw new SmokeNotRun()
  }
  reporter.record(
    'loopback-port-preflight',
    'pass',
    'all required loopback ports are available',
  )
}

async function authenticate(client, reporter, adminPassword) {
  await reporter.check(
    'administrator-session-csrf',
    'administrator session and CSRF enforcement work',
    'administrator session or CSRF enforcement failed',
    async () => {
      const anonymous = await client.request('/api/control/gateway/ports')
      if (anonymous.status !== 401) throw new Error('control API is public')
      await anonymous.arrayBuffer().catch(() => {})
      await client.login(adminPassword)
      const me = await client.json('/api/auth/me')
      if (me.authenticated !== true || me.user !== 'admin')
        throw new Error('administrator session was not accepted')
      const invalidCsrf = await client.request('/api/control/gateway/ports/1', {
        method: 'PUT',
        body: {},
        csrf: 'invalid-smoke-csrf',
      })
      if (invalidCsrf.status !== 403)
        throw new Error('invalid CSRF was accepted')
      await invalidCsrf.arrayBuffer().catch(() => {})
    },
  )
}

async function importUnreachableNodes(client, reporter) {
  return reporter.check(
    'deterministic-unreachable-nodes',
    'two isolated unreachable test nodes were imported',
    'unreachable test-node import failed',
    async () => {
      const [firstPort, secondPort] = await allocateClosedPorts(2)
      const content = `proxies:\n  - name: ${UNREACHABLE_NAMES[0]}\n    type: socks5\n    server: 127.0.0.1\n    port: ${firstPort}\n    udp: false\n  - name: ${UNREACHABLE_NAMES[1]}\n    type: socks5\n    server: 127.0.0.1\n    port: ${secondPort}\n    udp: false\n`
      const preview = await client.json(
        '/api/control/gateway/imports/preview',
        {
          method: 'POST',
          body: { content },
        },
      )
      if (
        preview.validCount !== 2 ||
        !Array.isArray(preview.nodes) ||
        preview.nodes.length !== 2 ||
        typeof preview.previewId !== 'string'
      )
        throw new Error('import preview did not contain two nodes')
      await client.json('/api/control/gateway/imports/apply', {
        method: 'POST',
        body: { previewId: preview.previewId },
      })
      const nodes = await client.json('/api/control/gateway/nodes')
      const nodeIds = UNREACHABLE_NAMES.map(
        (name) => nodes.items.find((node) => node.name === name)?.id,
      )
      if (nodeIds.some((id) => typeof id !== 'string'))
        throw new Error('imported nodes are missing')
      return nodeIds
    },
  )
}

async function createCredentials(
  client,
  reporter,
  boundPassword,
  unboundPassword,
) {
  return reporter.check(
    'credential-port-bindings',
    'bound and unbound SOCKS accounts were created',
    'SOCKS account creation or binding failed',
    async () => {
      const portIds = Array.from({ length: 10 }, (_, index) => index + 1)
      const bound = await client.json('/api/control/gateway/credentials', {
        method: 'POST',
        body: {
          username: BOUND_USERNAME,
          password: boundPassword,
          enabled: true,
          portIds,
        },
      })
      const unbound = await client.json('/api/control/gateway/credentials', {
        method: 'POST',
        body: {
          username: UNBOUND_USERNAME,
          password: unboundPassword,
          enabled: true,
          portIds: [],
        },
      })
      if (
        typeof bound.id !== 'string' ||
        typeof unbound.id !== 'string' ||
        !sameJson(bound.portIds, portIds) ||
        !sameJson(unbound.portIds, [])
      )
        throw new Error('credential bindings differ from request')
      const listed = await client.json('/api/control/gateway/credentials')
      if (
        !Array.isArray(listed.items) ||
        listed.items.some((credential) => 'password' in credential)
      )
        throw new Error('credential list exposed a secret')
      return bound.id
    },
  )
}

async function configurePorts(client, reporter, nodeIds, credentialId) {
  await reporter.check(
    'fixed-port-route-structures',
    'ten fixed ports cover one-hop, two-hop, manual, auto and failover',
    'fixed port or hop-mode configuration failed',
    async () => {
      for (let id = 1; id <= 10; id++) {
        await client.json(`/api/control/gateway/ports/${id}`, {
          method: 'PUT',
          body: {
            enabled: true,
            credentialIds: [credentialId],
            hops: expectedRoute(id, nodeIds),
          },
          timeoutMs: 45_000,
        })
      }
      const ports = await client.json('/api/control/gateway/ports')
      assertPortStructures(ports.items, nodeIds, credentialId)
      const status = await client.json('/api/control/gateway/status')
      if (
        status.services?.mihomo?.controllerReachable !== true ||
        !Array.isArray(status.listeners) ||
        status.listeners.length !== 10 ||
        status.listeners.some(
          (listener) =>
            listener.enabled !== true || listener.reachable !== true,
        )
      )
        throw new Error('gateway listeners are not all reachable')
    },
  )
}

async function verifyAuthentication(
  reporter,
  boundPassword,
  unboundPassword,
  timeoutMs,
) {
  await reporter.check(
    'bound-account-authentication',
    'the bound account authenticates on all ten SOCKS listeners',
    'the bound account failed on one or more SOCKS listeners',
    async () => {
      for (const port of GATEWAY_PORTS)
        await expectAuth(port, BOUND_USERNAME, boundPassword, true, timeoutMs)
    },
  )
  await reporter.check(
    'anonymous-socks-rejection',
    'anonymous SOCKS authentication is rejected',
    'anonymous SOCKS authentication was accepted',
    () => expectAnonymousRejected(GATEWAY_PORTS[0], timeoutMs),
  )
  await reporter.check(
    'wrong-password-rejection',
    'the bound account is rejected with a wrong password',
    'the bound account was accepted with a wrong password',
    () =>
      expectAuth(
        GATEWAY_PORTS[0],
        BOUND_USERNAME,
        `${boundPassword}-wrong`,
        false,
        timeoutMs,
      ),
  )
  await reporter.check(
    'unbound-account-rejection',
    'an unbound account is rejected',
    'an unbound account was accepted',
    () =>
      expectAuth(
        GATEWAY_PORTS[0],
        UNBOUND_USERNAME,
        unboundPassword,
        false,
        timeoutMs,
      ),
  )
}

async function verifyFailClosed(reporter, boundPassword, timeoutMs) {
  await reporter.check(
    'fail-closed-local-canary',
    'an unreachable proxy candidate cannot fall back to DIRECT',
    'local canary detected DIRECT fallback or the check was inconclusive',
    async () => {
      let accepted = 0
      const canary = createServer((socket) => {
        accepted++
        socket.end(FAIL_CLOSED_CANARY_MARKER)
      })
      await listen(canary, {
        host: FAIL_CLOSED_CANARY_HOST,
        port: 0,
        exclusive: true,
      })
      try {
        const address = canary.address()
        if (!address || typeof address === 'string')
          throw new Error('canary did not bind')
        const direct = await connectSocket(
          address.port,
          FAIL_CLOSED_CANARY_HOST,
          timeoutMs,
        )
        try {
          const marker = await new SocketReader(direct, timeoutMs).read(
            FAIL_CLOSED_CANARY_MARKER.length,
          )
          if (!marker.equals(FAIL_CLOSED_CANARY_MARKER))
            throw new Error('direct canary returned unexpected data')
        } finally {
          direct.destroy()
        }
        if (accepted !== 1) throw new Error('direct canary was not reachable')
        const baseline = accepted
        const reachedCanary = await socksConnect(
          GATEWAY_PORTS[0],
          BOUND_USERNAME,
          boundPassword,
          address.port,
          timeoutMs,
        )
        if (reachedCanary || accepted !== baseline)
          throw new Error('gateway reached the canary directly')
      } finally {
        await closeServer(canary)
      }
    },
  )
}

async function verifyIpv6Rejected(reporter, stage, timeoutMs) {
  await reporter.check(
    `ipv6-socks-rejection-${stage}`,
    `IPv6 SOCKS connections are rejected ${stage}`,
    `an IPv6 SOCKS connection was accepted ${stage}`,
    () =>
      Promise.all(
        GATEWAY_PORTS.map((port) =>
          expectConnectionRejected(port, '::1', timeoutMs),
        ),
      ),
  )
}

async function verifyRollback(
  client,
  reporter,
  nodeIds,
  credentialId,
  boundPassword,
) {
  await reporter.check(
    'transactional-port-conflict-rollback',
    'a deterministic listener conflict rolled back state and revision history',
    'listener-conflict rollback did not preserve the previous state',
    async () => {
      await client.json('/api/control/gateway/ports/10', {
        method: 'PUT',
        body: { enabled: false },
        timeoutMs: 45_000,
      })
      const beforePorts = await client.json('/api/control/gateway/ports')
      const before = beforePorts.items[9]
      const beforeRevisions = await client.json(
        '/api/control/gateway/revisions',
      )
      if (!before || before.enabled !== false)
        throw new Error('port 10010 did not disable')

      const conflict = createServer((socket) => socket.destroy())
      await listen(conflict, { host: '0.0.0.0', port: 10010, exclusive: true })
      try {
        const response = await client.request('/api/control/gateway/ports/10', {
          method: 'PUT',
          body: { enabled: true },
          timeoutMs: 45_000,
        })
        await response.arrayBuffer().catch(() => {})
        if (response.ok) throw new Error('conflicting listener was applied')
      } finally {
        await closeServer(conflict)
      }

      const afterPorts = await client.json('/api/control/gateway/ports')
      const after = afterPorts.items[9]
      const afterRevisions = await client.json('/api/control/gateway/revisions')
      const status = await client.json('/api/control/gateway/status')
      if (
        !sameJson(after, before) ||
        !sameJson(
          afterRevisions.items.map((revision) => revision.id),
          beforeRevisions.items.map((revision) => revision.id),
        ) ||
        status.lastApply?.result !== 'failure' ||
        typeof status.lastApply?.errorCode !== 'string'
      )
        throw new Error('failed candidate was not rolled back')

      await client.json('/api/control/gateway/ports/10', {
        method: 'PUT',
        body: {
          enabled: true,
          credentialIds: [credentialId],
          hops: expectedRoute(10, nodeIds),
        },
        timeoutMs: 45_000,
      })
      await expectAuth(10010, BOUND_USERNAME, boundPassword, true, 5_000)
    },
  )
}

async function verifyOptionalRealNode(client, reporter) {
  const content = process.env.SMOKE_NODE_URL
  if (!content) {
    reporter.record(
      'optional-real-node',
      'not-run',
      'SMOKE_NODE_URL was not supplied',
    )
    return
  }
  await reporter.check(
    'optional-real-node',
    'the explicitly supplied real node passed its live probe',
    'the explicitly supplied real node failed its live probe',
    async () => {
      const previous = await client.json('/api/control/gateway/ports')
      const port = previous.items[0]
      const preview = await client.json(
        '/api/control/gateway/imports/preview',
        {
          method: 'POST',
          body: { content },
        },
      )
      const nodeId = preview.nodes?.[0]?.id
      if (preview.validCount < 1 || typeof nodeId !== 'string')
        throw new Error('real node preview failed')
      await client.json('/api/control/gateway/imports/apply', {
        method: 'POST',
        body: { previewId: preview.previewId },
      })
      let changed = false
      try {
        await client.json('/api/control/gateway/ports/1', {
          method: 'PUT',
          body: { hops: [{ mode: 'manual', nodeIds: [nodeId] }] },
          timeoutMs: 45_000,
        })
        changed = true
        const result = await client.json(
          `/api/control/gateway/nodes/${encodeURIComponent(nodeId)}/test`,
          { method: 'POST', timeoutMs: 15_000 },
        )
        if (result.reachable !== true) throw new Error('real node probe failed')
      } finally {
        if (changed) {
          await client.json('/api/control/gateway/ports/1', {
            method: 'PUT',
            body: {
              enabled: port.enabled,
              credentialIds: port.credentialIds,
              hops: port.hops,
            },
            timeoutMs: 45_000,
          })
        }
      }
    },
  )
}

async function beforeRestart(options, reporter) {
  const adminPassword = requiredSecret('SMOKE_ADMIN_PASSWORD')
  const boundPassword = requiredSecret('SMOKE_BOUND_PASSWORD')
  const unboundPassword = requiredSecret('SMOKE_UNBOUND_PASSWORD')
  const client = new ApiClient(options.timeoutMs)
  await authenticate(client, reporter, adminPassword)
  const nodeIds = await importUnreachableNodes(client, reporter)
  const credentialId = await createCredentials(
    client,
    reporter,
    boundPassword,
    unboundPassword,
  )
  await configurePorts(client, reporter, nodeIds, credentialId)
  await verifyAuthentication(
    reporter,
    boundPassword,
    unboundPassword,
    Math.min(options.timeoutMs, 5_000),
  )
  await verifyIpv6Rejected(
    reporter,
    'before-restart',
    Math.min(options.timeoutMs, 1_500),
  )
  await verifyFailClosed(
    reporter,
    boundPassword,
    Math.min(options.timeoutMs, 8_000),
  )
  await verifyRollback(client, reporter, nodeIds, credentialId, boundPassword)
  await verifyOptionalRealNode(client, reporter)
}

async function afterRestart(options, reporter) {
  const adminPassword = requiredSecret('SMOKE_ADMIN_PASSWORD')
  const boundPassword = requiredSecret('SMOKE_BOUND_PASSWORD')
  const unboundPassword = requiredSecret('SMOKE_UNBOUND_PASSWORD')
  const client = new ApiClient(options.timeoutMs)
  await reporter.check(
    'restart-persistence',
    'nodes, accounts, routes and ten listeners persist after restart',
    'gateway state or listeners did not persist after restart',
    async () => {
      await client.login(adminPassword)
      const [nodes, credentials, ports, status] = await Promise.all([
        client.json('/api/control/gateway/nodes'),
        client.json('/api/control/gateway/credentials'),
        client.json('/api/control/gateway/ports'),
        client.json('/api/control/gateway/status'),
      ])
      const nodeIds = UNREACHABLE_NAMES.map(
        (name) => nodes.items.find((node) => node.name === name)?.id,
      )
      const bound = credentials.items.find(
        (credential) => credential.username === BOUND_USERNAME,
      )
      const unbound = credentials.items.find(
        (credential) => credential.username === UNBOUND_USERNAME,
      )
      if (
        nodeIds.some((id) => typeof id !== 'string') ||
        !bound ||
        !unbound ||
        !sameJson(
          bound.portIds,
          Array.from({ length: 10 }, (_, i) => i + 1),
        ) ||
        !sameJson(unbound.portIds, [])
      )
        throw new Error('persisted resources are missing')
      assertPortStructures(ports.items, nodeIds, bound.id)
      if (
        status.services?.mihomo?.controllerReachable !== true ||
        status.listeners?.filter((listener) => listener.reachable === true)
          .length !== 10
      )
        throw new Error('persisted listeners are not reachable')
      for (const port of GATEWAY_PORTS)
        await expectAuth(
          port,
          BOUND_USERNAME,
          boundPassword,
          true,
          Math.min(options.timeoutMs, 5_000),
        )
      await expectAuth(
        GATEWAY_PORTS[0],
        UNBOUND_USERNAME,
        unboundPassword,
        false,
        Math.min(options.timeoutMs, 5_000),
      )
    },
  )
  await verifyIpv6Rejected(
    reporter,
    'after-restart',
    Math.min(options.timeoutMs, 1_500),
  )
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }
  const reporter = new Reporter(options.evidence)
  try {
    if (options.phase === 'preflight') await runPreflight(reporter)
    else if (options.phase === 'wait-health') {
      const client = new ApiClient(options.timeoutMs)
      await reporter.check(
        'gateway-health',
        'the loopback health endpoint is ready',
        'the loopback health endpoint did not become ready',
        () => waitForHealth(client, options.timeoutMs),
      )
    } else if (options.phase === 'before-restart') {
      await beforeRestart(options, reporter)
    } else if (options.phase === 'after-restart') {
      await afterRestart(options, reporter)
    }
  } catch (error) {
    if (error instanceof SmokeNotRun) process.exitCode = 2
    else {
      const check = error instanceof SmokeFailure ? error.check : options.phase
      process.stderr.write(`fail: smoke phase stopped at ${check}\n`)
      process.exitCode = 1
    }
  }
}

await main()
