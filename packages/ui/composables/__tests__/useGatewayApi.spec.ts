import ky from 'ky'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getGatewayCsrfToken,
  resolveGatewayApiBase,
  useGatewayApi,
} from '../useGatewayApi'

const http = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('ky', () => ({
  default: { create: http.create },
}))

function jsonResponse(body: unknown = {}) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    }),
  )
}

describe('gateway v2 API client', () => {
  const previousWindow = globalThis.window

  beforeEach(() => {
    vi.clearAllMocks()
    http.create.mockReturnValue({
      get: http.get,
      post: http.post,
      put: http.put,
      delete: http.delete,
    })
    http.get.mockImplementation(() => jsonResponse({ items: [] }))
    http.post.mockImplementation(() => jsonResponse({}))
    http.put.mockImplementation(() => jsonResponse({}))
    http.delete.mockImplementation(() => jsonResponse())
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    })
  })

  it('uses the same-origin API base and the exact item envelope', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://gateway.example.com' } },
    })

    expect(resolveGatewayApiBase()).toBe('https://gateway.example.com/api')

    useGatewayApi()
    expect(ky.create).toHaveBeenCalledWith({
      prefix: 'https://gateway.example.com/api',
      credentials: 'include',
      timeout: 20_000,
      retry: 0,
    })
  })

  it('uses only the approved v2 gateway GET paths', async () => {
    const api = useGatewayApi()

    await api.listPorts()
    await api.listNodes()
    await api.getNodeImpact('node/a')
    await api.listSubscriptions()
    await api.listCredentials()
    await api.getGatewayStatus()
    await api.listRevisions()

    expect(http.get.mock.calls.map(([path]) => path)).toEqual([
      'control/gateway/ports',
      'control/gateway/nodes',
      'control/gateway/nodes/node%2Fa/impact',
      'control/gateway/subscriptions',
      'control/gateway/credentials',
      'control/gateway/status',
      'control/gateway/revisions',
    ])
  })

  it('sends exact v2 mutation paths, bodies, and the session CSRF token', async () => {
    http.post.mockImplementationOnce(() =>
      jsonResponse({
        authenticated: true,
        user: 'admin',
        csrfToken: 'csrf-v2',
      }),
    )
    const api = useGatewayApi()
    await api.login('admin-password')
    http.post.mockClear()

    const portBody = {
      enabled: true,
      credentialIds: ['credential-1'],
      hops: [
        { mode: 'manual' as const, nodeIds: ['node-1'] },
        { mode: 'failover' as const, nodeIds: ['node-2', 'node-3'] },
      ],
    }
    await api.updatePort(2, portBody)
    await api.updateNode('node/a', { enabled: false })
    await api.testNode('node/a')
    await api.deleteNode('node/a', true)
    await api.previewImport({ content: 'vless://example' })
    await api.applyImport({ previewId: 'preview-1' })
    if (false) {
      // @ts-expect-error imports/apply accepts exactly one source
      await api.applyImport({ previewId: 'preview-1', content: 'nodes: []' })
    }
    await api.createSubscription({
      name: 'main',
      url: 'https://subscription.example',
      intervalMinutes: 60,
      enabled: true,
    })
    await api.updateSubscription('subscription/a', {
      name: 'renamed',
      url: 'https://updated.example',
      enabled: false,
    })
    await api.syncSubscription('subscription/a')
    await api.refreshSubscriptions()
    await api.deleteSubscription('subscription/a')
    await api.createCredential({
      username: 'alice',
      enabled: true,
      portIds: [1, 2],
    })
    await api.updateCredential('credential/a', {
      username: 'alice-2',
      enabled: false,
      portIds: [2],
    })
    await api.rotateCredential('credential/a', 'rotated-password')
    await api.deleteCredential('credential/a')
    await api.reapplyGateway()

    const mutation = (json?: unknown) => ({
      ...(json === undefined ? {} : { json }),
      headers: { 'X-CSRF-Token': 'csrf-v2' },
    })
    expect(getGatewayCsrfToken()).toBe('csrf-v2')
    expect(http.put).toHaveBeenCalledWith(
      'control/gateway/ports/2',
      mutation(portBody),
    )
    expect(http.put).toHaveBeenCalledWith(
      'control/gateway/nodes/node%2Fa',
      mutation({ enabled: false }),
    )
    expect(http.post).toHaveBeenCalledWith(
      'control/gateway/nodes/node%2Fa/test',
      mutation(),
    )
    expect(http.delete).toHaveBeenCalledWith(
      'control/gateway/nodes/node%2Fa',
      mutation({ confirmed: true }),
    )
    expect(http.post).toHaveBeenCalledWith('control/gateway/imports/preview', {
      ...mutation({ content: 'vless://example' }),
      timeout: 45_000,
    })
    expect(http.post).toHaveBeenCalledWith('control/gateway/imports/apply', {
      ...mutation({ previewId: 'preview-1' }),
      timeout: 45_000,
    })
    expect(http.post).toHaveBeenCalledWith(
      'control/gateway/subscriptions',
      mutation({
        name: 'main',
        url: 'https://subscription.example',
        intervalMinutes: 60,
        enabled: true,
      }),
    )
    expect(http.put).toHaveBeenCalledWith(
      'control/gateway/subscriptions/subscription%2Fa',
      mutation({
        name: 'renamed',
        url: 'https://updated.example',
        enabled: false,
      }),
    )
    expect(http.post).toHaveBeenCalledWith(
      'control/gateway/subscriptions/subscription%2Fa/sync',
      mutation(),
    )
    expect(http.post).toHaveBeenCalledWith(
      'control/gateway/subscriptions/refresh',
      mutation(),
    )
    expect(http.delete).toHaveBeenCalledWith(
      'control/gateway/subscriptions/subscription%2Fa',
      mutation(),
    )
    expect(http.post).toHaveBeenCalledWith(
      'control/gateway/credentials',
      mutation({ username: 'alice', enabled: true, portIds: [1, 2] }),
    )
    expect(http.put).toHaveBeenCalledWith(
      'control/gateway/credentials/credential%2Fa',
      mutation({ username: 'alice-2', enabled: false, portIds: [2] }),
    )
    expect(http.post).toHaveBeenCalledWith(
      'control/gateway/credentials/credential%2Fa/rotate',
      mutation({ password: 'rotated-password' }),
    )
    expect(http.delete).toHaveBeenCalledWith(
      'control/gateway/credentials/credential%2Fa',
      mutation(),
    )
    expect(http.post).toHaveBeenCalledWith(
      'control/gateway/reapply',
      mutation(),
    )
  })

  it('sends multipart imports with CSRF and no JSON wrapper', async () => {
    http.post.mockImplementationOnce(() =>
      jsonResponse({
        authenticated: true,
        user: 'admin',
        csrfToken: 'csrf-file',
      }),
    )
    const api = useGatewayApi()
    await api.login('password')
    http.post.mockClear()

    const file = new File(['proxies: []'], 'nodes.yaml', {
      type: 'application/yaml',
    })
    await api.previewImportFile(file)

    expect(http.post).toHaveBeenCalledOnce()
    const [path, options] = http.post.mock.calls[0]!
    expect(path).toBe('control/gateway/imports/preview')
    expect(options).toMatchObject({
      headers: { 'X-CSRF-Token': 'csrf-file' },
      timeout: 45_000,
    })
    expect(options.json).toBeUndefined()
    expect(options.body).toBeInstanceOf(FormData)
    expect((options.body as FormData).get('file')).toBe(file)
  })

  it('keeps auth endpoints separate and clears CSRF after logout', async () => {
    http.post.mockImplementationOnce(() =>
      jsonResponse({
        authenticated: true,
        user: 'admin',
        csrfToken: 'csrf-auth',
      }),
    )
    const api = useGatewayApi()

    await api.login('password')
    await api.logout()

    expect(http.post).toHaveBeenNthCalledWith(1, 'auth/login', {
      json: { password: 'password' },
    })
    expect(http.post).toHaveBeenNthCalledWith(2, 'auth/logout', {
      headers: { 'X-CSRF-Token': 'csrf-auth' },
    })
    expect(getGatewayCsrfToken()).toBe('')
  })
})
