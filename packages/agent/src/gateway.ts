import type {
  GatewayHop,
  GatewayMode,
  GatewayPort,
  GatewayStateV1,
  GatewayStateV2,
  StoredGatewayCredential,
  StoredNode,
} from './gateway-state'
import type { NormalizedNode } from './subscription/types'
import type { KernelStatus, MihomoSupervisor } from './types'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import {
  gatewayGroupName,
  gatewayLandingNodeName,
  gatewayRuntimeNodeName,
  generateGatewayConfig,
} from './gateway-config'
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
  loadExistingKey,
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
  controllerUrl: string
  controllerSecret?: string
  controllerCorsOrigins?: string[]
  agentVersion?: string
  fetch?: typeof fetch
  now?: () => number
  verifyListener?: (
    port: number,
    credential: Pick<StoredGatewayCredential, 'username' | 'password'>,
  ) => Promise<boolean>
}

export type GatewayHealth = 'healthy' | 'unhealthy' | 'unknown' | 'disabled'

export type GatewayListenerErrorCode =
  'NO_ENABLED_CREDENTIAL' | 'UNREACHABLE' | 'PROBE_FAILED'

export type GatewayApplyErrorCode =
  | 'VALIDATION_FAILED'
  | 'RUNTIME_FAILED'
  | 'VERIFICATION_FAILED'
  | 'PERSIST_FAILED'
  | 'APPLY_FAILED'

export interface GatewayListenerStatus {
  id: number
  port: number
  enabled: boolean
  health: GatewayHealth
  reachable: boolean | null
  errorCode: GatewayListenerErrorCode | null
}

