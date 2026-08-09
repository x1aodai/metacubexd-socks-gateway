export type GatewayOutboundMode = 'manual' | 'auto' | 'failover'

export interface GatewayNode {
  id: string
  name: string
  type?: string
  provider?: string
  healthy?: boolean
  latency?: number | null
}

export interface GatewayConfig {
  enabled: boolean
  port: number
  udp: boolean
  mode: GatewayOutboundMode
  selectedNode?: string
  updatedAt?: number
  nodes?: GatewayNode[]
}

export interface GatewayStatus {
  running: boolean
  healthy: boolean
  listenerReachable?: boolean
  controllerReachable?: boolean
  activeNode?: string
  activeNodeName?: string
  mode?: GatewayOutboundMode
  port?: number
  lastAppliedAt?: number
  lastError?: string
  revision?: string
  nodes?: GatewayNode[]
}

export interface GatewayCredential {
  id: string
  username: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface GatewayCredentialSecret extends GatewayCredential {
  password?: string
}

export interface GatewaySubscription {
  id: string
  name: string
  urlMasked: string
  intervalMinutes: number
  enabled: boolean
  nodeCount: number
  lastSyncAt?: number
  lastError?: string
}

export interface GatewayRevision {
  id: string
  createdAt: number
  reason?: string
  active?: boolean
  summary?: string
}

export interface GatewayAuditEntry {
  id?: string
  at?: number
  ts?: number
  action: string
  result?: 'success' | 'failure'
  actor?: string
  detail?: unknown
}

export interface GatewayImportPreview {
  previewId?: string
  validCount: number
  skippedCount: number
  protocolCounts: Record<string, number>
  errors: Array<string | { code?: string; message: string; index?: number }>
  nodes?: Array<Pick<GatewayNode, 'id' | 'name' | 'type'>>
}

export interface GatewayAuthSession {
  authenticated: boolean
  user?: string | { username: string }
  csrfToken?: string
}

export type GatewayListResponse<T> = T[] | { items: T[] }
