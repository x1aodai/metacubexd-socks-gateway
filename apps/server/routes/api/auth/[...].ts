import { AdminAuthError } from '@metacubexd/agent'
import {
  createError,
  defineEventHandler,
  deleteCookie,
  getCookie,
  getHeader,
  readBody,
  sendNoContent,
  setCookie,
} from 'h3'
import { getAuth, SESSION_COOKIE } from '../../../lib/auth'
import { serverEnv } from '../../../lib/supervisor'

function fail(error: unknown): never {
  if (error instanceof AdminAuthError) {
    throw createError({
      statusCode: error.statusCode,
      statusMessage: error.message,
      data: { error: error.message },
    })
  }
  throw error
}

export default defineEventHandler(async (event) => {
  const path = (event.path ?? '').split('?')[0]
  const auth = getAuth()
  const cookie = getCookie(event, SESSION_COOKIE)

  if (path === '/api/auth/login' && event.method === 'POST') {
    const body = (await readBody(event)) as { password?: string }
    try {
      const session = await auth.login(
        body?.password ?? '',
        event.node.req.socket.remoteAddress ?? 'unknown',
      )
      setCookie(event, SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: serverEnv().sessionCookieSecure,
        path: '/',
        maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
      })
      return {
        authenticated: true,
        user: session.username,
        csrfToken: session.csrfToken,
      }
    } catch (error) {
      fail(error)
    }
  }

  const session = await auth.authenticate(cookie)
  if (path === '/api/auth/me' && event.method === 'GET') {
    return session
      ? {
          authenticated: true,
          user: session.username,
          csrfToken: session.csrfToken,
        }
      : { authenticated: false }
  }
  if (!session)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  if (path === '/api/auth/check' && event.method === 'GET')
    return sendNoContent(event)
  if (getHeader(event, 'x-csrf-token') !== session.csrfToken)
    throw createError({ statusCode: 403, statusMessage: 'Invalid CSRF token' })

  if (path === '/api/auth/logout' && event.method === 'POST') {
    auth.logout(cookie)
    deleteCookie(event, SESSION_COOKIE, { path: '/' })
    return { authenticated: false }
  }
  if (path === '/api/auth/password' && event.method === 'PUT') {
    const body = (await readBody(event)) as {
      currentPassword?: string
      newPassword?: string
    }
    try {
      await auth.changePassword(
        body.currentPassword ?? '',
        body.newPassword ?? '',
      )
      deleteCookie(event, SESSION_COOKIE, { path: '/' })
      return { ok: true }
    } catch (error) {
      fail(error)
    }
  }

  throw createError({ statusCode: 404, statusMessage: 'Not Found' })
})
