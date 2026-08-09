import { describe, expect, it } from 'vitest'
import {
  readGatewayCsrfCookie,
  resolveGatewayApiBase,
  unwrapGatewayList,
} from '../useGatewayApi'

describe('gateway API helpers', () => {
  it('resolves the same-origin API base without a trailing slash', () => {
    const previousWindow = globalThis.window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://gateway.example.com' } },
    })

    expect(resolveGatewayApiBase()).toBe('https://gateway.example.com/api')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    })
  })

  it('reads supported CSRF cookie names and decodes their value', () => {
    expect(
      readGatewayCsrfCookie('theme=dark; XSRF-TOKEN=a%2Fb%2Bc; lang=zh'),
    ).toBe('a/b+c')
    expect(readGatewayCsrfCookie('csrf_token=token-1')).toBe('token-1')
    expect(readGatewayCsrfCookie('session=secret')).toBe('')
  })

  it('normalizes direct arrays and item envelopes', () => {
    expect(unwrapGatewayList([{ id: 'one' }])).toEqual([{ id: 'one' }])
    expect(unwrapGatewayList({ items: [{ id: 'two' }] })).toEqual([
      { id: 'two' },
    ])
  })
})
