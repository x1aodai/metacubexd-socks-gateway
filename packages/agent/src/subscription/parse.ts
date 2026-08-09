import type {
  ImportIssue,
  ImportPreview,
  MihomoProxy,
  NormalizedNode,
  SubscriptionFormat,
  SupportedProxyType,
} from './types.js'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { parse as parseYaml } from 'yaml'
import { SUPPORTED_PROXY_TYPES } from './types.js'

type UnknownRecord = Record<string, unknown>

interface Candidate {
  index: number
  value: unknown
}

const supportedTypes = new Set<string>(SUPPORTED_PROXY_TYPES)

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function port(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : undefined
}

function boolean(value: string | null): boolean | undefined {
  if (value === null) return undefined
  if (['1', 'true', 'yes'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no'].includes(value.toLowerCase())) return false
  return undefined
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function decodeBase64(value: string): string | undefined {
  const compact = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!compact || !/^[A-Z0-9+/]*={0,2}$/i.test(compact)) return undefined
  try {
    const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, '=')
    const output = Buffer.from(padded, 'base64').toString('utf8')
    const hasControlCharacter = Array.from(output).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 8 || (code >= 14 && code <= 31)
    })
    if (output.includes('\uFFFD') || hasControlCharacter) {
      return undefined
    }
    return output
  } catch {
    return undefined
  }
}

function nameFromUrl(url: URL, fallback: string): string {
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  return text(decode(fragment)) ?? fallback
}

function hostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '')
}

function parseHostPort(value: string): { server: string; port: number } {
  let server: string
  let rawPort: string
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end < 0 || value[end + 1] !== ':') throw new Error('invalid IPv6 host')
    server = value.slice(1, end)
    rawPort = value.slice(end + 2)
  } else {
    const separator = value.lastIndexOf(':')
    if (separator <= 0) throw new Error('missing server port')
    server = value.slice(0, separator)
    rawPort = value.slice(separator + 1)
  }
  const parsedPort = port(rawPort)
  if (!server || !parsedPort) throw new Error('invalid server or port')
  return { server, port: parsedPort }
}

function setIf(target: UnknownRecord, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== '') target[key] = value
}

function applyTransportOptions(proxy: UnknownRecord, url: URL): void {
  const q = url.searchParams
  const network = q.get('type') ?? q.get('network') ?? undefined
  setIf(proxy, 'network', network)
  setIf(proxy, 'client-fingerprint', q.get('fp') ?? undefined)
  setIf(proxy, 'flow', q.get('flow') ?? undefined)
  const alpn = q.get('alpn')
  if (alpn) proxy.alpn = alpn.split(',').filter(Boolean)

  if (network === 'ws') {
    const headers: UnknownRecord = {}
    setIf(headers, 'Host', q.get('host') ?? undefined)
    const options: UnknownRecord = {}
    setIf(options, 'path', q.get('path') ?? undefined)
    if (Object.keys(headers).length) options.headers = headers
    if (Object.keys(options).length) proxy['ws-opts'] = options
  }
  if (network === 'grpc') {
    const serviceName = q.get('serviceName') ?? q.get('service-name')
    if (serviceName) proxy['grpc-opts'] = { 'grpc-service-name': serviceName }
  }
}

function baseUrlProxy(
  raw: string,
  type: SupportedProxyType,
): { url: URL; proxy: MihomoProxy } {
  const url = new URL(raw)
  const parsedPort =
    port(url.port) ??
    (type === 'http' && url.protocol === 'https:'
      ? 443
      : type === 'http' && url.protocol === 'http:'
        ? 80
        : undefined)
  const server = hostname(url)
  if (!server || !parsedPort) throw new Error('missing server or port')
  return {
    url,
    proxy: {
      name: nameFromUrl(url, `${type}-${server}:${parsedPort}`),
      type,
      server,
      port: parsedPort,
    },
  }
}

function parseVless(raw: string): MihomoProxy {
  const { url, proxy } = baseUrlProxy(raw, 'vless')
  const uuid = text(decode(url.username))
  if (!uuid) throw new Error('missing VLESS UUID')
  proxy.uuid = uuid
  proxy.udp = true
  setIf(proxy, 'encryption', url.searchParams.get('encryption') ?? undefined)
  setIf(proxy, 'servername', url.searchParams.get('sni') ?? undefined)
  setIf(
    proxy,
    'skip-cert-verify',
    boolean(url.searchParams.get('allowInsecure')),
  )
  const security = url.searchParams.get('security')?.toLowerCase()
  if (security === 'tls' || security === 'reality') proxy.tls = true
  if (security === 'reality') {
    const reality: UnknownRecord = {}
    setIf(reality, 'public-key', url.searchParams.get('pbk') ?? undefined)
    setIf(reality, 'short-id', url.searchParams.get('sid') ?? undefined)
    if (Object.keys(reality).length) proxy['reality-opts'] = reality
  }
  applyTransportOptions(proxy, url)
  return proxy
}

