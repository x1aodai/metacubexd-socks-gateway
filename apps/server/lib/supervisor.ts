import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { createAgent } from '@metacubexd/agent'

/** Parsed server runtime config, sourced entirely from env. */
export interface ServerEnv {
  dataDir: string
  mihomoBin: string
  clashSecret: string
  adminPassword: string
  gatewayMasterKey: string
  sessionCookieSecure: boolean
}

function secret(envName: string, fileEnvName: string): string {
  const file = process.env[fileEnvName]
  if (file) {
    try {
      return readFileSync(file, 'utf8').split(/\r?\n/, 1)[0]?.trim() ?? ''
    } catch (error) {
      throw new Error(
        `unable to read ${fileEnvName}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return process.env[envName] ?? ''
}

/** Read process.env into a typed ServerEnv with documented defaults. */
export function serverEnv(): ServerEnv {
  return {
    dataDir: process.env.DATA_DIR ?? '/data',
    mihomoBin: process.env.MIHOMO_BIN ?? '/usr/local/bin/mihomo',
    clashSecret: process.env.CLASH_SECRET ?? '',
    adminPassword: secret('ADMIN_PASSWORD', 'ADMIN_PASSWORD_FILE'),
    gatewayMasterKey: secret('GATEWAY_MASTER_KEY', 'GATEWAY_MASTER_KEY_FILE'),
    sessionCookieSecure: process.env.SESSION_COOKIE_SECURE !== 'false',
  }
}

export type Agent = ReturnType<typeof createAgent>

let agentSingleton: Agent | undefined

/**
 * Module-singleton agent. Built once per process from serverEnv():
 * The Mihomo home, gateway state and active config live under DATA_DIR. The
 * server's outer middleware owns administrator session and CSRF enforcement.
 */
export function getAgent(): Agent {
  if (agentSingleton) return agentSingleton
  const env = serverEnv()
  const dataPath = env.dataDir.includes('\\') ? join : posix.join
  agentSingleton = createAgent({
    binaryPath: env.mihomoBin,
    homeDir: env.dataDir,
    activeConfigPath: dataPath(env.dataDir, 'active.yaml'),
    secret: env.clashSecret,
    // No mixed-port is configured: the managed gateway overlay owns the only
    // public listener and enforces authenticated SOCKS on the selected port.
    gateway: {
      dataDir: env.dataDir,
      masterKey: env.gatewayMasterKey || undefined,
    },
  })
  return agentSingleton
}

/** Test-only reset hook. */
export function __resetAgentForTests(): void {
  agentSingleton = undefined
}
