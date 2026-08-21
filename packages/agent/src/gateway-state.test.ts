import type {
  GatewayStateV1,
  GatewayStateV2,
  StoredGatewayCredential,
  StoredNode,
} from './gateway-state'
import type { MihomoProxy } from './subscription/types'
import { describe, expect, it } from 'vitest'
import {
  createInitialGatewayStateV2,
  GATEWAY_PORTS,
  migrateV1ToV2,
  validateGatewayStateV2,
} from './gateway-state'
import { stableNodeId } from './subscription/parse'

function proxy(name: string, port: number): MihomoProxy {
  return {
    name,
    type: 'socks5',
    server: '203.0.113.10',
    port,
    username: `upstream-${port}`,
    password: `secret-${port}`,
  }
}

function credential(id: string, enabled: boolean): StoredGatewayCredential {
  return {
    id,
    username: id,
    password: `password-for-${id}`,
    enabled,
    createdAt: 10,
    updatedAt: 20,
  }
}

function storedNode(value: MihomoProxy, enabled = true): StoredNode {
  return { id: stableNodeId(value), enabled, proxy: value }
}

function validState(): GatewayStateV2 {
  const state = createInitialGatewayStateV2()
  const first = proxy('first', 1080)
  const second = proxy('second', 1081)
  const third = proxy('third', 1082)
  const nodes = [first, second, third].map((node) => storedNode(node))
  state.credentials = [
    credential('enabled', true),
    credential('disabled', false),
  ]
  state.nodeSources = {
    manual: { nodes, excludedNodeIds: [] },
  }
  state.ports[0] = {
    ...state.ports[0]!,
    enabled: true,
    credentialIds: ['enabled', 'disabled'],
    hops: [{ mode: 'manual', nodeIds: [nodes[0]!.id] }],
  }
  state.ports[1] = {
    ...state.ports[1]!,
    enabled: true,
    credentialIds: ['enabled'],
    hops: [{ mode: 'auto', nodeIds: [nodes[0]!.id, nodes[1]!.id] }],
  }
  state.ports[2] = {
    ...state.ports[2]!,
    enabled: true,
    credentialIds: ['enabled'],
    hops: [{ mode: 'failover', nodeIds: [nodes[2]!.id] }],
  }
  return state
}

function v1State(
  overrides: Partial<GatewayStateV1['gateway']> = {},
): GatewayStateV1 {
  return {
    version: 1,
    gateway: {
      enabled: true,
      port: 1080,
      udp: true,
      mode: 'auto',
      updatedAt: 123,
      ...overrides,
    },
    credentials: [credential('enabled', true), credential('disabled', false)],
    nodeSources: {
      manual: [proxy('alpha', 2080), proxy('beta', 2081)],
    },
    revisions: [{ id: 'revision-1', createdAt: 100, reason: 'before' }],
    lastAppliedAt: 200,
    lastError: 'previous failure',
  }
}

describe('gateway v2 state', () => {
  it('creates exactly ten fixed disabled port slots', () => {
    const state = createInitialGatewayStateV2()

    expect(state).toMatchObject({
      version: 2,
      credentials: [],
      nodeSources: {},
      revisions: [],
    })
    expect(GATEWAY_PORTS).toEqual([
      10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010,
    ])
    expect(state.ports).toEqual(
      GATEWAY_PORTS.map((port, index) => ({
        id: index + 1,
        port,
        enabled: false,
        credentialIds: [],
        hops: [],
      })),
    )
    expect(() => validateGatewayStateV2(state)).not.toThrow()
  })

  it('accepts manual, auto, and failover hops backed by an enabled credential', () => {
    expect(() => validateGatewayStateV2(validState())).not.toThrow()
  })

  it('requires the exact fixed port slots', () => {
    const missing = validState()
    missing.ports.pop()
    expect(() => validateGatewayStateV2(missing)).toThrow(/exactly 10/i)

    const changed = validState()
    changed.ports[0] = { ...changed.ports[0]!, port: 11001 }
    expect(() => validateGatewayStateV2(changed)).toThrow(/fixed port/i)
  })

  it('requires enabled ports to have one or two hops and an enabled credential', () => {
    const noHops = validState()
    noHops.ports[0]!.hops = []
    expect(() => validateGatewayStateV2(noHops)).toThrow(/one or two hops/i)

    const threeHops = validState()
    threeHops.ports[0]!.hops = [
      ...threeHops.ports[0]!.hops,
      ...threeHops.ports[1]!.hops,
      ...threeHops.ports[2]!.hops,
    ]
    expect(() => validateGatewayStateV2(threeHops)).toThrow(/one or two hops/i)

    const disabledOnly = validState()
    disabledOnly.ports[0]!.credentialIds = ['disabled']
    expect(() => validateGatewayStateV2(disabledOnly)).toThrow(
      /enabled credential/i,
    )

    const unknownCredential = validState()
    unknownCredential.ports[0]!.credentialIds = ['missing']
    expect(() => validateGatewayStateV2(unknownCredential)).toThrow(
      /unknown credential/i,
    )
  })

  it('enforces each hop mode candidate contract', () => {
    const manualEmpty = validState()
    manualEmpty.ports[0]!.hops = [{ mode: 'manual', nodeIds: [] }]
    expect(() => validateGatewayStateV2(manualEmpty)).toThrow(
      /manual hop.*exactly one/i,
    )

    const manualMany = validState()
    manualMany.ports[0]!.hops = [
      {
        mode: 'manual',
        nodeIds: [
          manualMany.ports[0]!.hops[0]!.nodeIds[0]!,
          manualMany.ports[1]!.hops[0]!.nodeIds[1]!,
        ],
      },
    ]
    expect(() => validateGatewayStateV2(manualMany)).toThrow(
      /manual hop.*exactly one/i,
    )

    for (const mode of ['auto', 'failover'] as const) {
      const state = validState()
      state.ports[0]!.hops = [{ mode, nodeIds: [] }]
      expect(() => validateGatewayStateV2(state)).toThrow(
        new RegExp(`${mode} hop.*at least one`, 'i'),
      )
    }
  })

  it('rejects unknown nodes and any overlap between consecutive hops', () => {
    const unknown = validState()
    unknown.ports[0]!.hops = [{ mode: 'manual', nodeIds: ['node_missing'] }]
    expect(() => validateGatewayStateV2(unknown)).toThrow(/unknown node/i)

    const repeated = validState()
    const firstId = repeated.ports[0]!.hops[0]!.nodeIds[0]!
    repeated.ports[0]!.hops = [
      { mode: 'auto', nodeIds: [firstId] },
      { mode: 'failover', nodeIds: [firstId] },
    ]
    expect(() => validateGatewayStateV2(repeated)).toThrow(/consecutive hops/i)
  })
})

