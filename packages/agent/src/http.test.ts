import type { AddressInfo } from 'node:net'
import type { KernelState, ProfileMeta } from './types'
import { Buffer } from 'node:buffer'
import { mkdtempSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toNodeListener } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayValidationError } from './gateway'
import { createControlRouter } from './http'
import { ProfileEditorConflictError } from './profile-editor'
import { SubscriptionFetchError } from './profiles'
import { TunPreconditionError } from './tun'

function fakeState(over: Partial<KernelState> = {}): KernelState {
  return {
    status: 'stopped',
    externalController: '127.0.0.1:9090',
    secret: 'sek',
    ...over,
  }
}

function makeSystemProxy(enabled = false) {
  return {
    isEnabled: vi.fn(async () => enabled),
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    setAutoProxy: vi.fn(async () => {}),
    disableAutoProxy: vi.fn(async () => {}),
    describe: vi.fn(() => ({ port: 7890, bypass: ['localhost', '127.0.0.1'] })),
  }
}

function makeDeps(token?: string) {
  const state = fakeState()
  const supervisor = {
    getState: vi.fn(() => state),
    start: vi.fn(async () =>
      fakeState({ status: 'running', pid: 1, version: '1.19.27' }),
    ),
    stop: vi.fn(async () => fakeState({ status: 'stopped' })),
    restart: vi.fn(async () => fakeState({ status: 'running', pid: 2 })),
    validate: vi.fn(async () => ({ valid: true, message: 'ok' })),
    on: vi.fn(),
    off: vi.fn(),
    dispose: vi.fn(),
  }
  const profileList: ProfileMeta[] = [
    { id: 'p1', name: 'home', type: 'local', updatedAt: 1 },
  ]
  const profiles = {
    list: vi.fn(async () => profileList),
    read: vi.fn(async () => 'mixed-port: 7890\n'),
    create: vi.fn(async (i: { name: string }) => ({
      id: 'p2',
      name: i.name,
      type: 'local' as const,
      updatedAt: 2,
    })),
    update: vi.fn(async () => ({
      id: 'p1',
      name: 'x',
      type: 'local' as const,
      updatedAt: 3,
    })),
    delete: vi.fn(async () => {}),
    duplicate: vi.fn(async () => ({
      id: 'p3',
      name: 'home copy',
      type: 'local' as const,
      updatedAt: 4,
    })),
    importFromUrl: vi.fn(async () => ({
      id: 'p4',
      name: 'sub',
      type: 'remote' as const,
      updatedAt: 5,
    })),
    refresh: vi.fn(async (id: string) => ({
      id,
      name: 'sub',
      type: 'remote' as const,
      url: 'https://sub',
      updatedAt: 6,
      subscriptionInfo: {
        upload: 1,
        download: 2,
        total: 3,
        expire: 4,
      },
    })),
    getActiveId: vi.fn(async (): Promise<string | undefined> => undefined),
    setActive: vi.fn(async () => {}),
    rollback: vi.fn(async () => true),
    resetActive: vi.fn(async () => {}),
    getSection: vi.fn(async (): Promise<unknown> => null),
    setSection: vi.fn(async () => {}),
  }
  const info = vi.fn(() => ({
    hasAgent: true,
    version: '0.0.0',
    platform: { os: 'linux', arch: 'x64' },
    kernel: { bundled: true, path: '/bin/mihomo', version: '1.19.27' },
    features: ['profiles', 'logs-sse', 'kernel-control'],
  }))
  const homeDir = mkdtempSync(join(tmpdir(), 'mcxd-http-'))
  const activeConfigPath = join(homeDir, 'active.yaml')
  return { supervisor, profiles, info, homeDir, activeConfigPath, token }
}

