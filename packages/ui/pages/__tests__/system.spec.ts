import type { GatewayStatus } from '~/types/gateway'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SystemPage from '../system.vue'

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
    versions: { web: '1.2.3', agent: '2.3.4', mihomo: '3.4.5' },
    listeners: Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      port: 10_001 + index,
      enabled: index === 0,
      health: index === 0 ? 'healthy' : 'disabled',
      reachable: index === 0,
      errorCode: null,
    })),
    ports: [],
    lastApply: {
      result: 'success',
      at: 1_700_000_000_000,
      reason: 'port.update',
      errorCode: null,
    },
  }
}

describe('system page', () => {
  const api = {
    getGatewayStatus: vi.fn(),
    listRevisions: vi.fn(),
    reapplyGateway: vi.fn(),
    refreshSubscriptions: vi.fn(),
    changePassword: vi.fn(),
  }
  const auth = { logout: vi.fn() }
  const navigateTo = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    api.getGatewayStatus.mockResolvedValue(gatewayStatus())
    api.listRevisions.mockResolvedValue({
      items: [
        {
          id: 'revision-1',
          createdAt: 1_700_000_000_000,
          reason: 'port.update',
        },
      ],
    })
    api.reapplyGateway.mockResolvedValue({ ok: true })
    api.refreshSubscriptions.mockResolvedValue({ items: [] })
    api.changePassword.mockResolvedValue({ ok: true })
    auth.logout.mockResolvedValue(undefined)
    navigateTo.mockResolvedValue(undefined)
    vi.stubGlobal('useGatewayApi', () => api)
    vi.stubGlobal('useGatewayAuth', () => auth)
    vi.stubGlobal('navigateTo', navigateTo)
    vi.stubGlobal('controlErrorMessage', (error: unknown) =>
      error instanceof Error ? error.message : '操作失败',
    )
  })

  it('shows only core service, version, listener, and recent apply information', async () => {
    const wrapper = mount(SystemPage)
    await flushPromises()

    expect(wrapper.text()).toContain('Web')
    expect(wrapper.text()).toContain('Agent')
    expect(wrapper.text()).toContain('Mihomo')
    expect(wrapper.text()).toContain('1.2.3')
    expect(wrapper.text()).toContain('2.3.4')
    expect(wrapper.text()).toContain('3.4.5')
    expect(wrapper.findAll('[data-testid="listener-row"]')).toHaveLength(10)
    expect(wrapper.text()).toContain('10001')
    expect(wrapper.text()).toContain('10010')
    expect(wrapper.text()).toContain('端口配置更新')
    expect(wrapper.text()).not.toContain('port.update')
    expect(wrapper.text()).not.toMatch(/日志|规则|代理组|YAML|审计中心/)
  })

  it('reapplies saved state and refreshes all subscriptions with inline results', async () => {
    api.refreshSubscriptions.mockResolvedValueOnce({
      items: [
        { id: 'sub-a', ok: true, nodeCount: 3 },
        {
          id: 'sub-b',
          ok: false,
          nodeCount: 0,
          error: 'subscription refresh failed',
        },
      ],
    })
    const wrapper = mount(SystemPage)
    await flushPromises()

    await wrapper.get('[data-testid="reapply-gateway"]').trigger('click')
    await flushPromises()
    expect(api.reapplyGateway).toHaveBeenCalledOnce()
    expect(api.getGatewayStatus).toHaveBeenCalledTimes(2)
    expect(api.listRevisions).toHaveBeenCalledTimes(2)
    expect(
      wrapper.get('[data-testid="system-action-message"]').text(),
    ).toContain('当前配置已重新应用')

    await wrapper.get('[data-testid="refresh-subscriptions"]').trigger('click')
    await flushPromises()
    expect(api.refreshSubscriptions).toHaveBeenCalledOnce()
    expect(
      wrapper.get('[data-testid="subscription-refresh-result"]').text(),
    ).toContain('1 项成功，1 项失败')
    expect(
      wrapper.get('[data-testid="subscription-refresh-result"]').text(),
    ).toContain('订阅刷新失败')
  })

  it('does not misreport a completed reapply when only the view refresh fails', async () => {
    api.getGatewayStatus
      .mockResolvedValueOnce(gatewayStatus())
      .mockRejectedValueOnce(new Error('refresh failed'))
    const wrapper = mount(SystemPage)
    await flushPromises()

    await wrapper.get('[data-testid="reapply-gateway"]').trigger('click')
    await flushPromises()

    expect(api.reapplyGateway).toHaveBeenCalledOnce()
    expect(
      wrapper.get('[data-testid="system-action-message"]').text(),
    ).toContain('配置已重新应用，但状态刷新失败')
  })

  it('validates and changes the administrator password, then returns to login', async () => {
    const wrapper = mount(SystemPage)
    await flushPromises()

    await wrapper
      .get('[data-testid="current-password"]')
      .setValue('old-password-123')
    await wrapper
      .get('[data-testid="new-password"]')
      .setValue('new-password-123')
    await wrapper
      .get('[data-testid="confirm-password"]')
      .setValue('different-password')
    await wrapper.get('[data-testid="password-form"]').trigger('submit')
    expect(api.changePassword).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="password-message"]').text()).toContain(
      '两次输入的新密码不一致',
    )

    await wrapper
      .get('[data-testid="confirm-password"]')
      .setValue('new-password-123')
    await wrapper.get('[data-testid="password-form"]').trigger('submit')
    await flushPromises()

    expect(api.changePassword).toHaveBeenCalledWith(
      'old-password-123',
      'new-password-123',
    )
    expect(auth.logout).toHaveBeenCalledOnce()
    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true })
  })

  it('does not invite a second password change when logout navigation fails', async () => {
    navigateTo.mockRejectedValueOnce(new Error('navigation failed'))
    const wrapper = mount(SystemPage)
    await flushPromises()

    await wrapper
      .get('[data-testid="current-password"]')
      .setValue('old-password-123')
    await wrapper
      .get('[data-testid="new-password"]')
      .setValue('new-password-123')
    await wrapper
      .get('[data-testid="confirm-password"]')
      .setValue('new-password-123')
    await wrapper.get('[data-testid="password-form"]').trigger('submit')
    await flushPromises()

    expect(api.changePassword).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-testid="password-message"]').text()).toContain(
      '管理员密码已修改',
    )
    expect(wrapper.get('[data-testid="password-message"]').text()).toContain(
      '请手动返回登录页',
    )
  })
})
