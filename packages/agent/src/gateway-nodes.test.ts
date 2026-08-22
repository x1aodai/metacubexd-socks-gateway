import type { GatewayManager } from './gateway'
import type { GatewayHop, GatewayStateV1 } from './gateway-state'
import type { NormalizedNode } from './subscription'
import type { KernelState, MihomoSupervisor } from './types'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { createGatewayManager } from './gateway'
import { atomicWrite, encryptJson, loadOrCreateKey } from './secure-store'
import { stableNodeId } from './subscription'

function normalizedNode(
  name: string,
  port: number,
  extra: Record<string, unknown> = {},
): NormalizedNode {
  const proxy = {
    name,
    type: 'socks5' as const,
    server: '203.0.113.60',
    port,
    ...extra,
  }
  return { id: stableNodeId(proxy), originalName: name, proxy }
}

function renamed(node: NormalizedNode, name: string): NormalizedNode {
  return {
    id: node.id,
    originalName: name,
    proxy: { ...node.proxy, name },
  }
}

function stoppedState(): KernelState {
  return {
    status: 'stopped',
    externalController: '127.0.0.1:9090',
    secret: 'secret',
  }
}

function runningState(): KernelState {
  return { ...stoppedState(), status: 'running' }
}

function fakeSupervisor() {
  let current = stoppedState()
  const start = vi.fn(async () => {
    current = runningState()
    return { ...current }
  })
  const restart = vi.fn(async () => {
    current = runningState()
    return { ...current }
  })
  const supervisor: MihomoSupervisor = {
    getState: () => ({ ...current }),
    start,
    stop: vi.fn(async () => {
      current = stoppedState()
      return { ...current }
    }),
    restart,
    setBinaryPath: () => {},
    validate: vi.fn(async () => ({ valid: true, message: '' })),
    on: () => {},
    off: () => {},
    dispose: async () => {},
  }
  return { supervisor, start, restart }
}

async function setup(
  options: {
    listProxies?: () => Promise<Response>
    delay?: (url: string) => Promise<Response>
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-gateway-nodes-'))
  const fake = fakeSupervisor()
  const delay = vi.fn(
    options.delay ?? (async () => Response.json({ delay: 42 })),
  )
  const controllerFetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/version')) return Response.json({ version: 'test' })
    if (url.endsWith('/proxies'))
      return options.listProxies
        ? options.listProxies()
        : Response.json({ proxies: {} })
    if (url.includes('/delay?')) return delay(url)
    return new Response('not found', { status: 404 })
  })
  const manager = createGatewayManager({
    dataDir,
    activeConfigPath: join(dataDir, 'active.yaml'),
    masterKey: 'task-6-test-key',
    controllerUrl: '127.0.0.1:9090',
    fetch: controllerFetch as typeof fetch,
    verifyListener: vi.fn(async () => true),
    now: () => 6_000,
  })
  manager.bindSupervisor(fake.supervisor)
  await manager.bootstrap()
  return { manager, fake, delay, controllerFetch }
}

async function enablePorts(
  manager: GatewayManager,
  portIds: number[],
  hops: Record<number, GatewayHop[]>,
) {
  const credential = await manager.createCredential({
    username: `user-${portIds.join('-')}`,
    password: 'node-test-password',
    portIds,
  })
  for (const portId of portIds)
    await manager.updatePort(portId, {
      enabled: true,
      hops: hops[portId],
    })
  return credential
}