async function mount(deps: ReturnType<typeof makeDeps>) {
  const app = createControlRouter(deps as never)
  const server = createServer(toNodeListener(app))
  let port = 0
  // Windows can allocate port 6000 for listen(0), which WHATWG fetch rejects
  // as an unsafe port before the request reaches this local test server.
  // Retry the blocked ports that can occur in an unprivileged ephemeral range.
  const blockedPorts = new Set([
    1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6697, 10080,
  ])
  do {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
    if (blockedPorts.has(port) || (port >= 6665 && port <= 6669)) {
      await new Promise<void>((r) => server.close(() => r()))
    }
  } while (blockedPorts.has(port) || (port >= 6665 && port <= 6669))
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

function makeGatewayDeps() {
  const gateway = {
    listPorts: vi.fn(async () => [
      {
        id: 1,
        port: 10_001,
        enabled: false,
        credentialIds: [],
        hops: [],
      },
    ]),
    updatePort: vi.fn(async (id: number, input: object) => ({
      id,
      port: 10_000 + id,
      enabled: false,
      credentialIds: [],
      hops: [],
      ...input,
    })),
    listNodes: vi.fn(async () => [
      { id: 'node-1', name: 'safe-node', type: 'socks5', enabled: true },
    ]),
    updateNode: vi.fn(async (id: string, input: { enabled: boolean }) => ({
      id,
      name: 'safe-node',
      type: 'socks5',
      enabled: input.enabled,
    })),
    testNode: vi.fn(async () => ({ reachable: true, latencyMs: 8 })),
    nodeImpact: vi.fn(async () => ({ affectedPortIds: [1] })),
    deleteNode: vi.fn(async () => undefined),
    listCredentials: vi.fn(async () => [
      {
        id: 'credential-1',
        username: 'alice',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        portIds: [1],
      },
    ]),
    createCredential: vi.fn(async () => ({
      id: 'credential-2',
      username: 'bob',
      enabled: true,
      createdAt: 2,
      updatedAt: 2,
      portIds: [1, 2],
      password: 'one-time-password',
    })),
    updateCredential: vi.fn(async (id: string) => ({
      id,
      username: 'bob',
      enabled: false,
      createdAt: 2,
      updatedAt: 3,
      portIds: [],
    })),
    deleteCredential: vi.fn(async () => undefined),
    rotateCredential: vi.fn(async (id: string) => ({
      id,
      password: 'rotated-one-time-password',
    })),
    status: vi.fn(async () => ({
      services: {
        agent: { state: 'running', health: 'healthy' },
        mihomo: {
          state: 'stopped',
          health: 'unknown',
          controllerReachable: false,
        },
      },
      versions: { agent: '0.0.0', mihomo: null },
      listeners: [],
      ports: [],
      lastApply: null,
    })),
    reapply: vi.fn(async () => undefined),
    listRevisions: vi.fn(async () => [
      { id: 'revision-1', createdAt: 1, reason: 'gateway.bootstrap' },
    ]),
  }
  const gatewaySubscriptions = {
    previewImport: vi.fn(() => ({
      previewId: 'preview-1',
      format: 'yaml',
      validCount: 1,
      skippedCount: 0,
      protocolCounts: { socks5: 1 },
      errors: [],
      issues: [],
      nodes: [{ id: 'node-1', name: 'safe-node', type: 'socks5' }],
    })),
    applyImport: vi.fn(async () => ({ imported: 1, gateway: { ok: true } })),
    list: vi.fn(async () => [
      {
        id: 'subscription-1',
        name: 'safe-subscription',
        urlMasked: 'https://example.invalid/***',
        intervalMinutes: 60,
        enabled: true,
        nodeCount: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
    create: vi.fn(async () => ({
      id: 'subscription-2',
      name: 'created',
      urlMasked: 'https://example.invalid/***',
      intervalMinutes: 30,
      enabled: true,
      nodeCount: 1,
      createdAt: 2,
      updatedAt: 2,
    })),
    update: vi.fn(async (id: string) => ({
      id,
      name: 'updated',
      urlMasked: 'https://example.invalid/***',
      intervalMinutes: 45,
      enabled: false,
      nodeCount: 1,
      createdAt: 2,
      updatedAt: 3,
    })),
    delete: vi.fn(async () => undefined),
    sync: vi.fn(async (id: string) => ({
      id,
      name: 'synced',
      urlMasked: 'https://example.invalid/***',
      intervalMinutes: 45,
      enabled: true,
      nodeCount: 2,
      createdAt: 2,
      updatedAt: 4,
    })),
    refreshSubscriptions: vi.fn(async () => ({
      items: [{ id: 'subscription-1', ok: true, nodeCount: 2 }],
    })),
  }
  return { ...makeDeps(), gateway, gatewaySubscriptions }
}

describe('createControlRouter — info + kernel + auth', () => {
  let srv: Awaited<ReturnType<typeof mount>>
  afterEach(async () => srv?.close())

  it('gET /api/control/health is public 200', async () => {
    srv = await mount(makeDeps('tok'))
    const res = await fetch(`${srv.base}/api/control/health`)
    expect(res.status).toBe(200)
  })

  it('gET /api/control/info returns the capability shape', async () => {
    srv = await mount(makeDeps())
    const res = await fetch(`${srv.base}/api/control/info`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.hasAgent).toBe(true)
    expect(body.features).toContain('kernel-control')
    expect(body.platform).toMatchObject({ os: 'linux', arch: 'x64' })
  })

  it('protected route returns 401 without Bearer when token set', async () => {
    srv = await mount(makeDeps('tok'))
    const res = await fetch(`${srv.base}/api/control/kernel/status`)
    expect(res.status).toBe(401)
  })

  it('protected route returns 200 with correct Bearer', async () => {
    srv = await mount(makeDeps('tok'))
    const res = await fetch(`${srv.base}/api/control/kernel/status`, {
      headers: { Authorization: 'Bearer tok' },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).status).toBe(
      'stopped',
    )
  })

  it('wrong Bearer returns 401', async () => {
    srv = await mount(makeDeps('tok'))
    const res = await fetch(`${srv.base}/api/control/kernel/status`, {
      headers: { Authorization: 'Bearer nope' },
    })
    expect(res.status).toBe(401)
  })

  it('no token configured (in-process) skips auth', async () => {
    srv = await mount(makeDeps())
    const res = await fetch(`${srv.base}/api/control/kernel/status`)
    expect(res.status).toBe(200)
  })

  it('pOST kernel start/stop/restart return KernelState', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const start = await fetch(`${srv.base}/api/control/kernel/start`, {
      method: 'POST',
    })
    expect(((await start.json()) as Record<string, unknown>).status).toBe(
      'running',
    )
    expect(deps.supervisor.start).toHaveBeenCalledOnce()

    const stop = await fetch(`${srv.base}/api/control/kernel/stop`, {
      method: 'POST',
    })
    expect(((await stop.json()) as Record<string, unknown>).status).toBe(
      'stopped',
    )

    const restart = await fetch(`${srv.base}/api/control/kernel/restart`, {
      method: 'POST',
    })
    expect(((await restart.json()) as Record<string, unknown>).status).toBe(
      'running',
    )
  })

  it('projects secret and lastError out of every legacy KernelState response', async () => {
    const deps = makeDeps()
    const unsafe = fakeState({
      status: 'running',
      secret: 'kernel-secret-canary',
      lastError: 'https://private.invalid/?password=kernel-error-canary',
    }) as ReturnType<typeof fakeState> & { futureDiagnostic: string }
    unsafe.futureDiagnostic = 'future-kernel-canary'
    deps.supervisor.getState.mockReturnValue(unsafe)
    deps.supervisor.start.mockResolvedValue(unsafe)
    deps.supervisor.stop.mockResolvedValue(unsafe)
    deps.supervisor.restart.mockResolvedValue(unsafe)
    deps.profiles.getActiveId.mockResolvedValue('p1')
    srv = await mount(deps)

    const requests: Array<Promise<Response>> = [
      fetch(`${srv.base}/api/control/kernel/status`),
      fetch(`${srv.base}/api/control/kernel/start`, { method: 'POST' }),
      fetch(`${srv.base}/api/control/kernel/stop`, { method: 'POST' }),
      fetch(`${srv.base}/api/control/kernel/restart`, { method: 'POST' }),
      fetch(`${srv.base}/api/control/kernel/rollback`, { method: 'POST' }),
      fetch(`${srv.base}/api/control/kernel/recover`, { method: 'POST' }),
      fetch(`${srv.base}/api/control/profiles/p1/activate`, { method: 'POST' }),
      fetch(`${srv.base}/api/control/profiles/p1/refresh-and-activate`, {
        method: 'POST',
      }),
      fetch(`${srv.base}/api/control/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'mode: rule' }),
      }),
      fetch(`${srv.base}/api/control/config/section`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'mode', value: 'rule' }),
      }),
    ]
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(200)
      expect(await response.text()).not.toMatch(
        /kernel-secret-canary|private\.invalid|kernel-error-canary|future-kernel-canary|futureDiagnostic|lastError|"secret"/,
      )
    }
  })
})

describe('createControlRouter — gateway API contract', () => {
  let srv: Awaited<ReturnType<typeof mount>>
  afterEach(async () => srv?.close())

  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${srv.base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    })
  }

  it('maps fixed ports and node operations under the only gateway prefix', async () => {
    const deps = makeGatewayDeps()
    srv = await mount(deps as never)

    const ports = await request('/api/control/gateway/ports')
    expect(await ports.json()).toEqual({
      items: [
        {
          id: 1,
          port: 10_001,
          enabled: false,
          credentialIds: [],
          hops: [],
        },
      ],
    })

    const portBody = {
      enabled: true,
      credentialIds: ['credential-1'],
      hops: [{ mode: 'manual', nodeIds: ['node-1'] }],
    }
    expect(
      (await request('/api/control/gateway/ports/2', 'PUT', portBody)).status,
    ).toBe(200)
    expect(deps.gateway.updatePort).toHaveBeenCalledWith(2, portBody)

    expect(await (await request('/api/control/gateway/nodes')).json()).toEqual({
      items: [
        { id: 'node-1', name: 'safe-node', type: 'socks5', enabled: true },
      ],
    })
    await request('/api/control/gateway/nodes/node-1', 'PUT', {
      enabled: false,
    })
    expect(deps.gateway.updateNode).toHaveBeenCalledWith('node-1', {
      enabled: false,
    })

    expect(
      await (
        await request('/api/control/gateway/nodes/node-1/test', 'POST')
      ).json(),
    ).toEqual({ reachable: true, latencyMs: 8 })
    expect(deps.gateway.testNode).toHaveBeenCalledWith('node-1')

    expect(
      await (await request('/api/control/gateway/nodes/node-1/impact')).json(),
    ).toEqual({ affectedPortIds: [1] })
    expect(deps.gateway.nodeImpact).toHaveBeenCalledWith('node-1')

    const deleted = await request(
      '/api/control/gateway/nodes/node-1',
      'DELETE',
      { confirmed: true },
    )
    expect(deleted.status).toBe(204)
    expect(await deleted.text()).toBe('')
    expect(deps.gateway.deleteNode).toHaveBeenCalledWith('node-1', true)
  })

  it('maps imports and every subscription operation under gateway', async () => {
    const deps = makeGatewayDeps()
    srv = await mount(deps as never)

    const preview = await request(
      '/api/control/gateway/imports/preview',
      'POST',
      { content: 'proxies: []' },
    )
    expect(preview.status).toBe(200)
    expect(deps.gatewaySubscriptions.previewImport).toHaveBeenCalledWith(
      'proxies: []',
    )

    await request('/api/control/gateway/imports/apply', 'POST', {
      previewId: 'preview-1',
    })
    expect(deps.gatewaySubscriptions.applyImport).toHaveBeenCalledWith({
      previewId: 'preview-1',
    })

    expect(
      await (await request('/api/control/gateway/subscriptions')).json(),
    ).toEqual({ items: await deps.gatewaySubscriptions.list() })

    const createBody = {
      name: 'created',
      url: 'https://subscription.invalid/nodes',
      intervalMinutes: 30,
      enabled: true,
    }
    await request('/api/control/gateway/subscriptions', 'POST', createBody)
    expect(deps.gatewaySubscriptions.create).toHaveBeenCalledWith(createBody)

    const updateBody = {
      name: 'updated',
      intervalMinutes: 45,
      enabled: false,
    }
    await request(
      '/api/control/gateway/subscriptions/subscription-1',
      'PUT',
      updateBody,
    )
    expect(deps.gatewaySubscriptions.update).toHaveBeenCalledWith(
      'subscription-1',
      updateBody,
    )

    const synced = await request(
      '/api/control/gateway/subscriptions/subscription-1/sync',
      'POST',
    )
    expect(synced.status).toBe(200)
    expect(deps.gatewaySubscriptions.sync).toHaveBeenCalledWith(
      'subscription-1',
    )

    const refreshed = await request(
      '/api/control/gateway/subscriptions/refresh',
      'POST',
    )
    expect(await refreshed.json()).toEqual({
      items: [{ id: 'subscription-1', ok: true, nodeCount: 2 }],
    })
    expect(
      deps.gatewaySubscriptions.refreshSubscriptions,
    ).toHaveBeenCalledOnce()

    const deleted = await request(
      '/api/control/gateway/subscriptions/subscription-1',
      'DELETE',
    )
    expect(deleted.status).toBe(204)
    expect(deps.gatewaySubscriptions.delete).toHaveBeenCalledWith(
      'subscription-1',
    )
  })

  it('maps credentials, status, reapply and read-only revisions', async () => {
    const deps = makeGatewayDeps()
    srv = await mount(deps as never)

    expect(
      await (await request('/api/control/gateway/credentials')).json(),
    ).toEqual({ items: await deps.gateway.listCredentials() })

    const created = await request('/api/control/gateway/credentials', 'POST', {
      username: 'bob',
      password: 'provided-password',
      enabled: true,
      portIds: [1, 2],
    })
    expect(created.headers.get('cache-control')).toBe('no-store')
    expect((await created.json()) as object).toMatchObject({
      password: 'one-time-password',
    })
    expect(deps.gateway.createCredential).toHaveBeenCalledWith({
      username: 'bob',
      password: 'provided-password',
      enabled: true,
      portIds: [1, 2],
    })

    await request('/api/control/gateway/credentials/credential-1', 'PUT', {
      username: 'renamed',
      enabled: false,
      portIds: [],
    })
    expect(deps.gateway.updateCredential).toHaveBeenCalledWith('credential-1', {
      username: 'renamed',
      enabled: false,
      portIds: [],
    })

    const rotated = await request(
      '/api/control/gateway/credentials/credential-1/rotate',
      'POST',
      {},
    )
    expect(rotated.headers.get('cache-control')).toBe('no-store')
    expect((await rotated.json()) as object).toMatchObject({
      password: 'rotated-one-time-password',
    })
    expect(deps.gateway.rotateCredential).toHaveBeenCalledWith(
      'credential-1',
      undefined,
    )

    const deleted = await request(
      '/api/control/gateway/credentials/credential-1',
      'DELETE',
    )
    expect(deleted.status).toBe(204)

    expect((await request('/api/control/gateway/status')).status).toBe(200)
    expect(deps.gateway.status).toHaveBeenCalledOnce()

    expect(
      await (await request('/api/control/gateway/reapply', 'POST')).json(),
    ).toEqual({ ok: true })
    expect(deps.gateway.reapply).toHaveBeenCalledOnce()

    expect(
      await (await request('/api/control/gateway/revisions')).json(),
    ).toEqual({ items: await deps.gateway.listRevisions() })
  })

  it('rejects invalid JSON types instead of coercing truthy strings', async () => {
    const deps = makeGatewayDeps()
    srv = await mount(deps as never)
    const cases: Array<[string, string, unknown]> = [
      ['/api/control/gateway/ports/1', 'PUT', { enabled: 'false' }],
      ['/api/control/gateway/ports/1', 'PUT', { port: 10_001 }],
      ['/api/control/gateway/ports/1', 'PUT', { hops: [{ mode: 'auto' }] }],
      ['/api/control/gateway/nodes/node-1', 'PUT', { enabled: 'false' }],
      ['/api/control/gateway/nodes/node-1', 'DELETE', { confirmed: 'false' }],
      ['/api/control/gateway/imports/preview', 'POST', { content: 42 }],
      [
        '/api/control/gateway/subscriptions',
        'POST',
        { name: 'x', url: 'https://example.invalid', enabled: 'false' },
      ],
      [
        '/api/control/gateway/credentials',
        'POST',
        { username: 'x', portIds: ['1'] },
      ],
      [
        '/api/control/gateway/credentials/credential-1/rotate',
        'POST',
        { password: false },
      ],
      ['/api/control/gateway/credentials/credential-1/rotate', 'POST', null],
      ['/api/control/gateway/imports/apply', 'POST', {}],
      [
        '/api/control/gateway/imports/apply',
        'POST',
        { previewId: 'preview-1', content: 'proxies: []' },
      ],
    ]

    for (const [path, method, body] of cases) {
      const response = await request(path, method, body)
      expect(response.status, `${method} ${path}`).toBe(400)
      expect(await response.text()).not.toContain('example.invalid')
    }
    const malformed = await fetch(`${srv.base}/api/control/gateway/ports/1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.text()).not.toContain('not-json')
    expect(deps.gateway.updatePort).not.toHaveBeenCalled()
    expect(deps.gateway.updateNode).not.toHaveBeenCalled()
    expect(deps.gateway.deleteNode).not.toHaveBeenCalled()
    expect(deps.gateway.createCredential).not.toHaveBeenCalled()
    expect(deps.gateway.rotateCredential).not.toHaveBeenCalled()
    expect(deps.gatewaySubscriptions.previewImport).not.toHaveBeenCalled()
    expect(deps.gatewaySubscriptions.applyImport).not.toHaveBeenCalled()
    expect(deps.gatewaySubscriptions.create).not.toHaveBeenCalled()
  })

  it('whitelists 409 details and fixes unknown gateway/subscription errors', async () => {
    const deps = makeGatewayDeps()
    deps.gateway.deleteNode.mockRejectedValueOnce(
      new GatewayValidationError('node deletion requires confirmation', 409, {
        affectedPortIds: [2, 1],
        rawProxy: 'proxy-secret-canary',
        url: 'https://private.invalid/nodes',
      } as never),
    )
    srv = await mount(deps as never)

    const conflict = await request(
      '/api/control/gateway/nodes/node-1',
      'DELETE',
      { confirmed: false },
    )
    expect(conflict.status).toBe(409)
    const conflictText = await conflict.text()
    expect(JSON.parse(conflictText) as object).toMatchObject({
      data: {
        error: 'node deletion requires confirmation',
        affectedPortIds: [2, 1],
      },
    })
    expect(conflictText).not.toMatch(/rawProxy|private\.invalid|proxy-secret/)

    deps.gateway.listPorts.mockRejectedValueOnce(
      new Error('password=unknown-canary https://private.invalid/gateway'),
    )
    const unknown = await request('/api/control/gateway/ports')
    expect(unknown.status).toBe(500)
    expect(await unknown.text()).not.toMatch(/unknown-canary|private\.invalid/)

    deps.gateway.listNodes.mockRejectedValueOnce(
      new GatewayValidationError(
        'private-key: validation-canary at C:\\private\\candidate.yaml',
      ),
    )
    const unsafeValidation = await request('/api/control/gateway/nodes')
    expect(unsafeValidation.status).toBe(400)
    expect(await unsafeValidation.text()).not.toMatch(
      /validation-canary|private-key|candidate\.yaml|C:\\private/,
    )

    deps.gatewaySubscriptions.sync.mockRejectedValueOnce(
      new Error(
        'vless://subscription-secret Authorization: Bearer downstream-token',
      ),
    )
    const subscription = await request(
      '/api/control/gateway/subscriptions/subscription-1/sync',
      'POST',
    )
    expect(subscription.status).toBe(502)
    const subscriptionText = await subscription.text()
    expect(subscriptionText).toContain('subscription operation failed')
    expect(subscriptionText).not.toMatch(
      /vless|subscription-secret|downstream-token|Bearer/,
    )
  })

  it('strips unsafe downstream fields except the one-time password responses', async () => {
    const deps = makeGatewayDeps()
    deps.gateway.listPorts.mockResolvedValueOnce([
      {
        id: 1,
        port: 10_001,
        enabled: false,
        credentialIds: [],
        hops: [
          {
            mode: 'auto',
            nodeIds: ['node-1'],
            token: 'hop-token-canary',
          },
        ],
        rawDiagnostic: 'port-diagnostic-canary',
      },
    ] as never)
    deps.gateway.listNodes.mockResolvedValueOnce([
      {
        id: 'node-1',
        name: 'safe-node',
        type: 'socks5',
        enabled: true,
        password: 'node-password-canary',
        rawProxy: { server: '203.0.113.8' },
        config: 'mixed-port: 7890',
        diagnostic: 'Authorization: Bearer response-token-canary',
        token: 'node-token-canary',
        rawDiagnostic: 'node-diagnostic-canary',
      },
    ] as never)
    deps.gateway.testNode.mockResolvedValueOnce({
      reachable: false,
      errorCode: 'PROBE_FAILED',
      token: 'node-test-token-canary',
    } as never)
    deps.gateway.nodeImpact.mockResolvedValueOnce({
      affectedPortIds: [1],
      rawDiagnostic: 'impact-diagnostic-canary',
    } as never)
    deps.gateway.listCredentials.mockResolvedValueOnce([
      {
        id: 'credential-1',
        username: 'alice',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        portIds: [1],
        password: 'credential-password-canary',
        token: 'credential-token-canary',
        rawDiagnostic: 'credential-diagnostic-canary',
      },
    ] as never)
    deps.gateway.createCredential.mockResolvedValueOnce({
      id: 'credential-2',
      username: 'bob',
      enabled: true,
      createdAt: 2,
      updatedAt: 2,
      portIds: [1],
      password: 'one-time-password',
      token: 'create-token-canary',
      rawDiagnostic: 'create-diagnostic-canary',
    } as never)
    deps.gateway.listRevisions.mockResolvedValueOnce([
      {
        id: 'revision-1',
        createdAt: 1,
        reason: 'gateway.bootstrap',
        token: 'revision-token-canary',
      },
    ] as never)
    deps.gateway.status.mockResolvedValueOnce({
      services: {
        agent: {
          state: 'running',
          health: 'healthy',
          token: 'agent-status-token-canary',
        },
        mihomo: {
          state: 'running',
          health: 'healthy',
          controllerReachable: true,
          rawDiagnostic: 'mihomo-status-diagnostic-canary',
        },
      },
      versions: {
        agent: '0.0.0',
        mihomo: '1.19.27',
        token: 'version-token-canary',
      },
      listeners: [
        {
          id: 1,
          port: 10_001,
          enabled: true,
          health: 'healthy',
          reachable: true,
          errorCode: null,
          token: 'listener-token-canary',
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
              mode: 'auto',
              activeNodeId: 'node-1',
              health: 'healthy',
              rawDiagnostic: 'hop-status-diagnostic-canary',
            },
          ],
          token: 'port-status-token-canary',
        },
      ],
      lastApply: {
        result: 'success',
        at: 1,
        reason: 'gateway.reapply',
        errorCode: null,
        rawDiagnostic: 'apply-diagnostic-canary',
      },
      token: 'gateway-status-token-canary',
    } as never)
    deps.gatewaySubscriptions.list.mockResolvedValueOnce([
      {
        id: 'subscription-1',
        name: 'safe-subscription',
        urlMasked: 'https://example.invalid/***',
        url: 'https://private.invalid/raw',
        nodeCount: 1,
        enabled: true,
        intervalMinutes: 60,
        createdAt: 1,
        updatedAt: 1,
        token: 'subscription-token-canary',
        rawDiagnostic: 'subscription-diagnostic-canary',
      },
    ] as never)
    deps.gatewaySubscriptions.previewImport.mockReturnValueOnce({
      previewId: 'preview-1',
      format: 'yaml',
      validCount: 1,
      skippedCount: 1,
      protocolCounts: {
        socks5: 1,
        token: 'protocol-token-canary',
      },
      errors: ['vless://preview-error-canary'],
      issues: [
        {
          code: 'invalid-node',
          message: 'password=preview-message-canary',
          index: 2,
          rawDiagnostic: 'issue-diagnostic-canary',
        },
      ],
      nodes: [
        {
          id: 'node-1',
          name: 'safe-node',
          type: 'socks5',
          token: 'preview-node-token-canary',
        },
      ],
      rawDiagnostic: 'preview-diagnostic-canary',
    } as never)
    deps.gatewaySubscriptions.applyImport.mockResolvedValueOnce({
      imported: 1,
      gateway: { token: 'apply-gateway-token-canary' },
      rawDiagnostic: 'import-apply-diagnostic-canary',
    } as never)
    deps.gatewaySubscriptions.refreshSubscriptions.mockResolvedValueOnce({
      items: [
        {
          id: 'subscription-1',
          ok: false,
          nodeCount: 1,
          error: 'Authorization: Bearer refresh-token-canary',
          rawDiagnostic: 'refresh-diagnostic-canary',
        },
      ],
      token: 'refresh-result-token-canary',
    } as never)
    srv = await mount(deps as never)

    expect(await (await request('/api/control/gateway/ports')).json()).toEqual({
      items: [
        {
          id: 1,
          port: 10_001,
          enabled: false,
          credentialIds: [],
          hops: [{ mode: 'auto', nodeIds: ['node-1'] }],
        },
      ],
    })
    expect(await (await request('/api/control/gateway/nodes')).json()).toEqual({
      items: [
        { id: 'node-1', name: 'safe-node', type: 'socks5', enabled: true },
      ],
    })
    expect(
      await (
        await request('/api/control/gateway/nodes/node-1/test', 'POST')
      ).json(),
    ).toEqual({ reachable: false, errorCode: 'PROBE_FAILED' })
    expect(
      await (await request('/api/control/gateway/nodes/node-1/impact')).json(),
    ).toEqual({ affectedPortIds: [1] })
    expect(
      await (await request('/api/control/gateway/credentials')).json(),
    ).toEqual({
      items: [
        {
          id: 'credential-1',
          username: 'alice',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          portIds: [1],
        },
      ],
    })
    expect(
      await (await request('/api/control/gateway/revisions')).json(),
    ).toEqual({
      items: [{ id: 'revision-1', createdAt: 1, reason: 'gateway.bootstrap' }],
    })
    expect(await (await request('/api/control/gateway/status')).json()).toEqual(
      {
        services: {
          agent: { state: 'running', health: 'healthy' },
          mihomo: {
            state: 'running',
            health: 'healthy',
            controllerReachable: true,
          },
        },
        versions: { agent: '0.0.0', mihomo: '1.19.27' },
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
                mode: 'auto',
                activeNodeId: 'node-1',
                health: 'healthy',
              },
            ],
          },
        ],
        lastApply: {
          result: 'success',
          at: 1,
          reason: 'gateway.reapply',
          errorCode: null,
        },
      },
    )
    expect(
      await (await request('/api/control/gateway/subscriptions')).json(),
    ).toEqual({
      items: [
        {
          id: 'subscription-1',
          name: 'safe-subscription',
          urlMasked: 'https://example.invalid/***',
          intervalMinutes: 60,
          enabled: true,
          nodeCount: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    expect(
      await (
        await request('/api/control/gateway/imports/preview', 'POST', {
          content: 'proxies: []',
        })
      ).json(),
    ).toEqual({
      previewId: 'preview-1',
      format: 'yaml',
      validCount: 1,
      skippedCount: 1,
      protocolCounts: { socks5: 1 },
      errors: ['invalid node'],
      issues: [{ code: 'invalid-node', message: 'invalid node', index: 2 }],
      nodes: [{ id: 'node-1', name: 'safe-node', type: 'socks5' }],
    })
    expect(
      await (
        await request('/api/control/gateway/imports/apply', 'POST', {
          previewId: 'preview-1',
        })
      ).json(),
    ).toEqual({ imported: 1 })
    expect(
      await (
        await request('/api/control/gateway/subscriptions/refresh', 'POST')
      ).json(),
    ).toEqual({
      items: [
        {
          id: 'subscription-1',
          ok: false,
          nodeCount: 1,
          error: 'subscription refresh failed',
        },
      ],
    })

    const created = await request('/api/control/gateway/credentials', 'POST', {
      username: 'bob',
    })
    expect(await created.json()).toEqual({
      id: 'credential-2',
      username: 'bob',
      enabled: true,
      createdAt: 2,
      updatedAt: 2,
      portIds: [1],
      password: 'one-time-password',
    })
    expect(created.headers.get('cache-control')).toBe('no-store')
  })

  it('removes every legacy gateway, audit and runtime-config alias', async () => {
    srv = await mount(makeGatewayDeps() as never)
    const legacy: Array<[string, string]> = [
      ['/api/control/gateway', 'GET'],
      ['/api/control/gateway', 'PUT'],
      ['/api/control/gateway/outbound', 'PUT'],
      ['/api/control/import/preview', 'POST'],
      ['/api/control/import/apply', 'POST'],
      ['/api/control/subscriptions', 'GET'],
      ['/api/control/subscriptions/subscription-1/sync', 'POST'],
      ['/api/control/revisions', 'GET'],
      ['/api/control/revisions/revision-1/rollback', 'POST'],
      ['/api/control/audit', 'GET'],
      ['/api/control/config/runtime', 'GET'],
    ]
    for (const [path, method] of legacy) {
      expect((await request(path, method)).status, `${method} ${path}`).toBe(
        404,
      )
    }
  })
})

describe('createControlRouter — profiles + SSE', () => {
  let srv: Awaited<ReturnType<typeof mount>>
  afterEach(async () => srv?.close())

  it('gET /api/control/profiles returns ProfileMeta[]', async () => {
    srv = await mount(makeDeps())
    const res = await fetch(`${srv.base}/api/control/profiles`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown[]
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]).toMatchObject({ id: 'p1', name: 'home' })
  })

  it('pOST /api/control/profiles creates from {name, content?}', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'new', content: 'a: 1\n' }),
    })
    expect(res.status).toBe(200)
    expect(deps.profiles.create).toHaveBeenCalledWith({
      name: 'new',
      content: 'a: 1\n',
    })
    expect(((await res.json()) as Record<string, unknown>).name).toBe('new')
  })

  it('pOST /api/control/profiles passes through type for merge profiles', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'overlay',
        content: 'a: 1\n',
        type: 'merge',
      }),
    })
    expect(res.status).toBe(200)
    expect(deps.profiles.create).toHaveBeenCalledWith({
      name: 'overlay',
      content: 'a: 1\n',
      type: 'merge',
    })
  })

  it('pUT /api/control/profiles/:id passes through enabled', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles/p1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
    expect(deps.profiles.update).toHaveBeenCalledWith('p1', { enabled: false })
  })

  it('gET /api/control/profiles/:id returns { meta, content }', async () => {
    srv = await mount(makeDeps())
    const res = await fetch(`${srv.base}/api/control/profiles/p1`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.meta).toMatchObject({ id: 'p1' })
    expect(body.content).toBe('mixed-port: 7890\n')
  })

  it('pUT /api/control/profiles/:id updates', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles/p1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    })
    expect(res.status).toBe(200)
    expect(deps.profiles.update).toHaveBeenCalledWith('p1', { name: 'renamed' })
  })

  it('rejects direct edits to managed visual overlays', async () => {
    const deps = makeDeps()
    deps.profiles.list.mockResolvedValue([
      {
        id: 'p1',
        name: 'managed',
        type: 'merge',
        managedBy: 'visual-editor',
        baseProfileId: 'base',
        updatedAt: 1,
      },
    ])
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles/p1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'broken: true\n' }),
    })
    expect(res.status).toBe(403)
    expect(deps.profiles.update).not.toHaveBeenCalled()
  })

  it('dELETE /api/control/profiles/:id returns 204', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles/p1`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(204)
    expect(deps.profiles.delete).toHaveBeenCalledWith('p1')
  })

  it('pOST /api/control/profiles/:id/duplicate returns ProfileMeta', async () => {
    srv = await mount(makeDeps())
    const res = await fetch(`${srv.base}/api/control/profiles/p1/duplicate`, {
      method: 'POST',
    })
    expect(((await res.json()) as Record<string, unknown>).id).toBe('p3')
  })

  it('pOST /api/control/profiles/import imports from { url, name? }', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://sub', name: 'sub' }),
    })
    expect(((await res.json()) as Record<string, unknown>).type).toBe('remote')
    expect(deps.profiles.importFromUrl).toHaveBeenCalledWith(
      'https://sub',
      'sub',
    )
  })

  it('pOST /api/control/profiles/import preserves an upstream 429 response (#2138)', async () => {
    const deps = makeDeps()
    deps.profiles.importFromUrl.mockRejectedValue(
      new SubscriptionFetchError(429),
    )
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://sub.example/limited' }),
    })

    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({
      statusCode: 429,
      data: {
        error: 'Subscription provider returned HTTP 429',
        upstreamStatus: 429,
      },
    })
  })

  it('pOST /api/control/profiles/:id/refresh returns the updated meta', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles/p1/refresh`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(deps.profiles.refresh).toHaveBeenCalledWith('p1')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe('p1')
    expect(body.type).toBe('remote')
    expect(body.updatedAt).toBe(6)
  })

  it('pOST /api/control/profiles/:id/refresh is a pure re-fetch (no apply)', async () => {
    const deps = makeDeps()
    deps.profiles.getActiveId = vi.fn(async () => 'p1')
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles/p1/refresh`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(deps.profiles.refresh).toHaveBeenCalledWith('p1')
    // Pure refresh never touches the running config — apply is a separate action.
    expect(deps.profiles.setActive).not.toHaveBeenCalled()
    expect(deps.supervisor.restart).not.toHaveBeenCalled()
  })

  it('pOST /profiles/:id/refresh-and-activate refreshes, activates (validates), and restarts (#2108)', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(
      `${srv.base}/api/control/profiles/p1/refresh-and-activate`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    expect(deps.profiles.refresh).toHaveBeenCalledWith('p1')
    expect(deps.profiles.setActive).toHaveBeenCalledWith('p1')
    expect(deps.supervisor.validate).toHaveBeenCalledWith(deps.activeConfigPath)
    expect(deps.supervisor.restart).toHaveBeenCalledOnce()
    const body = (await res.json()) as {
      meta: { id: string; type: string }
      kernel: { status: string }
    }
    expect(body.meta.id).toBe('p1')
    expect(body.meta.type).toBe('remote')
    expect(body.kernel.status).toBe('running')
  })

  it('pOST /profiles/:id/refresh-and-activate returns 400 + restores prior when validation fails (#2109)', async () => {
    const deps = makeDeps()
    deps.profiles.getActiveId = vi.fn(async () => 'old')
    deps.supervisor.validate = vi.fn(async () => ({
      valid: false,
      message: 'parse error near line 3',
    }))
    srv = await mount(deps)
    const res = await fetch(
      `${srv.base}/api/control/profiles/p1/refresh-and-activate`,
      { method: 'POST' },
    )
    expect(res.status).toBe(400)
    // New (bad) candidate composed, then prior profile restored.
    expect(deps.profiles.setActive).toHaveBeenCalledWith('p1')
    expect(deps.profiles.setActive).toHaveBeenCalledWith('old')
    expect(deps.supervisor.restart).not.toHaveBeenCalled()
  })

  it('pUT /api/control/profiles/:id passes through updateInterval (#2107)', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles/p1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ updateInterval: 60 }),
    })
    expect(res.status).toBe(200)
    expect(deps.profiles.update).toHaveBeenCalledWith('p1', {
      updateInterval: 60,
    })
  })

  it('pOST /api/control/kernel/rollback restores the backup + restarts (#2109)', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/kernel/rollback`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(deps.profiles.rollback).toHaveBeenCalled()
    expect(deps.supervisor.restart).toHaveBeenCalled()
  })

  it('pOST /api/control/kernel/rollback 404s when no backup exists (#2109)', async () => {
    const deps = makeDeps()
    deps.profiles.rollback = vi.fn(async () => false)
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/kernel/rollback`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    expect(deps.supervisor.restart).not.toHaveBeenCalled()
  })

  it('pOST /api/control/kernel/recover resets to minimal + restarts (#2109)', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/kernel/recover`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(deps.profiles.resetActive).toHaveBeenCalled()
    expect(deps.supervisor.restart).toHaveBeenCalled()
  })

  it('pOST /api/control/profiles/:id/activate validates the composed config before restarting (#2109)', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles/p1/activate`, {
      method: 'POST',
    })
    expect(deps.profiles.setActive).toHaveBeenCalledWith('p1')
    expect(deps.supervisor.validate).toHaveBeenCalledWith(deps.activeConfigPath)
    expect(deps.supervisor.restart).toHaveBeenCalledOnce()
    expect(((await res.json()) as Record<string, unknown>).status).toBe(
      'running',
    )
  })

  it('pOST /api/control/profiles/:id/activate returns 400 + restores prior active when validation fails (#2109)', async () => {
    const deps = makeDeps()
    deps.profiles.getActiveId = vi.fn(async () => 'old')
    deps.supervisor.validate = vi.fn(async () => ({
      valid: false,
      message: 'parse error near line 3',
    }))
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles/p1/activate`, {
      method: 'POST',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      statusMessage: 'profile validation failed',
      data: { error: 'parse error near line 3' },
    })
    expect(deps.profiles.setActive).toHaveBeenCalledWith('p1')
    // Prior profile restored so the bad candidate does not persist.
    expect(deps.profiles.setActive).toHaveBeenCalledWith('old')
    expect(deps.supervisor.restart).not.toHaveBeenCalled()
  })

  it('pOST /api/control/profiles/:id/validate materializes a temp candidate then returns { valid, message }', async () => {
    const deps = makeDeps()
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/profiles/p1/validate`, {
      method: 'POST',
    })
    const body = await res.json()
    expect(body).toEqual({ valid: true, message: 'ok' })
    // It reads the profile by id and validates a real candidate PATH, never the bare id.
    expect(deps.profiles.read).toHaveBeenCalledWith('p1')
    const validatedPath = (
      deps.supervisor.validate.mock.calls as unknown as [string][][]
    )[0]![0] as unknown as string
    expect(validatedPath).toBe(join(deps.homeDir, '.validate-p1.yaml'))
    expect(validatedPath).not.toBe('p1')
  })

  it('exposes visual profile editor open/preview/apply/reset routes', async () => {
    const deps = makeDeps()
    const snapshot = {
      profile: { id: 'p1', name: 'home', type: 'local' as const, updatedAt: 1 },
      active: false,
      revision: 'rev',
      editableYaml: 'mode: rule\n',
      composedYaml: 'mode: rule\n',
      schemaVersion: 'schema',
      composition: [],
      diagnostics: [],
      conflicts: [],
    }
    const profileEditor = {
      open: vi.fn(async () => snapshot),
      preview: vi.fn(async () => ({
        ...snapshot,
        patch: { version: 1 as const, baseRevision: 'rev', operations: [] },
      })),
      apply: vi.fn(async () => ({
        profile: snapshot.profile,
        activeId: 'p1',
        revision: 'rev',
        kernel: fakeState({
          status: 'running',
          secret: 'editor-secret-canary',
          lastError: 'https://private.invalid/editor-error-canary',
        }),
      })),
      resetManagedOverlay: vi.fn(async () =>
        fakeState({
          status: 'running',
          secret: 'reset-secret-canary',
          lastError: 'https://private.invalid/reset-error-canary',
        }),
      ),
    }
    srv = await mount({ ...deps, profileEditor } as never)
    expect(
      await fetch(`${srv.base}/api/control/profiles/p1/editor`).then(
        (r) => r.status,
      ),
    ).toBe(200)
    const body = {
      patch: { version: 1, baseRevision: 'rev', operations: [] },
    }
    expect(
      await fetch(`${srv.base}/api/control/profiles/p1/editor/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.status),
    ).toBe(200)
    const applied = await fetch(`${srv.base}/api/control/profiles/p1/editor`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(applied.status).toBe(200)
    expect(await applied.text()).not.toMatch(
      /editor-secret-canary|editor-error-canary|private\.invalid|lastError/,
    )
    const reset = await fetch(
      `${srv.base}/api/control/profiles/p1/editor/overlay`,
      { method: 'DELETE' },
    )
    expect(reset.status).toBe(200)
    expect(await reset.text()).not.toMatch(
      /reset-secret-canary|reset-error-canary|private\.invalid|lastError/,
    )
    expect(
      await fetch(`${srv.base}/api/control/profiles/p1/editor/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }).then((r) => r.status),
    ).toBe(400)
  })

  it('maps visual editor conflicts to HTTP 409', async () => {
    const deps = makeDeps()
    const conflict = {
      operation: {
        op: 'set' as const,
        target: { path: ['mode'] },
        expectedHash: 'old',
        value: 'global' as const,
      },
      path: ['mode'],
      reason: 'changed' as const,
      current: 'direct' as const,
    }
    const profileEditor = {
      open: vi.fn(async () => {
        throw new ProfileEditorConflictError([conflict])
      }),
      preview: vi.fn(),
      apply: vi.fn(),
      resetManagedOverlay: vi.fn(),
    }
    srv = await mount({ ...deps, profileEditor } as never)
    const res = await fetch(`${srv.base}/api/control/profiles/p1/editor`)
    expect(res.status).toBe(409)
    expect((await res.json()) as object).toMatchObject({
      data: { conflicts: [expect.objectContaining({ reason: 'changed' })] },
    })
  })

  it('gET /api/control/kernel/logs streams text/event-stream and pushes a state event', async () => {
    const deps = makeDeps()
    // Capture the registered 'log' callback so we can drive a fake log line.
    let logCb:
      ((l: { stream: string; line: string; ts: number }) => void) | undefined
    deps.supervisor.on = vi.fn((event: string, cb: never) => {
      if (event === 'log') logCb = cb as never
    }) as never
    srv = await mount(deps)

    const res = await fetch(`${srv.base}/api/control/kernel/logs`)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    // First chunk should be the seeded state event.
    const first = await reader.read()
    const seeded = dec.decode(first.value)
    expect(seeded).toContain('"type":"state"')
    expect(seeded).not.toMatch(/"secret"|lastError|sek/)

    // Drive a log line through the captured callback and read the next chunk.
    logCb?.({ stream: 'stdout', line: 'hello-from-kernel', ts: 1 })
    const next = await reader.read()
    expect(dec.decode(next.value)).toContain('hello-from-kernel')

    await reader.cancel()
  })
})

describe('createControlRouter — system proxy', () => {
  let srv: Awaited<ReturnType<typeof mount>>
  afterEach(async () => srv?.close())

  it('gET /api/control/sysproxy reflects isEnabled() + describe()', async () => {
    const deps = { ...makeDeps(), systemProxy: makeSystemProxy(true) }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/sysproxy`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      enabled: true,
      port: 7890,
      bypass: ['localhost', '127.0.0.1'],
    })
    expect(deps.systemProxy.isEnabled).toHaveBeenCalledOnce()
    expect(deps.systemProxy.describe).toHaveBeenCalled()
  })

  it('pOST /api/control/sysproxy {enabled:true, bypass} calls enable(bypass)', async () => {
    const deps = { ...makeDeps(), systemProxy: makeSystemProxy(false) }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/sysproxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, bypass: ['example.com'] }),
    })
    expect(res.status).toBe(200)
    expect(deps.systemProxy.enable).toHaveBeenCalledWith(['example.com'])
    expect(deps.systemProxy.disable).not.toHaveBeenCalled()
    // Response mirrors the GET shape (enabled + describe()).
    expect(await res.json()).toEqual({
      enabled: false,
      port: 7890,
      bypass: ['localhost', '127.0.0.1'],
    })
  })

  it('pOST /api/control/sysproxy {mode:pac, enabled:true, pacUrl} calls setAutoProxy', async () => {
    const deps = { ...makeDeps(), systemProxy: makeSystemProxy(false) }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/sysproxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'pac',
        enabled: true,
        pacUrl: 'http://127.0.0.1:7890/proxy.pac',
      }),
    })
    expect(res.status).toBe(200)
    expect(deps.systemProxy.setAutoProxy).toHaveBeenCalledWith(
      'http://127.0.0.1:7890/proxy.pac',
    )
    expect(deps.systemProxy.enable).not.toHaveBeenCalled()
    expect(deps.systemProxy.disableAutoProxy).not.toHaveBeenCalled()
  })

  it('pOST /api/control/sysproxy {mode:pac, enabled:false} calls disableAutoProxy', async () => {
    const deps = { ...makeDeps(), systemProxy: makeSystemProxy(false) }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/sysproxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'pac', enabled: false }),
    })
    expect(res.status).toBe(200)
    expect(deps.systemProxy.disableAutoProxy).toHaveBeenCalledOnce()
    expect(deps.systemProxy.disable).not.toHaveBeenCalled()
    expect(deps.systemProxy.setAutoProxy).not.toHaveBeenCalled()
  })

  it('pOST /api/control/sysproxy {mode:pac, enabled:true} without pacUrl is a 400', async () => {
    const deps = { ...makeDeps(), systemProxy: makeSystemProxy(false) }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/sysproxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'pac', enabled: true }),
    })
    expect(res.status).toBe(400)
    expect(deps.systemProxy.setAutoProxy).not.toHaveBeenCalled()
  })

  it('pOST /api/control/sysproxy {enabled:false} calls disable()', async () => {
    const deps = { ...makeDeps(), systemProxy: makeSystemProxy(true) }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/sysproxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
    expect(deps.systemProxy.disable).toHaveBeenCalledOnce()
    expect(deps.systemProxy.enable).not.toHaveBeenCalled()
  })

  it('gET /api/control/sysproxy is 404 JSON when no controller is injected', async () => {
    srv = await mount(makeDeps())
    const res = await fetch(`${srv.base}/api/control/sysproxy`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'system-proxy unavailable' })
  })

  it('pOST /api/control/sysproxy is 404 JSON when no controller is injected', async () => {
    srv = await mount(makeDeps())
    const res = await fetch(`${srv.base}/api/control/sysproxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'system-proxy unavailable' })
  })
})

function makeKernelManager() {
  return {
    listVersions: vi.fn(async () => ({
      versions: ['v1.19.27', 'v1.19.0'],
      current: 'v1.19.27',
      bundled: 'v1.19.27',
    })),
    switch: vi.fn(async () => {}),
  }
}

function makeTunController(
  status: { enabled: boolean; mode: 'sidecar' | 'tun'; stack?: string } = {
    enabled: false,
    mode: 'sidecar',
  },
) {
  return {
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    status: vi.fn(async () => status),
    uninstall: vi.fn(async () => {}),
  }
}

describe('createControlRouter — geo assets', () => {
  let srv: Awaited<ReturnType<typeof mount>>
  afterEach(async () => srv?.close())

  it('pOST /api/control/geo/update downloads the 3 files into homeDir and returns { ok, files }', async () => {
    const requested: string[] = []
    const geoFetch = vi.fn(async (url: string) => {
      requested.push(url)
      return new Response(Buffer.from(`bytes:${url}`), { status: 200 })
    })
    const deps = {
      ...makeDeps(),
      geoFetch: geoFetch as unknown as typeof fetch,
    }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/geo/update`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      files: ['geoip.dat', 'geosite.dat', 'country.mmdb'],
    })
    // It fetched three assets and wrote them under homeDir.
    expect(requested).toHaveLength(3)
    const written = readdirSync(deps.homeDir)
    expect(written).toEqual(
      expect.arrayContaining(['geoip.dat', 'geosite.dat', 'country.mmdb']),
    )
  })
})