export interface GatewayHopStatus {
  index: number
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

export interface GatewayLastApply {
  result: 'success' | 'failure'
  at: number
  reason: string
  errorCode: GatewayApplyErrorCode | null
}

export interface GatewayStatus {
  services: {
    agent: { state: 'running'; health: 'healthy' }
    mihomo: {
      state: KernelStatus | 'unknown'
      health: Exclude<GatewayHealth, 'disabled'>
      controllerReachable: boolean
    }
  }
  versions: { agent: string; mihomo: string | null }
  listeners: GatewayListenerStatus[]
  ports: GatewayPortStatus[]
  lastApply: GatewayLastApply | null
}

export interface GatewayManager {
  bindSupervisor: (supervisor: MihomoSupervisor) => void
  bootstrap: () => Promise<void>
  reapply: () => Promise<void>
  overlayConfig: (content: string) => Promise<string>
  getGateway: () => Promise<GatewayConfig>
  updateGateway: (
    input: Partial<Pick<GatewayConfig, 'enabled' | 'port' | 'udp'>>,
  ) => Promise<GatewayConfig>
  status: () => Promise<GatewayStatus>
  listNodes: () => Promise<GatewayNode[]>
  updateNode: (id: string, input: { enabled: boolean }) => Promise<GatewayNode>
  testNode: (id: string) => Promise<GatewayNodeTestResult>
  nodeImpact: (id: string) => Promise<GatewayNodeImpact>
  deleteNode: (id: string, confirmed: boolean) => Promise<void>
  listPorts: () => Promise<GatewayPort[]>
  updatePort: (
    id: number,
    input: {
      enabled?: boolean
      credentialIds?: string[]
      hops?: GatewayHop[]
    },
  ) => Promise<GatewayPort>
  listCredentials: () => Promise<GatewayCredential[]>
  createCredential: (input: {
    username: string
    password?: string
    enabled?: boolean
    portIds?: number[]
  }) => Promise<GatewayCredential & { password: string }>
  updateCredential: (
    id: string,
    input: { username?: string; enabled?: boolean; portIds?: number[] },
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
    nodes: NormalizedNode[],
    reason: string,
  ) => Promise<GatewayConfig>
  replaceNodeSources: (
    sources: Array<{ sourceId: string; nodes: NormalizedNode[] }>,
    reason: string,
  ) => Promise<GatewayConfig>
  appendImportedNodes: (nodes: NormalizedNode[]) => Promise<GatewayConfig>
  removeNodeSource: (sourceId: string, reason: string) => Promise<GatewayConfig>
}

export class GatewayValidationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly details?: GatewayNodeImpact,
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
        let raw: string
        try {
          raw = await readFile(statePath, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          return initialState()
        }
        const key = await loadExistingKey(options.dataDir, options.masterKey)
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

  async function readLastApply(): Promise<GatewayLastApply | null> {
    let raw: string
    try {
      raw = await readFile(auditPath, 'utf8')
    } catch {
      return null
    }
    const lines = raw.split(/\r?\n/).reverse()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const projected = projectLastApply(JSON.parse(line) as unknown)
        if (projected) return projected
      } catch {
        // A malformed legacy line must not make status fail or expose its text.
      }
    }
    return null
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
    const candidatePath = join(
      options.dataDir,
      `.active.gateway.${process.pid}.${randomBytes(4).toString('hex')}.yaml`,
    )
    let previousActive: { content: string; exists: boolean } | undefined
    let revision: GatewayRevision | undefined
    let activeWriteStarted = false
    let processStartAttempted = false
    let stateWriteStarted = false
    let validatingState = true
    try {
      const next = cloneState(candidateState)
      try {
        validateGatewayStateV2(next)
      } catch (error) {
        throw new GatewayValidationError(
          error instanceof Error ? error.message : 'invalid gateway state',
        )
      }
      validatingState = false
      previousActive = await readActive()
      const candidate = generateGatewayConfig(
        baseContent ?? previousActive.content,
        next,
      )
      await atomicWrite(candidatePath, candidate)
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
      if (activeWriteStarted && previousActive)
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
        errorCode: classifyApplyError(
          error,
          processStartAttempted,
          stateWriteStarted,
          validatingState,
        ),
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

  async function readNodes(): Promise<GatewayNode[]> {
    const state = await loadState()
    if (state.version === 1) {
      const nodes = new Map<string, GatewayNode>()
      for (const [sourceId, proxies] of orderedNodeSources(state.nodeSources)) {
        for (const proxy of proxies) {
          const id = stableNodeId(proxy)
          const existing = nodes.get(id)
          if (existing) {
            if (!existing.sourceIds.includes(sourceId))
              existing.sourceIds.push(sourceId)
          } else {
            nodes.set(id, {
              id,
              name: proxy.name,
              type: proxy.type,
              enabled: true,
              sourceIds: [sourceId],
              portIds: [],
            })
          }
        }
      }
      return [...nodes.values()]
    }
    return listPersistedNodes(state)
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
        try {
          if (previous.version === 1) {
            await backupV1State()
            next = migrateV1ToV2(previous)
          } else {
            next = cloneState(previous)
          }
        } catch (error) {
          await audit('gateway.apply.failed', {
            reason: 'gateway.bootstrap',
            errorCode: 'VALIDATION_FAILED',
          }).catch(() => {})
          throw error
        }
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
    reapply() {
      return transaction(async () => {
        const current = cloneState(await loadV2State())
        await apply(current, 'gateway.reapply')
      })
    },
    async overlayConfig(content) {
      return overlay(content, pendingState ?? (await loadState()))
    },
    async getGateway() {
      return { ...gatewayView(await loadState()), nodes: await readNodes() }
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
      const persisted = await loadState()
      const state =
        persisted.version === 2 ? persisted : migrateV1ToV2(persisted)
      const kernel = supervisor?.getState()
      const credentials = new Map(
        state.credentials.map((credential) => [credential.id, credential]),
      )
      const verifyListener = options.verifyListener ?? verifySocksAuthentication
      const controllerPromise = controllerRequest('/proxies', { method: 'GET' })
        .then(async (response) => {
          if (!response.ok)
            return {
              reachable: false,
              proxies: undefined as Record<string, unknown> | undefined,
            }
          const body = (await response.json()) as unknown
          return {
            reachable: true,
            proxies:
              isRecord(body) && isRecord(body.proxies)
                ? body.proxies
                : undefined,
          }
        })
        .catch(() => ({
          reachable: false,
          proxies: undefined as Record<string, unknown> | undefined,
        }))
      const listenersPromise = Promise.all(
        state.ports.map(async (port): Promise<GatewayListenerStatus> => {
          const base = {
            id: port.id,
            port: port.port,
            enabled: port.enabled,
          }
          if (!port.enabled)
            return {
              ...base,
              health: 'disabled',
              reachable: null,
              errorCode: null,
            }
          const credential = port.credentialIds
            .map((id) => credentials.get(id))
            .find((item) => item?.enabled)
          if (!credential)
            return {
              ...base,
              health: 'unhealthy',
              reachable: false,
              errorCode: 'NO_ENABLED_CREDENTIAL',
            }
          try {
            const reachable = await verifyListener(port.port, credential)
            return {
              ...base,
              health: reachable ? 'healthy' : 'unhealthy',
              reachable,
              errorCode: reachable ? null : 'UNREACHABLE',
            }
          } catch {
            return {
              ...base,
              health: 'unhealthy',
              reachable: false,
              errorCode: 'PROBE_FAILED',
            }
          }
        }),
      )
      const [controller, listeners, lastApply] = await Promise.all([
        controllerPromise,
        listenersPromise,
        readLastApply(),
      ])
      const enabledNodes = enabledStateByNodeId(state)
      const listenerById = new Map(
        listeners.map((listener) => [listener.id, listener]),
      )
      const ports = state.ports.map((port): GatewayPortStatus => {
        const hops = port.hops.map((hop, index) =>
          projectGatewayHop(port, hop, index, controller.proxies, enabledNodes),
        )
        return {
          id: port.id,
          port: port.port,
          enabled: port.enabled,
          health: port.enabled
            ? gatewayPortHealth(listenerById.get(port.id), hops)
            : 'disabled',
          hops,
        }
      })
      const mihomoHealth = gatewayMihomoHealth(
        kernel?.status,
        controller.reachable && Boolean(controller.proxies),
      )
      return {
        services: {
          agent: { state: 'running', health: 'healthy' },
          mihomo: {
            state: kernel?.status ?? 'unknown',
            health: mihomoHealth,
            controllerReachable: controller.reachable,
          },
        },
        versions: {
          agent: options.agentVersion ?? 'unknown',
          mihomo: kernel?.version ?? null,
        },
        listeners,
        ports,
        lastApply,
      }
    },
    async listPorts() {
      return structuredClone((await loadV2State()).ports)
    },
    listNodes: readNodes,
    updateNode(id, input) {
      return transaction(async () => {
        if (typeof input.enabled !== 'boolean')
          throw new GatewayValidationError('node enabled must be boolean')
        const next = cloneState(await loadV2State())
        const matches = findStoredNodes(next, id)
        if (matches.length === 0)
          throw new GatewayValidationError('node not found', 404)
        for (const node of matches) node.enabled = input.enabled
        if (!input.enabled) disablePortsWithoutEnabledNodeCandidates(next)
        await apply(next, 'node.update')
        return gatewayNode(next, id)!
      })
    },
    async testNode(id) {
      const state = await loadV2State()
      const node = gatewayNode(state, id)
      if (!node) return { reachable: false, errorCode: 'NODE_NOT_FOUND' }
      if (!node.enabled)
        return { reachable: false, errorCode: 'NODE_NOT_ACTIVE' }

      let response: Response
      try {
        response = await controllerRequest(
          `/proxies/${encodeURIComponent(`GW-NODE-${id}`)}/delay?url=${encodeURIComponent('https://www.gstatic.com/generate_204')}&timeout=5000`,
        )
      } catch {
        return { reachable: false, errorCode: 'CONTROLLER_UNAVAILABLE' }
      }
      if (!response.ok) return { reachable: false, errorCode: 'PROBE_FAILED' }
      try {
        const body = await response.json()
        if (
          !isRecord(body) ||
          typeof body.delay !== 'number' ||
          !Number.isFinite(body.delay) ||
          body.delay <= 0
        )
          return { reachable: false, errorCode: 'PROBE_FAILED' }
        return { reachable: true, latencyMs: body.delay }
      } catch {
        return { reachable: false, errorCode: 'PROBE_FAILED' }
      }
    },
    async nodeImpact(id) {
      const state = await loadV2State()
      if (!gatewayNode(state, id))
        throw new GatewayValidationError('node not found', 404)
      return calculateNodeImpact(state, id)
    },
    deleteNode(id, confirmed) {
      return transaction(async () => {
        const next = cloneState(await loadV2State())
        const containingSources = Object.entries(next.nodeSources).filter(
          ([, source]) => source.nodes.some((node) => node.id === id),
        )
        if (containingSources.length === 0)
          throw new GatewayValidationError('node not found', 404)
        const impact = calculateNodeImpact(next, id)
        if (impact.affectedPortIds.length > 0 && !confirmed)
          throw new GatewayValidationError(
            'node deletion requires confirmation',
            409,
            impact,
          )
        for (const [sourceId, source] of containingSources) {
          source.nodes = source.nodes.filter((node) => node.id !== id)
          if (
            sourceId.startsWith('subscription:') &&
            !source.excludedNodeIds.includes(id)
          )
            source.excludedNodeIds.push(id)
        }
        removeNodeReferences(next, new Set([id]))
        await apply(next, 'node.delete')
      })
    },
    updatePort(id, input) {
      return transaction(async () => {
        validatePortId(id)
        if ('id' in input || 'port' in input)
          throw new GatewayValidationError(
            'gateway port id and fixed port number are not editable',
          )
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
          throw new GatewayValidationError(
            'gateway port enabled must be boolean',
          )

        const next = cloneState(await loadV2State())
        const port = next.ports[id - 1]!
        if (input.enabled !== undefined) port.enabled = input.enabled
        if (input.credentialIds !== undefined)
          port.credentialIds = structuredClone(input.credentialIds)
        if (input.hops !== undefined) port.hops = structuredClone(input.hops)
        if (input.enabled !== true)
          disablePortWithoutEnabledCredential(next, port)
        await apply(next, 'port.update')
        return structuredClone(port)
      })
    },
    async listCredentials() {
      const state = await loadState()
      return state.credentials.map((credential) =>
        publicCredential(credential, state),
      )
    },
    createCredential(input) {
      return transaction(async () => {
        validateUsername(input.username)
        const password = input.password ?? generatePassword()
        validateCredentialPassword(password)
        const portIds = normalizePortIds(input.portIds ?? [])
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
        setCredentialPortIds(next, credential.id, portIds)
        await apply(next, 'credential.create')
        return { ...publicCredential(credential, next), password }
      })
    },
    updateCredential(id, input) {
      return transaction(async () => {
        const portIds =
          input.portIds === undefined
            ? undefined
            : normalizePortIds(input.portIds)
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
        if (input.enabled !== undefined)
          credential.enabled = Boolean(input.enabled)
        if (portIds !== undefined)
          setCredentialPortIds(next, credential.id, portIds)
        disablePortsWithoutEnabledCredentials(next)
        credential.updatedAt = now()
        await apply(next, 'credential.update')
        return publicCredential(credential, next)
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
        disablePortsWithoutEnabledCredentials(next)
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
    replaceNodeSource(sourceId, nodes, reason) {
      return transaction(async () => {
        validateSourceId(sourceId)
        const normalized = normalizeManagedNodes(nodes)
        const next = cloneState(await loadV2State())
        const enabledSnapshot = enabledStateByNodeId(next)
        replaceNodeSourceInState(next, sourceId, normalized, enabledSnapshot)
        pruneUnavailableNodeCandidates(next)
        disablePortsWithoutEnabledNodeCandidates(next)
        await apply(next, reason)
        return { ...gatewayView(next), nodes: listPersistedNodes(next) }
      })
    },
    replaceNodeSources(sources, reason) {
      return transaction(async () => {
        if (!Array.isArray(sources))
          throw new GatewayValidationError('node sources must be an array')
        const sourceIds = new Set<string>()
        const replacements = sources.map(({ sourceId, nodes }) => {
          validateSourceId(sourceId)
          if (sourceIds.has(sourceId))
            throw new GatewayValidationError(
              `duplicate node source ${sourceId}`,
            )
          sourceIds.add(sourceId)
          return { sourceId, nodes: normalizeManagedNodes(nodes) }
        })
        const next = cloneState(await loadV2State())
        const enabledSnapshot = enabledStateByNodeId(next)
        for (const replacement of replacements)
          replaceNodeSourceInState(
            next,
            replacement.sourceId,
            replacement.nodes,
            enabledSnapshot,
          )
        pruneUnavailableNodeCandidates(next)
        disablePortsWithoutEnabledNodeCandidates(next)
        await apply(next, reason)
        return { ...gatewayView(next), nodes: listPersistedNodes(next) }
      })
    },
    appendImportedNodes(inputNodes) {
      return transaction(async () => {
        const normalized = normalizeManagedNodes(inputNodes)
        const next = cloneState(await loadV2State())
        const importedIds = new Set(normalized.map(({ id }) => id))
        for (const source of Object.values(next.nodeSources))
          source.excludedNodeIds = source.excludedNodeIds.filter(
            (id) => !importedIds.has(id),
          )
        const existing = next.nodeSources.manual?.nodes ?? []
        const manualNodes = new Map(existing.map((node) => [node.id, node]))
        const enabledById = enabledStateByNodeId(next)
        for (const value of normalized) {
          const node = storedNode(value, enabledById.get(value.id) ?? true)
          manualNodes.set(node.id, node)
        }
        next.nodeSources.manual = {
          nodes: [...manualNodes.values()],
          excludedNodeIds: next.nodeSources.manual?.excludedNodeIds ?? [],
        }
        await apply(next, 'import.apply')
        return { ...gatewayView(next), nodes: listPersistedNodes(next) }
      })
    },
    removeNodeSource(sourceId, reason) {
      return transaction(async () => {
        validateSourceId(sourceId)
        const next = cloneState(await loadV2State())
        delete next.nodeSources[sourceId]
        pruneUnavailableNodeCandidates(next)
        disablePortsWithoutEnabledNodeCandidates(next)
        await apply(next, reason)
        return { ...gatewayView(next), nodes: listPersistedNodes(next) }
      })
    },
  }
}

function projectGatewayHop(
  port: GatewayPort,
  hop: GatewayHop,
  index: number,
  proxies: Readonly<Record<string, unknown>> | undefined,
  enabledNodes: ReadonlyMap<string, boolean>,
): GatewayHopStatus {
  const base = { index: index + 1, mode: hop.mode }
  if (!port.enabled) return { ...base, activeNodeId: null, health: 'disabled' }
  if (!proxies) return { ...base, activeNodeId: null, health: 'unknown' }

  const group = proxies[gatewayGroupName(port.port, index + 1)]
  if (!isRecord(group) || typeof group.now !== 'string')
    return { ...base, activeNodeId: null, health: 'unknown' }
  if (group.now === 'REJECT')
    return { ...base, activeNodeId: null, health: 'unhealthy' }

  const activeNodeId =
    hop.nodeIds.find((id) =>
      index === 0
        ? gatewayRuntimeNodeName(id) === group.now
        : gatewayLandingNodeName(port.port, id) === group.now,
    ) ?? null
  if (!activeNodeId) return { ...base, activeNodeId: null, health: 'unknown' }
  if (!enabledNodes.get(activeNodeId))
    return { ...base, activeNodeId, health: 'unhealthy' }

  const active = proxies[group.now]
  const health: GatewayHealth =
    isRecord(active) && active.alive === true
      ? 'healthy'
      : isRecord(active) && active.alive === false
        ? 'unhealthy'
        : 'unknown'
  return { ...base, activeNodeId, health }
}

function gatewayPortHealth(
  listener: GatewayListenerStatus | undefined,
  hops: GatewayHopStatus[],
): GatewayHealth {
  if (
    listener?.health === 'unhealthy' ||
    hops.some(({ health }) => health === 'unhealthy')
  )
    return 'unhealthy'
  if (
    listener?.health !== 'healthy' ||
    hops.some(({ health }) => health !== 'healthy')
  )
    return 'unknown'
  return 'healthy'
}

function gatewayMihomoHealth(
  status: KernelStatus | undefined,
  controllerUsable: boolean,
): Exclude<GatewayHealth, 'disabled'> {
  if (!status || status === 'starting' || status === 'stopping')
    return 'unknown'
  if (status !== 'running') return 'unhealthy'
  return controllerUsable ? 'healthy' : 'unhealthy'
}

function classifyApplyError(
  error: unknown,
  processStartAttempted: boolean,
  stateWriteStarted: boolean,
  validatingState: boolean,
): GatewayApplyErrorCode {
  if (validatingState) return 'VALIDATION_FAILED'
  if (error instanceof GatewayValidationError) return 'VALIDATION_FAILED'
  if (
    error instanceof Error &&
    error.message === 'gateway listener or controller verification failed'
  )
    return 'VERIFICATION_FAILED'
  if (stateWriteStarted) return 'PERSIST_FAILED'
  if (processStartAttempted) return 'RUNTIME_FAILED'
  return 'APPLY_FAILED'
}

const GATEWAY_APPLY_ERROR_CODES: ReadonlySet<GatewayApplyErrorCode> = new Set([
  'VALIDATION_FAILED',
  'RUNTIME_FAILED',
  'VERIFICATION_FAILED',
  'PERSIST_FAILED',
  'APPLY_FAILED',
])

function projectLastApply(value: unknown): GatewayLastApply | null {
  if (
    !isRecord(value) ||
    typeof value.at !== 'number' ||
    !Number.isFinite(value.at) ||
    (value.result !== 'success' && value.result !== 'failure') ||
    typeof value.action !== 'string'
  )
    return null

  let detail: Record<string, unknown> = {}
  if (isRecord(value.detail)) detail = value.detail
  else if (typeof value.detail === 'string') {
    try {
      const parsed = JSON.parse(value.detail) as unknown
      if (isRecord(parsed)) detail = parsed
    } catch {
      // Legacy detail is optional; never project its raw value.
    }
  }

  if (value.result === 'failure' && value.action !== 'gateway.apply.failed')
    return null
  if (value.result === 'success' && value.action === 'gateway.apply.failed')
    return null
  const rawReason = value.result === 'failure' ? detail.reason : value.action
  const reason =
    typeof rawReason === 'string' && /^[a-z][a-z0-9.-]{0,127}$/.test(rawReason)
      ? rawReason
      : 'unknown'
  const errorCode =
    value.result === 'failure' &&
    typeof detail.errorCode === 'string' &&
    GATEWAY_APPLY_ERROR_CODES.has(detail.errorCode as GatewayApplyErrorCode)
      ? (detail.errorCode as GatewayApplyErrorCode)
      : null
  return { result: value.result, at: value.at, reason, errorCode }
}

function validateSourceId(sourceId: string): void {
  if (!/^[\w:-]{1,128}$/.test(sourceId))
    throw new GatewayValidationError('invalid node source id')
}

function normalizeManagedNodes(nodes: NormalizedNode[]): NormalizedNode[] {
  if (!Array.isArray(nodes))
    throw new GatewayValidationError('node list must be an array')
  const unique = new Map<string, NormalizedNode>()
  for (const value of nodes as unknown[]) {
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      typeof value.originalName !== 'string' ||
      !value.originalName.trim() ||
      !isRecord(value.proxy) ||
      typeof value.proxy.name !== 'string' ||
      !value.proxy.name.trim() ||
      typeof value.proxy.type !== 'string' ||
      typeof value.proxy.server !== 'string' ||
      !value.proxy.server.trim() ||
      typeof value.proxy.port !== 'number' ||
      !Number.isInteger(value.proxy.port) ||
      value.proxy.port < 1 ||
      value.proxy.port > 65_535
    )
      throw new GatewayValidationError('invalid normalized node')
    const node = structuredClone(value) as unknown as NormalizedNode
    if (node.id !== stableNodeId(node.proxy))
      throw new GatewayValidationError(
        `node ${node.id} does not match its stable node ID`,
      )
    unique.set(node.id, node)
  }
  return [...unique.values()]
}

function storedNode(node: NormalizedNode, enabled: boolean): StoredNode {
  return {
    id: node.id,
    enabled,
    proxy: structuredClone(node.proxy),
  }
}

function enabledStateByNodeId(state: GatewayStateV2): Map<string, boolean> {
  const enabled = new Map<string, boolean>()
  for (const source of Object.values(state.nodeSources))
    for (const node of source.nodes)
      enabled.set(node.id, (enabled.get(node.id) ?? false) || node.enabled)
  return enabled
}

function replaceNodeSourceInState(
  state: GatewayStateV2,
  sourceId: string,
  nodes: NormalizedNode[],
  enabled: ReadonlyMap<string, boolean>,
): void {
  const excludedNodeIds = state.nodeSources[sourceId]?.excludedNodeIds ?? []
  const excluded = new Set(excludedNodeIds)
  state.nodeSources[sourceId] = {
    nodes: nodes
      .filter(({ id }) => !excluded.has(id))
      .map((node) => storedNode(node, enabled.get(node.id) ?? true)),
    excludedNodeIds: [...excludedNodeIds],
  }
}

function listPersistedNodes(state: GatewayStateV2): GatewayNode[] {
  const nodes = new Map<string, GatewayNode>()
  for (const [sourceId, source] of orderedNodeSources(state.nodeSources)) {
    for (const node of source.nodes) {
      const existing = nodes.get(node.id)
      if (existing) {
        existing.enabled ||= node.enabled
        if (!existing.sourceIds.includes(sourceId))
          existing.sourceIds.push(sourceId)
      } else {
        nodes.set(node.id, {
          id: node.id,
          name: node.proxy.name,
          type: node.proxy.type,
          enabled: node.enabled,
          sourceIds: [sourceId],
          portIds: calculateNodeImpact(state, node.id).affectedPortIds,
        })
      }
    }
  }
  return [...nodes.values()]
}

function orderedNodeSources<T>(sources: Record<string, T>): [string, T][] {
  return Object.entries(sources).sort(
    ([left], [right]) =>
      Number(right === 'manual') - Number(left === 'manual') ||
      left.localeCompare(right),
  )
}

function gatewayNode(
  state: GatewayStateV2,
  id: string,
): GatewayNode | undefined {
  return listPersistedNodes(state).find((node) => node.id === id)
}

function findStoredNodes(state: GatewayStateV2, id: string): StoredNode[] {
  return Object.values(state.nodeSources).flatMap((source) =>
    source.nodes.filter((node) => node.id === id),
  )
}

function calculateNodeImpact(
  state: GatewayStateV2,
  id: string,
): GatewayNodeImpact {
  return {
    affectedPortIds: state.ports
      .filter((port) => port.hops.some((hop) => hop.nodeIds.includes(id)))
      .map(({ id: portId }) => portId),
  }
}

function removeNodeReferences(
  state: GatewayStateV2,
  nodeIds: ReadonlySet<string>,
): void {
  for (const port of state.ports) {
    port.hops = port.hops
      .map((hop) => ({
        ...hop,
        nodeIds: hop.nodeIds.filter((id) => !nodeIds.has(id)),
      }))
      .filter((hop) => hop.nodeIds.length > 0)
    if (port.hops.length === 0) port.enabled = false
  }
}

function pruneUnavailableNodeCandidates(state: GatewayStateV2): void {
  const available = new Set(
    Object.values(state.nodeSources).flatMap((source) =>
      source.nodes.map(({ id }) => id),
    ),
  )
  const affectedPortIds: number[] = []
  const candidateHops = state.ports.map((port) => {
    const hops = port.hops.map((hop) => ({
      ...hop,
      nodeIds: hop.nodeIds.filter((id) => available.has(id)),
    }))
    if (hops.some((hop) => hop.nodeIds.length === 0))
      affectedPortIds.push(port.id)
    return hops
  })
  if (affectedPortIds.length > 0)
    throw new GatewayValidationError(
      'node source update would remove the final candidate from a hop',
      409,
      { affectedPortIds },
    )
  for (const [index, port] of state.ports.entries())
    port.hops = candidateHops[index]!
}

function disablePortsWithoutEnabledNodeCandidates(state: GatewayStateV2): void {
  const enabled = new Set(
    Object.values(state.nodeSources).flatMap((source) =>
      source.nodes.filter((node) => node.enabled).map(({ id }) => id),
    ),
  )
  for (const port of state.ports) {
    if (
      port.enabled &&
      port.hops.some((hop) => !hop.nodeIds.some((id) => enabled.has(id)))
    )
      port.enabled = false
  }
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

function validatePortId(id: number): void {
  if (!Number.isInteger(id) || id < 1 || id > GATEWAY_PORTS.length)
    throw new GatewayValidationError('gateway port id must be within 1-10')
}

function normalizePortIds(portIds: number[]): number[] {
  if (!Array.isArray(portIds))
    throw new GatewayValidationError('credential portIds must be an array')
  const unique = new Set<number>()
  for (const id of portIds) {
    validatePortId(id)
    unique.add(id)
  }
  return [...unique].sort((left, right) => left - right)
}

function setCredentialPortIds(
  state: GatewayStateV2,
  credentialId: string,
  portIds: number[],
): void {
  const selected = new Set(portIds)
  for (const port of state.ports) {
    if (selected.has(port.id)) {
      if (!port.credentialIds.includes(credentialId))
        port.credentialIds.push(credentialId)
    } else {
      port.credentialIds = port.credentialIds.filter(
        (id) => id !== credentialId,
      )
    }
  }
}

function disablePortWithoutEnabledCredential(
  state: GatewayStateV2,
  port: GatewayPort,
): void {
  if (!port.enabled) return
  const enabledCredentialIds = new Set(
    state.credentials.filter(({ enabled }) => enabled).map(({ id }) => id),
  )
  if (!port.credentialIds.some((id) => enabledCredentialIds.has(id)))
    port.enabled = false
}

function disablePortsWithoutEnabledCredentials(state: GatewayStateV2): void {
  for (const port of state.ports)
    disablePortWithoutEnabledCredential(state, port)
}

function publicCredential(
  value: StoredCredential,
  state: PersistedState,
): GatewayCredential {
  return {
    id: value.id,
    username: value.username,
    enabled: value.enabled,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    portIds:
      state.version === 2
        ? state.ports
            .filter(({ credentialIds }) => credentialIds.includes(value.id))
            .map(({ id }) => id)
            .sort((left, right) => left - right)
        : [],
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
