import type { MihomoProxy } from './subscription/types'
import { stableNodeId } from './subscription/parse'

export const GATEWAY_PORTS = [
  10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010,
] as const

export type GatewayMode = 'manual' | 'auto' | 'failover'

export interface GatewayHop {
  mode: GatewayMode
  nodeIds: string[]
}

export interface GatewayPort {
  id: number
  port: number
  enabled: boolean
  credentialIds: string[]
  hops: GatewayHop[]
}

export interface StoredGatewayCredential {
  id: string
  username: string
  password: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface StoredGatewayRevision {
  id: string
  createdAt: number
  reason: string
}

export interface StoredNode {
  id: string
  enabled: boolean
  proxy: MihomoProxy
}

export interface StoredNodeSource {
  nodes: StoredNode[]
  excludedNodeIds: string[]
}

export interface GatewayStateV1 {
  version: 1
  gateway: {
    enabled: boolean
    port: number
    udp: boolean
    mode: GatewayMode
    selectedNode?: string
    updatedAt: number
  }
  credentials: StoredGatewayCredential[]
  nodeSources: Record<string, MihomoProxy[]>
  revisions: StoredGatewayRevision[]
  lastAppliedAt?: number
  lastError?: string
}

export interface GatewayStateV2 {
  version: 2
  ports: GatewayPort[]
  credentials: StoredGatewayCredential[]
  nodeSources: Record<string, StoredNodeSource>
  revisions: StoredGatewayRevision[]
  lastAppliedAt?: number
  lastError?: string
}

export function createInitialGatewayStateV2(): GatewayStateV2 {
  return {
    version: 2,
    ports: GATEWAY_PORTS.map((port, index) => ({
      id: index + 1,
      port,
      enabled: false,
      credentialIds: [],
      hops: [],
    })),
    credentials: [],
    nodeSources: {},
    revisions: [],
  }
}

export function validateGatewayStateV2(state: GatewayStateV2): void {
  if (state.version !== 2) throw new Error('gateway state must use version 2')
  if (
    !Array.isArray(state.ports) ||
    state.ports.length !== GATEWAY_PORTS.length
  )
    throw new Error('gateway state must contain exactly 10 port slots')

  const credentials = new Map(
    state.credentials.map((credential) => [credential.id, credential]),
  )
  const nodeIds = new Set<string>()
  for (const source of Object.values(state.nodeSources)) {
    for (const node of source.nodes) {
      if (node.id !== stableNodeId(node.proxy))
        throw new Error(`node ${node.id} does not match its stable node ID`)
      nodeIds.add(node.id)
    }
  }

  for (const [index, port] of state.ports.entries()) {
    const expectedPort = GATEWAY_PORTS[index]!
    if (port.id !== index + 1 || port.port !== expectedPort)
      throw new Error(
        `gateway port slot ${index + 1} must use fixed port ${expectedPort}`,
      )
    if (!Array.isArray(port.credentialIds))
      throw new Error(`gateway port ${port.id} has invalid credentials`)
    if (new Set(port.credentialIds).size !== port.credentialIds.length)
      throw new Error(`gateway port ${port.id} has duplicate credentials`)

    for (const credentialId of port.credentialIds) {
      if (!credentials.has(credentialId))
        throw new Error(
          `gateway port ${port.id} references unknown credential ${credentialId}`,
        )
    }

    if (!Array.isArray(port.hops))
      throw new Error(`gateway port ${port.id} has invalid hops`)
    if (port.enabled && (port.hops.length < 1 || port.hops.length > 2))
      throw new Error(
        `enabled gateway port ${port.id} requires one or two hops`,
      )
    if (port.hops.length > 2)
      throw new Error(`gateway port ${port.id} may contain at most two hops`)
    if (
      port.enabled &&
      !port.credentialIds.some((id) => credentials.get(id)?.enabled)
    )
      throw new Error(
        `enabled gateway port ${port.id} requires an enabled credential`,
      )

    for (const hop of port.hops) validateHop(port.id, hop, nodeIds)
    if (port.hops.length === 2) {
      const firstHopIds = new Set(port.hops[0]!.nodeIds)
      if (port.hops[1]!.nodeIds.some((id) => firstHopIds.has(id)))
        throw new Error(
          `gateway port ${port.id} cannot use the same node in consecutive hops`,
        )
    }
  }
}

export function migrateV1ToV2(state: GatewayStateV1): GatewayStateV2 {
  const nodeNames = new Map<string, Set<string>>()
  const allNodeIds: string[] = []
  const seenNodeIds = new Set<string>()
  const nodeSources = Object.fromEntries(
    Object.entries(state.nodeSources).map(([sourceId, proxies]) => {
      const nodes = proxies.map((proxy) => {
        assertMigratableProxy(proxy, sourceId)
        const stored = {
          id: stableNodeId(proxy),
          enabled: true,
          proxy: structuredClone(proxy),
        } satisfies StoredNode
        const idsForName = nodeNames.get(proxy.name) ?? new Set<string>()
        idsForName.add(stored.id)
        nodeNames.set(proxy.name, idsForName)
        if (!seenNodeIds.has(stored.id)) {
          seenNodeIds.add(stored.id)
          allNodeIds.push(stored.id)
        }
        return stored
      })
      return [
        sourceId,
        { nodes, excludedNodeIds: [] } satisfies StoredNodeSource,
      ]
    }),
  )
  const credentialIds = state.credentials
    .filter((credential) => credential.enabled)
    .map((credential) => credential.id)
  const hops = migrateV1Hops(state, nodeNames, allNodeIds)
  const migrated = createInitialGatewayStateV2()
  migrated.ports[0] = {
    id: 1,
    port: GATEWAY_PORTS[0],
    enabled: state.gateway.enabled,
    credentialIds,
    hops,
  }
  migrated.credentials = structuredClone(state.credentials)
  migrated.nodeSources = nodeSources
  migrated.revisions = structuredClone(state.revisions)
  migrated.lastAppliedAt = state.lastAppliedAt
  migrated.lastError = state.lastError
  validateGatewayStateV2(migrated)
  return migrated
}

function validateHop(
  portId: number,
  hop: GatewayHop,
  nodeIds: ReadonlySet<string>,
): void {
  if (!['manual', 'auto', 'failover'].includes(hop.mode))
    throw new Error(`gateway port ${portId} has an invalid hop mode`)
  if (!Array.isArray(hop.nodeIds))
    throw new Error(`gateway port ${portId} has invalid hop candidates`)
  if (hop.mode === 'manual' && hop.nodeIds.length !== 1)
    throw new Error(
      `gateway port ${portId} manual hop requires exactly one node`,
    )
  if (hop.mode !== 'manual' && hop.nodeIds.length === 0)
    throw new Error(
      `gateway port ${portId} ${hop.mode} hop requires at least one node`,
    )
  if (new Set(hop.nodeIds).size !== hop.nodeIds.length)
    throw new Error(`gateway port ${portId} hop has duplicate nodes`)
  for (const nodeId of hop.nodeIds) {
    if (!nodeIds.has(nodeId))
      throw new Error(
        `gateway port ${portId} references unknown node ${nodeId}`,
      )
  }
}

function migrateV1Hops(
  state: GatewayStateV1,
  nodeNames: ReadonlyMap<string, ReadonlySet<string>>,
  allNodeIds: string[],
): GatewayHop[] {
  if (state.gateway.mode === 'manual') {
    const matches = state.gateway.selectedNode
      ? nodeNames.get(state.gateway.selectedNode)
      : undefined
    if (!matches || matches.size !== 1) {
      if (state.gateway.enabled)
        throw new Error('cannot map enabled v1 manual node to a stable node ID')
      return []
    }
    return [{ mode: 'manual', nodeIds: [...matches] }]
  }

  if (state.gateway.mode === 'auto' || state.gateway.mode === 'failover') {
    if (allNodeIds.length === 0) {
      if (state.gateway.enabled)
        throw new Error(
          `cannot map enabled v1 ${state.gateway.mode} route without persisted nodes`,
        )
      return []
    }
    return [{ mode: state.gateway.mode, nodeIds: [...allNodeIds] }]
  }

  throw new Error('cannot migrate v1 gateway with an invalid outbound mode')
}

function assertMigratableProxy(proxy: MihomoProxy, sourceId: string): void {
  if (
    !proxy ||
    typeof proxy !== 'object' ||
    typeof proxy.name !== 'string' ||
    !proxy.name ||
    typeof proxy.type !== 'string' ||
    typeof proxy.server !== 'string' ||
    !Number.isInteger(proxy.port)
  )
    throw new Error(`cannot migrate invalid node from source ${sourceId}`)
}
