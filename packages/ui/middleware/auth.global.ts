export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return

  const auth = useGatewayAuth()
  const state = await auth.check()

  if (to.path === '/login') {
    if (state === 'authenticated') {
      return navigateTo('/ports', { replace: true })
    }
    return
  }

  if (state !== 'authenticated') {
    return navigateTo(
      { path: '/login', query: { redirect: to.fullPath } },
      { replace: true },
    )
  }
})
