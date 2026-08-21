import type { GatewayPort, GatewayStatus } from '~/types/gateway'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PortsPage from '../ports.vue'

const ports: GatewayPort[] = Array.from({ length: 10 }, (_, index) => ({
  id: index + 1,
  port: 10_001 + index,
  enabled: index === 0,
  credentialIds: index === 0 ? ['credential-1'] : [],
  hops: index === 0 ? [{ mode: 'manual', nodeIds: ['node-1'] }] : [],
}))

function gatewayStatus(): GatewayStatus {
  return {
    services: {
      web: { state: 'running', health: 'healthy' },
      agent: { state: 'running', health: 'healthy' },
      mihomo: {
        state: 'running',
        health: 'healthy',
        controllerReachable: true,
      },
    },
    versions: { web: '1.0.0', agent: '1.0.0', mihomo: '1.0.0' },
    listeners: [],
    ports: ports.map((port) => ({
      id: port.id,
      port: port.port,
      enabled: port.enabled,
      health: port.enabled ? 'healthy' : 'disabled',
      hops: port.hops.map((hop, index) => ({
        index: (index + 1) as 1 | 2,
        mode: hop.mode,
        activeNodeId: hop.nodeIds[0] ?? null,
        health: 'healthy',
      })),
    })),
    lastApply: {
      result: 'success',
      at: 100,
      reason: 'port.update',
      errorCode: null,
    },
  }
}

const PortEditorStub = {
  props: ['port'],
  emits: ['save', 'cancel'],
  template: `
    <div>
      <button
        data-testid="save-editor"
        @click="$emit('save', { enabled: true, credentialIds: ['credential-1'], hops: [{ mode: 'manual', nodeIds: ['node-1'] }] })"
      >保存</button>
      <button data-testid="cancel-editor" @click="$emit('cancel')">取消</button>
    </div>
  `,
}

describe('ports page', () => {
  const api = {
    listPorts: vi.fn(),
    listNodes: vi.fn(),
    listCredentials: vi.fn(),
    getGatewayStatus: vi.fn(),
    updatePort: vi.fn(),
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    api.listPorts.mockResolvedValue({ items: structuredClone(ports) })
    api.listNodes.mockResolvedValue({
      items: [
        {
          id: 'node-1',
          name: '东京落地',
          type: 'vless',
          enabled: true,
          sourceIds: ['manual'],
          portIds: [1],
          healthy: true,
        },
      ],
    })
    api.listCredentials.mockResolvedValue({
      items: [
        {
          id: 'credential-1',
          username: 'alice',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          portIds: [1],
        },
      ],
    })
    api.getGatewayStatus.mockResolvedValue(gatewayStatus())
    api.updatePort.mockImplementation(
      async (id: number, body: Partial<GatewayPort>) => ({
        ...ports[id - 1]!,
        ...body,
      }),
    )
    vi.stubGlobal('useGatewayApi', () => api)
    vi.stubGlobal('controlErrorMessage', (error: unknown) =>
      error instanceof Error ? error.message : '操作失败',
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function render() {
    return mount(PortsPage, {
      global: {
        stubs: {
          PortEditor: PortEditorStub,
          StatusBadge: { template: '<span>状态</span>' },
        },
      },
    })
  }

  it('shows ten fixed ports and stops five-second status polling on unmount', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.findAll('[data-testid="port-row"]')).toHaveLength(10)
    expect(wrapper.text()).toContain('10001')
    expect(wrapper.text()).toContain('10010')
    expect(api.getGatewayStatus).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()
    expect(api.getGatewayStatus).toHaveBeenCalledTimes(2)

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(api.getGatewayStatus).toHaveBeenCalledTimes(2)
  })

  it('saves one port transactionally and reports success or failure inline', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="edit-port-1"]').trigger('click')
    await wrapper.get('[data-testid="save-editor"]').trigger('click')
    await flushPromises()
    expect(api.updatePort).toHaveBeenCalledWith(1, {
      enabled: true,
      credentialIds: ['credential-1'],
      hops: [{ mode: 'manual', nodeIds: ['node-1'] }],
    })
    expect(wrapper.get('[data-testid="port-message-1"]').text()).toContain(
      '已保存并应用',
    )

    api.updatePort.mockRejectedValueOnce(new Error('配置校验失败'))
    await wrapper.get('[data-testid="edit-port-2"]').trigger('click')
    await wrapper.get('[data-testid="save-editor"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="port-message-2"]').text()).toContain(
      '配置校验失败',
    )
  })

  it('closes the inline editor when its cancel action is used', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="edit-port-1"]').trigger('click')
    expect(wrapper.find('[data-testid="cancel-editor"]').exists()).toBe(true)

    await wrapper.get('[data-testid="cancel-editor"]').trigger('click')
    expect(wrapper.find('[data-testid="cancel-editor"]').exists()).toBe(false)
  })

  it('allows only one port transaction at a time', async () => {
    let resolveUpdate!: (value: GatewayPort) => void
    api.updatePort.mockImplementationOnce(
      () =>
        new Promise<GatewayPort>((resolve) => {
          resolveUpdate = resolve
        }),
    )
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="edit-port-1"]').trigger('click')
    await wrapper.get('[data-testid="save-editor"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(
      wrapper.get('[data-testid="refresh-ports"]').attributes('disabled'),
    ).toBe('')
    expect(
      wrapper.get('[data-testid="edit-port-2"]').attributes('disabled'),
    ).toBe('')

    resolveUpdate(ports[0]!)
    await flushPromises()
    expect(
      wrapper.get('[data-testid="edit-port-2"]').attributes('disabled'),
    ).toBeUndefined()
  })
})
