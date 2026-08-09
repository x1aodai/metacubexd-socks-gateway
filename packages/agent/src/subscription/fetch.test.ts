import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import { fetchSubscription, isPublicAddress } from './fetch.js'

describe('subscription SSRF protection', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ])('blocks private or special-use address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])(
    'allows public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true)
    },
  )

  it('accepts HTTP(S) only', async () => {
    await expect(fetchSubscription('file:///etc/passwd')).rejects.toThrow(
      'must use HTTP or HTTPS',
    )
    await expect(fetchSubscription('ftp://example.com/list')).rejects.toThrow(
      'must use HTTP or HTTPS',
    )
  })

  it('blocks private IP literals before making a request', async () => {
    await expect(
      fetchSubscription('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow('blocked address')
    await expect(fetchSubscription('http://[::1]/')).rejects.toThrow(
      'blocked address',
    )
  })

  it('blocks a hostname when any DNS answer is private', async () => {
    const resolve = vi.fn().mockResolvedValue([
      { address: '1.1.1.1', family: 4 as const },
      { address: '10.0.0.2', family: 4 as const },
    ])

    await expect(
      fetchSubscription('https://subscription.example/list', { resolve }),
    ).rejects.toThrow('blocked address: 10.0.0.2')
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('reports empty and failed DNS resolution without connecting', async () => {
    await expect(
      fetchSubscription('https://empty.example/list', {
        resolve: vi.fn().mockResolvedValue([]),
      }),
    ).rejects.toThrow('has no addresses')
    await expect(
      fetchSubscription('https://failure.example/list', {
        resolve: vi.fn().mockRejectedValue(new Error('NXDOMAIN')),
      }),
    ).rejects.toThrow('DNS lookup failed')
  })

  it('validates every redirect hop and blocks a private redirect target', async () => {
    const resolve = vi.fn(async (hostname: string) =>
      hostname === 'public.example'
        ? [{ address: '1.1.1.1', family: 4 as const }]
        : [{ address: '192.168.1.8', family: 4 as const }],
    )
    const transport = vi.fn().mockResolvedValue({
      status: 302,
      location: 'http://internal.example/admin',
      body: Buffer.alloc(0),
    })

    await expect(
      fetchSubscription('https://public.example/list', { resolve, transport }),
    ).rejects.toThrow('blocked address')
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(transport).toHaveBeenCalledOnce()
  })

  it('follows at most three redirects and returns bounded response metadata', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValue([{ address: '1.1.1.1', family: 4 as const }])
    const transport = vi.fn(async (url: URL) => {
      const step = Number(url.searchParams.get('step') ?? 0)
      if (step < 3) {
        return {
          status: 302,
          location: `?step=${step + 1}`,
          body: Buffer.alloc(0),
        }
      }
      return {
        status: 200,
        contentType: 'text/yaml',
        body: Buffer.from('proxies: []\n'),
      }
    })

    await expect(
      fetchSubscription('https://public.example/list?step=0', {
        resolve,
        transport,
      }),
    ).resolves.toEqual({
      content: 'proxies: []\n',
      finalUrl: 'https://public.example/list?step=3',
      bytes: 12,
      redirects: 3,
      contentType: 'text/yaml',
    })

    const redirectForever = vi.fn().mockResolvedValue({
      status: 302,
      location: '/again',
      body: Buffer.alloc(0),
    })
    await expect(
      fetchSubscription('https://public.example/list', {
        resolve,
        transport: redirectForever,
      }),
    ).rejects.toThrow('exceeded 3 redirects')
  })

  it('enforces the byte limit and total timeout with injected dependencies', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValue([{ address: '1.1.1.1', family: 4 as const }])
    await expect(
      fetchSubscription('https://public.example/list', {
        resolve,
        maxBytes: 4,
        transport: vi.fn().mockResolvedValue({
          status: 200,
          body: Buffer.from('12345'),
        }),
      }),
    ).rejects.toThrow('exceeds 4 byte limit')

    await expect(
      fetchSubscription('https://slow.example/list', {
        timeoutMs: 10,
        resolve: vi.fn(() => new Promise<never>(() => undefined)),
      }),
    ).rejects.toThrow('timed out after 10ms')
  })
})
