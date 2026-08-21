import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { createAgent } from '@metacubexd/agent'

/** Parsed server runtime config, sourced entirely from env. */
export interface ServerEnv {
  controlPort: number
  clashApiPort: number
  dataDir: string
  mihomoBin: string
  controlToken: string
  clashSecret: string
  githubToken: string
  defaultBackendURL: string
  adminPassword: string
  gatewayMasterKey: string
  sessionCookieSecure: boolean
  publicDirectAccess: boolean
}

function int(value: string | undefined, fallback: number): number {
  const n = value == null ? Number.NaN : Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
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
    controlPort: int(process.env.CONTROL_PORT, 8080),
    clashApiPort: int(process.env.CLASH_API_PORT, 9090),
    dataDir: process.env.DATA_DIR ?? '/data',
    mihomoBin: process.env.MIHOMO_BIN ?? '/usr/local/bin/mihomo',
    controlToken: process.env.CONTROL_TOKEN ?? '',
    clashSecret: process.env.CLASH_SECRET ?? '',
    githubToken: process.env.GITHUB_TOKEN ?? '',
    defaultBackendURL: process.env.DEFAULT_BACKEND_URL ?? '',
    adminPassword: secret('ADMIN_PASSWORD', 'ADMIN_PASSWORD_FILE'),
    gatewayMasterKey: secret('GATEWAY_MASTER_KEY', 'GATEWAY_MASTER_KEY_FILE'),
    sessionCookieSecure: process.env.SESSION_COOKIE_SECURE !== 'false',
    publicDirectAccess: process.env.PUBLIC_DIRECT_ACCESS === 'true',
  }
}

export type Agent = ReturnType<typeof createAgent>

let agentSingleton: Agent | undefined

/**
 * Module-singleton agent. Built once per process from serverEnv():
 * homeDir/profilesDir/activeConfigPath live under DATA_DIR and the kernel binary
 * is MIHOMO_BIN. The server's outer middleware owns cookie/session auth, so the
 * in-process agent router intentionally has no bearer token of its own.
 */
export function getAgent(): Agent {
  if (agentSingleton) return agentSingleton
  const env = serverEnv()
  const dataPath = env.dataDir.includes('\\') ? join : posix.join
  agentSingleton = createAgent({
    binaryPath: env.mihomoBin,
    homeDir: env.dataDir,
    profilesDir: dataPath(env.dataDir, 'profiles'),
    activeConfigPath: dataPath(env.dataDir, 'active.yaml'),
    externalController: '127.0.0.1:9090',
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
