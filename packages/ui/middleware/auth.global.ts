export default defineNuxtRouteMiddleware(async (to) => {
  // Skip middleware on server
  if (import.meta.server) return

  // Skip endpoint check in mock mode
  const config = useRuntimeConfig()
  if (config.public.mockMode) {
    return
  }

  // The all-in-one server requires one administrator session for the complete
  // dashboard. A standalone/static deployment has no auth endpoint; the probe
  // reports `unavailable` and existing endpoint navigation continues unchanged.
  const gatewayAuth = useGatewayAuth()
  const state = await gatewayAuth.check(
    gatewayAuth.state.value !== 'unavailable',
  )
  if (to.path !== '/login' && state === 'unauthenticated') {
    return navigateTo(
      { path: '/login', query: { redirect: to.fullPath } },
      { replace: true },
    )
  }
  if (to.path === '/login') {
    if (state === 'authenticated') {
      return navigateTo('/gateway', { replace: true })
    }
    return
  }

  const endpointStore = useEndpointStore()
  const hasEndpoint = !!endpointStore.currentEndpoint

  if (to.path === '/' || to.path === '/setup' || to.path === '/gateway') {
    return
  }

  if (!hasEndpoint) {
    return navigateTo('/', { replace: true })
  }
})
