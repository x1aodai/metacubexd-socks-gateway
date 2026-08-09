import type { GatewayManager } from './gateway'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGatewaySubscriptionManager } from './gateway-subscriptions'

function proxy(name: string, port: number): string {
  return `  - { name: ${name}, type: socks5, server: 8.8.8.8, port: ${port} }`
}

function gatewayMock() {
  return {
    appendImportedNodes: vi.fn(async () => ({
      enabled: false,
      port: 1080,
      udp: false,
      mode: 'failover',
      updatedAt: 1,
    })),
    replaceNodeSource: vi.fn(async () => ({
      enabled: false,
      port: 1080,
      udp: false,
      mode: 'failover',
      updatedAt: 1,
    })),
    removeNodeSource: vi.fn(async () => ({
      enabled: false,
      port: 1080,
      udp: false,
      mode: 'failover',
      updatedAt: 1,
    })),
  } as unknown as GatewayManager
}

describe('gateway imports and subscriptions', () => {
  it('previews and applies parsed nodes through the managed gateway source', async () => {
    const gateway = gatewayMock()
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-import-'))
    const manager = createGatewaySubscriptionManager({
      dataDir,
      gateway,
      masterKey: 'test-key',
    })
    const preview = manager.previewImport(
      `proxies:\n${proxy('node-a', 1080)}\n`,
    )
    expect(preview).toMatchObject({ validCount: 1, skippedCount: 0 })
    const result = await manager.applyImport({ previewId: preview.previewId })
    expect(result.imported).toBe(1)
    expect(gateway.appendImportedNodes).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'node-a', type: 'socks5' }),
    ])
  })

  it('retains last-good nodes when a subscription shrinks by more than half', async () => {
    const gateway = gatewayMock()
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-subscriptions-'))
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        content: `proxies:\n${[1, 2, 3, 4].map((n) => proxy(`node-${n}`, 1080 + n)).join('\n')}\n`,
        finalUrl: 'https://example.com/sub',
        bytes: 10,
        redirects: 0,
      })
      .mockResolvedValueOnce({
        content: `proxies:\n${proxy('only-one', 2080)}\n`,
        finalUrl: 'https://example.com/sub',
        bytes: 10,
        redirects: 0,
      })
    const manager = createGatewaySubscriptionManager({
      dataDir,
      gateway,
      masterKey: 'test-key',
      fetchSubscription: fetcher,
    })
    const created = await manager.create({
      name: 'primary',
      url: 'https://example.com/sub?token=secret-value',
      enabled: true,
    })
    expect(created.nodeCount).toBe(4)
    expect(created.intervalMinutes).toBe(360)
    expect(created.urlMasked).not.toContain('secret-value')
    await expect(manager.sync(created.id)).rejects.toMatchObject({
      statusCode: 409,
    })
    const [after] = await manager.list()
    expect(after?.nodeCount).toBe(4)
    expect(after?.lastError).toContain('last-good retained')
    expect(gateway.replaceNodeSource).toHaveBeenCalledTimes(1)
    expect(
      await readFile(join(dataDir, 'subscriptions.enc'), 'utf8'),
    ).not.toContain('secret-value')
  })

  it('enforces the minimum 15 minute refresh interval', async () => {
    const manager = createGatewaySubscriptionManager({
      dataDir: await mkdtemp(join(tmpdir(), 'mcxd-subscriptions-interval-')),
      gateway: gatewayMock(),
      masterKey: 'test-key',
      fetchSubscription: vi.fn(),
    })
    await expect(
      manager.create({
        name: 'too-fast',
        url: 'https://example.com/sub',
        intervalMinutes: 14,
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns and persists a new subscription with lastError when its first sync fails', async () => {
    const gateway = gatewayMock()
    const manager = createGatewaySubscriptionManager({
      dataDir: await mkdtemp(join(tmpdir(), 'mcxd-subscriptions-failed-')),
      gateway,
      masterKey: 'test-key',
      fetchSubscription: vi.fn(async () => {
        throw new Error('upstream unavailable')
      }),
    })
    const created = await manager.create({
      name: 'temporarily-down',
      url: 'https://example.com/sub',
    })
    expect(created.lastError).toBe('upstream unavailable')
    expect((await manager.list()).map((item) => item.id)).toContain(created.id)
    expect(gateway.replaceNodeSource).not.toHaveBeenCalled()
  })
})