function parseTrojan(raw: string): MihomoProxy {
  const { url, proxy } = baseUrlProxy(raw, 'trojan')
  const password = text(decode(url.username || url.password))
  if (!password) throw new Error('missing Trojan password')
  proxy.password = password
  proxy.udp = true
  proxy.sni = url.searchParams.get('sni') ?? hostname(url)
  setIf(
    proxy,
    'skip-cert-verify',
    boolean(url.searchParams.get('allowInsecure')),
  )
  applyTransportOptions(proxy, url)
  return proxy
}

function parseVmess(raw: string): MihomoProxy {
  const encoded = raw.slice(raw.indexOf('://') + 3).split('#', 1)[0] ?? ''
  const decoded = decodeBase64(encoded)
  if (!decoded) throw new Error('invalid VMess base64 payload')
  let config: unknown
  try {
    config = JSON.parse(decoded)
  } catch {
    throw new Error('invalid VMess JSON payload')
  }
  if (!isRecord(config)) throw new Error('invalid VMess payload')
  const server = text(config.add)
  const parsedPort = port(config.port)
  const uuid = text(config.id)
  if (!server || !parsedPort || !uuid) {
    throw new Error('VMess payload is missing add, port, or id')
  }
  const proxy: MihomoProxy = {
    name: text(config.ps) ?? `vmess-${server}:${parsedPort}`,
    type: 'vmess',
    server,
    port: parsedPort,
    uuid,
    alterId: Number(config.aid ?? 0),
    cipher: text(config.scy) ?? 'auto',
    udp: true,
  }
  const network = text(config.net)
  setIf(proxy, 'network', network)
  if (config.tls === 'tls') proxy.tls = true
  setIf(proxy, 'servername', text(config.sni))
  setIf(proxy, 'client-fingerprint', text(config.fp))
  if (network === 'ws') {
    const headers: UnknownRecord = {}
    setIf(headers, 'Host', text(config.host))
    const options: UnknownRecord = {}
    setIf(options, 'path', text(config.path))
    if (Object.keys(headers).length) options.headers = headers
    proxy['ws-opts'] = options
  }
  if (network === 'grpc' && text(config.path)) {
    proxy['grpc-opts'] = { 'grpc-service-name': text(config.path) }
  }
  return proxy
}

function parseShadowsocks(raw: string): MihomoProxy {
  const withoutScheme = raw.slice(raw.indexOf('://') + 3)
  const hashIndex = withoutScheme.indexOf('#')
  const fragment = hashIndex >= 0 ? withoutScheme.slice(hashIndex + 1) : ''
  const beforeHash =
    hashIndex >= 0 ? withoutScheme.slice(0, hashIndex) : withoutScheme
  const queryIndex = beforeHash.indexOf('?')
  const authority =
    queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash
  const query = new URLSearchParams(
    queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : '',
  )

  let credential: string
  let hostPort: string
  const at = authority.lastIndexOf('@')
  if (at >= 0) {
    const rawCredential = decode(authority.slice(0, at))
    credential = decodeBase64(rawCredential) ?? rawCredential
    hostPort = authority.slice(at + 1)
  } else {
    const decoded = decodeBase64(authority)
    if (!decoded) throw new Error('invalid Shadowsocks base64 payload')
    const decodedAt = decoded.lastIndexOf('@')
    if (decodedAt < 0) throw new Error('missing Shadowsocks server')
    credential = decoded.slice(0, decodedAt)
    hostPort = decoded.slice(decodedAt + 1)
  }
  const separator = credential.indexOf(':')
  if (separator <= 0) throw new Error('missing Shadowsocks cipher or password')
  const cipher = credential.slice(0, separator)
  const password = credential.slice(separator + 1)
  const target = parseHostPort(hostPort)
  const proxy: MihomoProxy = {
    name: text(decode(fragment)) ?? `ss-${target.server}:${target.port}`,
    type: 'ss',
    server: target.server,
    port: target.port,
    cipher,
    password,
    udp: true,
  }
  const plugin = query.get('plugin')
  if (plugin) {
    const [pluginName, ...rawOptions] = plugin.split(';')
    setIf(proxy, 'plugin', pluginName)
    const options: UnknownRecord = {}
    for (const option of rawOptions) {
      const [key, ...value] = option.split('=')
      if (key) options[key] = value.length ? value.join('=') : true
    }
    if (Object.keys(options).length) proxy['plugin-opts'] = options
  }
  return proxy
}

