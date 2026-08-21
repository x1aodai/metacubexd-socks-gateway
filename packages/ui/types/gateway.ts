export type GatewayMode = 'manual' | 'auto' | 'failover'
export type GatewayHealth = 'healthy' | 'unhealthy' | 'unknown' | 'disabled'

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

export interface GatewayNode {
  id: string
  name: string
  type: string
  enabled: boolean
  sourceIds: string[]
  portIds: number[]
  healthy?: boolean
  latency?: number | null
}

export interface GatewayNodeImpact {
  affectedPortIds: number[]
}

export type GatewayNodeTestErrorCode =
  | 'NODE_NOT_FOUND'
  | 'NODE_NOT_ACTIVE'
  | 'CONTROLLER_UNAVAILABLE'
  | 'PROBE_FAILED'

export interface GatewayNodeTestResult {
  reachable: boolean
  latencyMs?: number
  errorCode?: GatewayNodeTestErrorCode
}

export interface GatewayCredential {
  id: string
  username: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  portIds: number[]
}

export interface GatewayCreatedCredential extends GatewayCredential {
  password: string
}

export interface GatewayRotatedCredential {
  id: string
  password: string
}

export interface GatewaySubscription {
  id: string
  name: string
  urlMasked: string
  intervalMinutes: number
  enabled: boolean
  nodeCount: number
  createdAt: number
  updatedAt: number
  lastSyncAt?: number
  lastError?: string
}

export interface GatewaySubscriptionRefreshItem {
  id: string
  ok: boolean
  nodeCount: number
  error?: string
}

export interface GatewaySubscriptionRefreshResult {
  items: GatewaySubscriptionRefreshItem[]
}

export interface GatewayImportIssue {
  code: string
  message: string
  index?: number
}

export interface GatewayImportPreview {
  previewId: string
  format: string
  validCount: number
  skippedCount: number
  protocolCounts: Record<string, number>
  errors: string[]
  issues: GatewayImportIssue[]
  nodes: Array<Pick<GatewayNode, 'id' | 'name' | 'type'>>
}

export type GatewayImportApplyInput =
  | { previewId: string; content?: never }
  | { content: string; previewId?: never }

export interface GatewayRevision {
  id: string
  createdAt: number
  reason: string
}

export type GatewayListenerErrorCode =
  'NO_ENABLED_CREDENTIAL' | 'UNREACHABLE' | 'PROBE_FAILED'

export interface GatewayListenerStatus {
  id: number
  port: number
  enabled: boolean
  health: GatewayHealth
  reachable: boolean | null
  errorCode: GatewayListenerErrorCode | null
}

export interface GatewayHopStatus {
  index: 1 | 2
  mode: GatewayMode
  activeNodeId: string | null
  health: GatewayHealth
}

export interface GatewayPortStatus {
  id: number
  port: number
  enabled: boolean
  health: GatewayHealth
  hops: GatewayHopStatus[]
}

export type GatewayApplyErrorCode =
  | 'VALIDATION_FAILED'
  | 'RUNTIME_FAILED'
  | 'VERIFICATION_FAILED'
  | 'PERSIST_FAILED'
  | 'APPLY_FAILED'

export interface GatewayLastApply {
  result: 'success' | 'failure'
  at: number
  reason: string
  errorCode: GatewayApplyErrorCode | null
}

export interface GatewayStatus {
  services: {
    web: { state: 'running'; health: 'healthy' }
    agent: { state: 'running'; health: 'healthy' }
    mihomo: {
      state:
        'stopped' | 'starting' | 'running' | 'stopping' | 'errored' | 'unknown'
      health: Exclude<GatewayHealth, 'disabled'>
      controllerReachable: boolean
    }
  }
  versions: {
    web: string
    agent: string
    mihomo: string | null
  }
  listeners: GatewayListenerStatus[]
  ports: GatewayPortStatus[]
  lastApply: GatewayLastApply | null
}

export type GatewayAuthSession =
  | {
      authenticated: true
      user: string
      csrfToken: string
    }
  | {
      authenticated: false
    }

export interface GatewayCollection<T> {
  items: T[]
}
