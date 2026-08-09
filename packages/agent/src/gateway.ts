import type { MihomoSupervisor } from './types'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import {
  atomicWrite,
  decryptJson,
  encryptJson,
  loadOrCreateKey,
} from './secure-store'

export type GatewayMode = 'manual' | 'auto' | 'failover'

export interface GatewayConfig {
  enabled: boolean
  port: number
  udp: boolean
  mode: GatewayMode
  selectedNode?: string
  updatedAt: number
  nodes?: GatewayNode[]
}

export interface GatewayNode {
  id: string
  name: string
  type?: string
  healthy?: boolean
  latency?: number | null
}

export interface GatewayCredential {
  id: string
  username: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

interface StoredCredential extends GatewayCredential {
  password: string
}

export interface GatewayRevision {
  id: string
  createdAt: number
  reason: string
}

interface PersistedState {
  version: 1
  gateway: GatewayConfig
  credentials: StoredCredential[]
  nodeSources: Record<string, Array<Record<string, unknown>>>
  revisions: GatewayRevision[]
  lastAppliedAt?: number
  lastError?: string
}

interface RevisionPayload {
  state: PersistedState
  activeConfig: string
}

export interface GatewayManagerOptions {
  dataDir: string
  activeConfigPath: string
  masterKey?: string
  defaultPort?: number
  minPort?: number
  maxPort?: number
  controllerUrl: string
  controllerSecret?: string
  controllerCorsOrigins?: string[]
  fetch?: typeof fetch
  now?: () => number
}

export interface GatewayStatus {
  healthy: boolean
  running: boolean
  listenerReachable: boolean
  controllerReachable: boolean
  activeNode?: string
  lastAppliedAt?: number
  lastError?: string
  mode?: GatewayMode
  port?: number
  nodes?: GatewayNode[]
}

export interface GatewayManager {
  bindSupervisor: (supervisor: MihomoSupervisor) => void
  overlayConfig: (content: string) => Promise<string>
  getGateway: () => Promise<GatewayConfig>
  updateGateway: (
    input: Partial<Pick<GatewayConfig, 'enabled' | 'port' | 'udp'>>,
  ) => Promise<GatewayConfig>
  status: () => Promise<GatewayStatus>
  listCredentials: () => Promise<GatewayCredential[]>
  createCredential: (input: {
    username: string
    password?: string
    enabled?: boolean
  }) => Promise<GatewayCredential & { password: string }>
  updateCredential: (
    id: string,
    input: { username?: string; enabled?: boolean },
  ) => Promise<GatewayCredential>
  deleteCredential: (id: string) => Promise<void>
  rotateCredential: (
    id: string,
    password?: string,
  ) => Promise<{ id: string; password: string }>
  setOutbound: (input: {
    mode: GatewayMode
    nodeId?: string
  }) => Promise<GatewayConfig>
  listRevisions: () => Promise<GatewayRevision[]>
  rollback: (id: string) => Promise<GatewayConfig>
  listAudit: (limit?: number) => Promise<unknown[]>
  replaceNodeSource: (
    sourceId: string,
    proxies: Array<Record<string, unknown>>,
    reason: string,
  ) => Promise<GatewayConfig>
  appendImportedNodes: (
    proxies: Array<Record<string, unknown>>,
  ) => Promise<GatewayConfig>
  removeNodeSource: (sourceId: string, reason: string) => Promise<GatewayConfig>
}

export class GatewayValidationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message)
  }
}

const MANAGED_GROUPS = new Set(['GATEWAY', 'MANUAL', 'AUTO', 'FAILOVER'])
const RESERVED_PROXY_NAMES = new Set([...MANAGED_GROUPS, 'DIRECT', 'REJECT'])

