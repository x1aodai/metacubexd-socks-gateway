import { describe, expect, it } from 'vitest'
import {
  gatewayCodeLabel,
  gatewayErrorMessage,
  gatewayReasonLabel,
} from '../gatewayDisplay'

describe('gateway display text', () => {
  it('translates known gateway errors and never exposes raw English diagnostics', () => {
    expect(gatewayErrorMessage(new Error('node not found'))).toBe(
      '节点不存在。',
    )
    expect(gatewayErrorMessage(new Error('gateway validation failed'))).toBe(
      '配置校验失败，请检查账号、节点和链路。',
    )
    expect(
      gatewayErrorMessage(new Error('sensitive internal diagnostic')),
    ).toBe('操作失败，请稍后重试。')
    expect(gatewayErrorMessage(new Error('配置校验失败'))).toBe('配置校验失败')
    expect(gatewayErrorMessage(new Error('内部数据库路径已损坏'))).toBe(
      '操作失败，请稍后重试。',
    )
    expect(gatewayErrorMessage(new Error('Gateway unavailable'))).toBe(
      '操作失败，请稍后重试。',
    )
  })

  it('turns internal apply reasons into concise Chinese labels', () => {
    expect(gatewayReasonLabel('port.update')).toBe('端口配置更新')
    expect(gatewayReasonLabel('gateway.reapply')).toBe('重新应用当前配置')
    expect(gatewayReasonLabel('subscription.enable')).toBe('启用订阅')
    expect(gatewayReasonLabel('subscriptions.refresh')).toBe('刷新全部订阅')
    expect(gatewayReasonLabel('unrecognized.reason')).toBe('配置变更')
    expect(gatewayCodeLabel('PROBE_FAILED')).toBe('连通性探测失败')
    expect(gatewayCodeLabel('PRIVATE_CODE')).toBe('操作失败')
  })
})