describe('createControlRouter — kernel version management', () => {
  let srv: Awaited<ReturnType<typeof mount>>
  afterEach(async () => srv?.close())

  it('gET /api/control/kernel/versions returns listVersions()', async () => {
    const deps = { ...makeDeps(), kernelManager: makeKernelManager() }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/kernel/versions`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      versions: ['v1.19.27', 'v1.19.0'],
      current: 'v1.19.27',
      bundled: 'v1.19.27',
    })
    expect(deps.kernelManager.listVersions).toHaveBeenCalledOnce()
  })

  it('pOST /api/control/kernel/switch { version } calls switch then returns { ok: true }', async () => {
    const deps = { ...makeDeps(), kernelManager: makeKernelManager() }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/kernel/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'v1.19.0' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(deps.kernelManager.switch).toHaveBeenCalledWith('v1.19.0')
  })

  it('gET /api/control/kernel/versions is 404 JSON when no kernelManager is injected', async () => {
    srv = await mount(makeDeps())
    const res = await fetch(`${srv.base}/api/control/kernel/versions`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'kernel-version unavailable' })
  })

  it('pOST /api/control/kernel/switch is 404 JSON when no kernelManager is injected', async () => {
    srv = await mount(makeDeps())
    const res = await fetch(`${srv.base}/api/control/kernel/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'v1.19.0' }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'kernel-version unavailable' })
  })
})

