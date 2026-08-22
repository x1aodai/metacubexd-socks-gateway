import type { MihomoSupervisor } from './types'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { createGatewayManager } from './gateway'
import { stableNodeId } from './subscription'

function fakeSupervisor(
  validate = vi.fn(async () => ({ valid: true, message: '' })),
): MihomoSupervisor {
  return {
    getState: () => ({
      status: 'running',
      externalController: '127.0.0.1:9090',
      secret: 'secret',
    }),
    start: async () => fakeSupervisor(validate).getState(),
    stop: async () => fakeSupervisor(validate).getState(),
    restart: async () => fakeSupervisor(validate).getState(),
    setBinaryPath: () => {},
    validate,
    on: () => {},
    off: () => {},
    dispose: async () => {},
  }
}

describe('managed SOCKS gateway', () => {
  it('overlays a single authenticated listener and fail-closed groups', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-gateway-'))
    const activeConfigPath = join(dataDir, 'active.yaml')
    const manager = createGatewayManager({
      dataDir,
      activeConfigPath,
      masterKey: 'test-key',
      controllerUrl: '127.0.0.1:9090',
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
      verifyListener: vi.fn(async () => true),
    })
    manager.bindSupervisor(fakeSupervisor())
    await manager.bootstrap()
    const created = await manager.createCredential({
      username: 'alice',
      password: 'a-secure-socks-password',
      portIds: [1],
    })
    expect(created.password).toBe('a-secure-socks-password')
    const proxy = {
      name: 'node-a',
      type: 'socks5' as const,
      server: '203.0.113.1',
      port: 1080,
    }
    await manager.appendImportedNodes([
      { id: stableNodeId(proxy), originalName: proxy.name, proxy },
    ])
    await manager.setOutbound({ mode: 'manual', nodeId: 'node-a' })
    await manager.updateGateway({ enabled: true })

    const rendered = await manager.overlayConfig(`
mixed-port: 7890
authentication: [unsafe:credential]
skip-auth-prefixes: [127.0.0.1/32]
tun: { enable: true }
external-controller-cors:
  allow-origins: ['*']
listeners:
  - { name: unsafe-http, type: http, port: 8088, listen: 0.0.0.0 }
proxies:
  - { name: node-a, type: socks5, server: 203.0.113.1, port: 1080 }
rules:
  - MATCH,DIRECT
`)
    const config = parse(rendered)
    expect(config['mixed-port']).toBeUndefined()
    expect(config.authentication).toBeUndefined()
    expect(config['skip-auth-prefixes']).toBeUndefined()
    expect(config.tun).toBeUndefined()
    expect(config['external-controller-cors']).toBeUndefined()
    expect(config.listeners).toEqual([
      expect.objectContaining({
        name: 'gateway-socks-10001',
        port: 10001,
        proxy: 'GW-10001-H1',
        users: [{ username: 'alice', password: 'a-secure-socks-password' }],
      }),
    ])
    expect(config.rules).toEqual([
      'IN-NAME,gateway-socks-10001,GW-10001-H1',
      'MATCH,REJECT',
    ])
    expect(config['proxy-groups'][0]).toMatchObject({ name: 'GW-10001-H1' })
    expect(JSON.stringify(config['proxy-groups'])).not.toContain('DIRECT')
  })

  it('never returns stored passwords and encrypts persistence at rest', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-gateway-secret-'))
    const manager = createGatewayManager({
      dataDir,
      activeConfigPath: join(dataDir, 'active.yaml'),
      masterKey: 'test-key',
      controllerUrl: '127.0.0.1:9090',
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    })
    manager.bindSupervisor(fakeSupervisor())
    await manager.bootstrap()
    await manager.createCredential({
      username: 'alice',
      password: 'never-return-this-password',
    })
    expect(await manager.listCredentials()).toEqual([
      expect.not.objectContaining({ password: expect.anything() }),
    ])
    expect(await readFile(join(dataDir, 'gateway.enc'), 'utf8')).not.toContain(
      'never-return-this-password',
    )
  })

  it('keeps the last-good state when mihomo validation fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-gateway-invalid-'))
    const validate = vi
      .fn()
      .mockResolvedValueOnce({ valid: true, message: '' })
      .mockResolvedValueOnce({ valid: true, message: '' })
      .mockResolvedValueOnce({ valid: false, message: 'bad config' })
    const manager = createGatewayManager({
      dataDir,
      activeConfigPath: join(dataDir, 'active.yaml'),
      masterKey: 'test-key',
      controllerUrl: '127.0.0.1:9090',
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    })
    manager.bindSupervisor(fakeSupervisor(validate))
    await manager.bootstrap()
    const created = await manager.createCredential({
      username: 'alice',
      password: 'first-valid-password',
    })
    await expect(
      manager.updateCredential(created.id, { username: 'alice-updated' }),
    ).rejects.toThrow('bad config')
    expect((await manager.listCredentials())[0]?.username).toBe('alice')
    expect((await manager.getGateway()).port).toBe(10001)
    expect((await manager.listRevisions()).length).toBe(1)
  })
})
