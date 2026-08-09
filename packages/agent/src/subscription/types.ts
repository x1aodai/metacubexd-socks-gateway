export const SUPPORTED_PROXY_TYPES = [
  'vless',
  'vmess',
  'trojan',
  'ss',
  'hysteria2',
  'tuic',
  'socks5',
  'http',
] as const

export type SupportedProxyType = (typeof SUPPORTED_PROXY_TYPES)[number]

export interface MihomoProxy {
  name: string
  type: SupportedProxyType
  server: string
  port: number
  [key: string]: unknown
}

export type SubscriptionFormat =
  'mihomo-config' | 'provider' | 'links' | 'base64-links' | 'unknown'

export type ImportIssueCode =
  | 'invalid-document'
  | 'invalid-node'
  | 'unsupported-protocol'
  | 'duplicate-node'

export interface ImportIssue {
  code: ImportIssueCode
  message: string
  /** One-based line or YAML array item number when one is available. */
  index?: number
}

export interface NormalizedNode {
  /** Stable across imports and node renames; derived from connection identity. */
  id: string
  /** Original source name before deterministic collision suffixing. */
  originalName: string
  proxy: MihomoProxy
}

export interface ImportPreviewSummary {
  total: number
  valid: number
  skipped: number
  protocols: Partial<Record<SupportedProxyType, number>>
}

export interface ImportPreview {
  format: SubscriptionFormat
  nodes: NormalizedNode[]
  issues: ImportIssue[]
  summary: ImportPreviewSummary
}