describe('createControlRouter — tun', () => {
  let srv: Awaited<ReturnType<typeof mount>>
  afterEach(async () => srv?.close())

  it('gET /api/control/tun reflects tunController.status()', async () => {
    const deps = {
      ...makeDeps(),
      tunController: makeTunController({
        enabled: true,
        mode: 'tun',
        stack: 'gvisor',
      }),
    }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/tun`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      enabled: true,
      mode: 'tun',
      stack: 'gvisor',
    })
    expect(deps.tunController.status).toHaveBeenCalledOnce()
  })

  it('pOST /api/control/tun {enabled:true, stack} calls enable({stack}) then returns status()', async () => {
    const deps = {
      ...makeDeps(),
      tunController: makeTunController({
        enabled: true,
        mode: 'tun',
        stack: 'mixed',
      }),
    }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/tun`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, stack: 'mixed' }),
    })
    expect(res.status).toBe(200)
    expect(deps.tunController.enable).toHaveBeenCalledWith({ stack: 'mixed' })
    expect(deps.tunController.disable).not.toHaveBeenCalled()
    // Response mirrors the GET shape (status()).
    expect(await res.json()).toEqual({
      enabled: true,
      mode: 'tun',
      stack: 'mixed',
    })
  })

  it('pOST /api/control/tun maps a TunPreconditionError to a clean handled 4xx (not an unhandled 500)', async () => {
    const controller = makeTunController({ enabled: false, mode: 'sidecar' })
    controller.enable = vi.fn(async () => {
      throw new TunPreconditionError('tun: no active profile to edit')
    })
    const deps = { ...makeDeps(), tunController: controller }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/tun`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, stack: 'mixed' }),
    })
    // 409 Conflict (the default precondition status), carrying the reason — NOT
    // a 500 H3 [unhandled] error.
    expect(res.status).toBe(409)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      data: { error: 'tun: no active profile to edit' },
    })
  })

  it('pOST /api/control/tun lets a genuine enable failure propagate as a 500', async () => {
    const controller = makeTunController({ enabled: false, mode: 'sidecar' })
    controller.enable = vi.fn(async () => {
      throw new Error('elevation denied')
    })
    const deps = { ...makeDeps(), tunController: controller }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/tun`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, stack: 'mixed' }),
    })
    expect(res.status).toBe(500)
  })

  it('pOST /api/control/tun {enabled:false} calls disable() then returns status()', async () => {
    const deps = {
      ...makeDeps(),
      tunController: makeTunController({ enabled: false, mode: 'sidecar' }),
    }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/tun`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
    expect(deps.tunController.disable).toHaveBeenCalledOnce()
    expect(deps.tunController.enable).not.toHaveBeenCalled()
    expect(await res.json()).toEqual({ enabled: false, mode: 'sidecar' })
  })

  it('pOST /api/control/tun/uninstall calls uninstall() then returns status()', async () => {
    const deps = {
      ...makeDeps(),
      tunController: makeTunController({ enabled: false, mode: 'sidecar' }),
    }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/tun/uninstall`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(deps.tunController.uninstall).toHaveBeenCalledOnce()
    expect(await res.json()).toEqual({ enabled: false, mode: 'sidecar' })
  })

  it('pOST /api/control/tun/uninstall is 404 JSON when the controller lacks uninstall', async () => {
    const controller = makeTunController({ enabled: false, mode: 'sidecar' })
    // A controller WITHOUT the uninstall capability (older/partial impl).
    delete (controller as { uninstall?: unknown }).uninstall
    const deps = { ...makeDeps(), tunController: controller }
    srv = await mount(deps as never)
    const res = await fetch(`${srv.base}/api/control/tun/uninstall`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'tun unavailable' })
  })

  it('gET /api/control/tun is 404 JSON when no controller is injected', async () => {
    srv = await mount(makeDeps())
    const res = await fetch(`${srv.base}/api/control/tun`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'tun unavailable' })
  })

  it('pOST /api/control/tun/uninstall is 404 JSON when no controller is injected', async () => {
    srv = await mount(makeDeps())
    const res = await fetch(`${srv.base}/api/control/tun/uninstall`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'tun unavailable' })
  })

  it('pOST /api/control/tun is 404 JSON when no controller is injected', async () => {
    srv = await mount(makeDeps())
    const res = await fetch(`${srv.base}/api/control/tun`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, stack: 'gvisor' }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'tun unavailable' })
  })
})

