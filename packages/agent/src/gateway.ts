import type {
  GatewayMode,
  GatewayStateV1,
  GatewayStateV2,
  StoredGatewayCredential,
  StoredNode,
} from './gateway-state'
import type { MihomoProxy } from './subscription/types'
import type { MihomoSupervisor } from './types'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { generateGatewayConfig } from './gateway-config'
import {
  createInitialGatewayStateV2,
  GATEWAY_PORTS,
  migrateV1ToV2,
  validateGatewayStateV2,
} from './gateway-state'
import {
  atomicWrite,
  decryptJson,
  encryptJson,
  loadOrCreateKey,
} from './secure-store'
import { stableNodeId } from './subscription/parse'

export type { GatewayMode } from './gateway-state'

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

type StoredCredential = StoredGatewayCredential

export interface GatewayRevision {
  id: string
  createdAt: number
  reason: string
}

type PersistedState = GatewayStateV1 | GatewayStateV2

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
  verifyListener?: (
    port: number,
    credential: Pick<StoredGatewayCredential, 'username' | 'password'>,
  ) => Promise<boolean>
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
  bootstrap: () => Promise<void>
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
  const statePath = join(options.dataDir, 'gateway.enc')
  const v1BackupPath = join(options.dataDir, 'gateway.enc.v1.bak')
  const auditPath = join(options.dataDir, 'audit.jsonl')
  const revisionsDir = join(options.dataDir, 'revisions')
  let statePromise: Promise<PersistedState> | undefined
  let pendingState: GatewayStateV2 | undefined
  let supervisor: MihomoSupervisor | undefined
  let tail: Promise<unknown> = Promise.resolve()
  let bootstrapped = false

  function transaction<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn)
    tail = result.catch(() => {})
    return result
  }

  function initialState(): GatewayStateV2 {
    return createInitialGatewayStateV2()
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
          if (loaded.version === 1) {
            loaded.nodeSources ??= {}
            loaded.revisions ??= []
            return loaded
          }
          if (loaded.version === 2) {
            validateGatewayStateV2(loaded)
            return loaded
          }
          throw new Error('unsupported gateway state version')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          return initialState()
        }
      })()
    }
    return statePromise
  }

  async function persistState(state: PersistedState): Promise<void> {
    const key = await loadOrCreateKey(options.dataDir, options.masterKey)
    await atomicWrite(statePath, encryptJson(state, key))
    statePromise = Promise.resolve(structuredClone(state))
  }

  function cloneState<T extends PersistedState>(state: T): T {
    return structuredClone(state)
  }

  async function backupV1State(): Promise<void> {
    const original = await readFile(statePath)
    try {
      const handle = await open(v1BackupPath, 'wx', 0o600)
      try {
        await handle.writeFile(original)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await chmod(v1BackupPath, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readFile(v1BackupPath)
      if (!existing.equals(original))
        throw new Error('existing v1 backup does not match gateway.enc')
      await chmod(v1BackupPath, 0o600)
    }
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

  async function readActive(): Promise<{ content: string; exists: boolean }> {
    try {
      return {
        content: await readFile(options.activeConfigPath, 'utf8'),
        exists: true,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { content: '', exists: false }
      throw error
    }
  }

  async function readPersistedBytes(): Promise<Buffer | undefined> {
    try {
      return await readFile(statePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async function overlayLegacy(
    content: string,
    state: GatewayStateV1,
    previousState?: GatewayStateV1,
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
        .filter((item): item is GatewayStateV1 => Boolean(item))
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

  async function overlay(
    content: string,
    state: PersistedState,
    previousState?: PersistedState,
  ): Promise<string> {
    if (state.version === 2) return generateGatewayConfig(content, state)
    return overlayLegacy(
      content,
      state,
      previousState?.version === 1 ? previousState : undefined,
    )
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
    const path = join(revisionsDir, `${revision.id}.enc`)
    try {
      await atomicWrite(
        path,
        encryptJson({ state, activeConfig } satisfies RevisionPayload, key),
      )
    } catch (error) {
      await unlink(path).catch(() => {})
      throw error
    }
    return revision
  }

  async function pruneRevisionFiles(
    revisions: GatewayRevision[],
  ): Promise<void> {
    await Promise.all(
      revisions.map((revision) =>
        unlink(join(revisionsDir, `${revision.id}.enc`)).catch(() => {}),
      ),
    )
  }

  async function cleanupOrphanRevisionFiles(
    revisions: GatewayRevision[],
  ): Promise<void> {
    let files: string[]
    try {
      files = await readdir(revisionsDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const referenced = new Set(
      revisions.map((revision) => `${revision.id}.enc`),
    )
    await Promise.all(
      files
        .filter((file) => file.endsWith('.enc') && !referenced.has(file))
        .map((file) => unlink(join(revisionsDir, file))),
    )
  }

  async function apply(
    candidateState: GatewayStateV2,
    reason: string,
    baseContent?: string,
    lifecycle: 'start' | 'restart' = 'restart',
    previousState?: PersistedState,
    createRevision = true,
  ): Promise<void> {
    if (!supervisor) throw new Error('gateway supervisor is not bound')
    const previous = cloneState(previousState ?? (await loadState()))
    const previousStateBytes = await readPersistedBytes()
    const next = cloneState(candidateState)
    validateGatewayStateV2(next)
    const previousActive = await readActive()
    const candidate = generateGatewayConfig(
      baseContent ?? previousActive.content,
      next,
    )
    const candidatePath = join(
      options.dataDir,
      `.active.gateway.${process.pid}.${randomBytes(4).toString('hex')}.yaml`,
    )
    await atomicWrite(candidatePath, candidate)
    let revision: GatewayRevision | undefined
    let activeWriteStarted = false
    let processStartAttempted = false
    let stateWriteStarted = false
    try {
      const validation = await supervisor.validate(candidatePath)
      if (!validation.valid)
        throw new GatewayValidationError(
          validation.message || 'mihomo rejected the configuration',
        )
      let removedRevisions: GatewayRevision[] = []
      if (createRevision) {
        revision = await snapshot(previous, previousActive.content, reason)
        const revisions = [revision, ...previous.revisions]
        removedRevisions = revisions.slice(50)
        next.revisions = revisions.slice(0, 50)
      } else {
        next.revisions = [...previous.revisions]
      }
      next.lastError = undefined
      pendingState = next
      activeWriteStarted = true
      await atomicWrite(options.activeConfigPath, candidate)
      processStartAttempted = true
      const kernel = await supervisor[lifecycle]()
      if (kernel.status !== 'running')
        throw new Error(kernel.lastError || 'mihomo failed to start')
      const verified = await waitForVerification(next)
      if (!verified)
        throw new Error('gateway listener or controller verification failed')
      next.lastAppliedAt = now()
      stateWriteStarted = true
      await persistState(next)
      pendingState = undefined
      await pruneRevisionFiles(removedRevisions)
      await audit(reason, {
        ports: next.ports
          .filter(({ enabled }) => enabled)
          .map(({ port }) => port),
      }).catch(() => {})
    } catch (error) {
      pendingState = undefined
      if (activeWriteStarted)
        if (previousActive.exists) {
          await atomicWrite(options.activeConfigPath, previousActive.content)
        } else {
          await unlink(options.activeConfigPath).catch(
            (unlinkError: NodeJS.ErrnoException) => {
              if (unlinkError.code !== 'ENOENT') throw unlinkError
            },
          )
        }
      if (stateWriteStarted) {
        if (previousStateBytes) {
          await atomicWrite(statePath, previousStateBytes)
        } else {
          await unlink(statePath).catch(
            (unlinkError: NodeJS.ErrnoException) => {
              if (unlinkError.code !== 'ENOENT') throw unlinkError
            },
          )
        }
      }
      statePromise = Promise.resolve(cloneState(previous))
      if (processStartAttempted) {
        if (lifecycle === 'start') await supervisor.stop().catch(() => {})
        else await supervisor.restart().catch(() => {})
      }
      if (revision)
        await unlink(join(revisionsDir, `${revision.id}.enc`)).catch(() => {})
      await audit('gateway.apply.failed', {
        reason,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
      throw error
    } finally {
      await unlink(candidatePath).catch(() => {})
    }
  }

  async function loadV2State(): Promise<GatewayStateV2> {
    if (!bootstrapped)
      throw new GatewayValidationError(
        'gateway bootstrap is required before mutations',
        503,
      )
    const state = await loadState()
    if (state.version !== 2)
      throw new GatewayValidationError(
        'gateway bootstrap is required before mutations',
        503,
      )
    return state
  }

  function gatewayView(state: PersistedState): GatewayConfig {
    if (state.version === 1) return { ...state.gateway }
    const port = state.ports[0]!
    const hop = port.hops[0]
    return {
      enabled: port.enabled,
      port: port.port,
      udp: false,
      mode: hop?.mode ?? 'failover',
      ...(hop?.mode === 'manual' ? { selectedNode: hop.nodeIds[0] } : {}),
      updatedAt: state.lastAppliedAt ?? 0,
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

  async function waitForVerification(state: GatewayStateV2): Promise<boolean> {
    const credentials = new Map(
      state.credentials.map((credential) => [credential.id, credential]),
    )
    const verifyListener = options.verifyListener ?? verifySocksAuthentication
    for (let attempt = 0; attempt < 20; attempt++) {
      const controller = await controllerRequest('/version')
        .then((response) => response.ok)
        .catch(() => false)
      if (controller) {
        const listeners = await Promise.all(
          state.ports
            .filter(({ enabled }) => enabled)
            .map(async (port) => {
              const credential = port.credentialIds
                .map((id) => credentials.get(id))
                .find((item) => item?.enabled)
              return Boolean(
                credential && (await verifyListener(port.port, credential)),
              )
            }),
        )
        if (listeners.every(Boolean)) return true
      }
      if (attempt < 19 && !options.verifyListener)
        await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return false
  }

  return {
    bindSupervisor(value) {
      supervisor = value
    },
    bootstrap() {
      return transaction(async () => {
        if (bootstrapped) return
        if (!supervisor) throw new Error('gateway supervisor is not bound')
        const previous = cloneState(await loadState())
        let next: GatewayStateV2
        if (previous.version === 1) {
          await backupV1State()
          next = migrateV1ToV2(previous)
        } else {
          next = cloneState(previous)
        }
        validateGatewayStateV2(next)
        await cleanupOrphanRevisionFiles(previous.revisions)
        const lifecycle =
          supervisor.getState().status === 'running' ? 'restart' : 'start'
        await apply(
          next,
          'gateway.bootstrap',
          undefined,
          lifecycle,
          previous,
          previous.version === 1,
        )
        bootstrapped = true
      })
    },
    async overlayConfig(content) {
      return overlay(content, pendingState ?? (await loadState()))
    },
    async getGateway() {
      return { ...gatewayView(await loadState()), nodes: await listNodes() }
    },
    updateGateway(input) {
      return transaction(async () => {
        const next = cloneState(await loadV2State())
        if (input.port !== undefined && input.port !== GATEWAY_PORTS[0])
          throw new GatewayValidationError('gateway port is fixed at 10001')
        if (input.udp)
          throw new GatewayValidationError(
            'UDP is not supported by the gateway',
          )
        if (input.enabled !== undefined)
          next.ports[0]!.enabled = Boolean(input.enabled)
        await apply(next, 'gateway.update')
        return gatewayView(next)
      })
    },
    async status() {
      const state = await loadState()
      const view = gatewayView(state)
      const kernel = supervisor?.getState()
      const controllerReachable = await controllerRequest('/version')
        .then((r) => r.ok)
        .catch(() => false)
      const credential = state.credentials.find((item) => item.enabled)
      const listenerReachable =
        !view.enabled ||
        Boolean(
          credential &&
          (await (options.verifyListener ?? verifySocksAuthentication)(
            view.port,
            credential,
          )),
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
      return {
        healthy:
          kernel?.status === 'running' &&
          controllerReachable &&
          listenerReachable,
        running: kernel?.status === 'running',
        listenerReachable,
        controllerReachable,
        activeNode,
        mode: view.mode,
        port: view.port,
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
        const next = cloneState(await loadV2State())
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
        if (credential.enabled) next.ports[0]!.credentialIds.push(credential.id)
        await apply(next, 'credential.create')
        return { ...publicCredential(credential), password }
      })
    },
    updateCredential(id, input) {
      return transaction(async () => {
        const next = cloneState(await loadV2State())
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
        if (input.enabled !== undefined) {
          credential.enabled = Boolean(input.enabled)
          if (
            credential.enabled &&
            !next.ports[0]!.credentialIds.includes(credential.id)
          )
            next.ports[0]!.credentialIds.push(credential.id)
        }
        credential.updatedAt = now()
        await apply(next, 'credential.update')
        return publicCredential(credential)
      })
    },
    deleteCredential(id) {
      return transaction(async () => {
        const next = cloneState(await loadV2State())
        const index = next.credentials.findIndex((item) => item.id === id)
        if (index === -1)
          throw new GatewayValidationError('credential not found', 404)
        next.credentials.splice(index, 1)
        for (const port of next.ports)
          port.credentialIds = port.credentialIds.filter(
            (credentialId) => credentialId !== id,
          )
        await apply(next, 'credential.delete')
      })
    },
    rotateCredential(id, supplied) {
      return transaction(async () => {
        const password = supplied ?? generatePassword()
        validateCredentialPassword(password)
        const next = cloneState(await loadV2State())
        const credential = next.credentials.find((item) => item.id === id)
        if (!credential)
          throw new GatewayValidationError('credential not found', 404)
        credential.password = password
        credential.updatedAt = now()
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
        const next = cloneState(await loadV2State())
        const enabledNodes = Object.values(next.nodeSources)
          .flatMap((source) => source.nodes)
          .filter(({ enabled }) => enabled)
        const requested = input.nodeId
          ? enabledNodes.find(
              (node) =>
                node.id === input.nodeId || node.proxy.name === input.nodeId,
            )
          : undefined
        const nodeIds =
          input.mode === 'manual'
            ? requested
              ? [requested.id]
              : []
            : [...new Set(enabledNodes.map(({ id }) => id))]
        next.ports[0]!.hops = [{ mode: input.mode, nodeIds }]
        await apply(next, 'outbound.update')
        return gatewayView(next)
      })
    },
    async listRevisions() {
      return [...(await loadState()).revisions]
    },
    rollback(id) {
      return transaction(async () => {
        const current = cloneState(await loadV2State())
        const revision = current.revisions.find((item) => item.id === id)
        if (!revision)
          throw new GatewayValidationError('revision not found', 404)
        const [raw, key] = await Promise.all([
          readFile(join(revisionsDir, `${id}.enc`), 'utf8'),
          loadOrCreateKey(options.dataDir, options.masterKey),
        ])
        const payload = decryptJson<RevisionPayload>(raw, key)
        const next =
          payload.state.version === 1
            ? migrateV1ToV2(payload.state)
            : cloneState(payload.state)
        await apply(next, 'revision.rollback', payload.activeConfig)
        return gatewayView(next)
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
        const next = cloneState(await loadV2State())
        next.nodeSources[sourceId] = {
          nodes: proxies.map(storedNode),
          excludedNodeIds: [],
        }
        await apply(next, reason)
        return { ...gatewayView(next), nodes: await listNodes() }
      })
    },
    appendImportedNodes(proxies) {
      return transaction(async () => {
        validateManagedProxies(proxies)
        const next = cloneState(await loadV2State())
        const existing = next.nodeSources.manual?.nodes ?? []
        const nodes = new Map(existing.map((node) => [node.id, node]))
        for (const proxy of proxies) {
          const node = storedNode(proxy)
          nodes.set(node.id, node)
        }
        next.nodeSources.manual = {
          nodes: [...nodes.values()],
          excludedNodeIds: [],
        }
        await apply(next, 'import.apply')
        return { ...gatewayView(next), nodes: await listNodes() }
      })
    },
    removeNodeSource(sourceId, reason) {
      return transaction(async () => {
        validateSourceId(sourceId)
        const next = cloneState(await loadV2State())
        delete next.nodeSources[sourceId]
        const remaining = new Set(
          Object.values(next.nodeSources).flatMap((source) =>
            source.nodes.map(({ id }) => id),
          ),
        )
        for (const port of next.ports) {
          port.hops = port.hops.map((hop) => ({
            ...hop,
            nodeIds: hop.nodeIds.filter((id) => remaining.has(id)),
          }))
          if (port.hops.some((hop) => hop.nodeIds.length === 0)) {
            port.enabled = false
            port.hops = []
          }
        }
        await apply(next, reason)
        return { ...gatewayView(next), nodes: await listNodes() }
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

function storedNode(proxy: Record<string, unknown>): StoredNode {
  const value = structuredClone(proxy) as unknown as MihomoProxy
  return { id: stableNodeId(value), enabled: true, proxy: value }
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

function publicCredential(value: StoredCredential): GatewayCredential {
  return {
    id: value.id,
    username: value.username,
    enabled: value.enabled,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
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
