import type { GatewayManager } from './gateway'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGatewaySubscriptionManager } from './gateway-subscriptions'
import {
  atomicWrite,
  decryptJson,
  encryptJson,
  loadOrCreateKey,
} from './secure-store'

function proxy(name: string, port: number): string {
  return `  - { name: ${name}, type: socks5, server: 8.8.8.8, port: ${port} }`
}

function gatewayMock() {
  const gateway = {
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
    replaceNodeSources: vi.fn(async () => ({
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
  }
  return gateway as typeof gateway & GatewayManager
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
      expect.objectContaining({
        id: expect.stringMatching(/^node_/),
        originalName: 'node-a',
        proxy: expect.objectContaining({ name: 'node-a', type: 'socks5' }),
      }),
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
    expect(created.lastError).toBe('subscription refresh failed')
    expect((await manager.list()).map((item) => item.id)).toContain(created.id)
    expect(gateway.replaceNodeSource).not.toHaveBeenCalled()
  })

  it('uses a fixed no-valid-nodes message', async () => {
    const manager = createGatewaySubscriptionManager({
      dataDir: await mkdtemp(join(tmpdir(), 'mcxd-subscriptions-empty-')),
      gateway: gatewayMock(),
      masterKey: 'test-key',
      fetchSubscription: vi.fn(async () => ({
        content: 'proxies: []',
        finalUrl: 'https://example.com/empty',
        bytes: 10,
        redirects: 0,
      })),
    })

    await expect(
      manager.create({ name: 'empty', url: 'https://example.com/empty' }),
    ).resolves.toMatchObject({
      lastError: 'subscription returned no valid nodes',
    })
  })

  it('keeps the version 1 raw proxy disk schema while enabling and syncing a legacy encrypted fixture', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-subscriptions-legacy-'))
    const masterKey = 'test-key'
    const key = await loadOrCreateKey(dataDir, masterKey)
    await atomicWrite(
      join(dataDir, 'subscriptions.enc'),
      encryptJson(
        {
          version: 1,
          items: [
            {
              id: 'legacy-subscription',
              name: 'legacy',
              url: 'https://example.com/legacy',
              intervalMinutes: 360,
              enabled: false,
              nodes: [
                {
                  name: 'legacy-raw',
                  type: 'socks5',
                  server: '8.8.4.4',
                  port: 1400,
                },
              ],
              nodeCount: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
        key,
      ),
    )
    const gateway = gatewayMock()
    const manager = createGatewaySubscriptionManager({
      dataDir,
      gateway,
      masterKey,
      fetchSubscription: vi.fn(async () => ({
        content: `proxies:\n${proxy('refreshed-raw', 1401)}\n`,
        finalUrl: 'https://example.com/legacy',
        bytes: 10,
        redirects: 0,
      })),
    })

    await expect(
      manager.update('legacy-subscription', { enabled: true }),
    ).resolves.toMatchObject({ enabled: true, nodeCount: 1 })
    expect(gateway.replaceNodeSource).toHaveBeenNthCalledWith(
      1,
      'subscription:legacy-subscription',
      [
        expect.objectContaining({
          id: expect.stringMatching(/^node_/),
          originalName: 'legacy-raw',
          proxy: expect.objectContaining({ name: 'legacy-raw' }),
        }),
      ],
      'subscription.enable',
    )
    await expect(manager.sync('legacy-subscription')).resolves.toMatchObject({
      nodeCount: 1,
    })

    const stored = decryptJson<{
      version: 1
      items: Array<{ nodes: Array<Record<string, unknown>> }>
    }>(await readFile(join(dataDir, 'subscriptions.enc'), 'utf8'), key)
    expect(stored.version).toBe(1)
    expect(stored.items[0]!.nodes).toEqual([
      expect.objectContaining({
        name: 'refreshed-raw',
        type: 'socks5',
        server: '8.8.8.8',
        port: 1401,
      }),
    ])
    expect(stored.items[0]!.nodes[0]).not.toHaveProperty('id')
    expect(stored.items[0]!.nodes[0]).not.toHaveProperty('proxy')
  })

  it('disables a subscription by retaining its source bucket as empty', async () => {
    const gateway = gatewayMock()
    const manager = createGatewaySubscriptionManager({
      dataDir: await mkdtemp(join(tmpdir(), 'mcxd-subscriptions-disable-')),
      gateway,
      masterKey: 'test-key',
      fetchSubscription: vi.fn(async () => ({
        content: `proxies:\n${proxy('kept-excluded', 1500)}\n`,
        finalUrl: 'https://example.com/disable',
        bytes: 10,
        redirects: 0,
      })),
    })
    const created = await manager.create({
      name: 'disable-me',
      url: 'https://example.com/disable',
    })
    gateway.replaceNodeSource.mockClear()

    await manager.update(created.id, { enabled: false })

    expect(gateway.replaceNodeSource).toHaveBeenCalledWith(
      `subscription:${created.id}`,
      [],
      'subscription.disable',
    )
    expect(gateway.removeNodeSource).not.toHaveBeenCalled()

    await manager.delete(created.id)
    expect(gateway.removeNodeSource).toHaveBeenCalledWith(
      `subscription:${created.id}`,
      'subscription.delete',
    )
  })

  it('never exposes arbitrary downstream diagnostics in refresh, list, or encrypted state DTO fields', async () => {
    const canaries = [
      'vless://user@example.com:443?security=reality',
      'vmess://eyJ2IjoiMiJ9',
      'ss://cipher:secret@example.com:8388',
      'Authorization: Bearer controller-secret',
      'password: upstream-password',
      'Mihomo validation canary',
    ]
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-subscriptions-canary-'))
    const masterKey = 'test-key'
    let refreshing = false
    const fetcher = vi.fn(async (url: string) => {
      const index = Number(url.split('/').at(-1))
      if (refreshing) throw new Error(canaries[index])
      return {
        content: `proxies:\n${proxy(`safe-${index}`, 1600 + index)}\n`,
        finalUrl: url,
        bytes: 10,
        redirects: 0,
      }
    })
    const manager = createGatewaySubscriptionManager({
      dataDir,
      gateway: gatewayMock(),
      masterKey,
      fetchSubscription: fetcher,
    })
    for (let index = 0; index < canaries.length; index++)
      await manager.create({
        name: `canary-${index}`,
        url: `https://example.com/canary/${index}`,
      })
    refreshing = true

    const result = await manager.refreshSubscriptions()
    const listed = await manager.list()
    const key = await loadOrCreateKey(dataDir, masterKey)
    const stored = decryptJson<unknown>(
      await readFile(join(dataDir, 'subscriptions.enc'), 'utf8'),
      key,
    )

    expect(result.items).toHaveLength(canaries.length)
    expect(
      result.items.every(
        ({ error }) => error === 'subscription refresh failed',
      ),
    ).toBe(true)
    expect(
      listed.every(
        ({ lastError }) => lastError === 'subscription refresh failed',
      ),
    ).toBe(true)
    const publicAndStored = JSON.stringify({ result, listed, stored })
    for (const canary of canaries) expect(publicAndStored).not.toContain(canary)
  })

  it('refreshes every enabled subscription and merges successful sources in one candidate while retaining failed sources', async () => {
    const gateway = gatewayMock()
    let phase: 'initial' | 'refresh' = 'initial'
    const fetcher = vi.fn(async (url: string) => {
      if (phase === 'initial') {
        const name = url.includes('first')
          ? 'first-old'
          : url.includes('second')
            ? 'second-old'
            : 'disabled-old'
        return {
          content: `proxies:\n${proxy(name, 1100)}\n`,
          finalUrl: url,
          bytes: 10,
          redirects: 0,
        }
      }
      if (url.includes('second'))
        throw new Error(`fetch failed for ${url}&password=refresh-secret`)
      if (url.includes('disabled'))
        throw new Error('disabled subscription must not be fetched')
      return {
        content: `proxies:\n${proxy('first-new-a', 1201)}\n${proxy('first-new-b', 1202)}\n`,
        finalUrl: url,
        bytes: 20,
        redirects: 0,
      }
    })
    const manager = createGatewaySubscriptionManager({
      dataDir: await mkdtemp(join(tmpdir(), 'mcxd-subscriptions-refresh-')),
      gateway,
      masterKey: 'test-key',
      fetchSubscription: fetcher,
    })
    const first = await manager.create({
      name: 'first',
      url: 'https://example.com/first?token=first-secret',
    })
    const second = await manager.create({
      name: 'second',
      url: 'https://example.com/second?token=second-secret',
    })
    const disabled = await manager.create({
      name: 'disabled',
      url: 'https://example.com/disabled?token=disabled-secret',
      enabled: false,
    })
    phase = 'refresh'
    fetcher.mockClear()
    gateway.replaceNodeSources.mockClear()

    const result = await manager.refreshSubscriptions()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.flat().join(' ')).not.toContain('disabled-secret')
    expect(gateway.replaceNodeSources).toHaveBeenCalledTimes(1)
    expect(gateway.replaceNodeSources).toHaveBeenCalledWith(
      [
        {
          sourceId: `subscription:${first.id}`,
          nodes: [
            expect.objectContaining({ originalName: 'first-new-a' }),
            expect.objectContaining({ originalName: 'first-new-b' }),
          ],
        },
      ],
      'subscriptions.refresh',
    )
    expect(result.items).toEqual([
      { id: first.id, ok: true, nodeCount: 2 },
      expect.objectContaining({ id: second.id, ok: false, nodeCount: 1 }),
    ])
    expect(JSON.stringify(result)).not.toContain('second-secret')
    expect(JSON.stringify(result)).not.toContain('refresh-secret')

    const listed = await manager.list()
    expect(listed.find(({ id }) => id === first.id)?.nodeCount).toBe(2)
    expect(listed.find(({ id }) => id === second.id)?.nodeCount).toBe(1)
    expect(listed.find(({ id }) => id === disabled.id)?.nodeCount).toBe(1)
    expect(JSON.stringify(listed)).not.toContain('second-secret')
    expect(JSON.stringify(listed)).not.toContain('refresh-secret')
  })

  it('retains every previous source when the combined gateway candidate fails', async () => {
    const gateway = gatewayMock()
    let refresh = false
    const fetcher = vi.fn(async (url: string) => ({
      content: refresh
        ? `proxies:\n${proxy(`${url.includes('one') ? 'one' : 'two'}-new-a`, 1301)}\n${proxy(`${url.includes('one') ? 'one' : 'two'}-new-b`, 1302)}\n`
        : `proxies:\n${proxy(`${url.includes('one') ? 'one' : 'two'}-old`, 1300)}\n`,
      finalUrl: url,
      bytes: 20,
      redirects: 0,
    }))
    const manager = createGatewaySubscriptionManager({
      dataDir: await mkdtemp(join(tmpdir(), 'mcxd-subscriptions-rollback-')),
      gateway,
      masterKey: 'test-key',
      fetchSubscription: fetcher,
    })
    const one = await manager.create({
      name: 'one',
      url: 'https://example.com/one',
    })
    const two = await manager.create({
      name: 'two',
      url: 'https://example.com/two',
    })
    refresh = true
    gateway.replaceNodeSources.mockRejectedValueOnce(
      new Error('gateway apply failed token=apply-secret'),
    )

    const result = await manager.refreshSubscriptions()

    expect(gateway.replaceNodeSources).toHaveBeenCalledTimes(1)
    expect(result.items).toEqual([
      expect.objectContaining({ id: one.id, ok: false, nodeCount: 1 }),
      expect.objectContaining({ id: two.id, ok: false, nodeCount: 1 }),
    ])
    expect(JSON.stringify(result)).not.toContain('apply-secret')
    expect((await manager.list()).map(({ nodeCount }) => nodeCount)).toEqual([
      1, 1,
    ])
  })
})
