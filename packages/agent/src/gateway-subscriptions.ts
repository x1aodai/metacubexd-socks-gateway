import type { GatewayManager } from './gateway'
import type {
  FetchedSubscription,
  ImportPreview,
  MihomoProxy,
  NormalizedNode,
} from './subscription/index'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GatewayValidationError } from './gateway'
import {
  atomicWrite,
  decryptJson,
  encryptJson,
  loadOrCreateKey,
} from './secure-store'
import {
  fetchSubscription,
  previewSubscription,
  stableNodeId,
} from './subscription/index'

const DEFAULT_INTERVAL_MINUTES = 360
const MIN_INTERVAL_MINUTES = 15
const PREVIEW_TTL_MS = 10 * 60 * 1000
const NO_VALID_NODES_MESSAGE = 'subscription returned no valid nodes'
const NODE_COUNT_DROPPED_MESSAGE =
  'subscription node count dropped; last-good retained'
const REFRESH_FAILED_MESSAGE = 'subscription refresh failed'

interface StoredSubscription {
  id: string
  name: string
  url: string
  intervalMinutes: number
  enabled: boolean
  nodes: MihomoProxy[]
  nodeCount: number
  createdAt: number
  updatedAt: number
  lastSyncAt?: number
  lastError?: string
}

interface SubscriptionState {
  version: 1
  items: StoredSubscription[]
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

export interface GatewayImportPreview {
  previewId: string
  format: string
  validCount: number
  skippedCount: number
  protocolCounts: Record<string, number>
  errors: string[]
  issues: Array<{ code: string; message: string; index?: number }>
  nodes: Array<{ id: string; name: string; type: string }>
}

export interface GatewaySubscriptionManagerOptions {
  dataDir: string
  gateway: GatewayManager
  masterKey?: string
  now?: () => number
  fetchSubscription?: (url: string) => Promise<FetchedSubscription>
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}

export interface GatewaySubscriptionManager {
  previewImport: (content: string) => GatewayImportPreview
  applyImport: (input: {
    previewId?: string
    content?: string
  }) => Promise<{ imported: number; gateway: unknown }>
  list: () => Promise<GatewaySubscription[]>
  create: (input: {
    name: string
    url: string
    intervalMinutes?: number
    enabled?: boolean
  }) => Promise<GatewaySubscription>
  update: (
    id: string,
    input: {
      name?: string
      url?: string
      intervalMinutes?: number
      enabled?: boolean
    },
  ) => Promise<GatewaySubscription>
  delete: (id: string) => Promise<void>
  sync: (id: string) => Promise<GatewaySubscription>
  refreshSubscriptions: () => Promise<GatewaySubscriptionRefreshResult>
  start: () => void
  stop: () => void
}

export function createGatewaySubscriptionManager(
  options: GatewaySubscriptionManagerOptions,
): GatewaySubscriptionManager {
  const now = options.now ?? Date.now
  const doFetch = options.fetchSubscription ?? ((url) => fetchSubscription(url))
  const setIntervalFn = options.setInterval ?? globalThis.setInterval
  const clearIntervalFn = options.clearInterval ?? globalThis.clearInterval
  const path = join(options.dataDir, 'subscriptions.enc')
  const previews = new Map<
    string,
    { expiresAt: number; preview: ImportPreview }
  >()
  let statePromise: Promise<SubscriptionState> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let tail: Promise<unknown> = Promise.resolve()

  function transaction<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn)
    tail = result.catch(() => {})
    return result
  }

  async function load(): Promise<SubscriptionState> {
    if (!statePromise) {
      statePromise = (async () => {
        try {
          const [raw, key] = await Promise.all([
            readFile(path, 'utf8'),
            loadOrCreateKey(options.dataDir, options.masterKey),
          ])
          return decryptJson<SubscriptionState>(raw, key)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          return { version: 1, items: [] }
        }
      })()
    }
    return statePromise
  }

  async function persist(state: SubscriptionState): Promise<void> {
    const key = await loadOrCreateKey(options.dataDir, options.masterKey)
    await atomicWrite(path, encryptJson(state, key))
    statePromise = Promise.resolve(state)
  }

  function buildPreview(content: string): {
    response: GatewayImportPreview
    parsed: ImportPreview
  } {
    if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024)
      throw new GatewayValidationError('import exceeds the 8 MiB limit', 413)
    const parsed = previewSubscription(content)
    const previewId = randomUUID()
    previews.set(previewId, {
      expiresAt: now() + PREVIEW_TTL_MS,
      preview: parsed,
    })
    return {
      parsed,
      response: {
        previewId,
        format: parsed.format,
        validCount: parsed.summary.valid,
        skippedCount: parsed.summary.skipped,
        protocolCounts: { ...parsed.summary.protocols },
        errors: parsed.issues.map((issue) => issue.message),
        issues: parsed.issues.map((issue) => ({
          code: issue.code,
          message: issue.message.replace(/https?:\/\/\S+/gi, '[REDACTED URL]'),
          ...(issue.index === undefined ? {} : { index: issue.index }),
        })),
        nodes: parsed.nodes.map((node) => ({
          id: node.id,
          name: node.proxy.name,
          type: node.proxy.type,
        })),
      },
    }
  }

  async function syncRecord(
    state: SubscriptionState,
    record: StoredSubscription,
  ): Promise<GatewaySubscription> {
    try {
      const nodes = await fetchRecordNodes(record)
      if (record.enabled)
        await options.gateway.replaceNodeSource(
          `subscription:${record.id}`,
          nodes,
          'subscription.sync',
        )
      record.nodes = rawProxies(nodes)
      record.nodeCount = nodes.length
      record.lastSyncAt = now()
      record.updatedAt = now()
      record.lastError = undefined
      await persist(state)
      return publicSubscription(record)
    } catch (error) {
      record.lastError = safeError(error)
      record.updatedAt = now()
      await persist(state)
      throw publicSyncError(error)
    }
  }

  async function fetchRecordNodes(
    record: StoredSubscription,
  ): Promise<NormalizedNode[]> {
    const fetched = await doFetch(record.url)
    const parsed = previewSubscription(fetched.content)
    if (parsed.nodes.length === 0)
      throw new GatewayValidationError(NO_VALID_NODES_MESSAGE, 422)
    if (record.nodeCount > 0 && parsed.nodes.length * 2 < record.nodeCount)
      throw new GatewayValidationError(
        `subscription node count dropped from ${record.nodeCount} to ${parsed.nodes.length}; last-good retained`,
        409,
      )
    return parsed.nodes
  }

  return {
    previewImport(content) {
      for (const [id, value] of previews)
        if (value.expiresAt <= now()) previews.delete(id)
      return buildPreview(content).response
    },
    applyImport(input) {
      return transaction(async () => {
        let parsed: ImportPreview | undefined
        if (input.previewId) {
          const cached = previews.get(input.previewId)
          if (!cached || cached.expiresAt <= now())
            throw new GatewayValidationError(
              'import preview expired or not found',
              404,
            )
          parsed = cached.preview
          previews.delete(input.previewId)
        } else if (input.content) {
          parsed = buildPreview(input.content).parsed
        }
        if (!parsed)
          throw new GatewayValidationError('previewId or content is required')
        if (parsed.nodes.length === 0)
          throw new GatewayValidationError(
            'import contains no valid nodes',
            422,
          )
        const gateway = await options.gateway.appendImportedNodes(parsed.nodes)
        return { imported: parsed.nodes.length, gateway }
      })
    },
    async list() {
      return (await load()).items.map(publicSubscription)
    },
    create(input) {
      return transaction(async () => {
        validateName(input.name)
        const state = structuredClone(await load())
        const intervalMinutes = validateInterval(
          input.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
        )
        const record: StoredSubscription = {
          id: randomUUID(),
          name: input.name.trim(),
          url: validateUrl(input.url),
          intervalMinutes,
          enabled: input.enabled ?? true,
          nodes: [],
          nodeCount: 0,
          createdAt: now(),
          updatedAt: now(),
        }
        state.items.push(record)
        try {
          return await syncRecord(state, record)
        } catch {
          return publicSubscription(record)
        }
      })
    },
    update(id, input) {
      return transaction(async () => {
        const state = structuredClone(await load())
        const record = state.items.find((item) => item.id === id)
        if (!record)
          throw new GatewayValidationError('subscription not found', 404)
        if (input.name !== undefined) {
          validateName(input.name)
          record.name = input.name.trim()
        }
        const urlChanged = input.url !== undefined
        if (input.url !== undefined) record.url = validateUrl(input.url)
        if (input.intervalMinutes !== undefined)
          record.intervalMinutes = validateInterval(input.intervalMinutes)
        const wasEnabled = record.enabled
        if (input.enabled !== undefined) record.enabled = Boolean(input.enabled)
        record.updatedAt = now()
        if (wasEnabled && !record.enabled) {
          await options.gateway.replaceNodeSource(
            `subscription:${record.id}`,
            [],
            'subscription.disable',
          )
        } else if (!wasEnabled && record.enabled) {
          if (record.nodes.length > 0)
            await options.gateway.replaceNodeSource(
              `subscription:${record.id}`,
              normalizeStoredProxies(record.nodes),
              'subscription.enable',
            )
          try {
            return await syncRecord(state, record)
          } catch {
            await persist(state)
            return publicSubscription(record)
          }
        }
        if (urlChanged) {
          try {
            return await syncRecord(state, record)
          } catch {
            return publicSubscription(record)
          }
        }
        await persist(state)
        return publicSubscription(record)
      })
    },
    delete(id) {
      return transaction(async () => {
        const state = structuredClone(await load())
        const index = state.items.findIndex((item) => item.id === id)
        if (index === -1)
          throw new GatewayValidationError('subscription not found', 404)
        state.items.splice(index, 1)
        await options.gateway.removeNodeSource(
          `subscription:${id}`,
          'subscription.delete',
        )
        await persist(state)
      })
    },
    sync(id) {
      return transaction(async () => {
        const state = structuredClone(await load())
        const record = state.items.find((item) => item.id === id)
        if (!record)
          throw new GatewayValidationError('subscription not found', 404)
        return syncRecord(state, record)
      })
    },
    refreshSubscriptions() {
      return transaction(async () => {
        const state = structuredClone(await load())
        const records = state.items.filter(({ enabled }) => enabled)
        type PreparedRefresh =
          | { record: StoredSubscription; nodes: NormalizedNode[] }
          | { record: StoredSubscription; error: unknown }
        const prepared: PreparedRefresh[] = await Promise.all(
          records.map(async (record): Promise<PreparedRefresh> => {
            try {
              return { record, nodes: await fetchRecordNodes(record) }
            } catch (error) {
              return { record, error }
            }
          }),
        )
        const successes = prepared.filter(
          (
            item,
          ): item is {
            record: StoredSubscription
            nodes: NormalizedNode[]
          } => 'nodes' in item,
        )
        let applyError: unknown
        if (successes.length > 0) {
          try {
            await options.gateway.replaceNodeSources(
              successes.map(({ record, nodes }) => ({
                sourceId: `subscription:${record.id}`,
                nodes,
              })),
              'subscriptions.refresh',
            )
          } catch (error) {
            applyError = error
          }
        }

        const items = prepared.map((item): GatewaySubscriptionRefreshItem => {
          const error = 'error' in item ? item.error : applyError
          if (error === undefined && 'nodes' in item) {
            item.record.nodes = rawProxies(item.nodes)
            item.record.nodeCount = item.nodes.length
            item.record.lastSyncAt = now()
            item.record.updatedAt = now()
            item.record.lastError = undefined
            return {
              id: item.record.id,
              ok: true,
              nodeCount: item.record.nodeCount,
            }
          }
          const message = safeError(error)
          item.record.lastError = message
          item.record.updatedAt = now()
          return {
            id: item.record.id,
            ok: false,
            nodeCount: item.record.nodeCount,
            error: message,
          }
        })
        await persist(state)
        return { items }
      })
    },
    start() {
      if (timer) return
      timer = setIntervalFn(() => {
        void load()
          .then((state) => {
            for (const record of state.items) {
              if (!record.enabled) continue
              const due =
                (record.lastSyncAt ?? 0) + record.intervalMinutes * 60_000
              if (due <= now()) void this.sync(record.id).catch(() => {})
            }
          })
          .catch(() => {})
      }, 60_000)
      timer.unref?.()
    },
    stop() {
      if (timer) clearIntervalFn(timer)
      timer = undefined
    },
  }
}