describe('createControlRouter — WebDAV backup/restore', () => {
  let srv: Awaited<ReturnType<typeof mount>>
  afterEach(async () => srv?.close())

  function makeWebdav() {
    const calls: { put: [string, string][]; get: string[]; mkcol: string[] } = {
      put: [],
      get: [],
      mkcol: [],
    }
    let stored = ''
    const client = {
      put: vi.fn(async (path: string, body: string) => {
        calls.put.push([path, body])
        stored = body
      }),
      get: vi.fn(async (path: string) => {
        calls.get.push(path)
        return stored
      }),
      mkcol: vi.fn(async (dir: string) => {
        calls.mkcol.push(dir)
      }),
    }
    const opts: unknown[] = []
    const createWebdavClient = vi.fn((o: unknown) => {
      opts.push(o)
      return client
    })
    return { client, calls, opts, createWebdavClient }
  }

  it('pOST /backup builds a bundle of all profiles and uploads it via webdav', async () => {
    const dav = makeWebdav()
    const deps = {
      ...makeDeps(),
      createWebdavClient: dav.createWebdavClient,
    }
    srv = await mount(deps as never)

    const res = await fetch(`${srv.base}/api/control/backup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webdav: {
          url: 'https://dav/',
          username: 'u',
          password: 'p',
          dir: 'mcxd',
        },
        uiSettings: { theme: 'dark' },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.path).toBe('mcxd/metacubexd-backup.json')

    // Client constructed with the request credentials.
    expect(dav.opts[0]).toMatchObject({
      url: 'https://dav/',
      username: 'u',
      password: 'p',
    })
    // mkcol best-effort on the dir, then put the bundle.
    expect(dav.calls.mkcol).toEqual(['mcxd'])
    expect(dav.calls.put).toHaveLength(1)
    const [putPath, putBody] = dav.calls.put[0]!
    expect(putPath).toBe('mcxd/metacubexd-backup.json')
    const bundle = JSON.parse(putBody) as Record<string, unknown>
    expect(bundle.version).toBe(1)
    expect(bundle.uiSettings).toEqual({ theme: 'dark' })
    expect(bundle.profiles).toEqual([
      {
        meta: { id: 'p1', name: 'home', type: 'local', updatedAt: 1 },
        content: 'mixed-port: 7890\n',
      },
    ])
  })

  it('pOST /backup tolerates a failing mkcol (best-effort) and still uploads', async () => {
    const dav = makeWebdav()
    dav.client.mkcol = vi.fn(async () => {
      throw new Error('mkcol boom')
    })
    const deps = {
      ...makeDeps(),
      createWebdavClient: dav.createWebdavClient,
    }
    srv = await mount(deps as never)

    const res = await fetch(`${srv.base}/api/control/backup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webdav: { url: 'https://dav/', username: 'u', password: 'p' },
      }),
    })
    expect(res.status).toBe(200)
    expect(dav.calls.put).toHaveLength(1)
    // No dir provided -> bundle lands at the root.
    expect(dav.calls.put[0]![0]).toBe('metacubexd-backup.json')
  })

  it('pOST /restore re-creates profiles from the bundle and returns uiSettings', async () => {
    const dav = makeWebdav()
    const bundle = {
      version: 1,
      profiles: [
        {
          meta: { id: 'x1', name: 'restored', type: 'local', updatedAt: 9 },
          content: 'port: 1234\n',
        },
        {
          meta: {
            id: 'x2',
            name: 'sub',
            type: 'remote',
            url: 'https://s',
            updatedAt: 10,
          },
          content: 'proxies: []\n',
        },
        {
          meta: { id: 'x3', name: 'ov', type: 'merge', updatedAt: 11 },
          content: 'append-rules:\n  - MATCH,DIRECT\n',
        },
        {
          meta: { id: 'x4', name: 'tweak', type: 'script', updatedAt: 12 },
          content: 'module.exports = (c) => c\n',
        },
      ],
      uiSettings: { lang: 'zh' },
    }
    dav.client.get = vi.fn(async () => JSON.stringify(bundle))

    const deps = {
      ...makeDeps(),
      createWebdavClient: dav.createWebdavClient,
    }
    srv = await mount(deps as never)

    const res = await fetch(`${srv.base}/api/control/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webdav: {
          url: 'https://dav/',
          username: 'u',
          password: 'p',
          dir: 'mcxd',
        },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.restored).toBe(4)
    expect(body.uiSettings).toEqual({ lang: 'zh' })

    // Downloads the bundle from the same path the backup writes.
    expect(dav.client.get).toHaveBeenCalledWith('mcxd/metacubexd-backup.json')
    // Recreates via profiles.create (new ids — avoids clashes), passing name/content/type.
    expect(deps.profiles.create).toHaveBeenCalledTimes(4)
    expect(deps.profiles.create).toHaveBeenCalledWith({
      name: 'restored',
      content: 'port: 1234\n',
      type: 'local',
    })
    // 'remote' is restored as 'local' (keep content, no re-fetch)...
    expect(deps.profiles.create).toHaveBeenCalledWith({
      name: 'sub',
      content: 'proxies: []\n',
      type: 'local',
    })
    // ...but composition types (merge/script) are preserved so they still apply.
    expect(deps.profiles.create).toHaveBeenCalledWith({
      name: 'ov',
      content: 'append-rules:\n  - MATCH,DIRECT\n',
      type: 'merge',
    })
    expect(deps.profiles.create).toHaveBeenCalledWith({
      name: 'tweak',
      content: 'module.exports = (c) => c\n',
      type: 'script',
    })
  })

  it('pOST /backup surfaces a webdav put failure (no silent swallow)', async () => {
    const dav = makeWebdav()
    dav.client.put = vi.fn(async () => {
      throw new Error('webdav PUT failed 403')
    })
    const deps = {
      ...makeDeps(),
      createWebdavClient: dav.createWebdavClient,
    }
    srv = await mount(deps as never)

    const res = await fetch(`${srv.base}/api/control/backup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webdav: { url: 'https://dav/', username: 'u', password: 'p' },
      }),
    })
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})

