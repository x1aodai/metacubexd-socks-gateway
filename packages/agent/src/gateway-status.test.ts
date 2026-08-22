import type {
  GatewayStateV2,
  StoredGatewayCredential,
  StoredNode,
} from './gateway-state.js'
import type { KernelState, MihomoSupervisor } from './types.js'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  gatewayGroupName,
  gatewayLandingNodeName,
  gatewayRuntimeNodeName,
} from './gateway-config.js'
import { createInitialGatewayStateV2 } from './gateway-state.js'
import { createGatewayManager } from './gateway.js'
import { atomicWrite, encryptJson, loadOrCreateKey } from './secure-store.js'
import { stableNodeId } from './subscription/parse.js'

const MASTER_KEY = 'gateway-status-test-master-key'

function fakeSupervisor(): MihomoSupervisor {
  const state: KernelState = {
    status: 'running',
    pid: 8842,
    version: 'v1.19.29',
    externalController: '127.0.0.1:9090',
    secret: 'supervisor-secret-canary',
    lastError: 'https://controller.invalid/?secret=supervisor-canary',
  }
  return {
    start: vi.fn(async () => ({ ...state })),
    stop: vi.fn(async () => ({ ...state, status: 'stopped' as const })),
    restart: vi.fn(async () => ({ ...state })),
    validate: vi.fn(async () => ({ valid: true, message: '' })),
    getState: vi.fn(() => ({ ...state })),
    setBinaryPath: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    dispose: vi.fn(async () => undefined),
  }
}

function makeNode(name: string, port: number): StoredNode {
  const proxy = {
    name,
    type: 'socks5' as const,
    server: '127.0.0.1',
    port,
    udp: false as const,
    enabled: true,
    username: `node-user-${port}`,
    password: `node-password-canary-${port}`,
  }
  return { id: stableNodeId(proxy), enabled: true, proxy }
}

function buildState(enabledPorts = 10): GatewayStateV2 {
  const now = 1_700_000_000_000
  const state = createInitialGatewayStateV2()
  const nodes: StoredNode[] = []

  for (const port of state.ports) {
    const first = makeNode(`first-${port.id}`, 20_000 + port.id)
    const second = makeNode(`second-${port.id}`, 21_000 + port.id)
    nodes.push(first, second)

    const credentialId = `credential-${port.id}`
    state.credentials.push({
      id: credentialId,
      username: `listener-user-${port.id}`,
      password: `listener-password-canary-${port.id}`,
      enabled: true,
      createdAt: now + port.id,
      updatedAt: now + port.id,
    })
    port.credentialIds = [credentialId]
    port.enabled = port.id <= enabledPorts
    port.hops =
      port.id % 2 === 0
        ? [
            { mode: 'manual', nodeIds: [first.id] },
            { mode: 'manual', nodeIds: [second.id] },
          ]
        : [{ mode: 'manual', nodeIds: [first.id] }]
  }

  state.nodeSources = { manual: { nodes, excludedNodeIds: [] } }
  return state
}

function proxySnapshot(
  state: GatewayStateV2,
  reject?: { portId: number; hop: number },
): Record<string, unknown> {
  const proxies: Record<string, unknown> = {
    REJECT: { type: 'Reject', alive: false, rawDiagnostic: 'raw-proxy-canary' },
  }

  for (const port of state.ports) {
    for (let index = 0; index < port.hops.length; index += 1) {
      const hop = port.hops[index]!
      const group = gatewayGroupName(port.port, index + 1)
      if (reject?.portId === port.id && reject.hop === index + 1) {
        proxies[group] = { type: 'Selector', now: 'REJECT', all: ['REJECT'] }
        continue
      }

      const nodeId = hop.nodeIds[0]!
      const runtime =
        index === 0
          ? gatewayRuntimeNodeName(nodeId)
          : gatewayLandingNodeName(port.port, nodeId)
      proxies[group] = {
        type: 'Selector',
        now: runtime,
        all: [runtime, 'REJECT'],
      }
      proxies[runtime] = {
        type: 'Socks5',
        alive: true,
        history: [{ delay: 8 }],
        password: 'raw-proxy-password-canary',
      }
    }
  }

  return { proxies }
}

async function writeState(
  dataDir: string,
  state: GatewayStateV2,
): Promise<void> {
  const key = await loadOrCreateKey(dataDir, MASTER_KEY)
  await atomicWrite(join(dataDir, 'gateway.enc'), encryptJson(state, key))
  await atomicWrite(
    join(dataDir, 'active-gateway.yaml'),
    'active-config-canary',
  )
}

