import type { GatewayHop } from './gateway-state'
import type { KernelState, MihomoSupervisor } from './types'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { createGatewayManager } from './gateway'
import {
  createInitialGatewayStateV2,
  validateGatewayStateV2,
} from './gateway-state'
import { stableNodeId } from './subscription/parse'

const PROXY = {
  name: 'task-5-node',
  type: 'socks5' as const,
  server: '203.0.113.25',
  port: 1080,
}
const NODE_ID = stableNodeId(PROXY)
const NODE = { id: NODE_ID, originalName: PROXY.name, proxy: PROXY }
const HOPS: GatewayHop[] = [{ mode: 'manual', nodeIds: [NODE_ID] }]

function stoppedState(): KernelState {
  return {
    status: 'stopped',
    externalController: '127.0.0.1:9090',
    secret: 'secret',
  }
}

function runningState(): KernelState {
  return { ...stoppedState(), status: 'running' }
}

function fakeSupervisor() {
  let current = stoppedState()
  const validate = vi.fn(async () => ({ valid: true, message: '' }))
  const start = vi.fn(async () => {
    current = runningState()
    return { ...current }
  })
  const restart = vi.fn(async () => {
    current = runningState()
    return { ...current }
  })
  const supervisor: MihomoSupervisor = {
    getState: () => ({ ...current }),
    start,
    stop: vi.fn(async () => {
      current = stoppedState()
      return { ...current }
    }),
    restart,
    setBinaryPath: () => {},
    validate,
    on: () => {},
    off: () => {},
    dispose: async () => {},
  }
  return { supervisor, validate, start, restart }
}

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-gateway-ports-'))
  const fake = fakeSupervisor()
  const manager = createGatewayManager({
    dataDir,
    activeConfigPath: join(dataDir, 'active.yaml'),
    masterKey: 'task-5-test-key',
    controllerUrl: '127.0.0.1:9090',
    fetch: vi.fn(async () => Response.json({ proxies: {} }, { status: 200 })),
    verifyListener: vi.fn(async () => true),
    now: () => 5_000,
  })
  manager.bindSupervisor(fake.supervisor)
  await manager.bootstrap()
  await manager.appendImportedNodes([NODE])
  return { manager, fake }
}

