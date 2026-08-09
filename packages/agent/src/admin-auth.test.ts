import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AdminAuthError, createAdminAuth } from './admin-auth'

describe('admin auth', () => {
  it('creates a scrypt-backed administrator and manages CSRF-bound sessions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-auth-'))
    const auth = createAdminAuth({
      dataDir,
      initialPassword: 'a-strong-admin-password',
      masterKey: 'test-master-key',
    })
    const session = await auth.login('a-strong-admin-password', '127.0.0.1')
    expect(session.username).toBe('admin')
    expect(session.csrfToken.length).toBeGreaterThan(20)
    expect(await auth.authenticate(session.token)).toMatchObject({
      username: 'admin',
    })
    auth.logout(session.token)
    expect(await auth.authenticate(session.token)).toBeUndefined()
  })

  it('rate limits repeated failed logins', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-auth-rate-'))
    const auth = createAdminAuth({
      dataDir,
      initialPassword: 'a-strong-admin-password',
      masterKey: 'test-master-key',
      loginMaxAttempts: 2,
    })
    await expect(
      auth.login('wrong-password', '198.51.100.1'),
    ).rejects.toMatchObject({ statusCode: 401 })
    await expect(
      auth.login('wrong-password', '198.51.100.1'),
    ).rejects.toMatchObject({ statusCode: 401 })
    await expect(auth.login('wrong-password', '198.51.100.1')).rejects.toEqual(
      new AdminAuthError('too many login attempts', 429),
    )
  })

  it('invalidates sessions when the administrator password changes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcxd-auth-change-'))
    const auth = createAdminAuth({
      dataDir,
      initialPassword: 'a-strong-admin-password',
      masterKey: 'test-master-key',
    })
    const session = await auth.login('a-strong-admin-password', 'local')
    await auth.changePassword(
      'a-strong-admin-password',
      'the-new-admin-password',
    )
    expect(await auth.authenticate(session.token)).toBeUndefined()
    await expect(
      auth.login('a-strong-admin-password', 'old'),
    ).rejects.toMatchObject({ statusCode: 401 })
    await expect(
      auth.login('the-new-admin-password', 'new'),
    ).resolves.toMatchObject({ username: 'admin' })
  })
})
