import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createApp,
  createError,
  defineEventHandler,
  getHeader,
  readBody,
  setResponseHeader,
  toNodeListener,
} from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetAuthForTests } from '../../lib/auth'
import serverPackage from '../../package.json'

const agentState = vi.hoisted(() => ({
  current: undefined as unknown,
}))

vi.mock('../../lib/supervisor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/supervisor')>()
  return {
    ...actual,
    getAgent: () => agentState.current,
  }
})

interface ForwardedRequest {
  method: string
  path: string
  cookie?: string
  csrf?: string
  authorization?: string
  body: unknown
}

const forwarded: ForwardedRequest[] = []
const agentStatus = vi.fn(async () => makeAgentStatus())
const agentRouter = createApp()

agentRouter.use(
  defineEventHandler(async (event) => {
    const path = event.path.split('?')[0] ?? event.path
    if (
      path.startsWith('/api/control/gateway/') &&
      (event.method === 'PUT' || event.method === 'POST')
    ) {
      const body = await readBody(event)
      if ((body as { marker?: string } | undefined)?.marker === 'slow')
        await new Promise((resolve) => setTimeout(resolve, 20))
      forwarded.push({
        method: event.method,
        path,
        cookie: getHeader(event, 'cookie'),
        csrf: getHeader(event, 'x-csrf-token'),
        authorization: getHeader(event, 'authorization'),
        body,
      })
      if (
        path === '/api/control/gateway/credentials' &&
        event.method === 'POST'
      ) {
        setResponseHeader(event, 'cache-control', 'no-store')
        return { id: 'credential-1', password: 'one-time-password' }
      }
      return { ok: true, body }
    }
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }),
)

agentState.current = {
  router: agentRouter,
  gateway: { status: agentStatus },
}

function makeAgentStatus() {
  return {
    services: {
      agent: { state: 'running', health: 'healthy' },
      mihomo: {
        state: 'running',
        health: 'healthy',
        controllerReachable: true,
      },
    },
    versions: { agent: 'agent-test-version', mihomo: 'mihomo-test-version' },
    listeners: [
      {
        id: 1,
        port: 10_001,
        enabled: true,
        health: 'healthy',
        reachable: true,
        errorCode: null,
      },
    ],
    ports: [
      {
        id: 1,
        port: 10_001,
        enabled: true,
        health: 'healthy',
        hops: [
          {
            index: 1,
            mode: 'manual',
            activeNodeId: 'node-safe-id',
            health: 'healthy',
          },
        ],
      },
    ],
    lastApply: {
      result: 'success',
      at: 100,
      reason: 'gateway.reapply',
      errorCode: null,
    },
    secret: 'agent-status-secret-canary',
    token: 'agent-status-token-canary',
  }
}

async function start() {
  const [
    { default: authRoute },
    { default: authMiddleware },
    { default: control },
  ] = await Promise.all([
    import('../api/auth/[...]'),
    import('../../middleware/auth'),
    import('../api/control/[...]'),
  ])
  const app = createApp()
  app.use(
    defineEventHandler((event) =>
      event.path.startsWith('/api/auth/') ? authRoute(event) : undefined,
    ),
  )
  app.use(authMiddleware)
  app.use(
    defineEventHandler((event) =>
      event.path.startsWith('/api/control/') ? control(event) : undefined,
    ),
  )
  const server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('test server did not bind')
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
  }
}

async function login(base: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'a-strong-admin-password' }),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { csrfToken: string }
  return {
    cookie: (response.headers.get('set-cookie') ?? '').split(';', 1)[0]!,
    csrf: body.csrfToken,
  }
}

