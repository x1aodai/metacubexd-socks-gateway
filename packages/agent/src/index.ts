import type { GatewayManagerOptions } from './gateway'
import type { CreateSupervisorOptions } from './supervisor'
import { createGatewayManager } from './gateway'
import { createGatewaySubscriptionManager } from './gateway-subscriptions'
import { createControlRouter } from './http'
import { createSupervisor } from './supervisor'

const CONTROLLER_URL = '127.0.0.1:9090'

export const AGENT_VERSION = '0.0.0'

export { AdminAuthError, createAdminAuth } from './admin-auth'
export type { AdminAuth, AdminAuthOptions, AdminSession } from './admin-auth'
export { createGatewayManager, GatewayValidationError } from './gateway'
export type {
  GatewayApplyErrorCode,
  GatewayConfig,
  GatewayCredential,
  GatewayHealth,
  GatewayHopStatus,
  GatewayLastApply,
  GatewayListenerErrorCode,
  GatewayListenerStatus,
  GatewayManager,
  GatewayManagerOptions,
  GatewayNode,
  GatewayNodeImpact,
  GatewayNodeTestErrorCode,
  GatewayNodeTestResult,
  GatewayPortStatus,
  GatewayRevision,
  GatewayStatus,
} from './gateway'
export {
  createInitialGatewayStateV2,
  GATEWAY_PORTS,
  migrateV1ToV2,
  validateGatewayStateV2,
} from './gateway-state'
export type {
  GatewayHop,
  GatewayMode,
  GatewayPort,
  GatewayStateV1,
  GatewayStateV2,
  StoredGatewayCredential,
  StoredGatewayRevision,
  StoredNode,
  StoredNodeSource,
} from './gateway-state'
export { createGatewaySubscriptionManager } from './gateway-subscriptions'
export type {
  GatewayImportPreview,
  GatewaySubscription,
  GatewaySubscriptionManager,
  GatewaySubscriptionManagerOptions,
  GatewaySubscriptionRefreshItem,
  GatewaySubscriptionRefreshResult,
} from './gateway-subscriptions'
export { createControlRouter } from './http'
export type { ControlRouterDeps } from './http'
export { MIHOMO_VERSION, mihomoAsset } from './kernel/assets'
export { createSupervisor } from './supervisor'
export type { CreateSupervisorOptions, SupervisorDeps } from './supervisor'
export * from './types'

export type CreateAgentOptions = Omit<
  CreateSupervisorOptions,
  'configTransform' | 'externalController' | 'mixedPort'
> & {
  gateway: Omit<
    GatewayManagerOptions,
    'activeConfigPath' | 'agentVersion' | 'controllerSecret' | 'controllerUrl'
  >
}

export function createAgent(opts: CreateAgentOptions) {
  if (!opts.gateway) throw new Error('gateway options are required')

  const { gateway: gatewayOptions, ...supervisorOptions } = opts
  const gateway = createGatewayManager({
    ...gatewayOptions,
    activeConfigPath: opts.activeConfigPath,
    controllerUrl: CONTROLLER_URL,
    controllerSecret: opts.secret,
    agentVersion: AGENT_VERSION,
  })
  const supervisor = createSupervisor({
    ...supervisorOptions,
    externalController: CONTROLLER_URL,
    configTransform: gateway.overlayConfig,
  })
  gateway.bindSupervisor(supervisor)
  const gatewaySubscriptions = createGatewaySubscriptionManager({
    dataDir: gatewayOptions.dataDir,
    masterKey: gatewayOptions.masterKey,
    gateway,
  })
  const router = createControlRouter({ gateway, gatewaySubscriptions })

  return { supervisor, router, gateway, gatewaySubscriptions }
}
