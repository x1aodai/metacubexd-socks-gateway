import { createAdminAuth } from '@metacubexd/agent'
import { serverEnv } from './supervisor'

export const SESSION_COOKIE = 'mcxd_gateway_session'

let authSingleton: ReturnType<typeof createAdminAuth> | undefined

export function getAuth() {
  if (authSingleton) return authSingleton
  const env = serverEnv()
  authSingleton = createAdminAuth({
    dataDir: env.dataDir,
    initialPassword: env.adminPassword || undefined,
    masterKey: env.gatewayMasterKey || undefined,
  })
  return authSingleton
}

export function __resetAuthForTests(): void {
  authSingleton = undefined
}