describe('authenticated Server gateway integration', () => {
  const original = { ...process.env }
  let running: Awaited<ReturnType<typeof start>> | undefined

  beforeEach(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mcxd-server-gateway-'))
    process.env.ADMIN_PASSWORD = 'a-strong-admin-password'
    process.env.GATEWAY_MASTER_KEY = 'test-master-key'
    process.env.SESSION_COOKIE_SECURE = 'false'
    process.env.CONTROL_TOKEN = 'must-not-reach-agent-canary'
    __resetAuthForTests()
    forwarded.length = 0
    agentStatus.mockClear()
    running = await start()
  })

  afterEach(async () => {
    if (running)
      await new Promise<void>((resolve) =>
        running!.server.close(() => resolve()),
      )
    running = undefined
    process.env = { ...original }
    __resetAuthForTests()
  })

  it('rejects gateway status without an administrator session', async () => {
    const response = await fetch(`${running!.base}/api/control/gateway/status`)

    expect(response.status).toBe(401)
    expect(agentStatus).not.toHaveBeenCalled()
  })

  it('rejects gateway mutations with missing or incorrect CSRF', async () => {
    const auth = await login(running!.base)
    const request = (csrf?: string) =>
      fetch(`${running!.base}/api/control/gateway/ports/1`, {
        method: 'PUT',
        headers: {
          cookie: auth.cookie,
          'content-type': 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({ enabled: true }),
      })

    expect((await request()).status).toBe(403)
    expect((await request('wrong-csrf-token')).status).toBe(403)
    expect(forwarded).toEqual([])
  })

  it('adds only the Web service and version to the safe Agent status projection', async () => {
    const auth = await login(running!.base)
    const response = await fetch(
      `${running!.base}/api/control/gateway/status`,
      { headers: { cookie: auth.cookie } },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual([
      'lastApply',
      'listeners',
      'ports',
      'services',
      'versions',
    ])
    expect(body.services).toEqual({
      agent: makeAgentStatus().services.agent,
      mihomo: makeAgentStatus().services.mihomo,
      web: { state: 'running', health: 'healthy' },
    })
    expect(body.versions).toEqual({
      agent: 'agent-test-version',
      mihomo: 'mihomo-test-version',
      web: serverPackage.version,
    })
    expect(body.listeners).toEqual(makeAgentStatus().listeners)
    expect(body.ports).toEqual(makeAgentStatus().ports)
    expect(body.lastApply).toEqual(makeAgentStatus().lastApply)
    expect(agentStatus).toHaveBeenCalledOnce()
    expect(JSON.stringify(body)).not.toMatch(
      /agent-status-secret-canary|agent-status-token-canary|must-not-reach-agent-canary/,
    )
  })

  it('maps a sensitive manager status failure to a fixed safe 500', async () => {
    const auth = await login(running!.base)
    agentStatus.mockRejectedValueOnce(
      new Error(
        'GET https://private.invalid/?secret=manager-status-secret-canary',
      ),
    )

    const response = await fetch(
      `${running!.base}/api/control/gateway/status`,
      { headers: { cookie: auth.cookie } },
    )

    expect(response.status).toBe(500)
    const rendered = await response.text()
    expect(rendered).toContain('Gateway status unavailable')
    expect(rendered).not.toMatch(
      /private\.invalid|manager-status-secret-canary/,
    )
  })

  it('forwards legal mutations without browser session material or CONTROL_TOKEN', async () => {
    const auth = await login(running!.base)
    const response = await fetch(
      `${running!.base}/api/control/gateway/ports/1`,
      {
        method: 'PUT',
        headers: {
          cookie: auth.cookie,
          'content-type': 'application/json',
          'x-csrf-token': auth.csrf,
          authorization: 'Bearer browser-authorization-canary',
        },
        body: JSON.stringify({ enabled: true }),
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      body: { enabled: true },
    })
    expect(forwarded).toEqual([
      {
        method: 'PUT',
        path: '/api/control/gateway/ports/1',
        cookie: undefined,
        csrf: undefined,
        authorization: undefined,
        body: { enabled: true },
      },
    ])
  })

  it('preserves no-store on a proxied one-time password response', async () => {
    const auth = await login(running!.base)
    const response = await fetch(
      `${running!.base}/api/control/gateway/credentials`,
      {
        method: 'POST',
        headers: {
          cookie: auth.cookie,
          'content-type': 'application/json',
          'x-csrf-token': auth.csrf,
        },
        body: JSON.stringify({ username: 'alice' }),
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      id: 'credential-1',
      password: 'one-time-password',
    })
  })

  it('keeps concurrent PUT request bodies independent', async () => {
    const auth = await login(running!.base)
    const put = (body: Record<string, unknown>) =>
      fetch(`${running!.base}/api/control/gateway/ports/1`, {
        method: 'PUT',
        headers: {
          cookie: auth.cookie,
          'content-type': 'application/json',
          'x-csrf-token': auth.csrf,
        },
        body: JSON.stringify(body),
      }).then(async (response) => ({
        status: response.status,
        body: (await response.json()) as unknown,
      }))

    const [slow, fast] = await Promise.all([
      put({ marker: 'slow', enabled: true }),
      put({ marker: 'fast', enabled: false }),
    ])

    expect(slow).toEqual({
      status: 200,
      body: { ok: true, body: { marker: 'slow', enabled: true } },
    })
    expect(fast).toEqual({
      status: 200,
      body: { ok: true, body: { marker: 'fast', enabled: false } },
    })
    expect(forwarded.map(({ body }) => body)).toEqual([
      { marker: 'fast', enabled: false },
      { marker: 'slow', enabled: true },
    ])
  })
})
