import { Buffer } from 'node:buffer'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function atomicWrite(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(
    dirname(path),
    `.${path.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  )
  const handle = await open(temporary, 'wx', mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  await chmod(path, mode)
}

export async function loadOrCreateKey(
  dataDir: string,
  explicit?: string,
): Promise<Buffer> {
  if (explicit) return createHash('sha256').update(explicit).digest()
  const path = join(dataDir, '.gateway-master-key')
  try {
    const value = await readFile(path)
    if (value.length === 32) return value
    throw new Error('gateway master key has an invalid length')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dataDir, { recursive: true })
  const value = randomBytes(32)
  try {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(value)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return readFile(path)
    throw error
  }
}

export function encryptJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ])
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: encrypted.toString('base64url'),
  })
}

export function decryptJson<T>(raw: string, key: Buffer): T {
  const envelope = JSON.parse(raw) as {
    v: number
    iv: string
    tag: string
    data: string
  }
  if (envelope.v !== 1) throw new Error('unsupported encrypted store version')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.iv, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'))
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64url')),
      decipher.final(),
    ]).toString('utf8'),
  ) as T
}
