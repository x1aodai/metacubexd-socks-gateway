import { Buffer } from 'node:buffer'
import { scrypt as nodeScrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  atomicWrite,
  decryptJson,
  encryptJson,
  loadOrCreateKey,
} from './secure-store'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000

interface AdminRecord {
  version: 1
  username: string
  salt: string
  hash: string
  updatedAt: number
}

interface Session {
  username: string
  csrfToken: string
  expiresAt: number
}

export interface AdminAuthOptions {
  dataDir: string
  initialPassword?: string
  masterKey?: string
  now?: () => number
  sessionTtlMs?: number
  loginWindowMs?: number
  loginMaxAttempts?: number
}

export interface AdminSession {
  token: string
  username: string
  csrfToken: string
  expiresAt: number
}

export interface AdminAuth {
  login: (password: string, remoteAddress: string) => Promise<AdminSession>
  authenticate: (
    token?: string,
  ) => Promise<Omit<AdminSession, 'token'> | undefined>
  logout: (token?: string) => void
  changePassword: (
    currentPassword: string,
    nextPassword: string,
  ) => Promise<void>
  isConfigured: () => Promise<boolean>
}

export class AdminAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
  }
}

export function createAdminAuth(options: AdminAuthOptions): AdminAuth {
  const now = options.now ?? Date.now
  const ttl = options.sessionTtlMs ?? SESSION_TTL_MS
  const windowMs = options.loginWindowMs ?? 15 * 60 * 1000
  const maxAttempts = options.loginMaxAttempts ?? 5
  const recordPath = join(options.dataDir, 'admin.enc')
  const sessions = new Map<string, Session>()
  const attempts = new Map<string, number[]>()
  let recordPromise: Promise<AdminRecord | undefined> | undefined

  async function derive(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) =>
      nodeScrypt(
        password,
        salt,
        32,
        { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, derived) =>
          error ? reject(error) : resolve(derived as Buffer),
      ),
    )
  }

  async function save(record: AdminRecord): Promise<void> {
    const key = await loadOrCreateKey(options.dataDir, options.masterKey)
    await atomicWrite(recordPath, encryptJson(record, key))
  }

  async function load(): Promise<AdminRecord | undefined> {
    if (!recordPromise) {
      recordPromise = (async () => {
        try {
          const [raw, key] = await Promise.all([
            readFile(recordPath, 'utf8'),
            loadOrCreateKey(options.dataDir, options.masterKey),
          ])
          return decryptJson<AdminRecord>(raw, key)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if (!options.initialPassword) return undefined
          validatePassword(options.initialPassword)
          const salt = randomBytes(16)
          const hash = await derive(options.initialPassword, salt)
          const created: AdminRecord = {
            version: 1,
            username: 'admin',
            salt: salt.toString('base64url'),
            hash: hash.toString('base64url'),
            updatedAt: now(),
          }
          await save(created)
          return created
        }
      })()
    }
    return recordPromise
  }

  async function verify(password: string): Promise<boolean> {
    const record = await load()
    if (!record) return false
    const expected = Buffer.from(record.hash, 'base64url')
    const actual = await derive(password, Buffer.from(record.salt, 'base64url'))
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    )
  }

  function enforceRateLimit(remoteAddress: string): void {
    const cutoff = now() - windowMs
    const recent = (attempts.get(remoteAddress) ?? []).filter(
      (ts) => ts > cutoff,
    )
    if (recent.length >= maxAttempts)
      throw new AdminAuthError('too many login attempts', 429)
    recent.push(now())
    attempts.set(remoteAddress, recent)
  }

  return {
    async login(password, remoteAddress) {
      enforceRateLimit(remoteAddress || 'unknown')
      const record = await load()
      if (!record)
        throw new AdminAuthError(
          'administrator password is not configured',
          503,
        )
      if (!(await verify(password)))
        throw new AdminAuthError('invalid credentials', 401)
      attempts.delete(remoteAddress || 'unknown')
      const token = randomBytes(32).toString('base64url')
      const session: Session = {
        username: record.username,
        csrfToken: randomBytes(24).toString('base64url'),
        expiresAt: now() + ttl,
      }
      sessions.set(token, session)
      return { token, ...session }
    },
    async authenticate(token) {
      if (!token) return undefined
      const session = sessions.get(token)
      if (!session) return undefined
      if (session.expiresAt <= now()) {
        sessions.delete(token)
        return undefined
      }
      return { ...session }
    },
    logout(token) {
      if (token) sessions.delete(token)
    },
    async changePassword(currentPassword, nextPassword) {
      if (!(await verify(currentPassword)))
        throw new AdminAuthError('current password is incorrect', 403)
      validatePassword(nextPassword)
      const salt = randomBytes(16)
      const hash = await derive(nextPassword, salt)
      const record: AdminRecord = {
        version: 1,
        username: 'admin',
        salt: salt.toString('base64url'),
        hash: hash.toString('base64url'),
        updatedAt: now(),
      }
      await save(record)
      recordPromise = Promise.resolve(record)
      sessions.clear()
    },
    async isConfigured() {
      return (await load()) !== undefined
    },
  }
}

function validatePassword(password: string): void {
  if (
    typeof password !== 'string' ||
    password.length < 12 ||
    password.length > 256
  )
    throw new AdminAuthError('password must contain 12 to 256 characters', 400)
}
