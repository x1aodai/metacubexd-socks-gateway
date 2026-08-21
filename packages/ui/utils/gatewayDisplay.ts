import { controlErrorMessage } from './controlError'

const gatewayMessages: Readonly<Record<string, string>> = {
  'gateway bootstrap is required before mutations':
    '网关尚未初始化，暂时不能修改配置。',
  'gateway port is fixed at 10001': 'SOCKS 端口号固定，不能修改。',
  'UDP is not supported by the gateway': '网关仅支持 TCP，不支持 UDP。',
  'node enabled must be boolean': '节点启用状态无效。',
  'node not found': '节点不存在。',
  'node deletion requires confirmation': '删除节点前需要确认受影响端口。',
  'gateway port id must be within 1-10': '端口槽位必须在 1–10 之间。',
  'gateway port id and fixed port number are not editable':
    '固定端口号不能修改。',
  'gateway port enabled must be boolean': '端口启用状态无效。',
  'credential username already exists': '账号名称已存在。',
  'credential not found': '账号不存在。',
  'invalid outbound mode': '节点选择模式无效。',
  'nodeId is required for manual mode': '固定节点模式必须选择一个节点。',
  'revision not found': '保存版本不存在。',
  'node sources must be an array': '节点来源格式无效。',
  'invalid node source id': '节点来源标识无效。',
  'node list must be an array': '节点列表格式无效。',
  'invalid normalized node': '节点内容无效。',
  'node source update would remove the final candidate from a hop':
    '更新会移除某一跳的最后一个候选节点。',
  'credential portIds must be an array': '账号绑定端口格式无效。',
  'username must be 1-64 safe ASCII characters':
    '账号名称必须是 1–64 位安全字符。',
  'SOCKS password must contain 12 to 128 characters':
    'SOCKS 密码长度必须为 12–128 个字符。',
  'password must contain 12 to 256 characters':
    '管理员密码长度必须为 12–256 个字符。',
  'current password is incorrect': '当前管理员密码不正确。',
  配置校验失败: '配置校验失败',
  'gateway validation failed': '配置校验失败，请检查账号、节点和链路。',
  'gateway operation failed': '网关操作失败，请稍后重试。',
  'Gateway status unavailable': '暂时无法读取网关状态。',
  'subscription operation failed': '订阅操作失败，请稍后重试。',
  'subscription not found': '订阅不存在。',
  'subscription name must contain 1 to 100 characters':
    '订阅名称必须为 1–100 个字符。',
  'subscription interval must be 15 to 43200 minutes':
    '订阅刷新间隔必须为 15–43200 分钟。',
  'subscription URL must use HTTP or HTTPS': '订阅地址必须使用 HTTP 或 HTTPS。',
  'subscription node count dropped; last-good retained':
    '订阅节点数异常下降，已保留上次可用结果。',
  'subscription returned no valid nodes': '订阅没有返回有效节点。',
  'subscription refresh failed': '订阅刷新失败。',
  'invalid import document': '导入内容格式无效。',
  'invalid node': '导入内容包含无效节点。',
  'unsupported proxy protocol': '导入内容包含不支持的协议。',
  'duplicate node': '导入内容包含重复节点。',
  'import issue': '导入内容存在问题。',
}

const gatewayReasons: Readonly<Record<string, string>> = {
  'gateway.bootstrap': '初始化网关',
  'gateway.reapply': '重新应用当前配置',
  'gateway.update': '网关配置更新',
  'outbound.update': '节点链路更新',
  'revision.rollback': '恢复保存版本',
  'port.update': '端口配置更新',
  'node.update': '节点状态更新',
  'node.delete': '删除节点',
  'credential.create': '创建账号',
  'credential.update': '账号配置更新',
  'credential.delete': '删除账号',
  'credential.rotate': '轮换账号密码',
  'subscription.enable': '启用订阅',
  'subscription.disable': '停用订阅',
  'subscription.delete': '删除订阅',
  'subscription.sync': '同步订阅',
  'subscriptions.refresh': '刷新全部订阅',
  'import.apply': '导入节点',
}

const gatewayCodes: Readonly<Record<string, string>> = {
  NODE_NOT_FOUND: '节点不存在',
  NODE_NOT_ACTIVE: '节点已停用',
  CONTROLLER_UNAVAILABLE: 'Mihomo 控制器不可用',
  PROBE_FAILED: '连通性探测失败',
  NO_ENABLED_CREDENTIAL: '没有可用账号',
  UNREACHABLE: '端口不可连接',
  VALIDATION_FAILED: '配置校验失败',
  RUNTIME_FAILED: '运行时应用失败',
  VERIFICATION_FAILED: '应用后验证失败',
  PERSIST_FAILED: '保存配置失败',
  APPLY_FAILED: '应用配置失败',
}

export function gatewayErrorMessage(error: unknown): string {
  const message = controlErrorMessage(error).trim()
  const translated = gatewayMessages[message]
  if (translated) return translated
  if (/timed?\s*out/i.test(message)) return '请求超时，请稍后重试。'
  if (/network|fetch|connection|econn/i.test(message))
    return '网络连接失败，请检查服务状态后重试。'
  return '操作失败，请稍后重试。'
}

export function gatewayReasonLabel(reason: string): string {
  return gatewayReasons[reason] ?? '配置变更'
}

export function gatewayCodeLabel(code: string): string {
  return gatewayCodes[code] ?? '操作失败'
}
