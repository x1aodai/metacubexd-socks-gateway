import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import {
  normalizeProxy,
  parseShareLink,
  previewSubscription,
  stableNodeId,
} from './parse.js'

function base64(value: string): string {
  return Buffer.from(value).toString('base64').replace(/=+$/, '')
}

describe('subscription import parsing', () => {
  it('extracts only proxies from a full Mihomo config', () => {
    const preview = previewSubscription(`
mixed-port: 7890
external-controller: 0.0.0.0:9090
rules:
  - MATCH,DIRECT
proxies:
  - name: edge
    type: vless
    server: edge.example.com
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
`)

    expect(preview.format).toBe('mihomo-config')
    expect(preview.summary).toEqual({
      total: 1,
      valid: 1,
      skipped: 0,
      protocols: { vless: 1 },
    })
    expect(preview.nodes[0]?.proxy).toMatchObject({
      name: 'edge',
      type: 'vless',
      server: 'edge.example.com',
      port: 443,
    })
  })

  it('accepts provider payload and deterministically resolves duplicate names', () => {
    const preview = previewSubscription(`
payload:
  - { name: same, type: trojan, server: a.example.com, port: 443, password: a }
  - { name: same, type: trojan, server: b.example.com, port: 443, password: b }
`)

    expect(preview.format).toBe('provider')
    expect(preview.nodes.map(({ proxy }) => proxy.name)).toEqual([
      'same',
      'same (2)',
    ])
    expect(preview.nodes[0]?.id).not.toBe(preview.nodes[1]?.id)
  })

  it('parses all supported common share-link formats', () => {
    const vmess = base64(
      JSON.stringify({
        v: '2',
        ps: 'vmess node',
        add: 'vmess.example.com',
        port: '443',
        id: '22222222-2222-2222-2222-222222222222',
        aid: '0',
        net: 'ws',
        host: 'cdn.example.com',
        path: '/ws',
        tls: 'tls',
      }),
    )
    const ssCredential = base64('aes-128-gcm:p@ssword')
    const input = [
      'vless://11111111-1111-1111-1111-111111111111@vless.example.com:443?security=reality&type=grpc&sni=front.example.com&pbk=publicKey&sid=abcd&fp=chrome#VLESS',
      `vmess://${vmess}`,
      'trojan://secret@trojan.example.com:443?sni=front.example.com#Trojan',
      `ss://${ssCredential}@ss.example.com:8388#SS`,
      'hysteria2://secret@hy.example.com:443?sni=hy.example.com&insecure=1&obfs=salamander&obfs-password=obfs#HY2',
      'tuic://33333333-3333-3333-3333-333333333333:secret@tuic.example.com:443?sni=tuic.example.com&congestion_control=bbr&udp_relay_mode=native#TUIC',
      'socks5://alice:password@socks.example.com:1080#SOCKS',
      'https://bob:password@http.example.com:8443#HTTP',
    ].join('\n')

    const preview = previewSubscription(input)

    expect(preview.summary.valid).toBe(8)
    expect(preview.summary.skipped).toBe(0)
    expect(preview.summary.protocols).toEqual({
      vless: 1,
      vmess: 1,
      trojan: 1,
      ss: 1,
      hysteria2: 1,
      tuic: 1,
      socks5: 1,
      http: 1,
    })
    expect(preview.nodes[0]?.proxy).toMatchObject({
      tls: true,
      network: 'grpc',
      servername: 'front.example.com',
      'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': 'publicKey', 'short-id': 'abcd' },
    })
    expect(preview.nodes[1]?.proxy).toMatchObject({
      network: 'ws',
      tls: true,
      'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
    })
    expect(preview.nodes[7]?.proxy).toMatchObject({ type: 'http', tls: true })
  })

  it('decodes base64 link collections', () => {
    const encoded = base64(
      'socks5://user:pass@one.example.com:1080#One\n' +
        'http://two.example.com:8080#Two\n',
    )
    const preview = previewSubscription(encoded)

    expect(preview.format).toBe('base64-links')
    expect(preview.summary.valid).toBe(2)
    expect(preview.nodes.map(({ proxy }) => proxy.name)).toEqual(['One', 'Two'])
  })

  it('reports invalid, unsupported, and exact duplicate nodes without aborting', () => {
    const node = 'socks5://user:pass@one.example.com:1080#One'
    const preview = previewSubscription(
      [node, 'ftp://example.com:21#unsupported', 'not-a-link', node].join('\n'),
    )

    expect(preview.summary).toMatchObject({ total: 4, valid: 1, skipped: 3 })
    expect(preview.issues.map(({ code }) => code)).toEqual([
      'unsupported-protocol',
      'invalid-node',
      'duplicate-node',
    ])
    expect(preview.issues.map(({ index }) => index)).toEqual([2, 3, 4])
  })

  it('keeps stable IDs across rename and mapping-key order changes', () => {
    const first = normalizeProxy({
      name: 'old',
      type: 'trojan',
      server: 'edge.example.com',
      port: 443,
      password: 'secret',
    })
    const second = normalizeProxy({
      password: 'secret',
      port: '443',
      server: 'edge.example.com',
      type: 'trojan',
      name: 'new',
    })

    expect(stableNodeId(first)).toBe(stableNodeId(second))
  })

  it('rejects malformed YAML and validates required proxy fields', () => {
    const malformed = previewSubscription('proxies:\n - name: [')
    expect(malformed.issues[0]).toMatchObject({ code: 'invalid-document' })

    expect(() =>
      normalizeProxy({ name: 'bad', type: 'vless', server: 'example.com' }),
    ).toThrow('valid server or port')
    expect(() => parseShareLink('vless://id@example.com:not-a-port')).toThrow()
  })
})
