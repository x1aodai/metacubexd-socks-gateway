import { beforeEach, describe, expect, it, vi } from 'vitest'
import bootKernel from '../boot-kernel'

const fakes = vi.hoisted(() => ({
  supervisor: {
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
  },
  scheduler: {
    start: vi.fn(),
    stop: vi.fn(),
  },
  gateway: {
    bootstrap: vi.fn(),
    status: vi.fn(),
  },
  gatewaySubscriptions: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}))

vi.mock('nitropack/runtime', () => ({
  defineNitroPlugin: (plugin: unknown) => plugin,
}))

vi.mock('../../lib/supervisor', () => ({
  getAgent: () => fakes,
}))

type CloseHook = () => void | Promise<void>

function testApp() {
  let closeHook: CloseHook | undefined
  const hook = vi.fn((name: string, callback: CloseHook) => {
    if (name === 'close') closeHook = callback
  })
  return {
    app: { hooks: { hook } },
    close: () => {
      if (!closeHook) throw new Error('close hook was not registered')
      return closeHook()
    },
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const runBoot = bootKernel as unknown as (
  app: ReturnType<typeof testApp>['app'],
) => Promise<void>

describe('boot-kernel gateway lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    fakes.supervisor.dispose.mockResolvedValue(undefined)
    fakes.gateway.bootstrap.mockResolvedValue(undefined)
    vi.spyOn(globalThis, 'setInterval').mockReturnValue({
      unref: vi.fn(),
    } as never)
  })

  it('awaits bootstrap before starting only the gateway subscription scheduler', async () => {
    const gate = deferred()
    fakes.gateway.bootstrap.mockReturnValueOnce(gate.promise)
    const { app } = testApp()

    const booting = runBoot(app)
    await Promise.resolve()

    expect(fakes.gateway.bootstrap).toHaveBeenCalledOnce()
    expect(fakes.gatewaySubscriptions.start).not.toHaveBeenCalled()
    expect(fakes.scheduler.start).not.toHaveBeenCalled()
    expect(fakes.supervisor.start).not.toHaveBeenCalled()
    expect(fakes.supervisor.stop).not.toHaveBeenCalled()
    expect(fakes.supervisor.restart).not.toHaveBeenCalled()
    expect(fakes.gateway.status).not.toHaveBeenCalled()
    expect(setInterval).not.toHaveBeenCalled()

    gate.resolve()
    await booting

    expect(fakes.gatewaySubscriptions.start).toHaveBeenCalledOnce()
  })

  it('propagates bootstrap failure without starting any scheduler or lifecycle', async () => {
    const failure = new Error('bootstrap failed')
    fakes.gateway.bootstrap.mockRejectedValueOnce(failure)
    const { app } = testApp()

    await expect(runBoot(app)).rejects.toBe(failure)

    expect(fakes.gatewaySubscriptions.start).not.toHaveBeenCalled()
    expect(fakes.scheduler.start).not.toHaveBeenCalled()
    expect(fakes.supervisor.start).not.toHaveBeenCalled()
    expect(fakes.supervisor.stop).not.toHaveBeenCalled()
    expect(fakes.supervisor.restart).not.toHaveBeenCalled()
    expect(fakes.gateway.status).not.toHaveBeenCalled()
    expect(setInterval).not.toHaveBeenCalled()
  })

  it('stops gateway subscriptions before awaiting supervisor disposal on close', async () => {
    const events: string[] = []
    const disposeGate = deferred()
    fakes.gatewaySubscriptions.stop.mockImplementationOnce(() => {
      events.push('gatewaySubscriptions.stop')
    })
    fakes.supervisor.dispose.mockImplementationOnce(async () => {
      events.push('supervisor.dispose')
      await disposeGate.promise
    })
    const harness = testApp()
    await runBoot(harness.app)

    let settled = false
    const closing = Promise.resolve(harness.close()).then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(events).toEqual(['gatewaySubscriptions.stop', 'supervisor.dispose'])
    expect(settled).toBe(false)
    expect(fakes.scheduler.stop).not.toHaveBeenCalled()
    expect(fakes.supervisor.stop).not.toHaveBeenCalled()

    disposeGate.resolve()
    await closing
    expect(settled).toBe(true)
  })
})
