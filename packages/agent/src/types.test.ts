import type {
  KernelState,
  KernelStatus,
  MihomoSupervisor,
  SupervisorOptions,
} from './types'
import { describe, expect, expectTypeOf, it } from 'vitest'

describe('gateway supervisor public types', () => {
  it('keeps the kernel lifecycle state used by gateway health', () => {
    expectTypeOf<KernelStatus>().toEqualTypeOf<
      'stopped' | 'starting' | 'running' | 'stopping' | 'errored'
    >()
    const state: KernelState = {
      status: 'stopped',
      externalController: '127.0.0.1:9090',
      secret: 'test-only',
    }
    expect(state.status).toBe('stopped')
  })

  it('keeps the supervisor construction and lifecycle signatures', () => {
    const options: SupervisorOptions = {
      binaryPath: '/fake/mihomo',
      homeDir: '/tmp/gateway',
      activeConfigPath: '/tmp/gateway/active.yaml',
    }
    expect(options.binaryPath).toBe('/fake/mihomo')
    expectTypeOf<MihomoSupervisor['start']>().returns.toEqualTypeOf<
      Promise<KernelState>
    >()
    expectTypeOf<MihomoSupervisor['validate']>().parameters.toEqualTypeOf<
      [string]
    >()
  })
})
