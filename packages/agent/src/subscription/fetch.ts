import type { RequestOptions } from 'node:http'
import { Buffer } from 'node:buffer'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export interface SubscriptionFetchOptions {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  userAgent?: string
  /** Dependency-injection seam for deterministic tests. Production callers omit it. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
  /** Dependency-injection seam for deterministic tests. Production callers omit it. */
  transport?: SubscriptionTransport
}

export interface FetchedSubscription {
  content: string
  finalUrl: string
  bytes: number
  redirects: number
  contentType?: string
}

export interface SubscriptionHopResponse {
  status: number
  location?: string
  contentType?: string
  body: Buffer
}

export type SubscriptionTransport = (
  url: URL,
  addresses: ResolvedAddress[],
  maxBytes: number,
  userAgent: string,
  signal: AbortSignal,
) => Promise<SubscriptionHopResponse>

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 3
const redirectStatuses = new Set([301, 302, 303, 307, 308])

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::', 96],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6')
}

function mappedIpv4(address: string): string | undefined {
  const lower = address.toLowerCase()
  if (!lower.startsWith('::ffff:')) return undefined
  const tail = lower.slice('::ffff:'.length)
  if (isIP(tail) === 4) return tail
  const parts = tail.split(':')
  if (parts.length !== 2) return undefined
  const high = Number.parseInt(parts[0] ?? '', 16)
  const low = Number.parseInt(parts[1] ?? '', 16)
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xFFFF ||
    low < 0 ||
    low > 0xFFFF
  ) {
    return undefined
  }
  return `${high >> 8}.${high & 0xFF}.${low >> 8}.${low & 0xFF}`
}

/** True only for a routable address outside the private/special-use ranges. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (!family) return false
  const mapped = mappedIpv4(address)
  if (mapped) return !blocked.check(mapped, 'ipv4')
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isInteger(value) || value <= 0
    ? fallback
    : value
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return value === undefined || !Number.isInteger(value) || value < 0
    ? fallback
    : value
}

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true }) as Promise<
    ResolvedAddress[]
  >
}

async function resolvePublic(
  url: URL,
  resolve: (hostname: string) => Promise<ResolvedAddress[]>,
): Promise<ResolvedAddress[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literalFamily = isIP(hostname)
  let addresses: ResolvedAddress[]
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily as 4 | 6 }]
  } else {
    try {
      addresses = await resolve(hostname)
    } catch (error) {
      throw new Error(
        `subscription DNS lookup failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (!addresses.length)
    throw new Error(`subscription host has no addresses: ${hostname}`)
  const unsafe = addresses.find(({ address }) => !isPublicAddress(address))
  if (unsafe) {
    throw new Error(
      `subscription URL resolves to a blocked address: ${unsafe.address}`,
    )
  }
  return addresses
}

const downloadHop: SubscriptionTransport = (
  url: URL,
  addresses: ResolvedAddress[],
  maxBytes: number,
  userAgent: string,
  signal: AbortSignal,
): Promise<SubscriptionHopResponse> => {
  return new Promise((resolve, reject) => {
    const selected = addresses[0]
    if (!selected) {
      reject(new Error('subscription host has no usable address'))
      return
    }
    const lookup = ((
      _hostname: string,
      lookupOptions: { all?: boolean },
      callback: (
        error: NodeJS.ErrnoException | null,
        address: string | ResolvedAddress[],
        family?: number,
      ) => void,
    ) => {
      if (lookupOptions.all) callback(null, [selected])
      else callback(null, selected.address, selected.family)
    }) as unknown as NonNullable<RequestOptions['lookup']>
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        auth: url.username
          ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
          : undefined,
        lookup,
        signal,
        headers: {
          accept: 'text/yaml,text/plain,application/yaml,*/*;q=0.8',
          'accept-encoding': 'identity',
          'user-agent': userAgent,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        const contentType = response.headers['content-type']
        if (redirectStatuses.has(status)) {
          response.destroy()
          resolve({ status, location, body: Buffer.alloc(0) })
          return
        }
        const declaredLength = Number(response.headers['content-length'])
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          response.destroy()
          reject(new Error(`subscription exceeds ${maxBytes} byte limit`))
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buffer.length
          if (bytes > maxBytes) {
            response.destroy(
              new Error(`subscription exceeds ${maxBytes} byte limit`),
            )
            return
          }
          chunks.push(buffer)
        })
        response.once('end', () => {
          resolve({
            status,
            location,
            contentType: Array.isArray(contentType)
              ? contentType[0]
              : contentType,
            body: Buffer.concat(chunks, bytes),
          })
        })
        response.once('error', reject)
      },
    )
    request.once('error', reject)
    request.end()
  })
}

function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new Error(`subscription fetch timed out after ${timeoutMs}ms`),
    )
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error(`subscription fetch timed out after ${timeoutMs}ms`))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Fetch a subscription with a total timeout and SSRF checks on the initial URL
 * and every redirect. DNS results are pinned into the socket lookup callback so
 * a second, unchecked resolution cannot redirect the connection internally.
 */
export async function fetchSubscription(
  rawUrl: string,
  options: SubscriptionFetchOptions = {},
): Promise<FetchedSubscription> {
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES)
  const maxRedirects = nonNegativeInteger(
    options.maxRedirects,
    DEFAULT_MAX_REDIRECTS,
  )
  const resolve = options.resolve ?? defaultResolve
  const transport = options.transport ?? downloadHop
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let redirects = 0
  let current: URL
  try {
    current = new URL(rawUrl)
  } catch {
    clearTimeout(timer)
    throw new Error('invalid subscription URL')
  }

  try {
    while (true) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new Error('subscription URL must use HTTP or HTTPS')
      }
      const addresses = await abortable(
        resolvePublic(current, resolve),
        controller.signal,
        timeoutMs,
      )
      let response: SubscriptionHopResponse
      try {
        response = await abortable(
          transport(
            current,
            addresses,
            maxBytes,
            options.userAgent ?? 'clash.meta',
            controller.signal,
          ),
          controller.signal,
          timeoutMs,
        )
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`subscription fetch timed out after ${timeoutMs}ms`)
        }
        throw error
      }
      if (response.body.length > maxBytes) {
        throw new Error(`subscription exceeds ${maxBytes} byte limit`)
      }
      if (redirectStatuses.has(response.status)) {
        if (!response.location)
          throw new Error('subscription redirect has no location')
        if (redirects >= maxRedirects) {
          throw new Error(`subscription exceeded ${maxRedirects} redirects`)
        }
        current = new URL(response.location, current)
        redirects += 1
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `subscription fetch failed with HTTP ${response.status}`,
        )
      }
      return {
        content: response.body.toString('utf8'),
        finalUrl: current.toString(),
        bytes: response.body.length,
        redirects,
        contentType: response.contentType,
      }
    }
  } finally {
    clearTimeout(timer)
  }
}