async function setup(options?: {
  state?: GatewayStateV2
  fetchImpl?: typeof fetch
  verifyListener?: (
    port: number,
    credential: Pick<StoredGatewayCredential, 'username' | 'password'>,
  ) => Promise<boolean>
  audit?: string
}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gateway-status-'))
  const state = options?.state ?? buildState()
  await writeState(dataDir, state)
  if (options?.audit !== undefined) {
    await atomicWrite(join(dataDir, 'audit.jsonl'), options.audit)
  }
  const supervisor = fakeSupervisor()
  const fetchImpl = options?.fetchImpl ?? vi.fn<typeof fetch>()
  const verifyListener = options?.verifyListener ?? vi.fn(async () => true)
  const manager = createGatewayManager({
    dataDir,
    activeConfigPath: join(dataDir, 'active-gateway.yaml'),
    controllerUrl: 'http://controller.invalid',
    controllerSecret: 'controller-secret-canary',
    masterKey: MASTER_KEY,
    agentVersion: '7.0.0-test',
    fetch: fetchImpl,
    verifyListener,
  })
  manager.bindSupervisor(supervisor)
  return { dataDir, fetchImpl, manager, state, supervisor, verifyListener }
}

describe('gatewayManager.status', () => {
  it('does not create a data directory or master key for an uninitialized store', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'gateway-status-empty-'))
    const dataDir = join(parentDir, 'not-created')
    const manager = createGatewayManager({
      dataDir,
      activeConfigPath: join(dataDir, 'active-gateway.yaml'),
      controllerUrl: 'http://controller.invalid',
      agentVersion: '7.0.0-test',
      fetch: vi.fn(async () => new Response('{}', { status: 503 })),
      verifyListener: vi.fn(async () => true),
    })
    manager.bindSupervisor(fakeSupervisor())

    const status = await manager.status()
    const repeated = await manager.status()

    expect(status.ports).toHaveLength(10)
    expect(status.listeners.every(({ enabled }) => !enabled)).toBe(true)
    expect(status.lastApply).toBeNull()
    expect(repeated).toEqual(status)
    await expect(readdir(dataDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not create a missing master key while reading an existing store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'gateway-status-no-key-'))
    await atomicWrite(join(dataDir, 'gateway.enc'), '{}')
    const manager = createGatewayManager({
      dataDir,
      activeConfigPath: join(dataDir, 'active-gateway.yaml'),
      controllerUrl: 'http://controller.invalid',
      fetch: vi.fn(async () => new Response('{}', { status: 503 })),
      verifyListener: vi.fn(async () => true),
    })
    manager.bindSupervisor(fakeSupervisor())

    await expect(manager.status()).rejects.toBeDefined()

    expect(await readdir(dataDir)).toEqual(['gateway.enc'])
  })

  it('maps all ten ports and every hop from exactly one safe controller snapshot', async () => {
    const state = buildState()
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify(proxySnapshot(state, { portId: 10, hop: 2 })),
          {
            status: 200,
          },
        ),
    )
    const { manager, verifyListener } = await setup({ state, fetchImpl })

    const status = await manager.status()

    expect(Object.keys(status).sort()).toEqual([
      'lastApply',
      'listeners',
      'ports',
      'services',
      'versions',
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'http://controller.invalid/proxies',
    )
    expect(status.services).toEqual({
      agent: { health: 'healthy', state: 'running' },
      mihomo: {
        controllerReachable: true,
        health: 'healthy',
        state: 'running',
      },
    })
    expect(status.versions).toEqual({ agent: '7.0.0-test', mihomo: 'v1.19.29' })
    expect(status.listeners).toHaveLength(10)
    expect(status.listeners[0]).toEqual({
      id: 1,
      port: 10_001,
      enabled: true,
      health: 'healthy',
      reachable: true,
      errorCode: null,
    })
    expect(status.ports).toHaveLength(10)
    expect(status.ports[0]?.hops).toEqual([
      {
        activeNodeId: state.ports[0]?.hops[0]?.nodeIds[0],
        health: 'healthy',
        index: 1,
        mode: 'manual',
      },
    ])
    expect(status.ports[1]?.hops).toHaveLength(2)
    expect(status.ports[9]?.hops[1]).toEqual({
      activeNodeId: null,
      health: 'unhealthy',
      index: 2,
      mode: 'manual',
    })
    expect(status.ports[9]?.health).toBe('unhealthy')
    expect(verifyListener).toHaveBeenCalledTimes(10)
    expect(status.lastApply).toBeNull()

    const rendered = JSON.stringify(status)
    expect(rendered).not.toMatch(
      /pid|externalController|controller-secret-canary|password-canary|raw-proxy|active-config|controller\.invalid|lastError/,
    )
  })

  it('probes each enabled listener with its own first bound credential and isolates failures', async () => {
    const state = buildState()
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(proxySnapshot(state)), { status: 200 }),
    )
    const verifyListener = vi.fn(
      async (
        port: number,
        credential: Pick<StoredGatewayCredential, 'username' | 'password'>,
      ) => {
        expect(credential.username).toBe(`listener-user-${port - 10_000}`)
        expect(credential.password).toBe(
          `listener-password-canary-${port - 10_000}`,
        )
        if (port === 10_004) {
          throw new Error(
            'listener failure https://private.invalid/?secret=listener-canary',
          )
        }
        return true
      },
    )
    const { manager } = await setup({ state, fetchImpl, verifyListener })

    const status = await manager.status()

    expect(verifyListener).toHaveBeenCalledTimes(10)
    expect(status.listeners[3]).toMatchObject({
      errorCode: 'PROBE_FAILED',
      health: 'unhealthy',
      reachable: false,
    })
    expect(status.ports[3]?.health).toBe('unhealthy')
    expect(
      status.listeners.filter((listener) => listener.health === 'unhealthy'),
    ).toHaveLength(1)
    expect(status.ports[2]?.health).toBe('healthy')
    expect(status.ports[4]?.health).toBe('healthy')
    expect(JSON.stringify(status)).not.toContain('private.invalid')
  })

  it('does not probe disabled listeners and safely degrades a controller exception', async () => {
    const state = buildState(2)
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error(
        'GET https://private.invalid/?secret=controller-exception-canary',
      )
    })
    const verifyListener = vi.fn(async () => true)
    const { manager } = await setup({ state, fetchImpl, verifyListener })

    const status = await manager.status()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(verifyListener).toHaveBeenCalledTimes(2)
    expect(status.listeners[2]).toMatchObject({
      health: 'disabled',
      reachable: null,
    })
    expect(status.ports[2]?.health).toBe('disabled')
    expect(status.ports[0]?.hops[0]).toMatchObject({
      activeNodeId: null,
      health: 'unknown',
    })
    expect(status.services.mihomo).toMatchObject({
      controllerReachable: false,
      health: 'unhealthy',
    })
    expect(JSON.stringify(status)).not.toContain('private.invalid')
  })

  it('samples an unhealthy manual route repeatedly without mutating persistent or runtime state', async () => {
    const state = buildState(1)
    const snapshot = proxySnapshot(state) as {
      proxies: Record<string, unknown>
    }
    const activeName = gatewayRuntimeNodeName(
      state.ports[0]!.hops[0]!.nodeIds[0]!,
    )
    snapshot.proxies[activeName] = { type: 'Socks5', alive: false }
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(snapshot), { status: 200 }),
    )
    const { dataDir, manager, supervisor } = await setup({ state, fetchImpl })
    const revisionsPath = join(dataDir, 'revisions')
    await mkdir(revisionsPath)
    await atomicWrite(join(revisionsPath, 'seed.yaml'), 'revision-canary')

    const before = {
      state: await readFile(join(dataDir, 'gateway.enc')),
      active: await readFile(join(dataDir, 'active-gateway.yaml')),
      audit: await readFile(join(dataDir, 'audit.jsonl')).catch(() =>
        Buffer.from(''),
      ),
      revisions: await readdir(revisionsPath),
      revision: await readFile(join(revisionsPath, 'seed.yaml')),
    }

    for (let index = 0; index < 4; index += 1) {
      const status = await manager.status()
      expect(status.ports[0]?.hops[0]).toEqual({
        activeNodeId: state.ports[0]!.hops[0]!.nodeIds[0],
        health: 'unhealthy',
        index: 1,
        mode: 'manual',
      })
    }

    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(await readFile(join(dataDir, 'gateway.enc'))).toEqual(before.state)
    expect(await readFile(join(dataDir, 'active-gateway.yaml'))).toEqual(
      before.active,
    )
    expect(
      await readFile(join(dataDir, 'audit.jsonl')).catch(() => Buffer.from('')),
    ).toEqual(before.audit)
    expect(await readdir(revisionsPath)).toEqual(before.revisions)
    expect(await readFile(join(revisionsPath, 'seed.yaml'))).toEqual(
      before.revision,
    )
    expect(supervisor.start).not.toHaveBeenCalled()
    expect(supervisor.stop).not.toHaveBeenCalled()
    expect(supervisor.restart).not.toHaveBeenCalled()
    expect(supervisor.validate).not.toHaveBeenCalled()
  })

  it('projects legacy and malformed audit records without returning raw diagnostics', async () => {
    const state = buildState(0)
    const audit = [
      JSON.stringify({
        at: 90,
        action: 'gateway.apply.bootstrap',
        result: 'success',
        detail: JSON.stringify({ reason: 'gateway.apply.bootstrap' }),
      }),
      JSON.stringify({
        at: 100,
        action: 'gateway.apply.failed',
        result: 'failure',
        detail: JSON.stringify({
          reason: 'gateway.reapply',
          error: 'https://private.invalid/?password=audit-password-canary',
        }),
      }),
      '{malformed latest audit',
    ].join('\n')
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(proxySnapshot(state)), { status: 200 }),
    )
    const { manager } = await setup({ state, fetchImpl, audit })

    const status = await manager.status()

    expect(status.lastApply).toEqual({
      at: 100,
      errorCode: null,
      reason: 'gateway.reapply',
      result: 'failure',
    })
    expect(JSON.stringify(status)).not.toMatch(
      /private\.invalid|audit-password-canary|"error"/,
    )
  })
})
