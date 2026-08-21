import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the agent so we can assert how the server wires env -> createAgent,
// without spawning a real kernel.
const createAgentMock = vi.fn((_opts: Record<string, unknown>) => ({
  supervisor: { getState: () => ({ status: 'stopped' }) },
  profiles: {},
  router: { __isRouter: true },
  info: () => ({ hasAgent: true }),
}))
vi.mock('@metacubexd/agent', () => ({
  createAgent: createAgentMock,
}))

describe('apps/server lib/supervisor', () => {
  const ORIGINAL = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    createAgentMock.mockClear()
    process.env = { ...ORIGINAL }
  })
  afterEach(() => {
    process.env = { ...ORIGINAL }
  })

  it('reads server env into a typed config with documented defaults', async () => {
    delete process.env.CONTROL_PORT
    delete process.env.CLASH_API_PORT
    delete process.env.CLASH_API_BIND_ADDRESS
    delete process.env.CLASH_API_CORS_ORIGINS
    delete process.env.MIXED_PORT
    delete process.env.DATA_DIR
    delete process.env.MIHOMO_BIN
    delete process.env.CLASH_SECRET
    delete process.env.CONTROL_TOKEN
    delete process.env.GITHUB_TOKEN
    delete process.env.ADMIN_PASSWORD
    delete process.env.ADMIN_PASSWORD_FILE
    delete process.env.GATEWAY_MASTER_KEY
    delete process.env.GATEWAY_MASTER_KEY_FILE
    delete process.env.PUBLIC_DIRECT_ACCESS
    const { serverEnv } = await import('../supervisor')
    const env = serverEnv()
    expect(env.controlPort).toBe(8080)
    expect(env.clashApiPort).toBe(9090)
    expect(env.dataDir).toBe('/data')
    expect(env.mihomoBin).toBe('/usr/local/bin/mihomo')
    expect(env.githubToken).toBe('')
    expect(env.publicDirectAccess).toBe(false)
    expect(env).not.toHaveProperty('clashApiBindAddress')
    expect(env).not.toHaveProperty('clashApiCorsOrigins')
    expect(env).not.toHaveProperty('mixedPort')
    expect(env).not.toHaveProperty('socksPortMin')
    expect(env).not.toHaveProperty('socksPortMax')
  })

  it('ignores removed gateway env while retaining unrelated runtime env', async () => {
    process.env.CONTROL_PORT = '18080'
    process.env.CLASH_API_PORT = '19090'
    process.env.CLASH_API_BIND_ADDRESS = '0.0.0.0'
    process.env.CLASH_API_CORS_ORIGINS =
      'http://gateway.example.com:8080, http://gateway.example.net:8080'
    process.env.MIXED_PORT = '17890'
    process.env.DATA_DIR = '/srv/data'
    process.env.MIHOMO_BIN = '/opt/mihomo'
    process.env.GITHUB_TOKEN = 'github-token'
    process.env.PUBLIC_DIRECT_ACCESS = 'true'
    const { serverEnv } = await import('../supervisor')
    const env = serverEnv()
    expect(env.controlPort).toBe(18080)
    expect(env.clashApiPort).toBe(19090)
    expect(env.dataDir).toBe('/srv/data')
    expect(env.mihomoBin).toBe('/opt/mihomo')
    expect(env.githubToken).toBe('github-token')
    expect(env.publicDirectAccess).toBe(true)
    expect(env).not.toHaveProperty('clashApiBindAddress')
    expect(env).not.toHaveProperty('clashApiCorsOrigins')
    expect(env).not.toHaveProperty('mixedPort')
  })

  it('builds the agent once with fixed Controller and minimal gateway options', async () => {
    process.env.DATA_DIR = '/data'
    process.env.MIHOMO_BIN = '/usr/local/bin/mihomo'
    process.env.CLASH_API_PORT = '9090'
    process.env.CLASH_API_BIND_ADDRESS = '0.0.0.0'
    process.env.CLASH_API_CORS_ORIGINS = 'http://gateway.example.com:8080'
    process.env.MIXED_PORT = '17890'
    process.env.SOCKS_PORT_MIN = '20001'
    process.env.SOCKS_PORT_MAX = '20010'
    process.env.CLASH_SECRET = 'clash-x'
    process.env.GATEWAY_MASTER_KEY = 'gateway-key'
    const { getAgent } = await import('../supervisor')
    const a = getAgent()
    const b = getAgent()
    expect(a).toBe(b)
    expect(createAgentMock).toHaveBeenCalledTimes(1)
    const opts = createAgentMock.mock.calls[0]![0]
    expect(opts.binaryPath).toBe('/usr/local/bin/mihomo')
    expect(opts.homeDir).toBe('/data')
    expect(opts.profilesDir).toBe('/data/profiles')
    expect(opts.activeConfigPath).toBe('/data/active.yaml')
    expect(opts.agentToken).toBeUndefined()
    expect(opts.externalController).toBe('127.0.0.1:9090')
    expect(opts.secret).toBe('clash-x')
    expect(opts.mixedPort).toBeUndefined()
    expect(opts.gateway).toEqual({
      dataDir: '/data',
      masterKey: 'gateway-key',
    })
  })
})