function parseHysteria2(raw: string): MihomoProxy {
  const { url, proxy } = baseUrlProxy(raw, 'hysteria2')
  const password = text(decode(url.password || url.username))
  if (!password) throw new Error('missing Hysteria2 password')
  proxy.password = password
  setIf(proxy, 'sni', url.searchParams.get('sni') ?? undefined)
  setIf(proxy, 'skip-cert-verify', boolean(url.searchParams.get('insecure')))
  setIf(proxy, 'obfs', url.searchParams.get('obfs') ?? undefined)
  setIf(
    proxy,
    'obfs-password',
    url.searchParams.get('obfs-password') ??
      url.searchParams.get('obfsParam') ??
      undefined,
  )
  setIf(proxy, 'up', url.searchParams.get('up') ?? undefined)
  setIf(proxy, 'down', url.searchParams.get('down') ?? undefined)
  const alpn = url.searchParams.get('alpn')
  if (alpn) proxy.alpn = alpn.split(',').filter(Boolean)
  return proxy
}

function parseTuic(raw: string): MihomoProxy {
  const { url, proxy } = baseUrlProxy(raw, 'tuic')
  const uuid = text(decode(url.username))
  const password = text(decode(url.password))
  if (!uuid || !password) throw new Error('missing TUIC UUID or password')
  proxy.uuid = uuid
  proxy.password = password
  setIf(proxy, 'sni', url.searchParams.get('sni') ?? undefined)
  setIf(
    proxy,
    'skip-cert-verify',
    boolean(url.searchParams.get('allow_insecure')),
  )
  setIf(
    proxy,
    'congestion-controller',
    url.searchParams.get('congestion_control') ?? undefined,
  )
  setIf(
    proxy,
    'udp-relay-mode',
    url.searchParams.get('udp_relay_mode') ?? undefined,
  )
  const alpn = url.searchParams.get('alpn')
  if (alpn) proxy.alpn = alpn.split(',').filter(Boolean)
  return proxy
}

function parseSocksOrHttp(raw: string, type: 'socks5' | 'http'): MihomoProxy {
  const { url, proxy } = baseUrlProxy(raw, type)
  const username = text(decode(url.username))
  const password = text(decode(url.password))
  setIf(proxy, 'username', username)
  setIf(proxy, 'password', password)
  proxy.udp = type === 'socks5'
  if (type === 'http' && url.protocol === 'https:') proxy.tls = true
  return proxy
}

export function parseShareLink(raw: string): MihomoProxy {
  const input = raw.trim()
  const match = /^([a-z][a-z\d+.-]*):\/\//i.exec(input)
  if (!match) throw new Error('not a proxy URI')
  const scheme = match[1]?.toLowerCase()
  switch (scheme) {
    case 'vless':
      return parseVless(input)
    case 'vmess':
      return parseVmess(input)
    case 'trojan':
      return parseTrojan(input)
    case 'ss':
      return parseShadowsocks(input)
    case 'hysteria2':
    case 'hy2':
      return parseHysteria2(input.replace(/^hy2:/i, 'hysteria2:'))
    case 'tuic':
      return parseTuic(input)
    case 'socks':
    case 'socks5':
      return parseSocksOrHttp(input.replace(/^socks:/i, 'socks5:'), 'socks5')
    case 'http':
    case 'https':
      return parseSocksOrHttp(input, 'http')
    default:
      throw new Error(`unsupported proxy protocol: ${scheme}`)
  }
}

function normalizeType(raw: string): SupportedProxyType | undefined {
  const type = raw.toLowerCase()
  if (type === 'hy2') return 'hysteria2'
  if (type === 'socks') return 'socks5'
  if (type === 'https') return 'http'
  return supportedTypes.has(type) ? (type as SupportedProxyType) : undefined
}

export function normalizeProxy(value: unknown): MihomoProxy {
  if (!isRecord(value)) throw new Error('node must be a mapping')
  const rawType = text(value.type)
  if (!rawType) throw new Error('node is missing type')
  const type = normalizeType(rawType)
  if (!type) throw new Error(`unsupported proxy protocol: ${rawType}`)
  const server = text(value.server)
  const parsedPort = port(value.port)
  if (!server || !parsedPort)
    throw new Error('node is missing a valid server or port')
  const proxy = { ...value } as UnknownRecord
  proxy.name = text(value.name) ?? `${type}-${server}:${parsedPort}`
  proxy.type = type
  proxy.server = server
  proxy.port = parsedPort
  if (rawType.toLowerCase() === 'https') proxy.tls = true
  if (
    (type === 'vless' || type === 'vmess' || type === 'tuic') &&
    !text(proxy.uuid)
  ) {
    throw new Error(`${type} node is missing uuid`)
  }
  if (
    (type === 'trojan' ||
      type === 'ss' ||
      type === 'hysteria2' ||
      type === 'tuic') &&
    !text(proxy.password)
  ) {
    throw new Error(`${type} node is missing password`)
  }
  if (type === 'ss' && !text(proxy.cipher)) {
    throw new Error('ss node is missing cipher')
  }
  return proxy as MihomoProxy
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  )
}

