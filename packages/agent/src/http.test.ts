import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { toNodeListener } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayValidationError } from './gateway'
import { createControlRouter } from './http'

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
      {
        id: 'node-1',
        name: 'safe-node',
        type: 'socks5',
        enabled: true,
        sourceIds: ['manual'],
        portIds: [1],
      },
    ]),
    updateNode: vi.fn(async (id: string, input: { enabled: boolean }) => ({
      id,
      name: 'safe-node',
      type: 'socks5',
      enabled: input.enabled,
      sourceIds: ['manual'],
      portIds: [1],
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
  return { gateway, gatewaySubscriptions }
}

async function mount(deps: ReturnType<typeof makeGatewayDeps>) {
  const app = createControlRouter(deps as never)
  const server = createServer(toNodeListener(app))
  let port = 0
  const blockedPorts = new Set([
    1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6697, 10080,
  ])
  do {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
    if (blockedPorts.has(port) || (port >= 6665 && port <= 6669))
      await new Promise<void>((resolve) => server.close(() => resolve()))
  } while (blockedPorts.has(port) || (port >= 6665 && port <= 6669))
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

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

  it('exposes health plus the gateway API and returns 404 for generic Mihomo routes', async () => {
    srv = await mount(makeGatewayDeps())

    expect((await request('/api/control/health')).status).toBe(200)
    for (const [path, method] of [
      ['/api/control/info', 'GET'],
      ['/api/control/kernel/status', 'GET'],
      ['/api/control/kernel/start', 'POST'],
      ['/api/control/kernel/logs', 'GET'],
      ['/api/control/profiles', 'GET'],
      ['/api/control/config', 'GET'],
      ['/api/control/config/section?key=rules', 'GET'],
      ['/api/control/geo/update', 'POST'],
      ['/api/control/backup', 'POST'],
      ['/api/control/restore', 'POST'],
      ['/api/control/sysproxy', 'GET'],
      ['/api/control/tun', 'GET'],
    ] as const)
      expect((await request(path, method)).status, `${method} ${path}`).toBe(
        404,
      )
  })

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
        {
          id: 'node-1',
          name: 'safe-node',
          type: 'socks5',
          enabled: true,
          sourceIds: ['manual'],
          portIds: [1],
        },
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
        sourceIds: ['manual', 'subscription:safe'],
        portIds: [1, 10],
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
        {
          id: 'node-1',
          name: 'safe-node',
          type: 'socks5',
          enabled: true,
          sourceIds: ['manual', 'subscription:safe'],
          portIds: [1, 10],
        },
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
