import type { MihomoSupervisor } from './types'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { createGatewayManager } from './gateway'

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
    const server = createServer((socket) => {
      let stage = 0
      socket.on('data', () => {
        socket.write(
          stage++ === 0 ? Buffer.from([0x05, 0x02]) : Buffer.from([0x01, 0x00]),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('missing test port')
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-gateway-'))
    const activeConfigPath = join(dataDir, 'active.yaml')
    const manager = createGatewayManager({
      dataDir,
      activeConfigPath,
      masterKey: 'test-key',
      defaultPort: address.port,
      minPort: address.port,
      maxPort: address.port,
      controllerUrl: '127.0.0.1:9090',
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    })
    manager.bindSupervisor(fakeSupervisor())
    const created = await manager.createCredential({
      username: 'alice',
      password: 'a-secure-socks-password',
    })
    expect(created.password).toBe('a-secure-socks-password')
    await manager.updateGateway({ enabled: true })

    const rendered = await manager.overlayConfig(`
mixed-port: 7890
authentication: [unsafe:credential]
skip-auth-prefixes: [127.0.0.1/32]
tun: { enable: true }
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
    expect(config.listeners).toEqual([
      expect.objectContaining({
        name: 'gateway-socks',
        port: address.port,
        users: [{ username: 'alice', password: 'a-secure-socks-password' }],
      }),
    ])
    expect(config.rules).toEqual(['MATCH,GATEWAY'])
    expect(config['proxy-groups'][0]).toMatchObject({ name: 'GATEWAY' })
    expect(JSON.stringify(config['proxy-groups'])).not.toContain('DIRECT')
    await new Promise<void>((resolve) => server.close(() => resolve()))
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
      .mockResolvedValueOnce({ valid: false, message: 'bad config' })
    const manager = createGatewayManager({
      dataDir,
      activeConfigPath: join(dataDir, 'active.yaml'),
      masterKey: 'test-key',
      controllerUrl: '127.0.0.1:9090',
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    })
    manager.bindSupervisor(fakeSupervisor(validate))
    await manager.createCredential({
      username: 'alice',
      password: 'first-valid-password',
    })
    await expect(manager.updateGateway({ port: 1081 })).rejects.toThrow(
      'bad config',
    )
    expect((await manager.getGateway()).port).toBe(1080)
    expect((await manager.listRevisions()).length).toBe(1)
  })
})