export function createGatewayManager(
  options: GatewayManagerOptions,
): GatewayManager {
  const now = options.now ?? Date.now
  const doFetch = options.fetch ?? fetch
  const minPort = options.minPort ?? 1080
  const maxPort = options.maxPort ?? 1099
  const defaultPort = options.defaultPort ?? minPort
  const statePath = join(options.dataDir, 'gateway.enc')
  const auditPath = join(options.dataDir, 'audit.jsonl')
  const revisionsDir = join(options.dataDir, 'revisions')
  let statePromise: Promise<PersistedState> | undefined
  let supervisor: MihomoSupervisor | undefined
  let tail: Promise<unknown> = Promise.resolve()
  let manualHealthFailures = 0

  function transaction<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn)
    tail = result.catch(() => {})
    return result
  }

  function initialState(): PersistedState {
    if (
      !Number.isInteger(defaultPort) ||
      defaultPort < minPort ||
      defaultPort > maxPort
    )
      throw new Error(`default SOCKS port must be within ${minPort}-${maxPort}`)
    return {
      version: 1,
      gateway: {
        enabled: false,
        port: defaultPort,
        udp: false,
        mode: 'failover',
        updatedAt: now(),
      },
      credentials: [],
      nodeSources: {},
      revisions: [],
    }
  }

  async function loadState(): Promise<PersistedState> {
    if (!statePromise) {
      statePromise = (async () => {
        try {
          const [raw, key] = await Promise.all([
            readFile(statePath, 'utf8'),
            loadOrCreateKey(options.dataDir, options.masterKey),
          ])
          const loaded = decryptJson<PersistedState>(raw, key)
          loaded.nodeSources ??= {}
          loaded.revisions ??= []
          return loaded
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          const value = initialState()
          await persistState(value)
          return value
        }
      })()
    }
    return statePromise
  }

  async function persistState(state: PersistedState): Promise<void> {
    const key = await loadOrCreateKey(options.dataDir, options.masterKey)
    await atomicWrite(statePath, encryptJson(state, key))
    statePromise = Promise.resolve(state)
  }

  function cloneState(state: PersistedState): PersistedState {
    return structuredClone(state)
  }

  async function audit(action: string, detail: unknown = {}): Promise<void> {
    await mkdir(options.dataDir, { recursive: true })
    const entry = `${JSON.stringify({
      id: randomUUID(),
      at: now(),
      action,
      result: action.endsWith('.failed') ? 'failure' : 'success',
      actor: 'admin',
      detail: JSON.stringify(redact(detail)),
    })}\n`
    const handle = await open(auditPath, 'a', 0o600)
    try {
      await handle.writeFile(entry, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(auditPath, 0o600)
  }

  async function readActive(): Promise<string> {
    try {
      return await readFile(options.activeConfigPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  async function overlay(
    content: string,
    state: PersistedState,
    previousState?: PersistedState,
  ): Promise<string> {
    let document: Record<string, unknown>
    try {
      const value = parse(content || '{}')
      document =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {}
    } catch (error) {
      throw new GatewayValidationError(
        `base configuration is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    for (const key of [
      'port',
      'socks-port',
      'mixed-port',
      'redir-port',
      'tproxy-port',
      'authentication',
      'skip-auth-prefixes',
      'allow-lan',
      'bind-address',
      'tun',
      'external-controller-cors',
    ])
      delete document[key]

    const controllerCorsOrigins = (options.controllerCorsOrigins ?? [])
      .map((origin) => origin.trim())
      .filter(Boolean)
    if (controllerCorsOrigins.length > 0) {
      document['external-controller-cors'] = {
        'allow-origins': [...new Set(controllerCorsOrigins)],
        'allow-private-network': true,
      }
    }

    const managedNames = new Set(
      [state, previousState]
        .filter((item): item is PersistedState => Boolean(item))
        .flatMap((item) => deduplicateManagedProxies(item.nodeSources ?? {}))
        .map((proxy) => (typeof proxy.name === 'string' ? proxy.name : ''))
        .filter(Boolean),
    )
    const baseProxies = Array.isArray(document.proxies)
      ? document.proxies.filter(
          (proxy) =>
            !isRecord(proxy) ||
            typeof proxy.name !== 'string' ||
            !managedNames.has(proxy.name),
        )
      : []
    const importedProxies = deduplicateManagedProxies(state.nodeSources)
    const proxies = [...baseProxies, ...importedProxies]
    document.proxies = proxies
    const nodeNames = proxies
      .map((proxy) =>
        isRecord(proxy) && typeof proxy.name === 'string'
          ? proxy.name
          : undefined,
      )
      .filter(
        (name): name is string =>
          Boolean(name) && !RESERVED_PROXY_NAMES.has(name!),
      )
    const providerNames = isRecord(document['proxy-providers'])
      ? Object.keys(document['proxy-providers'] as Record<string, unknown>)
      : []
    const existingGroups = Array.isArray(document['proxy-groups'])
      ? document['proxy-groups'].filter(
          (group) =>
            !isRecord(group) ||
            typeof group.name !== 'string' ||
            !MANAGED_GROUPS.has(group.name),
        )
      : []
    const candidates = nodeNames.length > 0 ? nodeNames : ['REJECT']
    const use = providerNames.length > 0 ? providerNames : undefined
    const selectedMode = state.gateway.mode.toUpperCase()

    document['proxy-groups'] = [
      {
        name: 'GATEWAY',
        type: 'select',
        proxies: [
          selectedMode,
          ...['MANUAL', 'AUTO', 'FAILOVER'].filter((v) => v !== selectedMode),
          'REJECT',
        ],
      },
      {
        name: 'MANUAL',
        type: 'select',
        proxies:
          state.gateway.selectedNode &&
          nodeNames.includes(state.gateway.selectedNode)
            ? [
                state.gateway.selectedNode,
                ...candidates.filter((n) => n !== state.gateway.selectedNode),
                'REJECT',
              ]
            : [
                ...candidates,
                ...(candidates.includes('REJECT') ? [] : ['REJECT']),
              ],
        ...(use ? { use } : {}),
      },
      {
        name: 'AUTO',
        type: 'url-test',
        proxies: [
          ...candidates,
          ...(candidates.includes('REJECT') ? [] : ['REJECT']),
        ],
        ...(use ? { use } : {}),
        url: 'https://www.gstatic.com/generate_204',
        interval: 300,
        tolerance: 50,
      },
      {
        name: 'FAILOVER',
        type: 'fallback',
        proxies: [
          ...candidates,
          ...(candidates.includes('REJECT') ? [] : ['REJECT']),
        ],
        ...(use ? { use } : {}),
        url: 'https://www.gstatic.com/generate_204',
        interval: 60,
      },
      ...existingGroups,
    ]
    document.rules = ['MATCH,GATEWAY']
    delete document.listeners
    if (state.gateway.enabled) {
      const users = state.credentials
        .filter((credential) => credential.enabled)
        .map(({ username, password }) => ({ username, password }))
      if (users.length === 0)
        throw new GatewayValidationError(
          'at least one enabled SOCKS credential is required',
        )
      document.listeners = [
        {
          name: 'gateway-socks',
          type: 'socks',
          listen: '0.0.0.0',
          port: state.gateway.port,
          udp: state.gateway.udp,
          proxy: 'GATEWAY',
          users,
        },
      ]
    }
    return stringify(document, { lineWidth: 0 })
  }

  async function snapshot(
    state: PersistedState,
    activeConfig: string,
    reason: string,
  ): Promise<GatewayRevision> {
    const revision: GatewayRevision = {
      id: `${now()}-${randomBytes(5).toString('hex')}`,
      createdAt: now(),
      reason,
    }
    const key = await loadOrCreateKey(options.dataDir, options.masterKey)
    await mkdir(revisionsDir, { recursive: true })
    await atomicWrite(
      join(revisionsDir, `${revision.id}.enc`),
      encryptJson({ state, activeConfig } satisfies RevisionPayload, key),
    )
    return revision
  }

  async function pruneRevisions(state: PersistedState): Promise<void> {
    const removed = state.revisions.slice(50)
    state.revisions = state.revisions.slice(0, 50)
    await Promise.all(
      removed.map((revision) =>
        unlink(join(revisionsDir, `${revision.id}.enc`)).catch(() => {}),
      ),
    )
  }

  async function apply(
    next: PersistedState,
    reason: string,
    baseContent?: string,
  ): Promise<void> {
    if (!supervisor) throw new Error('gateway supervisor is not bound')
    const previous = cloneState(await loadState())
    const previousActive = await readActive()
    const candidate = await overlay(
      baseContent ?? previousActive,
      next,
      previous,
    )
    const candidatePath = join(
      options.dataDir,
      `.active.gateway.${process.pid}.${randomBytes(4).toString('hex')}.yaml`,
    )
    await atomicWrite(candidatePath, candidate)
    try {
      const validation = await supervisor.validate(candidatePath)
      if (!validation.valid)
        throw new GatewayValidationError(
          validation.message || 'mihomo rejected the configuration',
        )
      const revision = await snapshot(previous, previousActive, reason)
      next.revisions = [revision, ...previous.revisions]
      await pruneRevisions(next)
      next.lastError = undefined
      await atomicWrite(options.activeConfigPath, candidate)
      await persistState(next)
      const kernel = await supervisor.restart()
      if (kernel.status !== 'running')
        throw new Error(kernel.lastError || 'mihomo failed to start')
      const verified = await waitForVerification(next)
      if (!verified)
        throw new Error('gateway listener or controller verification failed')
      next.lastAppliedAt = now()
      await persistState(next)
      await audit(reason, {
        port: next.gateway.port,
        enabled: next.gateway.enabled,
      })
    } catch (error) {
      previous.lastError =
        error instanceof Error ? error.message : String(error)
      await atomicWrite(options.activeConfigPath, previousActive)
      await persistState(previous)
      await supervisor.restart().catch(() => {})
      await audit('gateway.apply.failed', { reason, error: previous.lastError })
      throw error
    } finally {
      await unlink(candidatePath).catch(() => {})
    }
  }

  async function controllerRequest(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const base = options.controllerUrl.startsWith('http')
      ? options.controllerUrl
      : `http://${options.controllerUrl}`
    const headers = new Headers(init?.headers)
    if (options.controllerSecret)
      headers.set('authorization', `Bearer ${options.controllerSecret}`)
    return doFetch(`${base.replace(/\/$/, '')}${path}`, {
      ...init,
      headers,
    })
  }

  async function putProxy(group: string, name: string): Promise<void> {
    const response = await controllerRequest(
      `/proxies/${encodeURIComponent(group)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    )
    if (!response.ok)
      throw new GatewayValidationError(
        `mihomo rejected outbound selection (${response.status})`,
        502,
      )
  }

  async function listNodes(): Promise<GatewayNode[]> {
    try {
      const response = await controllerRequest('/proxies')
      if (!response.ok) return []
      const body = await response.json()
      if (!isRecord(body) || !isRecord(body.proxies)) return []
      return Object.entries(body.proxies)
        .filter(
          ([name, value]) =>
            !MANAGED_GROUPS.has(name) &&
            name !== 'DIRECT' &&
            name !== 'REJECT' &&
            isRecord(value) &&
            !Array.isArray(value.all),
        )
        .map(([name, value]) => {
          const proxy = value as Record<string, unknown>
          const history = Array.isArray(proxy.history) ? proxy.history : []
          const last = history.at(-1)
          return {
            id: name,
            name,
            ...(typeof proxy.type === 'string' ? { type: proxy.type } : {}),
            ...(typeof proxy.alive === 'boolean'
              ? { healthy: proxy.alive }
              : {}),
            latency:
              isRecord(last) && typeof last.delay === 'number'
                ? last.delay
                : null,
          }
        })
    } catch {
      return []
    }
  }

  async function waitForVerification(state: PersistedState): Promise<boolean> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const controller = await controllerRequest('/version')
        .then((r) => r.ok)
        .catch(() => false)
      const credential = state.credentials.find((item) => item.enabled)
      const listener =
        !state.gateway.enabled ||
        Boolean(
          credential &&
          (await verifySocksAuthentication(state.gateway.port, credential)),
        )
      if (controller && listener) return true
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return false
  }

  return {
    bindSupervisor(value) {
      supervisor = value
    },
    async overlayConfig(content) {
      return overlay(content, await loadState())
    },
    async getGateway() {
      return { ...(await loadState()).gateway, nodes: await listNodes() }
    },
    updateGateway(input) {
      return transaction(async () => {
        const next = cloneState(await loadState())
        if (input.port !== undefined) validatePort(input.port, minPort, maxPort)
        if (input.enabled !== undefined)
          next.gateway.enabled = Boolean(input.enabled)
        if (input.port !== undefined) next.gateway.port = input.port
        if (input.udp !== undefined) next.gateway.udp = Boolean(input.udp)
        next.gateway.updatedAt = now()
        await apply(next, 'gateway.update')
        return { ...next.gateway }
      })
    },
    async status() {
      const state = await loadState()
      const kernel = supervisor?.getState()
      const controllerReachable = await controllerRequest('/version')
        .then((r) => r.ok)
        .catch(() => false)
      const credential = state.credentials.find((item) => item.enabled)
      const listenerReachable =
        !state.gateway.enabled ||
        Boolean(
          credential &&
          (await verifySocksAuthentication(state.gateway.port, credential)),
        )
      let activeNode: string | undefined
      if (controllerReachable) {
        const activeGroup = await controllerRequest('/proxies/GATEWAY')
          .then((response) => (response.ok ? response.json() : undefined))
          .then((body) =>
            isRecord(body) && typeof body.now === 'string'
              ? body.now
              : undefined,
          )
          .catch(() => undefined)
        activeNode = activeGroup
        if (activeGroup && MANAGED_GROUPS.has(activeGroup)) {
          activeNode = await controllerRequest(
            `/proxies/${encodeURIComponent(activeGroup)}`,
          )
            .then((response) => (response.ok ? response.json() : undefined))
            .then((body) =>
              isRecord(body) && typeof body.now === 'string'
                ? body.now
                : activeGroup,
            )
            .catch(() => activeGroup)
        }
      }
      const nodes = await listNodes()
      if (state.gateway.mode === 'manual' && state.gateway.selectedNode) {
        const selected = nodes.find(
          (node) => node.id === state.gateway.selectedNode,
        )
        manualHealthFailures =
          selected?.healthy === false ? manualHealthFailures + 1 : 0
        if (manualHealthFailures >= 3 && controllerReachable) {
          await putProxy('GATEWAY', 'FAILOVER').catch(() => {})
          state.gateway.mode = 'failover'
          state.gateway.updatedAt = now()
          await persistState(state)
          await audit('outbound.health-fallback', {
            nodeId: state.gateway.selectedNode,
          })
          manualHealthFailures = 0
        }
      } else {
        manualHealthFailures = 0
      }
      return {
        healthy:
          kernel?.status === 'running' &&
          controllerReachable &&
          listenerReachable,
        running: kernel?.status === 'running',
        listenerReachable,
        controllerReachable,
        activeNode,
        mode: state.gateway.mode,
        port: state.gateway.port,
        nodes,
        lastAppliedAt: state.lastAppliedAt,
        lastError: state.lastError ?? kernel?.lastError,
      }
    },
    async listCredentials() {
      return (await loadState()).credentials.map(publicCredential)
    },
    createCredential(input) {
      return transaction(async () => {
        validateUsername(input.username)
        const password = input.password ?? generatePassword()
        validateCredentialPassword(password)
        const next = cloneState(await loadState())
        if (next.credentials.some((item) => item.username === input.username))
          throw new GatewayValidationError(
            'credential username already exists',
            409,
          )
        const credential: StoredCredential = {
          id: randomUUID(),
          username: input.username,
          password,
          enabled: input.enabled ?? true,
          createdAt: now(),
          updatedAt: now(),
        }
        next.credentials.push(credential)
        next.gateway.updatedAt = now()
        await apply(next, 'credential.create')
        return { ...publicCredential(credential), password }
      })
    },
    updateCredential(id, input) {
      return transaction(async () => {
        const next = cloneState(await loadState())
        const credential = next.credentials.find((item) => item.id === id)
        if (!credential)
          throw new GatewayValidationError('credential not found', 404)
        if (input.username !== undefined) {
          validateUsername(input.username)
          if (
            next.credentials.some(
              (item) => item.id !== id && item.username === input.username,
            )
          )
            throw new GatewayValidationError(
              'credential username already exists',
              409,
            )
          credential.username = input.username
        }
        if (input.enabled !== undefined)
          credential.enabled = Boolean(input.enabled)
        credential.updatedAt = now()
        next.gateway.updatedAt = now()
        await apply(next, 'credential.update')
        return publicCredential(credential)
      })
    },
    deleteCredential(id) {
      return transaction(async () => {
        const next = cloneState(await loadState())
        const index = next.credentials.findIndex((item) => item.id === id)
        if (index === -1)
          throw new GatewayValidationError('credential not found', 404)
        next.credentials.splice(index, 1)
        next.gateway.updatedAt = now()
        await apply(next, 'credential.delete')
      })
    },
    rotateCredential(id, supplied) {
      return transaction(async () => {
        const password = supplied ?? generatePassword()
        validateCredentialPassword(password)
        const next = cloneState(await loadState())
        const credential = next.credentials.find((item) => item.id === id)
        if (!credential)
          throw new GatewayValidationError('credential not found', 404)
        credential.password = password
        credential.updatedAt = now()
        next.gateway.updatedAt = now()
        await apply(next, 'credential.rotate')
        return { id, password }
      })
    },
    setOutbound(input) {
      return transaction(async () => {
        if (!['manual', 'auto', 'failover'].includes(input.mode))
          throw new GatewayValidationError('invalid outbound mode')
        if (input.mode === 'manual' && !input.nodeId)
          throw new GatewayValidationError('nodeId is required for manual mode')
        const next = cloneState(await loadState())
        if (input.mode === 'manual') {
          await putProxy('MANUAL', input.nodeId!)
          next.gateway.selectedNode = input.nodeId
        }
        await putProxy('GATEWAY', input.mode.toUpperCase())
        next.gateway.mode = input.mode
        next.gateway.updatedAt = now()
        await persistState(next)
        await audit('outbound.update', {
          mode: input.mode,
          nodeId: input.nodeId,
        })
        return { ...next.gateway }
      })
    },
    async listRevisions() {
      return [...(await loadState()).revisions]
    },
    rollback(id) {
      return transaction(async () => {
        const current = cloneState(await loadState())
        const revision = current.revisions.find((item) => item.id === id)
        if (!revision)
          throw new GatewayValidationError('revision not found', 404)
        const [raw, key] = await Promise.all([
          readFile(join(revisionsDir, `${id}.enc`), 'utf8'),
          loadOrCreateKey(options.dataDir, options.masterKey),
        ])
        const payload = decryptJson<RevisionPayload>(raw, key)
        const next = cloneState(payload.state)
        next.gateway.updatedAt = now()
        await apply(next, 'revision.rollback', payload.activeConfig)
        return { ...next.gateway }
      })
    },
    async listAudit(limit = 100) {
      const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500)
      try {
        const raw = await readFile(auditPath, 'utf8')
        return raw
          .trim()
          .split('\n')
          .slice(-bounded)
          .reverse()
          .map((line) => JSON.parse(line) as unknown)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    },
    replaceNodeSource(sourceId, proxies, reason) {
      return transaction(async () => {
        validateSourceId(sourceId)
        validateManagedProxies(proxies)
        const next = cloneState(await loadState())
        next.nodeSources[sourceId] = structuredClone(proxies)
        next.gateway.updatedAt = now()
        await apply(next, reason)
        return { ...next.gateway, nodes: await listNodes() }
      })
    },
    appendImportedNodes(proxies) {
      return transaction(async () => {
        validateManagedProxies(proxies)
        const next = cloneState(await loadState())
        const existing = next.nodeSources.manual ?? []
        next.nodeSources.manual = mergeManagedProxies(existing, proxies)
        next.gateway.updatedAt = now()
        await apply(next, 'import.apply')
        return { ...next.gateway, nodes: await listNodes() }
      })
    },
    removeNodeSource(sourceId, reason) {
      return transaction(async () => {
        validateSourceId(sourceId)
        const next = cloneState(await loadState())
        delete next.nodeSources[sourceId]
        if (
          next.gateway.selectedNode &&
          !allManagedNames(next).has(next.gateway.selectedNode)
        ) {
          next.gateway.selectedNode = undefined
          if (next.gateway.mode === 'manual') next.gateway.mode = 'failover'
        }
        next.gateway.updatedAt = now()
        await apply(next, reason)
        return { ...next.gateway, nodes: await listNodes() }
      })
    },
  }
}

function validateSourceId(sourceId: string): void {
  if (!/^[\w:-]{1,128}$/.test(sourceId))
    throw new GatewayValidationError('invalid node source id')
}

function validateManagedProxies(proxies: Array<Record<string, unknown>>): void {
  if (!Array.isArray(proxies) || proxies.length > 10_000)
    throw new GatewayValidationError('invalid or excessive node list')
  for (const proxy of proxies) {
    if (
      !isRecord(proxy) ||
      typeof proxy.name !== 'string' ||
      !proxy.name.trim()
    )
      throw new GatewayValidationError('every node must have a name')
  }
}

function mergeManagedProxies(
  current: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged = new Map(current.map((proxy) => [String(proxy.name), proxy]))
  for (const proxy of incoming) merged.set(String(proxy.name), proxy)
  return [...merged.values()]
}

function deduplicateManagedProxies(
  sources: Record<string, Array<Record<string, unknown>>>,
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = []
  const names = new Set<string>()
  for (const [sourceId, proxies] of Object.entries(sources)) {
    for (const original of proxies) {
      const proxy = structuredClone(original)
      const baseName = String(proxy.name)
      let name = RESERVED_PROXY_NAMES.has(baseName)
        ? `${baseName} [${sourceId}]`
        : baseName
      let suffix = 2
      while (names.has(name)) name = `${baseName} [${sourceId}:${suffix++}]`
      names.add(name)
      proxy.name = name
      output.push(proxy)
    }
  }
  return output
}

function allManagedNames(state: PersistedState): Set<string> {
  return new Set(
    deduplicateManagedProxies(state.nodeSources).map((proxy) =>
      String(proxy.name),
    ),
  )
}

function publicCredential(value: StoredCredential): GatewayCredential {
  return {
    id: value.id,
    username: value.username,
    enabled: value.enabled,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function validatePort(port: number, min: number, max: number): void {
  if (!Number.isInteger(port) || port < min || port > max)
    throw new GatewayValidationError(
      `port must be an integer within ${min}-${max}`,
    )
}

function validateUsername(username: string): void {
  if (typeof username !== 'string' || !/^[\w.@-]{1,64}$/.test(username))
    throw new GatewayValidationError(
      'username must be 1-64 safe ASCII characters',
    )
}

function validateCredentialPassword(password: string): void {
  if (
    typeof password !== 'string' ||
    password.length < 12 ||
    password.length > 128
  )
    throw new GatewayValidationError(
      'SOCKS password must contain 12 to 128 characters',
    )
}

function generatePassword(): string {
  return randomBytes(24).toString('base64url')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /password|secret|token|url|uuid/i.test(key) ? '[REDACTED]' : redact(item),
    ]),
  )
}

async function verifySocksAuthentication(
  port: number,
  credential: Pick<StoredCredential, 'username' | 'password'>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let stage: 'method' | 'auth' = 'method'
    let settled = false
    const done = (result: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(750)
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x02])))
    socket.on('data', (data) => {
      if (stage === 'method') {
        if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x02)
          return done(false)
        const username = Buffer.from(credential.username, 'utf8')
        const password = Buffer.from(credential.password, 'utf8')
        if (username.length > 255 || password.length > 255) return done(false)
        stage = 'auth'
        socket.write(
          Buffer.concat([
            Buffer.from([0x01, username.length]),
            username,
            Buffer.from([password.length]),
            password,
          ]),
        )
        return
      }
      done(data.length >= 2 && data[0] === 0x01 && data[1] === 0x00)
    })
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.once('close', () => done(false))
  })
}