export function stableNodeId(proxy: MihomoProxy): string {
  const identity: UnknownRecord = { ...proxy }
  delete identity.name
  const digest = createHash('sha256')
    .update(JSON.stringify(stableValue(identity)))
    .digest('hex')
  return `node_${digest.slice(0, 20)}`
}

function yamlCandidates(document: unknown):
  | {
      format: SubscriptionFormat
      candidates: Candidate[]
    }
  | undefined {
  if (!isRecord(document)) return undefined
  const key = Array.isArray(document.proxies)
    ? 'proxies'
    : Array.isArray(document.payload)
      ? 'payload'
      : undefined
  if (!key) return undefined
  return {
    format: key === 'proxies' ? 'mihomo-config' : 'provider',
    candidates: (document[key] as unknown[]).map((value, index) => ({
      index: index + 1,
      value,
    })),
  }
}

function linkCandidates(content: string): Candidate[] {
  return content
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter(({ line }) => line && !line.startsWith('#'))
    .map(({ line, index }) => ({ index, value: line }))
}

function discoverCandidates(content: string): {
  format: SubscriptionFormat
  candidates: Candidate[]
  issue?: ImportIssue
} {
  const trimmed = content.replace(/^\uFEFF/, '').trim()
  if (!trimmed) {
    return {
      format: 'unknown',
      candidates: [],
      issue: { code: 'invalid-document', message: 'subscription is empty' },
    }
  }

  try {
    const parsed = parseYaml(trimmed)
    const yaml = yamlCandidates(parsed)
    if (yaml) return yaml
    if (isRecord(parsed) && ('proxies' in parsed || 'payload' in parsed)) {
      return {
        format: 'unknown',
        candidates: [],
        issue: {
          code: 'invalid-document',
          message: 'proxies or payload must be an array',
        },
      }
    }
  } catch (error) {
    if (/^(?:proxies|payload)\s*:/m.test(trimmed)) {
      return {
        format: 'unknown',
        candidates: [],
        issue: {
          code: 'invalid-document',
          message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }
  }

  const decoded = decodeBase64(trimmed)
  if (decoded && decoded !== trimmed) {
    const decodedLinks = linkCandidates(decoded)
    if (
      decodedLinks.some(
        ({ value }) => typeof value === 'string' && value.includes('://'),
      )
    ) {
      return { format: 'base64-links', candidates: decodedLinks }
    }
    try {
      const yaml = yamlCandidates(parseYaml(decoded))
      if (yaml) return yaml
    } catch {
      // The regular per-line diagnostics below are more useful than a decode error.
    }
  }

  const candidates = linkCandidates(trimmed)
  return {
    format: candidates.some(({ value }) =>
      typeof value === 'string' ? value.includes('://') : false,
    )
      ? 'links'
      : 'unknown',
    candidates,
  }
}

function issueCode(error: Error): ImportIssue['code'] {
  return error.message.startsWith('unsupported proxy protocol')
    ? 'unsupported-protocol'
    : 'invalid-node'
}

export function previewSubscription(content: string): ImportPreview {
  const discovered = discoverCandidates(content)
  const issues: ImportIssue[] = discovered.issue ? [discovered.issue] : []
  const nodes: NormalizedNode[] = []
  const ids = new Set<string>()
  const names = new Map<string, number>()

  for (const candidate of discovered.candidates) {
    try {
      const proxy =
        typeof candidate.value === 'string'
          ? parseShareLink(candidate.value)
          : normalizeProxy(candidate.value)
      const originalName = proxy.name
      const id = stableNodeId(proxy)
      if (ids.has(id)) {
        issues.push({
          code: 'duplicate-node',
          message: `duplicate node skipped: ${originalName}`,
          index: candidate.index,
        })
        continue
      }
      ids.add(id)
      const occurrence = (names.get(originalName) ?? 0) + 1
      names.set(originalName, occurrence)
      if (occurrence > 1) proxy.name = `${originalName} (${occurrence})`
      nodes.push({ id, originalName, proxy })
    } catch (error) {
      const parsedError =
        error instanceof Error ? error : new Error(String(error))
      issues.push({
        code: issueCode(parsedError),
        message: parsedError.message,
        index: candidate.index,
      })
    }
  }

  const protocols: ImportPreview['summary']['protocols'] = {}
  for (const { proxy } of nodes) {
    protocols[proxy.type] = (protocols[proxy.type] ?? 0) + 1
  }
  return {
    format: discovered.format,
    nodes,
    issues,
    summary: {
      total: discovered.candidates.length,
      valid: nodes.length,
      skipped: discovered.candidates.length - nodes.length,
      protocols,
    },
  }
}
