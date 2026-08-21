import type { GatewayStateV2, StoredNode } from './gateway-state'
import type { MihomoProxy } from './subscription/types'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { generateGatewayConfig } from './gateway-config'
import { createInitialGatewayStateV2 } from './gateway-state'
import { stableNodeId } from './subscription/parse'

function proxy(
  name: string,
  port: number,
  extra: Record<string, unknown> = {},
): MihomoProxy {
  return {
    name,
    type: 'socks5',
    server: '203.0.113.20',
    port,
    username: `upstream-${port}`,
    password: `secret-${port}`,
    ...extra,
  }
}

function storedNode(value: MihomoProxy, enabled = true): StoredNode {
  return { id: stableNodeId(value), enabled, proxy: value }
}

function tenPortState(): {
  state: GatewayStateV2
  nodes: StoredNode[]
} {
  const state = createInitialGatewayStateV2()
  const nodes = [
    storedNode(proxy('same display name', 1080)),
    storedNode(proxy('same display name', 1081)),
    storedNode(proxy('third', 1082)),
  ]
  state.nodeSources = {
    manual: { nodes, excludedNodeIds: [] },
    duplicate: {
      nodes: [
        {
          ...nodes[0]!,
          proxy: { ...nodes[0]!.proxy, name: 'renamed duplicate' },
        },
      ],
      excludedNodeIds: [],
    },
  }
  state.credentials = [
    {
      id: 'alice',
      username: 'alice',
      password: 'alice-password',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'bob',
      username: 'bob',
      password: 'bob-password',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'disabled',
      username: 'disabled',
      password: 'disabled-password',
      enabled: false,
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  for (const [index, port] of state.ports.entries()) {
    const mode = ['manual', 'auto', 'failover'][index % 3] as
      'manual' | 'auto' | 'failover'
    port.enabled = true
    port.credentialIds = index % 2 === 0 ? ['alice', 'disabled'] : ['bob']
    port.hops = [
      {
        mode,
        nodeIds:
          mode === 'manual'
            ? [nodes[index % nodes.length]!.id]
            : nodes.map(({ id }) => id),
      },
    ]
  }
  return { state, nodes }
}

function rendered(base: string, state: GatewayStateV2) {
  return parse(generateGatewayConfig(base, state)) as Record<string, unknown>
}

describe('single-hop gateway config generator', () => {
  it('generates ten isolated authenticated listeners and all three group modes', () => {
    const { state, nodes } = tenPortState()
    const config = rendered('{}', state)
    const listeners = config.listeners as Array<Record<string, unknown>>
    const groups = config['proxy-groups'] as Array<Record<string, unknown>>
    const proxies = config.proxies as Array<Record<string, unknown>>

    expect(listeners).toHaveLength(10)
    expect(listeners.map(({ name }) => name)).toEqual(
      state.ports.map(({ port }) => `gateway-socks-${port}`),
    )
    expect(listeners[0]).toEqual({
      name: 'gateway-socks-10001',
      type: 'socks',
      listen: '0.0.0.0',
      port: 10001,
      udp: false,
      proxy: 'GW-10001-H1',
      users: [{ username: 'alice', password: 'alice-password' }],
    })
    expect(listeners[1]).toMatchObject({
      name: 'gateway-socks-10002',
      proxy: 'GW-10002-H1',
      users: [{ username: 'bob', password: 'bob-password' }],
    })
    expect(groups).toHaveLength(10)
    expect(
      groups.slice(0, 3).map(({ name, type }) => ({ name, type })),
    ).toEqual([
      { name: 'GW-10001-H1', type: 'select' },
      { name: 'GW-10002-H1', type: 'url-test' },
      { name: 'GW-10003-H1', type: 'fallback' },
    ])
    expect(proxies).toHaveLength(nodes.length)
    expect(proxies.map(({ name }) => name)).toEqual(
      nodes.map(({ id }) => `GW-NODE-${id}`),
    )
    expect(new Set(proxies.map(({ name }) => name)).size).toBe(nodes.length)
    expect(config.rules).toEqual([
      ...state.ports.map(
        ({ port }) => `IN-NAME,gateway-socks-${port},GW-${port}-H1`,
      ),
      'MATCH,REJECT',
    ])
  })

  it('does not generate a listener or group for a disabled port', () => {
    const { state } = tenPortState()
    state.ports[4]!.enabled = false
    const config = rendered('{}', state)
    const serialized = JSON.stringify(config)

    expect(config.listeners).toHaveLength(9)
    expect(config['proxy-groups']).toHaveLength(9)
    expect(serialized).not.toContain('gateway-socks-10005')
    expect(serialized).not.toContain('GW-10005-H1')
  })

  it('rebuilds from a minimal safe document and discards a malicious base', () => {
    const { state } = tenPortState()
    const config = rendered(
      `
port: 7890
socks-port: 7891
mixed-port: 7892
authentication: [anonymous:unsafe]
skip-auth-prefixes: [0.0.0.0/0]
external-controller: 0.0.0.0:9090
secret: leaked-controller-secret
tun: { enable: true }
listeners:
  - { name: anonymous-http, type: http, listen: 0.0.0.0, port: 8088 }
proxies:
  - { name: old-node, type: direct }
proxy-providers:
  old-provider: { type: http, url: https://secret.example/sub }
proxy-groups:
  - { name: old-group, type: select, proxies: [DIRECT] }
rule-providers:
  old-rules: { type: http, url: https://secret.example/rules }
rules:
  - MATCH,DIRECT
`,
      state,
    )
    const serialized = JSON.stringify(config)

    expect(Object.keys(config).sort()).toEqual(
      ['ipv6', 'listeners', 'mode', 'proxies', 'proxy-groups', 'rules'].sort(),
    )
    expect(serialized).not.toContain('DIRECT')
    expect(serialized).not.toContain('old-')
    expect(serialized).not.toContain('anonymous')
    expect(serialized).not.toContain('leaked-controller-secret')
    expect(serialized).not.toContain('secret.example')
  })

  it('deduplicates stable nodes across sources despite display-name collisions', () => {
    const { state, nodes } = tenPortState()
    const config = rendered('{}', state)
    const proxies = config.proxies as Array<Record<string, unknown>>
    const firstGroup = (
      config['proxy-groups'] as Array<Record<string, unknown>>
    )[0]!

    expect(proxies).toHaveLength(3)
    expect(proxies.map(({ name }) => name)).toEqual(
      nodes.map(({ id }) => `GW-NODE-${id}`),
    )
    expect(firstGroup.proxies).toEqual([`GW-NODE-${nodes[0]!.id}`, 'REJECT'])
  })

  it('only emits enabled node candidates and falls back to REJECT', () => {
    const { state, nodes } = tenPortState()
    for (const source of Object.values(state.nodeSources)) {
      for (const node of source.nodes) node.enabled = false
    }
    const config = rendered('{}', state)
    const groups = config['proxy-groups'] as Array<Record<string, unknown>>

    expect(config.proxies).toEqual([])
    expect(groups[0]?.proxies).toEqual(['REJECT'])
    expect(JSON.stringify(config)).not.toContain(`GW-NODE-${nodes[0]!.id}`)
  })

  it('rejects imported route-control fields instead of honoring them', () => {
    const { state } = tenPortState()
    const unsafe = storedNode(
      proxy('unsafe', 3000, { 'dialer-proxy': 'DIRECT' }),
    )
    state.nodeSources = {
      manual: { nodes: [unsafe], excludedNodeIds: [] },
    }
    for (const port of state.ports) {
      port.hops = [{ mode: 'manual', nodeIds: [unsafe.id] }]
    }

    expect(() => generateGatewayConfig('{}', state)).toThrow(
      /route-control field dialer-proxy/i,
    )
  })

  it.each(['direct', 'reject'])(
    'rejects decrypted nodes with unsupported runtime type %s',
    (type) => {
      const { state } = tenPortState()
      const unsafeProxy = proxy('unsafe-type', 3000) as unknown as Record<
        string,
        unknown
      >
      unsafeProxy.type = type
      const unsafe = storedNode(unsafeProxy as unknown as MihomoProxy)
      state.nodeSources = {
        manual: { nodes: [unsafe], excludedNodeIds: [] },
      }
      for (const port of state.ports) {
        port.hops = [{ mode: 'manual', nodeIds: [unsafe.id] }]
      }

      expect(() => generateGatewayConfig('{}', state)).toThrow(
        new RegExp(`unsupported proxy type ${type}`, 'i'),
      )
    },
  )

  it('removes node udp flags and always writes listener udp false', () => {
    const state = createInitialGatewayStateV2()
    const udpNode = storedNode(proxy('udp-node', 1080, { udp: true }))
    state.nodeSources = {
      manual: { nodes: [udpNode], excludedNodeIds: [] },
    }
    state.credentials = [
      {
        id: 'alice',
        username: 'alice',
        password: 'alice-password',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    state.ports[0] = {
      ...state.ports[0]!,
      enabled: true,
      credentialIds: ['alice'],
      hops: [{ mode: 'manual', nodeIds: [udpNode.id] }],
    }
    const config = rendered('{}', state)
    const emittedNode = (config.proxies as Array<Record<string, unknown>>)[0]!
    const listener = (config.listeners as Array<Record<string, unknown>>)[0]!

    expect(emittedNode.udp).toBeUndefined()
    expect(listener.udp).toBe(false)
    expect(JSON.stringify(config)).not.toContain('"udp":true')
  })

  it('validates state and rejects two-hop input until the Task 3 generator exists', () => {
    const { state, nodes } = tenPortState()
    state.ports[0]!.port = 11001
    expect(() => generateGatewayConfig('{}', state)).toThrow(/fixed port/i)

    const twoHop = tenPortState().state
    twoHop.ports[0]!.hops = [
      { mode: 'manual', nodeIds: [nodes[0]!.id] },
      { mode: 'manual', nodeIds: [nodes[1]!.id] },
    ]
    expect(() => generateGatewayConfig('{}', twoHop)).toThrow(
      /single-hop generator/i,
    )
  })
})