describe('fixed gateway ports and credential bindings', () => {
  it('returns cloned fixed slots and rejects any attempt to address or mutate another port', async () => {
    const { manager } = await setup()

    const ports = await manager.listPorts()
    expect(ports).toHaveLength(10)
    expect(ports.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(ports.map(({ port }) => port)).toEqual([
      10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010,
    ])
    expect(ports.every(({ enabled }) => !enabled)).toBe(true)

    ports[0]!.enabled = true
    ports[0]!.credentialIds.push('caller-mutation')
    expect((await manager.listPorts())[0]).toMatchObject({
      enabled: false,
      credentialIds: [],
    })

    await expect(manager.updatePort(0, {})).rejects.toThrow(/port id/i)
    await expect(manager.updatePort(11, {})).rejects.toThrow(/port id/i)
    await expect(manager.updatePort(10001, {})).rejects.toThrow(/port id/i)
    await expect(
      manager.updatePort(1, { port: 11000 } as never),
    ).rejects.toThrow(/fixed|not editable/i)
    await expect(manager.updatePort(1, { id: 2 } as never)).rejects.toThrow(
      /fixed|not editable/i,
    )

    expect((await manager.listPorts()).map(({ port }) => port)).toEqual([
      10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010,
    ])
  })

  it('derives sorted portIds and treats credential binding input as an exact replacement', async () => {
    const { manager } = await setup()

    const unbound = await manager.createCredential({
      username: 'unbound',
      password: 'unbound-password',
    })
    const alsoUnbound = await manager.createCredential({
      username: 'also-unbound',
      password: 'also-unbound-password',
      portIds: [],
    })
    expect(unbound.portIds).toEqual([])
    expect(alsoUnbound.portIds).toEqual([])

    const alice = await manager.createCredential({
      username: 'alice',
      password: 'alice-password',
      portIds: [10, 2, 1, 2],
    })
    const bob = await manager.createCredential({
      username: 'bob',
      password: 'bob-password-long',
      portIds: [2, 1],
    })
    expect(alice.portIds).toEqual([1, 2, 10])
    expect(bob.portIds).toEqual([1, 2])

    const ports = await manager.listPorts()
    expect(ports[0]!.credentialIds).toEqual([alice.id, bob.id])
    expect(ports[1]!.credentialIds).toEqual([alice.id, bob.id])
    expect(ports[9]!.credentialIds).toEqual([alice.id])

    const replaced = await manager.updateCredential(alice.id, {
      portIds: [9, 3, 3],
    })
    expect(replaced).toMatchObject({ portIds: [3, 9] })
    expect(replaced).not.toHaveProperty('password')
    const preserved = await manager.updateCredential(alice.id, {
      username: 'alice-renamed',
    })
    expect(preserved.portIds).toEqual([3, 9])
    const cleared = await manager.updateCredential(alice.id, { portIds: [] })
    expect(cleared.portIds).toEqual([])

    const listed = await manager.listCredentials()
    expect(listed.find(({ id }) => id === alice.id)?.portIds).toEqual([])
    expect(listed.every((credential) => !('password' in credential))).toBe(true)

    await expect(
      manager.createCredential({
        username: 'invalid-port',
        password: 'invalid-port-password',
        portIds: [11],
      }),
    ).rejects.toThrow(/port id/i)
    await expect(
      manager.updateCredential(bob.id, { portIds: [0] }),
    ).rejects.toThrow(/port id/i)
  })

  it('updates one fixed port transactionally with multiple credentials and valid hops', async () => {
    const { manager, fake } = await setup()
    const alice = await manager.createCredential({
      username: 'alice',
      password: 'alice-password',
    })
    const bob = await manager.createCredential({
      username: 'bob',
      password: 'bob-password-long',
    })
    expect(alice.portIds).toEqual([])
    expect(bob.portIds).toEqual([])

    const updated = await manager.updatePort(1, {
      enabled: true,
      credentialIds: [alice.id, bob.id],
      hops: HOPS,
    })
    expect(updated).toEqual({
      id: 1,
      port: 10001,
      enabled: true,
      credentialIds: [alice.id, bob.id],
      hops: HOPS,
    })
    expect(
      (await manager.listCredentials()).map(({ username, portIds }) => ({
        username,
        portIds,
      })),
    ).toEqual([
      { username: 'alice', portIds: [1] },
      { username: 'bob', portIds: [1] },
    ])

    await expect(
      manager.updatePort(2, {
        enabled: true,
        credentialIds: [alice.id],
      }),
    ).rejects.toThrow(/one or two hops/i)
    await expect(
      manager.updatePort(2, { enabled: true, hops: HOPS }),
    ).rejects.toThrow(/enabled credential/i)
    await expect(
      manager.updatePort(2, {
        credentialIds: [alice.id, alice.id],
      }),
    ).rejects.toThrow(/duplicate credentials/i)
    await expect(
      manager.updatePort(2, { credentialIds: ['missing-credential'] }),
    ).rejects.toThrow(/unknown credential/i)

    fake.validate.mockResolvedValueOnce({
      valid: false,
      message: 'port candidate rejected',
    })
    await expect(
      manager.updatePort(2, { credentialIds: [alice.id] }),
    ).rejects.toThrow('port candidate rejected')
    expect((await manager.listPorts())[1]!.credentialIds).toEqual([])

    expect(await manager.updatePort(1, { credentialIds: [] })).toEqual({
      id: 1,
      port: 10001,
      enabled: false,
      credentialIds: [],
      hops: HOPS,
    })
  })

  it('keeps disabled-account bindings and only disables a port after its last enabled account is lost', async () => {
    const { manager } = await setup()
    const alice = await manager.createCredential({
      username: 'alice',
      password: 'alice-password',
      portIds: [1],
    })
    const bob = await manager.createCredential({
      username: 'bob',
      password: 'bob-password-long',
      portIds: [1],
    })
    await manager.updatePort(1, { enabled: true, hops: HOPS })

    const disabledAlice = await manager.updateCredential(alice.id, {
      enabled: false,
    })
    expect(disabledAlice.portIds).toEqual([1])
    expect((await manager.listPorts())[0]).toMatchObject({
      enabled: true,
      credentialIds: [alice.id, bob.id],
    })
    const whileBobRemains = parse(await manager.overlayConfig('ignored: true'))
    expect(whileBobRemains.listeners[0].users).toEqual([
      { username: 'bob', password: 'bob-password-long' },
    ])

    const disabledBob = await manager.updateCredential(bob.id, {
      enabled: false,
    })
    expect(disabledBob.portIds).toEqual([1])
    expect((await manager.listPorts())[0]).toEqual({
      id: 1,
      port: 10001,
      enabled: false,
      credentialIds: [alice.id, bob.id],
      hops: HOPS,
    })
    expect(
      parse(await manager.overlayConfig('ignored: true')).listeners,
    ).toEqual([])

    await manager.updateCredential(alice.id, { enabled: true })
    expect((await manager.listPorts())[0]!.enabled).toBe(false)
  })

  it('atomically replaces and deletes bindings while preserving unrelated accounts and hops', async () => {
    const { manager, fake } = await setup()
    const alice = await manager.createCredential({
      username: 'alice',
      password: 'alice-password',
      portIds: [1, 2],
    })
    const bob = await manager.createCredential({
      username: 'bob',
      password: 'bob-password-long',
      portIds: [1],
    })
    await manager.updatePort(1, { enabled: true, hops: HOPS })
    await manager.updatePort(2, { enabled: true, hops: HOPS })

    const afterUnbind = await manager.updateCredential(alice.id, {
      portIds: [2],
    })
    expect(afterUnbind.portIds).toEqual([2])
    expect((await manager.listPorts())[0]).toMatchObject({
      enabled: true,
      credentialIds: [bob.id],
      hops: HOPS,
    })

    const restartsBeforeDelete = fake.restart.mock.calls.length
    await manager.deleteCredential(alice.id)
    expect(fake.restart.mock.calls.length - restartsBeforeDelete).toBe(1)

    const ports = await manager.listPorts()
    expect(ports[0]).toMatchObject({
      enabled: true,
      credentialIds: [bob.id],
      hops: HOPS,
    })
    expect(ports[1]).toEqual({
      id: 2,
      port: 10002,
      enabled: false,
      credentialIds: [],
      hops: HOPS,
    })
    expect((await manager.listCredentials()).map(({ id }) => id)).toEqual([
      bob.id,
    ])
  })

  it('rejects duplicate stored credential IDs before relationships become ambiguous', () => {
    const state = createInitialGatewayStateV2()
    const credential = {
      id: 'duplicate-id',
      username: 'alice',
      password: 'alice-password',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }
    state.credentials = [credential, { ...credential, username: 'bob' }]

    expect(() => validateGatewayStateV2(state)).toThrow(
      /duplicate credential id/i,
    )
  })
})