describe('stable gateway node library', () => {
  it('imports NormalizedNode values, keeps stable references across rename, and lists safe persisted DTOs offline', async () => {
    const node = normalizedNode('original-name', 1080, {
      username: 'upstream-user',
      password: 'upstream-secret',
    })
    const { manager } = await setup({
      listProxies: async () => {
        throw new Error('controller offline')
      },
    })
    await manager.appendImportedNodes([node])
    await enablePorts(manager, [1], {
      1: [{ mode: 'manual', nodeIds: [node.id] }],
    })

    await manager.appendImportedNodes([renamed(node, 'renamed-node')])

    expect((await manager.listPorts())[0]!.hops).toEqual([
      { mode: 'manual', nodeIds: [node.id] },
    ])
    const nodes = await manager.listNodes()
    expect(nodes).toEqual([
      {
        id: node.id,
        name: 'renamed-node',
        type: 'socks5',
        enabled: true,
        sourceIds: ['manual'],
        portIds: [1],
      },
    ])
    expect(nodes[0]).not.toHaveProperty('proxy')
    expect(JSON.stringify(nodes)).not.toContain('203.0.113.60')
    expect(JSON.stringify(nodes)).not.toContain('upstream-secret')

    await expect(
      manager.appendImportedNodes(
        Array.from({ length: 10_001 }).fill(node) as NormalizedNode[],
      ),
    ).resolves.toBeDefined()
    expect(await manager.listNodes()).toHaveLength(1)
  })

  it('aggregates stable source IDs and sorted port references for each V2 node', async () => {
    const node = normalizedNode('shared-source-node', 1096)
    const { manager } = await setup()
    await manager.replaceNodeSource(
      'subscription:zeta',
      [renamed(node, 'zeta-name')],
      'subscription.sync',
    )
    await manager.replaceNodeSource(
      'subscription:alpha',
      [renamed(node, 'alpha-name')],
      'subscription.sync',
    )
    await manager.appendImportedNodes([renamed(node, 'manual-name')])
    await enablePorts(manager, [10, 2], {
      10: [{ mode: 'manual', nodeIds: [node.id] }],
      2: [{ mode: 'manual', nodeIds: [node.id] }],
    })

    expect(await manager.listNodes()).toEqual([
      {
        id: node.id,
        name: 'manual-name',
        type: 'socks5',
        enabled: true,
        sourceIds: ['manual', 'subscription:alpha', 'subscription:zeta'],
        portIds: [2, 10],
      },
    ])
  })

  it('lists V1 nodes with stable source IDs and no synthetic port references', async () => {
    const node = normalizedNode('legacy-manual-name', 1097)
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-gateway-nodes-v1-'))
    const state: GatewayStateV1 = {
      version: 1,
      gateway: {
        enabled: false,
        port: 1080,
        udp: false,
        mode: 'manual',
        updatedAt: 1,
      },
      credentials: [],
      nodeSources: {
        'subscription:zeta': [renamed(node, 'legacy-zeta-name').proxy],
        manual: [node.proxy],
        'subscription:alpha': [renamed(node, 'legacy-alpha-name').proxy],
      },
      revisions: [],
    }
    const masterKey = 'task-6-test-key'
    const key = await loadOrCreateKey(dataDir, masterKey)
    await atomicWrite(join(dataDir, 'gateway.enc'), encryptJson(state, key))
    const manager = createGatewayManager({
      dataDir,
      activeConfigPath: join(dataDir, 'active.yaml'),
      masterKey,
      controllerUrl: '127.0.0.1:9090',
    })

    expect(await manager.listNodes()).toEqual([
      {
        id: node.id,
        name: 'legacy-manual-name',
        type: 'socks5',
        enabled: true,
        sourceIds: ['manual', 'subscription:alpha', 'subscription:zeta'],
        portIds: [],
      },
    ])
  })

  it('toggles every source copy, filters disabled candidates, and only auto-disables ports that lose all enabled candidates', async () => {
    const first = normalizedNode('first', 1081)
    const second = normalizedNode('second', 1082)
    const { manager } = await setup()
    await manager.replaceNodeSource(
      'subscription:shared',
      [renamed(first, 'subscription-first')],
      'subscription.sync',
    )
    await manager.appendImportedNodes([first, second])
    await enablePorts(manager, [1], {
      1: [{ mode: 'auto', nodeIds: [first.id, second.id] }],
    })

    await manager.updateNode(first.id, { enabled: false })
    expect((await manager.listPorts())[0]).toMatchObject({
      enabled: true,
      hops: [{ mode: 'auto', nodeIds: [first.id, second.id] }],
    })
    const rendered = parse(await manager.overlayConfig('ignored: true'))
    expect(rendered['proxy-groups'][0].proxies).not.toContain(
      `GW-NODE-${first.id}`,
    )
    expect(rendered['proxy-groups'][0].proxies).toContain(
      `GW-NODE-${second.id}`,
    )

    await manager.updateNode(second.id, { enabled: false })
    expect((await manager.listPorts())[0]).toMatchObject({
      enabled: false,
      hops: [{ mode: 'auto', nodeIds: [first.id, second.id] }],
    })
    expect((await manager.listNodes()).map(({ enabled }) => enabled)).toEqual([
      false,
      false,
    ])

    await manager.updateNode(first.id, { enabled: true })
    expect((await manager.listPorts())[0]!.enabled).toBe(false)
    expect(
      (await manager.listNodes()).find(({ id }) => id === first.id),
    ).toMatchObject({ enabled: true })
    await expect(
      manager.updateNode('node_missing', { enabled: false }),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('tests any persisted enabled node through the Controller delay endpoint with whitelisted results', async () => {
    const active = normalizedNode('active', 1083)
    const inactive = normalizedNode('inactive', 1084)
    const { manager, delay } = await setup()
    await manager.appendImportedNodes([active, inactive])
    await enablePorts(manager, [1], {
      1: [{ mode: 'manual', nodeIds: [active.id] }],
    })

    await expect(manager.testNode(active.id)).resolves.toEqual({
      reachable: true,
      latencyMs: 42,
    })
    expect(delay).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`/proxies/GW-NODE-${active.id}/delay\\?.*timeout=5000`),
      ),
    )

    delay.mockResolvedValueOnce(Response.json({ delay: 0 }))
    await expect(manager.testNode(active.id)).resolves.toEqual({
      reachable: false,
      errorCode: 'PROBE_FAILED',
    })
    delay.mockRejectedValueOnce(new Error('controller leaked token=secret'))
    await expect(manager.testNode(active.id)).resolves.toEqual({
      reachable: false,
      errorCode: 'CONTROLLER_UNAVAILABLE',
    })
    await expect(manager.testNode(inactive.id)).resolves.toEqual({
      reachable: true,
      latencyMs: 42,
    })
    expect(delay).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`/proxies/GW-NODE-${inactive.id}/delay\\?`),
      ),
    )
    await manager.updateNode(inactive.id, { enabled: false })
    await expect(manager.testNode(inactive.id)).resolves.toEqual({
      reachable: false,
      errorCode: 'NODE_NOT_ACTIVE',
    })
    await expect(manager.testNode('node_missing')).resolves.toEqual({
      reachable: false,
      errorCode: 'NODE_NOT_FOUND',
    })
  })

  it('reports delete impact, requires confirmation, shrinks two hops to one, and disables an empty route', async () => {
    const first = normalizedNode('first', 1085)
    const second = normalizedNode('second', 1086)
    const landing = normalizedNode('landing', 1087)
    const { manager } = await setup()
    await manager.appendImportedNodes([first, second, landing])
    await enablePorts(manager, [1, 2], {
      1: [
        { mode: 'auto', nodeIds: [first.id, second.id] },
        { mode: 'manual', nodeIds: [landing.id] },
      ],
      2: [{ mode: 'manual', nodeIds: [first.id] }],
    })

    await expect(manager.nodeImpact(first.id)).resolves.toEqual({
      affectedPortIds: [1, 2],
    })
    await expect(manager.deleteNode(first.id, false)).rejects.toMatchObject({
      statusCode: 409,
      details: { affectedPortIds: [1, 2] },
    })
    expect(JSON.stringify(await manager.listNodes())).not.toContain(
      'upstream-secret',
    )

    await manager.deleteNode(first.id, true)
    expect((await manager.listPorts())[0]!.hops).toEqual([
      { mode: 'auto', nodeIds: [second.id] },
      { mode: 'manual', nodeIds: [landing.id] },
    ])
    expect((await manager.listPorts())[1]).toMatchObject({
      enabled: false,
      hops: [],
    })

    await manager.deleteNode(second.id, true)
    expect((await manager.listPorts())[0]).toMatchObject({
      enabled: true,
      hops: [{ mode: 'manual', nodeIds: [landing.id] }],
    })
    await manager.deleteNode(landing.id, true)
    expect((await manager.listPorts())[0]).toMatchObject({
      enabled: false,
      hops: [],
    })
    expect(await manager.listNodes()).toEqual([])
  })

  it('deduplicates a stable ID across sources, excludes every deleted subscription copy, and clears exclusions only on explicit import', async () => {
    const node = normalizedNode('shared', 1088)
    const otherName = renamed(node, 'shared-renamed')
    const { manager } = await setup()
    await manager.replaceNodeSource(
      'subscription:first',
      [node],
      'subscription.sync',
    )
    await manager.replaceNodeSource(
      'subscription:second',
      [otherName],
      'subscription.sync',
    )
    await manager.appendImportedNodes([otherName])
    expect(await manager.listNodes()).toHaveLength(1)

    await manager.deleteNode(node.id, false)
    expect(await manager.listNodes()).toEqual([])

    await manager.replaceNodeSource(
      'subscription:first',
      [],
      'subscription.disable',
    )
    await manager.replaceNodeSource(
      'subscription:first',
      [node],
      'subscription.enable',
    )
    await manager.replaceNodeSource(
      'subscription:second',
      [otherName],
      'subscription.sync',
    )
    expect(await manager.listNodes()).toEqual([])

    await manager.appendImportedNodes([node])
    await manager.replaceNodeSource(
      'subscription:first',
      [node],
      'subscription.sync',
    )
    await manager.replaceNodeSource(
      'subscription:second',
      [otherName],
      'subscription.sync',
    )
    await manager.removeNodeSource('manual', 'manual.remove')
    expect(await manager.listNodes()).toHaveLength(1)

    await manager.deleteNode(node.id, false)
    expect(await manager.listNodes()).toEqual([])
  })

  it('keeps hop count stable for ordinary source updates and rejects removal of the final candidate', async () => {
    const first = normalizedNode('first-source-node', 1090)
    const second = normalizedNode('second-source-node', 1091)
    const unrelated = normalizedNode('unrelated-source-node', 1092)
    const landing = normalizedNode('landing-source-node', 1095)
    const { manager } = await setup()
    await manager.replaceNodeSource(
      'subscription:routed',
      [first, second],
      'subscription.sync',
    )
    await manager.appendImportedNodes([landing])
    await enablePorts(manager, [1], {
      1: [
        { mode: 'auto', nodeIds: [first.id, second.id] },
        { mode: 'manual', nodeIds: [landing.id] },
      ],
    })

    await manager.replaceNodeSource(
      'subscription:routed',
      [second],
      'subscription.sync',
    )
    expect((await manager.listPorts())[0]!.hops).toEqual([
      { mode: 'auto', nodeIds: [second.id] },
      { mode: 'manual', nodeIds: [landing.id] },
    ])

    await expect(
      manager.replaceNodeSource(
        'subscription:routed',
        [unrelated],
        'subscription.sync',
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { affectedPortIds: [1] },
    })
    await expect(
      manager.replaceNodeSources(
        [
          { sourceId: 'subscription:routed', nodes: [] },
          { sourceId: 'subscription:other', nodes: [unrelated] },
        ],
        'subscriptions.refresh',
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { affectedPortIds: [1] },
    })
    await expect(
      manager.removeNodeSource('subscription:routed', 'subscription.delete'),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { affectedPortIds: [1] },
    })
    expect((await manager.listPorts())[0]!.hops).toEqual([
      { mode: 'auto', nodeIds: [second.id] },
      { mode: 'manual', nodeIds: [landing.id] },
    ])
    expect(new Set((await manager.listNodes()).map(({ id }) => id))).toEqual(
      new Set([second.id, landing.id]),
    )
  })

  it('uses one pre-batch enabled snapshot regardless of source replacement order', async () => {
    const node = normalizedNode('disabled-shared', 1093)
    const { manager } = await setup()
    await manager.replaceNodeSource(
      'subscription:a',
      [node],
      'subscription.sync',
    )
    await manager.updateNode(node.id, { enabled: false })

    await manager.replaceNodeSources(
      [
        { sourceId: 'subscription:a', nodes: [] },
        { sourceId: 'subscription:b', nodes: [node] },
      ],
      'subscriptions.refresh',
    )
    expect(await manager.listNodes()).toEqual([
      expect.objectContaining({ id: node.id, enabled: false }),
    ])

    await manager.replaceNodeSources(
      [
        { sourceId: 'subscription:b', nodes: [] },
        { sourceId: 'subscription:a', nodes: [node] },
      ],
      'subscriptions.refresh',
    )
    expect(await manager.listNodes()).toEqual([
      expect.objectContaining({ id: node.id, enabled: false }),
    ])
  })

  it('rejects explicitly enabling a port whose only node candidate is disabled', async () => {
    const node = normalizedNode('disabled-only', 1094)
    const { manager } = await setup()
    await manager.appendImportedNodes([node])
    await manager.updateNode(node.id, { enabled: false })
    await manager.createCredential({
      username: 'disabled-only-user',
      password: 'disabled-only-password',
      portIds: [1],
    })

    await expect(
      manager.updatePort(1, {
        enabled: true,
        hops: [{ mode: 'manual', nodeIds: [node.id] }],
      }),
    ).rejects.toThrow(/enabled node candidate/i)
    expect((await manager.listPorts())[0]).toMatchObject({
      enabled: false,
      hops: [],
    })
  })
})