describe('gateway v1 to v2 migration', () => {
  it.each(['manual', 'auto', 'failover'] as const)(
    'maps an enabled %s route to port 10001 with stable node IDs',
    (mode) => {
      const source = v1State({
        mode,
        ...(mode === 'manual' ? { selectedNode: 'beta' } : {}),
      })
      const migrated = migrateV1ToV2(source)
      const firstPort = migrated.ports[0]!
      const allNodeIds = Object.values(migrated.nodeSources).flatMap(
        ({ nodes }) => nodes.map(({ id }) => id),
      )

      expect(firstPort).toMatchObject({
        id: 1,
        port: 10001,
        enabled: true,
        credentialIds: ['enabled'],
      })
      expect(firstPort.hops).toHaveLength(1)
      expect(firstPort.hops[0]?.mode).toBe(mode)
      expect(firstPort.hops[0]?.nodeIds).toEqual(
        mode === 'manual'
          ? [stableNodeId(source.nodeSources.manual![1] as MihomoProxy)]
          : allNodeIds,
      )
      expect(migrated.credentials).toEqual(source.credentials)
      expect(
        migrated.credentials.find(({ id }) => id === 'disabled'),
      ).toMatchObject({ enabled: false })
      expect(migrated.ports.slice(1)).toEqual(
        GATEWAY_PORTS.slice(1).map((port, index) => ({
          id: index + 2,
          port,
          enabled: false,
          credentialIds: [],
          hops: [],
        })),
      )
      expect(migrated.revisions).toEqual(source.revisions)
      expect(migrated.lastAppliedAt).toBe(200)
      expect(migrated.lastError).toBe('previous failure')
      expect(() => validateGatewayStateV2(migrated)).not.toThrow()
    },
  )

  it('keeps a disabled v1 gateway disabled when its manual node cannot be mapped', () => {
    const migrated = migrateV1ToV2(
      v1State({ enabled: false, mode: 'manual', selectedNode: 'missing' }),
    )

    expect(migrated.ports[0]).toMatchObject({
      enabled: false,
      credentialIds: ['enabled'],
      hops: [],
    })
    expect(() => validateGatewayStateV2(migrated)).not.toThrow()
  })

  it('rejects an enabled manual route whose selected node cannot be mapped', () => {
    expect(() =>
      migrateV1ToV2(
        v1State({ enabled: true, mode: 'manual', selectedNode: 'missing' }),
      ),
    ).toThrow(/cannot map enabled v1 manual node/i)
  })

  it('rejects an enabled automatic route with no persisted nodes', () => {
    const source = v1State({ enabled: true, mode: 'auto' })
    source.nodeSources = {}

    expect(() => migrateV1ToV2(source)).toThrow(
      /cannot map enabled v1 auto route/i,
    )
  })

  it('rejects an enabled route with no enabled credential', () => {
    const source = v1State({ enabled: true, mode: 'failover' })
    source.credentials = [credential('disabled', false)]

    expect(() => migrateV1ToV2(source)).toThrow(/enabled credential/i)
  })
})
