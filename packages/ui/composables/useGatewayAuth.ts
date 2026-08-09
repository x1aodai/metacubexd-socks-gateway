import type { GatewayAuthSession } from '~/types/gateway'
import { HTTPError } from 'ky'

export type GatewayAuthState =
  'unknown' | 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable'

const state = ref<GatewayAuthState>('unknown')
const user = ref('')
let sessionRequest: Promise<GatewayAuthState> | null = null

function applySession(session: GatewayAuthSession): GatewayAuthState {
  state.value = session.authenticated ? 'authenticated' : 'unauthenticated'
  user.value =
    typeof session.user === 'string'
      ? session.user
      : session.user?.username || ''
  return state.value
}

function isStandaloneAuthMiss(error: unknown): boolean {
  if (error instanceof HTTPError) return error.response.status === 404
  if (error instanceof SyntaxError) return true
  if (typeof window === 'undefined') return true
  return (
    window.location?.protocol === 'file:' ||
    (window as unknown as { metacubexd?: { isDesktop?: boolean } }).metacubexd
      ?.isDesktop === true
  )
}

export function useGatewayAuth() {
  const api = useGatewayApi()

  async function check(force = false): Promise<GatewayAuthState> {
    if (!force && state.value !== 'unknown' && state.value !== 'checking') {
      return state.value
    }
    if (!force && sessionRequest) return sessionRequest

    state.value = 'checking'
    sessionRequest = api
      .getSession()
      .then(applySession)
      .catch((error: unknown) => {
        if (isStandaloneAuthMiss(error)) {
          // A missing auth endpoint means this is the normal static/desktop UI.
          // Do not intercept its existing navigation.
          state.value = 'unavailable'
        } else {
          // HTTP(S) server errors and network failures fail closed. The API is
          // guarded independently, but the administration shell should not
          // expose itself while its session state is unknown.
          state.value = 'unauthenticated'
        }
        return state.value
      })
      .finally(() => {
        sessionRequest = null
      })
    return sessionRequest
  }

  async function login(password: string) {
    const session = await api.login(password)
    return applySession(
      session.authenticated === false
        ? session
        : { ...session, authenticated: true },
    )
  }

  async function logout() {
    await api.logout()
    state.value = 'unauthenticated'
    user.value = ''
  }

  return {
    state: readonly(state),
    user: readonly(user),
    authenticated: computed(() => state.value === 'authenticated'),
    check,
    login,
    logout,
  }
}
