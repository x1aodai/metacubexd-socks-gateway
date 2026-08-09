import { createError, defineEventHandler, getCookie, getHeader } from 'h3'
import { getAuth, SESSION_COOKIE } from '../lib/auth'

const CONTROL_PREFIX = '/api/control'
const PUBLIC_CONTROL_PATHS = new Set([`${CONTROL_PREFIX}/health`])

export interface AuthInput {
  path: string
  authHeader: string | undefined
  queryToken: string | undefined
  configuredToken: string
}

export type AuthResult =
  { ok: true } | { ok: false; status: number; message: string }

/**
 * Legacy pure token decision retained for compatibility tests and embedded
 * agent clients. The all-in-one web server middleware below uses the
 * administrator session cookie and CSRF token instead.
 */
export function isAuthorized(input: AuthInput): AuthResult {
  const { path, authHeader, queryToken, configuredToken } = input

  // Static UI + any non-control route: always public.
  if (!path.startsWith(CONTROL_PREFIX)) return { ok: true }

  // Public control endpoints (health).
  if (PUBLIC_CONTROL_PATHS.has(path)) return { ok: true }

  // Fail closed if the operator never configured a token.
  if (!configuredToken)
    return {
      ok: false,
      status: 503,
      message: 'CONTROL_TOKEN is not configured',
    }

  const bearer = parseBearer(authHeader)
  const presented = bearer ?? queryToken
  if (presented && presented === configuredToken) return { ok: true }

  return { ok: false, status: 401, message: 'Unauthorized' }
}

function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined
  const value = header.trim()
  let separator = 0
  while (separator < value.length && !isWhitespace(value[separator]!)) {
    separator++
  }
  if (value.slice(0, separator).toLowerCase() !== 'bearer') return undefined

  let tokenStart = separator
  while (tokenStart < value.length && isWhitespace(value[tokenStart]!)) {
    tokenStart++
  }
  return tokenStart < value.length ? value.slice(tokenStart) : undefined
}

function isWhitespace(char: string): boolean {
  return char.trim() === ''
}

export default defineEventHandler(async (event) => {
  const path = event.path.split('?')[0] ?? event.path
  if (!path.startsWith(CONTROL_PREFIX) || PUBLIC_CONTROL_PATHS.has(path)) return
  const session = await getAuth().authenticate(getCookie(event, SESSION_COOKIE))
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(event.method)) {
    if (getHeader(event, 'x-csrf-token') !== session.csrfToken)
      throw createError({
        statusCode: 403,
        statusMessage: 'Invalid CSRF token',
      })
  }
})
