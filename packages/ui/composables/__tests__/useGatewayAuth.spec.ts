import { beforeEach, describe, expect, it, vi } from 'vitest'

interface AuthApiStub {
  getSession: ReturnType<typeof vi.fn>
  login: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
}

async function loadAuth(api: AuthApiStub) {
  vi.resetModules()
  vi.stubGlobal('useGatewayApi', () => api)
  const { useGatewayAuth } = await import('../useGatewayAuth')
  return useGatewayAuth()
}

describe('gateway authentication state', () => {
  let api: AuthApiStub

  beforeEach(() => {
    api = {
      getSession: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
    }
  })

  it('accepts only a session that explicitly authenticates', async () => {
    for (const session of [
      { user: 'admin', csrfToken: 'csrf' },
      { authenticated: true, user: '', csrfToken: 'csrf' },
      { authenticated: true, user: 'admin', csrfToken: '' },
      { authenticated: true, user: 'admin' },
    ]) {
      api.login.mockResolvedValueOnce(session)
      const auth = await loadAuth(api)

      await expect(auth.login('wrong')).resolves.toBe('unauthenticated')
      expect(auth).not.toHaveProperty('state')
      expect(auth).not.toHaveProperty('authenticated')
      expect(auth).not.toHaveProperty('user')
    }
  })

  it('deduplicates a session check', async () => {
    let resolveSession!: (value: {
      authenticated: true
      user: string
      csrfToken: string
    }) => void
    api.getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve
      }),
    )
    const auth = await loadAuth(api)

    const first = auth.check()
    const second = auth.check()
    expect(api.getSession).toHaveBeenCalledOnce()
    resolveSession({
      authenticated: true,
      user: 'admin',
      csrfToken: 'csrf',
    })

    await expect(Promise.all([first, second])).resolves.toEqual([
      'authenticated',
      'authenticated',
    ])
  })

  it('fails closed on session and login errors', async () => {
    for (const error of [
      new TypeError('network failed'),
      new SyntaxError('invalid JSON'),
      new Error('404'),
    ]) {
      api.getSession.mockRejectedValueOnce(error)
      const auth = await loadAuth(api)
      await expect(auth.check()).resolves.toBe('unauthenticated')
    }

    api.login.mockRejectedValueOnce(new TypeError('network failed'))
    const auth = await loadAuth(api)
    await expect(auth.login('password')).rejects.toThrow('network failed')
  })

  it('clears local identity even when logout fails', async () => {
    api.login.mockResolvedValue({
      authenticated: true,
      user: 'admin',
      csrfToken: 'csrf',
    })
    api.logout.mockRejectedValue(new TypeError('network failed'))
    const auth = await loadAuth(api)

    await auth.login('password')
    await expect(auth.logout()).rejects.toThrow('network failed')
    await expect(auth.check()).resolves.toBe('unauthenticated')
  })
})
