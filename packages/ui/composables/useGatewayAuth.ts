import type { GatewayAuthSession } from '~/types/gateway'
import { ref } from 'vue'

export type GatewayAuthState =
  'unknown' | 'checking' | 'authenticated' | 'unauthenticated'

const state = ref<GatewayAuthState>('unknown')
let sessionRequest: Promise<GatewayAuthState> | null = null

function unauthenticated(): GatewayAuthState {
  state.value = 'unauthenticated'
  return state.value
}

function applySession(session: GatewayAuthSession): GatewayAuthState {
  if (
    session.authenticated !== true ||
    typeof session.user !== 'string' ||
    session.user.length === 0 ||
    typeof session.csrfToken !== 'string' ||
    session.csrfToken.length === 0
  )
    return unauthenticated()
  state.value = 'authenticated'
  return state.value
}

export function useGatewayAuth() {
  const api = useGatewayApi()

  async function check(): Promise<GatewayAuthState> {
    if (state.value !== 'unknown' && state.value !== 'checking')
      return state.value
    if (sessionRequest) return sessionRequest

    state.value = 'checking'
    sessionRequest = api
      .getSession()
      .then(applySession)
      .catch(() => unauthenticated())
      .finally(() => {
        sessionRequest = null
      })
    return sessionRequest
  }

  async function login(password: string): Promise<GatewayAuthState> {
    try {
      return applySession(await api.login(password))
    } catch (error) {
      unauthenticated()
      throw error
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.logout()
    } finally {
      unauthenticated()
    }
  }

  return {
    check,
    login,
    logout,
  }
}
