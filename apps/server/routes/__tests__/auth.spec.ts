import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetAuthForTests } from '../../lib/auth'

async function start() {
  const handler = (await import('../api/auth/[...]')).default
  const app = createApp()
  app.use(handler)
  const server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('test server did not bind')
  return { server, base: `http://127.0.0.1:${address.port}` }
}

describe('administrator auth routes', () => {
  const original = { ...process.env }

  beforeEach(() => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mcxd-server-auth-'))
    process.env.ADMIN_PASSWORD = 'a-strong-admin-password'
    process.env.GATEWAY_MASTER_KEY = 'test-master-key'
    process.env.SESSION_COOKIE_SECURE = 'false'
    __resetAuthForTests()
  })

  afterEach(() => {
    process.env = { ...original }
    __resetAuthForTests()
  })

  it('sets a strict HttpOnly session and exposes the CSRF token only in JSON', async () => {
    const { server, base } = await start()
    try {
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'a-strong-admin-password' }),
      })
      expect(login.status).toBe(200)
      const cookieHeader = login.headers.get('set-cookie') ?? ''
      expect(cookieHeader).toContain('HttpOnly')
      expect(cookieHeader.toLowerCase()).toContain('samesite=strict')
      const cookie = cookieHeader.split(';', 1)[0]!
      const body = (await login.json()) as { csrfToken: string; user: string }
      expect(body.user).toBe('admin')
      expect(cookie).not.toContain(body.csrfToken)

      const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } })
      await expect(me.json()).resolves.toMatchObject({
        authenticated: true,
        user: 'admin',
      })
      const check = await fetch(`${base}/api/auth/check`, {
        headers: { cookie },
      })
      expect(check.status).toBe(204)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('rejects forward-auth without a session and mutations without CSRF', async () => {
    const { server, base } = await start()
    try {
      expect((await fetch(`${base}/api/auth/check`)).status).toBe(401)
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'a-strong-admin-password' }),
      })
      const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0]!
      const { csrfToken } = (await login.json()) as { csrfToken: string }
      const missing = await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie },
      })
      expect(missing.status).toBe(403)
      const wrong = await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': 'wrong-token' },
      })
      expect(wrong.status).toBe(403)
      const valid = await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': csrfToken },
      })
      expect(valid.status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
