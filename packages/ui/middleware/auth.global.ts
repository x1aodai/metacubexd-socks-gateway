export default defineNuxtRouteMiddleware(async (to) => {
  // Skip middleware on server
  if (import.meta.server) return

  // Skip endpoint check in mock mode
  const config = useRuntimeConfig()
  if (config.public.mockMode) {
    return
  }

  const gatewayAuth = useGatewayAuth()
  const state = await gatewayAuth.check()
  if (to.path !== '/login' && state === 'unauthenticated') {
    return navigateTo(
      { path: '/login', query: { redirect: to.fullPath } },
      { replace: true },
    )
  }
  if (to.path === '/login') {
    if (state === 'authenticated') {
      return navigateTo('/ports', { replace: true })
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
