import { describe, expect, it } from 'vitest'
import { controlErrorMessage } from '../controlError'

describe('controlErrorMessage', () => {
  it('prefers the nested H3 gateway diagnostic from a ky HTTPError', () => {
    const error = Object.assign(
      new Error('Request failed with status code 400'),
      {
        data: {
          statusCode: 400,
          statusMessage: 'gateway validation failed',
          data: { error: 'gateway port requires an enabled credential' },
        },
      },
    )

    expect(controlErrorMessage(error)).toBe(
      'gateway port requires an enabled credential',
    )
  })

  it('falls back through the H3 status message and an ordinary Error', () => {
    expect(
      controlErrorMessage({
        data: { statusMessage: 'gateway validation failed' },
      }),
    ).toBe('gateway validation failed')
    expect(controlErrorMessage(new Error('network down'))).toBe('network down')
  })

  it('surfaces a structured subscription error', () => {
    const error = Object.assign(
      new Error('Request failed with status code 429'),
      {
        data: {
          statusCode: 429,
          data: {
            error: 'subscription refresh failed',
            upstreamStatus: 429,
          },
        },
      },
    )

    expect(controlErrorMessage(error)).toBe('subscription refresh failed')
  })
})