describe('createControlRouter — active config', () => {
  let srv: Awaited<ReturnType<typeof mount>>
  afterEach(async () => srv?.close())

  it('gET /api/control/config still returns only the active profile source', async () => {
    const deps = makeDeps()
    deps.profiles.getActiveId = vi.fn(async () => 'p1')
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/config`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('mixed-port: 7890\n')
  })
})

describe('createControlRouter — config sections', () => {
  let srv: Awaited<ReturnType<typeof mount>>
  afterEach(async () => srv?.close())

  it('gET /api/control/config/section?key= returns the active profile section', async () => {
    const deps = makeDeps()
    deps.profiles.getActiveId = vi.fn(async () => 'p1')
    deps.profiles.getSection = vi.fn(async () => ['MATCH,DIRECT'])
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/config/section?key=rules`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(['MATCH,DIRECT'])
    expect(deps.profiles.getSection).toHaveBeenCalledWith('p1', 'rules')
  })

  it('gET /api/control/config/section returns null when there is no active profile', async () => {
    const deps = makeDeps()
    deps.profiles.getActiveId = vi.fn(async () => undefined)
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/config/section?key=rules`)
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
    expect(deps.profiles.getSection).not.toHaveBeenCalled()
  })

  it('pUT /api/control/config/section sets the section then re-activates + restarts', async () => {
    const deps = makeDeps()
    deps.profiles.getActiveId = vi.fn(async () => 'p1')
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/config/section`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'rules', value: ['MATCH,REJECT'] }),
    })
    expect(res.status).toBe(200)
    expect(deps.profiles.setSection).toHaveBeenCalledWith('p1', 'rules', [
      'MATCH,REJECT',
    ])
    expect(deps.profiles.setActive).toHaveBeenCalledWith('p1')
    expect(deps.supervisor.restart).toHaveBeenCalledOnce()
    expect(((await res.json()) as Record<string, unknown>).status).toBe(
      'running',
    )
  })

  it('pUT /api/control/config/section with restart:false persists WITHOUT restarting', async () => {
    const deps = makeDeps()
    deps.profiles.getActiveId = vi.fn(async () => 'p1')
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/config/section`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allow-lan', value: true, restart: false }),
    })
    expect(res.status).toBe(200)
    expect(deps.profiles.setSection).toHaveBeenCalledWith(
      'p1',
      'allow-lan',
      true,
    )
    expect(deps.profiles.setActive).toHaveBeenCalledWith('p1')
    // The field was already hot-applied by the client's PATCH /configs — no
    // restart, so live connections survive while the change is persisted.
    expect(deps.supervisor.restart).not.toHaveBeenCalled()
    expect(deps.supervisor.getState).toHaveBeenCalled()
  })

  it('pUT /api/control/config/section passes a null value through (delete)', async () => {
    const deps = makeDeps()
    deps.profiles.getActiveId = vi.fn(async () => 'p1')
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/config/section`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'dns', value: null }),
    })
    expect(res.status).toBe(200)
    expect(deps.profiles.setSection).toHaveBeenCalledWith('p1', 'dns', null)
    expect(deps.profiles.setActive).toHaveBeenCalledWith('p1')
  })

  it('pUT /api/control/config/section returns 409 when there is no active profile', async () => {
    const deps = makeDeps()
    deps.profiles.getActiveId = vi.fn(async () => undefined)
    srv = await mount(deps)
    const res = await fetch(`${srv.base}/api/control/config/section`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'rules', value: [] }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'no active profile' })
    expect(deps.profiles.setSection).not.toHaveBeenCalled()
    expect(deps.supervisor.restart).not.toHaveBeenCalled()
  })
})
