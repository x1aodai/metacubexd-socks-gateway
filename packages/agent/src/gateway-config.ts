import type {
  GatewayMode,
  GatewayPort,
  GatewayStateV2,
  StoredNode,
} from './gateway-state'
import type { MihomoProxy } from './subscription/types'
import { stringify } from 'yaml'
import { validateGatewayStateV2 } from './gateway-state'
import { SUPPORTED_PROXY_TYPES } from './subscription/types'

const ROUTE_CONTROL_FIELDS = new Set([
  'dialer-proxy',
  'detour',
  'interface-name',
  'routing-mark',
])
const SUPPORTED_PROXY_TYPE_SET: ReadonlySet<string> = new Set(
  SUPPORTED_PROXY_TYPES,
)

const MODE_TYPES: Record<GatewayMode, 'select' | 'url-test' | 'fallback'> = {
  manual: 'select',
  auto: 'url-test',
  failover: 'fallback',
}

export function generateGatewayConfig(
  _baseContent: string,
  state: GatewayStateV2,
): string {
  validateGatewayStateV2(state)

  const enabledPorts = state.ports.filter(({ enabled }) => enabled)
  for (const port of enabledPorts) {
    if (port.hops.length !== 1)
      throw new Error(
        `single-hop generator cannot render gateway port ${port.port}`,
      )
  }

  const nodes = collectEnabledNodes(state)
  const referencedNodeIds = new Set(
    enabledPorts.flatMap((port) => port.hops[0]!.nodeIds),
  )
  const proxies = [...nodes.values()]
    .filter(({ id }) => referencedNodeIds.has(id))
    .map(renderProxy)
  const credentials = new Map(
    state.credentials.map((credential) => [credential.id, credential]),
  )

  const listeners = enabledPorts.map((port) => ({
    name: listenerName(port.port),
    type: 'socks',
    listen: '0.0.0.0',
    port: port.port,
    udp: false,
    proxy: groupName(port.port),
    users: port.credentialIds
      .map((id) => credentials.get(id))
      .filter((credential) => credential?.enabled)
      .map((credential) => ({
        username: credential!.username,
        password: credential!.password,
      })),
  }))
  const groups = enabledPorts.map((port) => renderGroup(port, nodes))

  return stringify(
    {
      mode: 'rule',
      ipv6: false,
      proxies,
      'proxy-groups': groups,
      rules: [
        ...enabledPorts.map(
          (port) =>
            `IN-NAME,${listenerName(port.port)},${groupName(port.port)}`,
        ),
        'MATCH,REJECT',
      ],
      listeners,
    },
    { lineWidth: 0 },
  )
}

function collectEnabledNodes(state: GatewayStateV2): Map<string, StoredNode> {
  const nodes = new Map<string, StoredNode>()
  for (const source of Object.values(state.nodeSources)) {
    for (const node of source.nodes) {
      assertSupportedProxyType(node)
      assertNoRouteControl(node)
      if (node.enabled && !nodes.has(node.id)) nodes.set(node.id, node)
    }
  }
  return nodes
}

function assertSupportedProxyType(node: StoredNode): void {
  const type: unknown = node.proxy.type
  if (typeof type !== 'string' || !SUPPORTED_PROXY_TYPE_SET.has(type))
    throw new Error(
      `node ${node.id} has unsupported proxy type ${String(type)}`,
    )
}

function assertNoRouteControl(node: StoredNode): void {
  for (const field of ROUTE_CONTROL_FIELDS) {
    if (field in node.proxy)
      throw new Error(
        `node ${node.id} contains forbidden route-control field ${field}`,
      )
  }
}

function renderProxy(node: StoredNode): MihomoProxy {
  const { name: _name, udp: _udp, ...connection } = node.proxy
  return {
    ...connection,
    name: runtimeNodeName(node.id),
  } as MihomoProxy
}

function renderGroup(
  port: GatewayPort,
  enabledNodes: ReadonlyMap<string, StoredNode>,
): Record<string, unknown> {
  const hop = port.hops[0]!
  const group = {
    name: groupName(port.port),
    type: MODE_TYPES[hop.mode],
    proxies: [
      ...hop.nodeIds.filter((id) => enabledNodes.has(id)).map(runtimeNodeName),
      'REJECT',
    ],
  }
  if (hop.mode === 'manual') return group
  return {
    ...group,
    url: 'https://www.gstatic.com/generate_204',
    interval: hop.mode === 'auto' ? 300 : 60,
    ...(hop.mode === 'auto' ? { tolerance: 50 } : {}),
  }
}

function listenerName(port: number): string {
  return `gateway-socks-${port}`
}

function groupName(port: number): string {
  return `GW-${port}-H1`
}

function runtimeNodeName(id: string): string {
  return `GW-NODE-${id}`
}