function publicSubscription(record: StoredSubscription): GatewaySubscription {
  return {
    id: record.id,
    name: record.name,
    urlMasked: maskUrl(record.url),
    intervalMinutes: record.intervalMinutes,
    enabled: record.enabled,
    nodeCount: record.nodeCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastSyncAt: record.lastSyncAt,
    lastError:
      record.lastError === undefined
        ? undefined
        : publicStoredError(record.lastError),
  }
}

function normalizeStoredProxies(proxies: MihomoProxy[]): NormalizedNode[] {
  return proxies.map((proxy) => ({
    id: stableNodeId(proxy),
    originalName: proxy.name,
    proxy: structuredClone(proxy),
  }))
}

function rawProxies(nodes: NormalizedNode[]): MihomoProxy[] {
  return nodes.map(({ proxy }) => structuredClone(proxy))
}

function maskUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}/…`
  } catch {
    return '[invalid URL]'
  }
}

function validateName(name: string): void {
  if (
    typeof name !== 'string' ||
    name.trim().length < 1 ||
    name.trim().length > 100
  )
    throw new GatewayValidationError(
      'subscription name must contain 1 to 100 characters',
    )
}

function validateInterval(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_INTERVAL_MINUTES ||
    value > 43_200
  )
    throw new GatewayValidationError(
      'subscription interval must be 15 to 43200 minutes',
    )
  return value
}

function validateUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('unsupported protocol')
    return url.toString()
  } catch {
    throw new GatewayValidationError('subscription URL must use HTTP or HTTPS')
  }
}

function safeError(error: unknown): string {
  if (error instanceof GatewayValidationError) {
    if (error.statusCode === 422 && error.message === NO_VALID_NODES_MESSAGE)
      return NO_VALID_NODES_MESSAGE
    if (
      error.statusCode === 409 &&
      error.message.startsWith('subscription node count dropped from ')
    )
      return NODE_COUNT_DROPPED_MESSAGE
  }
  return REFRESH_FAILED_MESSAGE
}

function publicStoredError(message: string): string {
  if (
    message === NO_VALID_NODES_MESSAGE ||
    message === NODE_COUNT_DROPPED_MESSAGE ||
    message === REFRESH_FAILED_MESSAGE
  )
    return message
  return REFRESH_FAILED_MESSAGE
}

function publicSyncError(error: unknown): GatewayValidationError {
  return new GatewayValidationError(
    safeError(error),
    error instanceof GatewayValidationError ? error.statusCode : 502,
    error instanceof GatewayValidationError ? error.details : undefined,
  )
}
