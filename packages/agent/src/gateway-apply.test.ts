import type { GatewayManager } from './gateway'
import type { GatewayStateV1, GatewayStateV2 } from './gateway-state'
import type { KernelState, MihomoSupervisor } from './types'
import { mkdtemp, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { createGatewayManager } from './gateway'
import { createInitialGatewayStateV2 } from './gateway-state'
import * as secureStore from './secure-store'
import { stableNodeId } from './subscription/parse'

const MASTER_KEY = 'task-4-test-key'

function runningState(): KernelState {
  return {
    status: 'running',
    externalController: '127.0.0.1:9090',
    secret: 'secret',
  }
}

function stoppedState(): KernelState {
  return {
    status: 'stopped',
    externalController: '127.0.0.1:9090',
    secret: 'secret',
  }
}

function fakeSupervisor(
  options: {
    validate?: () => Promise<{ valid: boolean; message: string }>
    onStart?: () => Promise<void>
    onRestart?: () => Promise<void>
    restartStates?: KernelState[]
  } = {},
) {
  let current = stoppedState()
  const validate = vi.fn(
    options.validate ?? (async () => ({ valid: true, message: '' })),
  )
  const start = vi.fn(async () => {
    await options.onStart?.()
    current = runningState()
    return { ...current }
  })
  const restart = vi.fn(async () => {
    await options.onRestart?.()
    current = options.restartStates?.shift() ?? runningState()
    return { ...current }
  })
  const stop = vi.fn(async () => {
    current = stoppedState()
    return { ...current }
  })
  const supervisor: MihomoSupervisor = {
    getState: () => ({ ...current }),
    start,
    stop,
    restart,
    setBinaryPath: () => {},
    validate,
    on: () => {},
    off: () => {},
    dispose: async () => {},
  }
  return { supervisor, validate, start, restart, stop }
}

function validV2(enabledPorts = 0): GatewayStateV2 {
  const state = createInitialGatewayStateV2()
  const proxy = {
    name: 'upstream-a',
    type: 'socks5' as const,
    server: '203.0.113.10',
    port: 1080,
    username: 'upstream',
    password: 'upstream-password',
  }
  const id = stableNodeId(proxy)
  state.nodeSources = {
    manual: {
      nodes: [{ id, enabled: true, proxy }],
      excludedNodeIds: [],
    },
  }
  state.credentials = [
    {
      id: 'credential-a',
      username: 'alice',
      password: 'alice-password',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  for (const [index, port] of state.ports.entries()) {
    port.enabled = index < enabledPorts
    port.credentialIds = ['credential-a']
    port.hops = [{ mode: 'manual', nodeIds: [id] }]
  }
  return state
}

function validV1(): GatewayStateV1 {
  return {
    version: 1,
    gateway: {
      enabled: true,
      port: 1080,
      udp: false,
      mode: 'manual',
      selectedNode: 'upstream-a',
      updatedAt: 1,
    },
    credentials: [
      {
        id: 'credential-a',
        username: 'alice',
        password: 'alice-password',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    nodeSources: {
      manual: [
        {
          name: 'upstream-a',
          type: 'socks5',
          server: '203.0.113.10',
          port: 1080,
          username: 'upstream',
          password: 'upstream-password',
        },
      ],
    },
    revisions: [],
  }
}

async function writeState(
  dataDir: string,
  state: GatewayStateV1 | GatewayStateV2,
): Promise<string> {
  const key = await secureStore.loadOrCreateKey(dataDir, MASTER_KEY)
  const encrypted = secureStore.encryptJson(state, key)
  await secureStore.atomicWrite(join(dataDir, 'gateway.enc'), encrypted)
  return encrypted
}

async function readState(
  dataDir: string,
): Promise<GatewayStateV1 | GatewayStateV2> {
  const [raw, key] = await Promise.all([
    readFile(join(dataDir, 'gateway.enc'), 'utf8'),
    secureStore.loadOrCreateKey(dataDir, MASTER_KEY),
  ])
  return secureStore.decryptJson<GatewayStateV1 | GatewayStateV2>(raw, key)
}

async function setup(
  state: GatewayStateV1 | GatewayStateV2,
  fake = fakeSupervisor(),
  verifyListener: (
    port: number,
    credential: { username: string; password: string },
  ) => Promise<boolean> = vi.fn(async () => true),
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-gateway-apply-'))
  const activeConfigPath = join(dataDir, 'active.yaml')
  const active = 'mode: rule\nrules: [MATCH,REJECT]\n'
  await Promise.all([
    writeState(dataDir, state),
    secureStore.atomicWrite(activeConfigPath, active),
  ])
  const controllerFetch = vi.fn<typeof fetch>(
    async () => new Response('{}', { status: 200 }),
  )
  const manager = createGatewayManager({
    dataDir,
    activeConfigPath,
    masterKey: MASTER_KEY,
    controllerUrl: '127.0.0.1:9090',
    fetch: controllerFetch,
    verifyListener,
    now: () => 1_000,
  })
  manager.bindSupervisor(fake.supervisor)
  return {
    dataDir,
    activeConfigPath,
    active,
    manager,
    fake,
    verifyListener,
    controllerFetch,
  }
}

async function revisionFiles(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(join(dataDir, 'revisions'))).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

describe('transactional gateway apply and bootstrap', () => {
  it('migrates v1 once, preserves an exact 0600 backup, and starts through pending v2', async () => {
    const state = validV1()
    let manager: GatewayManager
    let transformedVersion: number | undefined
    const fake = fakeSupervisor({
      onStart: async () => {
        const rendered = parse(await manager.overlayConfig('malicious: base'))
        transformedVersion = rendered.listeners?.length
      },
    })
    const context = await setup(state, fake)
    manager = context.manager
    const originalRaw = await readFile(join(context.dataDir, 'gateway.enc'))

    await manager.bootstrap()

    const backupPath = join(context.dataDir, 'gateway.enc.v1.bak')
    expect(await readFile(backupPath)).toEqual(originalRaw)
    if (process.platform !== 'win32')
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600)
    expect((await readState(context.dataDir)).version).toBe(2)
    expect(transformedVersion).toBe(1)
    expect(fake.start).toHaveBeenCalledOnce()

    const backupBeforeSecondBootstrap = await readFile(backupPath)
    await manager.bootstrap()
    expect(await readFile(backupPath)).toEqual(backupBeforeSecondBootstrap)
    expect(fake.restart).not.toHaveBeenCalled()
  })

  it('fails closed when a v1 backup already exists with different bytes', async () => {
    const context = await setup(validV1())
    const backupPath = join(context.dataDir, 'gateway.enc.v1.bak')
    await secureStore.atomicWrite(backupPath, 'different-backup')
    const originalRaw = await readFile(join(context.dataDir, 'gateway.enc'))

    await expect(context.manager.bootstrap()).rejects.toThrow(/backup.*match/i)

    expect(await readFile(join(context.dataDir, 'gateway.enc'))).toEqual(
      originalRaw,
    )
    expect(await readFile(backupPath, 'utf8')).toBe('different-backup')
    expect(context.fake.validate).not.toHaveBeenCalled()
    expect(context.fake.start).not.toHaveBeenCalled()
  })

  it('keeps unmigratable enabled v1 bytes unchanged and never starts', async () => {
    const state = validV1()
    state.gateway.selectedNode = 'missing-node'
    const context = await setup(state)
    const originalRaw = await readFile(join(context.dataDir, 'gateway.enc'))
    const originalActive = await readFile(context.activeConfigPath)

    await expect(context.manager.bootstrap()).rejects.toThrow(/cannot map/i)

    expect(await readFile(join(context.dataDir, 'gateway.enc'))).toEqual(
      originalRaw,
    )
    expect(await readFile(join(context.dataDir, 'gateway.enc.v1.bak'))).toEqual(
      originalRaw,
    )
    expect(await readFile(context.activeConfigPath)).toEqual(originalActive)
    const audit = await readFile(join(context.dataDir, 'audit.jsonl'), 'utf8')
    expect(audit).not.toContain('missing-node')
    const failure = JSON.parse(audit.trim()) as Record<string, unknown>
    expect(failure).toMatchObject({
      action: 'gateway.apply.failed',
      result: 'failure',
    })
    expect(JSON.parse(String(failure.detail))).toEqual({
      reason: 'gateway.bootstrap',
      errorCode: 'VALIDATION_FAILED',
    })
    expect(context.fake.validate).not.toHaveBeenCalled()
    expect(context.fake.start).not.toHaveBeenCalled()
  })

  it('does not create gateway.enc when first bootstrap validation fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-gateway-new-'))
    const fake = fakeSupervisor({
      validate: async () => ({ valid: false, message: 'invalid candidate' }),
    })
    const manager = createGatewayManager({
      dataDir,
      activeConfigPath: join(dataDir, 'active.yaml'),
      masterKey: MASTER_KEY,
      controllerUrl: '127.0.0.1:9090',
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
      verifyListener: vi.fn(async () => true),
    })
    manager.bindSupervisor(fake.supervisor)

    await expect(
      manager.createCredential({
        username: 'before-bootstrap',
        password: 'before-bootstrap-password',
      }),
    ).rejects.toThrow(/bootstrap is required/i)

    await expect(manager.bootstrap()).rejects.toThrow('invalid candidate')

    await expect(readFile(join(dataDir, 'gateway.enc'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(fake.start).not.toHaveBeenCalled()
  })

  it('exposes pending state only to the restart transform and commits after verification', async () => {
    const state = validV2(0)
    let manager: GatewayManager
    let pendingListeners: unknown[] | undefined
    let publiclyEnabled: boolean | undefined
    let persistedDuringVerification: GatewayStateV2 | undefined
    const verifyListener = vi.fn(async () => {
      persistedDuringVerification = (await readState(
        context.dataDir,
      )) as GatewayStateV2
      return true
    })
    const fake = fakeSupervisor({
      onRestart: async () => {
        const transformed = parse(await manager.overlayConfig('old: base'))
        pendingListeners = transformed.listeners
        publiclyEnabled = (await manager.getGateway()).enabled
      },
    })
    const context = await setup(state, fake, verifyListener)
    manager = context.manager

    await manager.bootstrap()
    await manager.updateGateway({ enabled: true })

    expect(pendingListeners).toHaveLength(1)
    expect(publiclyEnabled).toBe(false)
    expect(persistedDuringVerification?.ports[0]?.enabled).toBe(false)
    const committed = (await readState(context.dataDir)) as GatewayStateV2
    expect(committed.ports[0]?.enabled).toBe(true)
    expect(committed.lastAppliedAt).toBe(1_000)
  })

  it('verifies Controller and every enabled listener during bootstrap', async () => {
    const verifyListener = vi.fn(
      async (
        _port: number,
        _credential: { username: string; password: string },
      ) => true,
    )
    const context = await setup(validV2(10), fakeSupervisor(), verifyListener)
    const orphanPath = join(context.dataDir, 'revisions', 'orphan.enc')
    await secureStore.atomicWrite(orphanPath, 'orphan')

    await context.manager.bootstrap()

    expect(verifyListener).toHaveBeenCalledTimes(10)
    expect(verifyListener.mock.calls.map(([port]) => port)).toEqual([
      10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010,
    ])
    expect(context.controllerFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9090/version',
      expect.any(Object),
    )
    expect(context.fake.start).toHaveBeenCalledOnce()
    expect(await revisionFiles(context.dataDir)).toEqual([])

    await context.manager.bootstrap()
    expect(context.fake.start).toHaveBeenCalledOnce()
    expect(context.fake.restart).not.toHaveBeenCalled()
  })

  it('restores committed state and clears pending after listener verification fails', async () => {
    const state = validV2(0)
    const context = await setup(
      state,
      fakeSupervisor(),
      vi.fn(async () => false),
    )
    await context.manager.bootstrap()
    const stateRaw = await readFile(join(context.dataDir, 'gateway.enc'))
    const activeRaw = await readFile(context.activeConfigPath)
    const revisionsBefore = await revisionFiles(context.dataDir)

    await expect(
      context.manager.updateGateway({ enabled: true }),
    ).rejects.toThrow(/verification failed/i)

    expect(await readFile(join(context.dataDir, 'gateway.enc'))).toEqual(
      stateRaw,
    )
    expect(await readFile(context.activeConfigPath)).toEqual(activeRaw)
    expect(context.fake.restart).toHaveBeenCalledTimes(2)
    expect(await revisionFiles(context.dataDir)).toEqual(revisionsBefore)
    const rendered = parse(await context.manager.overlayConfig('ignored: base'))
    expect(rendered.listeners).toEqual([])
  })

  it('rolls back a final persistence failure and removes its orphan revision', async () => {
    const context = await setup(validV2(0))
    await context.manager.bootstrap()
    const statePath = join(context.dataDir, 'gateway.enc')
    const stateRaw = await readFile(statePath)
    const activeRaw = await readFile(context.activeConfigPath)
    const revisionsBefore = await revisionFiles(context.dataDir)
    const originalAtomicWrite = secureStore.atomicWrite
    let failFinalPersist = true
    const writeSpy = vi
      .spyOn(secureStore, 'atomicWrite')
      .mockImplementation(async (path, data, mode) => {
        if (path === statePath && failFinalPersist) {
          failFinalPersist = false
          await originalAtomicWrite(path, data, mode)
          throw new Error('final persist failed after rename')
        }
        await originalAtomicWrite(path, data, mode)
      })

    try {
      await expect(
        context.manager.updateGateway({ enabled: true }),
      ).rejects.toThrow('final persist failed after rename')
    } finally {
      writeSpy.mockRestore()
    }

    expect(await readFile(statePath)).toEqual(stateRaw)
    expect(await readFile(context.activeConfigPath)).toEqual(activeRaw)
    expect(context.fake.restart).toHaveBeenCalledTimes(2)
    expect(await revisionFiles(context.dataDir)).toEqual(revisionsBefore)
  })

  it('restores a missing active config as missing when bootstrap fails', async () => {
    const context = await setup(
      validV2(1),
      fakeSupervisor(),
      vi.fn(async () => false),
    )
    await unlink(context.activeConfigPath)
    const stateRaw = await readFile(join(context.dataDir, 'gateway.enc'))

    await expect(context.manager.bootstrap()).rejects.toThrow(
      /verification failed/i,
    )

    await expect(readFile(context.activeConfigPath)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(join(context.dataDir, 'gateway.enc'))).toEqual(
      stateRaw,
    )
    expect(context.fake.stop).toHaveBeenCalledOnce()
    expect(await revisionFiles(context.dataDir)).toEqual([])
  })

  it('does not prune old revisions or retain a failed candidate revision', async () => {
    const state = validV2(0)
    state.revisions = Array.from({ length: 50 }, (_, index) => ({
      id: `old-${index}`,
      createdAt: index,
      reason: 'old',
    }))
    const fake = fakeSupervisor({
      restartStates: [
        { ...runningState(), status: 'errored', lastError: 'restart failed' },
        runningState(),
      ],
    })
    const context = await setup(state, fake)
    await Promise.all(
      state.revisions.map((revision) =>
        secureStore.atomicWrite(
          join(context.dataDir, 'revisions', `${revision.id}.enc`),
          revision.id,
        ),
      ),
    )
    await context.manager.bootstrap()
    const revisionsBefore = await revisionFiles(context.dataDir)

    await expect(
      context.manager.updateGateway({ enabled: true }),
    ).rejects.toThrow('restart failed')

    expect(await revisionFiles(context.dataDir)).toEqual(revisionsBefore)
    expect(fake.restart).toHaveBeenCalledTimes(2)
  })

  it('serializes bootstrap and mutations, keeps concurrent updates, and survives a failed tail item', async () => {
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const fake = fakeSupervisor({ onStart: () => startGate })
    const context = await setup(validV2(0), fake)

    const bootstrapping = context.manager.bootstrap()
    const firstMutation = context.manager.createCredential({
      username: 'bob',
      password: 'bob-password-long',
    })
    await vi.waitFor(() => expect(fake.start).toHaveBeenCalledOnce())
    expect(fake.restart).not.toHaveBeenCalled()
    releaseStart()
    await Promise.all([bootstrapping, firstMutation])

    fake.validate.mockResolvedValueOnce({
      valid: false,
      message: 'one failure',
    })
    const failed = context.manager.createCredential({
      username: 'carol',
      password: 'carol-password-long',
    })
    const succeeded = context.manager.createCredential({
      username: 'dave',
      password: 'dave-password-long',
    })
    await expect(failed).rejects.toThrow('one failure')
    await expect(succeeded).resolves.toMatchObject({ username: 'dave' })

    expect(
      (await context.manager.listCredentials()).map(({ username }) => username),
    ).toEqual(['alice', 'bob', 'dave'])
    expect(fake.restart).toHaveBeenCalledTimes(2)
  })

  it('reapplies a cloned current v2 state through the complete apply flow without changing business semantics', async () => {
    const context = await setup(validV2(1))
    await context.manager.bootstrap()
    const before = (await readState(context.dataDir)) as GatewayStateV2
    const activeBefore = await readFile(context.activeConfigPath)

    await context.manager.reapply()

    const after = (await readState(context.dataDir)) as GatewayStateV2
    expect({
      ports: after.ports,
      credentials: after.credentials,
      nodeSources: after.nodeSources,
    }).toEqual({
      ports: before.ports,
      credentials: before.credentials,
      nodeSources: before.nodeSources,
    })
    expect(await readFile(context.activeConfigPath)).toEqual(activeBefore)
    expect(after.revisions).toHaveLength(before.revisions.length + 1)
    expect(after.revisions[0]?.reason).toBe('gateway.reapply')
    expect(context.fake.validate).toHaveBeenCalledTimes(2)
    expect(context.fake.start).toHaveBeenCalledOnce()
    expect(context.fake.restart).toHaveBeenCalledOnce()
    expect(context.verifyListener).toHaveBeenCalledTimes(2)
    expect(
      context.controllerFetch.mock.calls.map(([url]) => String(url)),
    ).toEqual([
      'http://127.0.0.1:9090/version',
      'http://127.0.0.1:9090/version',
    ])
    const auditLines = (
      await readFile(join(context.dataDir, 'audit.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(auditLines.at(-1)).toMatchObject({
      action: 'gateway.reapply',
      result: 'success',
    })
  })

  it('serializes concurrent reapply transactions', async () => {
    const context = await setup(validV2(1))
    await context.manager.bootstrap()
    let releaseFirst!: () => void
    const firstRestartGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let restartIndex = 0
    context.fake.restart.mockImplementation(async () => {
      restartIndex += 1
      if (restartIndex === 1) await firstRestartGate
      return runningState()
    })

    const first = context.manager.reapply()
    const second = context.manager.reapply()
    await vi.waitFor(() =>
      expect(context.fake.restart).toHaveBeenCalledTimes(1),
    )
    expect(context.fake.validate).toHaveBeenCalledTimes(2)

    releaseFirst()
    await Promise.all([first, second])

    expect(context.fake.restart).toHaveBeenCalledTimes(2)
    expect(context.fake.validate).toHaveBeenCalledTimes(3)
    const after = (await readState(context.dataDir)) as GatewayStateV2
    expect(after.revisions.map(({ reason }) => reason).slice(0, 2)).toEqual([
      'gateway.reapply',
      'gateway.reapply',
    ])
  })

  it('rolls a failed reapply back byte-for-byte and audits only a fixed error code', async () => {
    const context = await setup(validV2(1))
    await context.manager.bootstrap()
    const statePath = join(context.dataDir, 'gateway.enc')
    const before = {
      state: await readFile(statePath),
      active: await readFile(context.activeConfigPath),
      revisions: await revisionFiles(context.dataDir),
      audit: await readFile(join(context.dataDir, 'audit.jsonl'), 'utf8'),
    }
    context.fake.restart
      .mockResolvedValueOnce({
        ...runningState(),
        status: 'errored',
        lastError:
          'restart failed https://private.invalid/?secret=runtime-error-canary',
      })
      .mockResolvedValueOnce(runningState())

    await expect(context.manager.reapply()).rejects.toThrow('restart failed')

    expect(await readFile(statePath)).toEqual(before.state)
    expect(await readFile(context.activeConfigPath)).toEqual(before.active)
    expect(await revisionFiles(context.dataDir)).toEqual(before.revisions)
    const auditAfter = await readFile(
      join(context.dataDir, 'audit.jsonl'),
      'utf8',
    )
    expect(auditAfter.startsWith(before.audit)).toBe(true)
    expect(auditAfter).not.toContain('private.invalid')
    expect(auditAfter).not.toContain('runtime-error-canary')
    const failure = JSON.parse(auditAfter.trim().split('\n').at(-1)!) as Record<
      string,
      unknown
    >
    expect(failure).toMatchObject({
      action: 'gateway.apply.failed',
      result: 'failure',
    })
    expect(JSON.parse(String(failure.detail))).toEqual({
      reason: 'gateway.reapply',
      errorCode: 'RUNTIME_FAILED',
    })
  })

  it('audits a candidate write failure before runtime without changing persisted bytes', async () => {
    const context = await setup(validV2(1))
    await context.manager.bootstrap()
    const statePath = join(context.dataDir, 'gateway.enc')
    const auditPath = join(context.dataDir, 'audit.jsonl')
    const before = {
      state: await readFile(statePath),
      active: await readFile(context.activeConfigPath),
      revisions: await revisionFiles(context.dataDir),
      audit: await readFile(auditPath, 'utf8'),
    }
    const originalAtomicWrite = secureStore.atomicWrite
    const writeSpy = vi
      .spyOn(secureStore, 'atomicWrite')
      .mockImplementation(async (path, data, mode) => {
        if (String(path).includes('.active.gateway.'))
          throw new Error(
            'candidate write failed https://private.invalid/?secret=candidate-canary',
          )
        await originalAtomicWrite(path, data, mode)
      })

    try {
      await expect(context.manager.reapply()).rejects.toThrow(
        'candidate write failed',
      )
    } finally {
      writeSpy.mockRestore()
    }

    expect(await readFile(statePath)).toEqual(before.state)
    expect(await readFile(context.activeConfigPath)).toEqual(before.active)
    expect(await revisionFiles(context.dataDir)).toEqual(before.revisions)
    const auditAfter = await readFile(auditPath, 'utf8')
    expect(auditAfter.startsWith(before.audit)).toBe(true)
    expect(auditAfter).not.toContain('private.invalid')
    expect(auditAfter).not.toContain('candidate-canary')
    const failure = JSON.parse(auditAfter.trim().split('\n').at(-1)!) as Record<
      string,
      unknown
    >
    expect(failure).toMatchObject({
      action: 'gateway.apply.failed',
      result: 'failure',
    })
    expect(JSON.parse(String(failure.detail))).toEqual({
      reason: 'gateway.reapply',
      errorCode: 'APPLY_FAILED',
    })
  })
})
