import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_VERSION,
  createAgent,
  createControlRouter,
  createGatewayManager,
  createGatewaySubscriptionManager,
  createInitialGatewayStateV2,
  createSupervisor,
  GATEWAY_PORTS,
  migrateV1ToV2,
  MIHOMO_VERSION,
  mihomoAsset,
  validateGatewayStateV2,
} from './index'
import * as publicAgentApi from './index'

function opts() {
  const homeDir = mkdtempSync(join(tmpdir(), 'mcxd-agent-'))
  return {
    binaryPath: '/fake/mihomo',
    homeDir,
    activeConfigPath: join(homeDir, 'active.yaml'),
    secret: 'test-controller-secret',
    gateway: { dataDir: join(homeDir, 'gateway') },
  }
}

describe('createAgent gateway-only composition', () => {
  it('requires the gateway and exposes only the gateway runtime surface', () => {
    const { gateway: _gateway, ...withoutGateway } = opts()
    expect(() => createAgent(withoutGateway as never)).toThrow(
      'gateway options are required',
    )

    const agent = createAgent(opts())
    expect(Object.keys(agent).sort()).toEqual([
      'gateway',
      'gatewaySubscriptions',
      'router',
      'supervisor',
    ])
  })

  it('fixes the Controller to loopback', () => {
    const agent = createAgent(opts())
    expect(agent.supervisor.getState()).toMatchObject({
      externalController: '127.0.0.1:9090',
      secret: 'test-controller-secret',
    })
  })

  it('pins gateway status to AGENT_VERSION even if runtime input is forged', async () => {
    const options = opts()
    const agent = createAgent({
      ...options,
      gateway: {
        ...options.gateway,
        fetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ proxies: {} }), { status: 200 }),
        ),
        agentVersion: 'forged-version',
      } as never,
    })

    expect((await agent.gateway.status()).versions.agent).toBe(AGENT_VERSION)
  })

  it('exports the gateway runtime and no removed generic capabilities', () => {
    expect(typeof createSupervisor).toBe('function')
    expect(typeof createGatewayManager).toBe('function')
    expect(typeof createGatewaySubscriptionManager).toBe('function')
    expect(typeof createControlRouter).toBe('function')
    expect(typeof mihomoAsset).toBe('function')
    expect(MIHOMO_VERSION.startsWith('v')).toBe(true)
    expect(GATEWAY_PORTS).toHaveLength(10)
    expect(typeof createInitialGatewayStateV2).toBe('function')
    expect(typeof migrateV1ToV2).toBe('function')
    expect(typeof validateGatewayStateV2).toBe('function')

    for (const name of [
      'applyActiveRefresh',
      'buildTunConfig',
      'createProfileConfigEditor',
      'createProfileScheduler',
      'createProfileStore',
      'createScriptRunner',
      'createWebdavClient',
      'fetchGeoAssets',
      'fetchKernel',
      'listMihomoVersions',
      'mergeConfigs',
    ])
      expect(publicAgentApi).not.toHaveProperty(name)
  })
})
