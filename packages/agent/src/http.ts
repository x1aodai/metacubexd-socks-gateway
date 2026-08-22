import type { App, H3Event } from 'h3'
import type {
  GatewayCredential,
  GatewayManager,
  GatewayNode,
  GatewayNodeImpact,
  GatewayNodeTestResult,
  GatewayRevision,
  GatewayStatus,
} from './gateway'
import type { GatewayPort } from './gateway-state'
import type {
  GatewayImportPreview,
  GatewaySubscription,
  GatewaySubscriptionManager,
  GatewaySubscriptionRefreshResult,
} from './gateway-subscriptions'
import {
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  getHeader,
  getRouterParam,
  readBody,
  readMultipartFormData,
  sendNoContent,
  setResponseHeader,
} from 'h3'
import { GatewayValidationError } from './gateway'
import { SUPPORTED_PROXY_TYPES } from './subscription/types'

export interface ControlRouterDeps {
  gateway: GatewayManager
  gatewaySubscriptions: GatewaySubscriptionManager
}

const PREFIX = '/api/control'

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalidGatewayBody(): never {
  throw new GatewayValidationError('invalid request body')
}

async function readGatewayBody(
  event: H3Event,
  allowedKeys: readonly string[],
  allowEmpty = false,
): Promise<JsonObject> {
  let value: unknown
  try {
    value = await readBody(event)
  } catch {
    return invalidGatewayBody()
  }
  if (allowEmpty && value === undefined) return {}
  if (!isJsonObject(value)) return invalidGatewayBody()
  const allowed = new Set(allowedKeys)
  if (Object.keys(value).some((key) => !allowed.has(key)))
    return invalidGatewayBody()
  return value
}

function optionalBoolean(body: JsonObject, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') return invalidGatewayBody()
  return value
}

function requiredBoolean(body: JsonObject, key: string): boolean {
  const value = optionalBoolean(body, key)
  if (value === undefined) return invalidGatewayBody()
  return value
}

function optionalString(body: JsonObject, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') return invalidGatewayBody()
  return value
}

function requiredString(body: JsonObject, key: string): string {
  const value = optionalString(body, key)
  if (value === undefined) return invalidGatewayBody()
  return value
}

function optionalNumber(body: JsonObject, key: string): number | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value))
    return invalidGatewayBody()
  return value
}

function optionalStringArray(
  body: JsonObject,
  key: string,
): string[] | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    return invalidGatewayBody()
  return [...value]
}

function optionalPortIds(body: JsonObject): number[] | undefined {
  const value = body.portIds
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        !Number.isInteger(item) || Number(item) < 1 || Number(item) > 10,
    )
  )
    return invalidGatewayBody()
  return [...value] as number[]
}

function optionalHops(body: JsonObject):
  | Array<{
      mode: 'manual' | 'auto' | 'failover'
      nodeIds: string[]
    }>
  | undefined {
  const value = body.hops
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return invalidGatewayBody()
  return value.map((hop) => {
    if (!isJsonObject(hop)) return invalidGatewayBody()
    if (Object.keys(hop).some((key) => key !== 'mode' && key !== 'nodeIds'))
      return invalidGatewayBody()
    if (hop.mode !== 'manual' && hop.mode !== 'auto' && hop.mode !== 'failover')
      return invalidGatewayBody()
    if (
      !Array.isArray(hop.nodeIds) ||
      hop.nodeIds.some((id) => typeof id !== 'string')
    )
      return invalidGatewayBody()
    return { mode: hop.mode, nodeIds: [...hop.nodeIds] }
  })
}

function gatewayPortId(event: H3Event): number {
  const raw = getRouterParam(event, 'id') ?? ''
  if (!/^(?:[1-9]|10)$/.test(raw)) return invalidGatewayBody()
  return Number(raw)
}

function publicGatewayPort(port: GatewayPort): GatewayPort {
  return {
    id: port.id,
    port: port.port,
    enabled: port.enabled,
    credentialIds: [...port.credentialIds],
    hops: port.hops.map((hop) => ({
      mode: hop.mode,
      nodeIds: [...hop.nodeIds],
    })),
  }
}

function publicGatewayNode(node: GatewayNode): GatewayNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    enabled: node.enabled,
    sourceIds: [...node.sourceIds],
    portIds: [...node.portIds],
    ...(node.healthy === undefined ? {} : { healthy: node.healthy }),
    ...(node.latency === undefined ? {} : { latency: node.latency }),
  }
}

function publicGatewayNodeTest(
  result: GatewayNodeTestResult,
): GatewayNodeTestResult {
  return {
    reachable: result.reachable,
    ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  }
}

function publicGatewayNodeImpact(impact: GatewayNodeImpact): GatewayNodeImpact {
  return { affectedPortIds: [...impact.affectedPortIds] }
}

function publicGatewayCredential(
  credential: GatewayCredential,
): GatewayCredential {
  return {
    id: credential.id,
    username: credential.username,
    enabled: credential.enabled,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    portIds: [...credential.portIds],
  }
}

function publicCreatedCredential(
  credential: GatewayCredential & { password: string },
): GatewayCredential & { password: string } {
  return {
    ...publicGatewayCredential(credential),
    password: credential.password,
  }
}

function publicGatewayRevision(revision: GatewayRevision): GatewayRevision {
  return {
    id: revision.id,
    createdAt: revision.createdAt,
    reason: revision.reason,
  }
}

function publicGatewayStatus(status: GatewayStatus): GatewayStatus {
  return {
    services: {
      agent: {
        state: status.services.agent.state,
        health: status.services.agent.health,
      },
      mihomo: {
        state: status.services.mihomo.state,
        health: status.services.mihomo.health,
        controllerReachable: status.services.mihomo.controllerReachable,
      },
    },
    versions: {
      agent: status.versions.agent,
      mihomo: status.versions.mihomo,
    },
    listeners: status.listeners.map((listener) => ({
      id: listener.id,
      port: listener.port,
      enabled: listener.enabled,
      health: listener.health,
      reachable: listener.reachable,
      errorCode: listener.errorCode,
    })),
    ports: status.ports.map((port) => ({
      id: port.id,
      port: port.port,
      enabled: port.enabled,
      health: port.health,
      hops: port.hops.map((hop) => ({
        index: hop.index,
        mode: hop.mode,
        activeNodeId: hop.activeNodeId,
        health: hop.health,
      })),
    })),
    lastApply:
      status.lastApply === null
        ? null
        : {
            result: status.lastApply.result,
            at: status.lastApply.at,
            reason: status.lastApply.reason,
            errorCode: status.lastApply.errorCode,
          },
  }
}

const PUBLIC_SUBSCRIPTION_ERRORS = new Set([
  'subscription node count dropped; last-good retained',
  'subscription returned no valid nodes',
  'subscription refresh failed',
])

function publicSubscriptionError(error: string): string {
  return PUBLIC_SUBSCRIPTION_ERRORS.has(error)
    ? error
    : 'subscription refresh failed'
}

function publicGatewaySubscription(
  subscription: GatewaySubscription,
): GatewaySubscription {
  return {
    id: subscription.id,
    name: subscription.name,
    urlMasked: subscription.urlMasked,
    intervalMinutes: subscription.intervalMinutes,
    enabled: subscription.enabled,
    nodeCount: subscription.nodeCount,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    ...(subscription.lastSyncAt === undefined
      ? {}
      : { lastSyncAt: subscription.lastSyncAt }),
    ...(subscription.lastError === undefined
      ? {}
      : { lastError: publicSubscriptionError(subscription.lastError) }),
  }
}

function publicSubscriptionRefresh(
  result: GatewaySubscriptionRefreshResult,
): GatewaySubscriptionRefreshResult {
  return {
    items: result.items.map((item) => ({
      id: item.id,
      ok: item.ok,
      nodeCount: item.nodeCount,
      ...(item.error === undefined
        ? {}
        : { error: publicSubscriptionError(item.error) }),
    })),
  }
}

const PUBLIC_IMPORT_ISSUE_MESSAGES: Readonly<Record<string, string>> = {
  'invalid-document': 'invalid import document',
  'invalid-node': 'invalid node',
  'unsupported-protocol': 'unsupported proxy protocol',
  'duplicate-node': 'duplicate node',
}

function publicImportPreview(
  preview: GatewayImportPreview,
): GatewayImportPreview {
  const issues = preview.issues.map((issue) => {
    const message = PUBLIC_IMPORT_ISSUE_MESSAGES[issue.code] ?? 'import issue'
    return {
      code:
        PUBLIC_IMPORT_ISSUE_MESSAGES[issue.code] === undefined
          ? 'unknown'
          : issue.code,
      message,
      ...(issue.index === undefined ? {} : { index: issue.index }),
    }
  })
  return {
    previewId: preview.previewId,
    format: preview.format,
    validCount: preview.validCount,
    skippedCount: preview.skippedCount,
    protocolCounts: Object.fromEntries(
      SUPPORTED_PROXY_TYPES.flatMap((protocol) => {
        const count = preview.protocolCounts[protocol]
        return count === undefined ? [] : [[protocol, count]]
      }),
    ),
    errors: issues.map((issue) => issue.message),
    issues,
    nodes: preview.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
    })),
  }
}

const PUBLIC_GATEWAY_ERROR_MESSAGES = new Set([
  'gateway bootstrap is required before mutations',
  'gateway port is fixed at 10001',
  'UDP is not supported by the gateway',
  'node enabled must be boolean',
  'node not found',
  'node deletion requires confirmation',
  'gateway port id must be within 1-10',
  'gateway port id and fixed port number are not editable',
  'gateway port enabled must be boolean',
  'credential username already exists',
  'credential not found',
  'invalid outbound mode',
  'nodeId is required for manual mode',
  'revision not found',
  'node sources must be an array',
  'invalid node source id',
  'node list must be an array',
  'invalid normalized node',
  'node source update would remove the final candidate from a hop',
  'credential portIds must be an array',
  'username must be 1-64 safe ASCII characters',
  'SOCKS password must contain 12 to 128 characters',
])

function safeGatewayErrorMessage(message: string): string {
  return PUBLIC_GATEWAY_ERROR_MESSAGES.has(message)
    ? message
    : 'gateway validation failed'
}

export function createControlRouter(deps: ControlRouterDeps): App {
  const app = createApp()
  const router = createRouter()
  const { gateway, gatewaySubscriptions } = deps

  async function withGatewayError<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (error instanceof GatewayValidationError) {
        const message = safeGatewayErrorMessage(error.message)
        const affectedPortIds =
          error.statusCode === 409 &&
          Array.isArray(error.details?.affectedPortIds)
            ? [
                ...new Set(
                  error.details.affectedPortIds.filter(
                    (id) => Number.isInteger(id) && id >= 1 && id <= 10,
                  ),
                ),
              ]
            : undefined
        throw createError({
          statusCode: error.statusCode,
          statusMessage: message,
          data: {
            error: message,
            ...(affectedPortIds ? { affectedPortIds } : {}),
          },
        })
      }
      throw createError({
        statusCode: 500,
        statusMessage: 'gateway operation failed',
        data: { error: 'gateway operation failed' },
      })
    }
  }

  // Deployment healthcheck; every product operation stays under /gateway.
  router.get(
    `${PREFIX}/health`,
    defineEventHandler(() => ({ ok: true })),
  )

  // ---- Managed fixed SOCKS gateway ----
  router.get(
    `${PREFIX}/gateway/ports`,
    defineEventHandler(() =>
      withGatewayError(async () => ({
        items: (await gateway.listPorts()).map(publicGatewayPort),
      })),
    ),
  )
  router.put(
    `${PREFIX}/gateway/ports/:id`,
    defineEventHandler((event) =>
      withGatewayError(async () => {
        const body = await readGatewayBody(event, [
          'enabled',
          'credentialIds',
          'hops',
        ])
        const enabled = optionalBoolean(body, 'enabled')
        const credentialIds = optionalStringArray(body, 'credentialIds')
        const hops = optionalHops(body)
        const input = {
          ...(enabled === undefined ? {} : { enabled }),
          ...(credentialIds === undefined ? {} : { credentialIds }),
          ...(hops === undefined ? {} : { hops }),
        }
        return publicGatewayPort(
          await gateway.updatePort(gatewayPortId(event), input),
        )
      }),
    ),
  )
  router.get(
    `${PREFIX}/gateway/nodes`,
    defineEventHandler(() =>
      withGatewayError(async () => ({
        items: (await gateway.listNodes()).map(publicGatewayNode),
      })),
    ),
  )
  router.put(
    `${PREFIX}/gateway/nodes/:id`,
    defineEventHandler((event) =>
      withGatewayError(async () => {
        const body = await readGatewayBody(event, ['enabled'])
        return publicGatewayNode(
          await gateway.updateNode(getRouterParam(event, 'id')!, {
            enabled: requiredBoolean(body, 'enabled'),
          }),
        )
      }),
    ),
  )
  router.post(
    `${PREFIX}/gateway/nodes/:id/test`,
    defineEventHandler((event) =>
      withGatewayError(async () =>
        publicGatewayNodeTest(
          await gateway.testNode(getRouterParam(event, 'id')!),
        ),
      ),
    ),
  )
  router.get(
    `${PREFIX}/gateway/nodes/:id/impact`,
    defineEventHandler((event) =>
      withGatewayError(async () =>
        publicGatewayNodeImpact(
          await gateway.nodeImpact(getRouterParam(event, 'id')!),
        ),
      ),
    ),
  )
  router.delete(
    `${PREFIX}/gateway/nodes/:id`,
    defineEventHandler((event) =>
      withGatewayError(async () => {
        const body = await readGatewayBody(event, ['confirmed'])
        await gateway.deleteNode(
          getRouterParam(event, 'id')!,
          requiredBoolean(body, 'confirmed'),
        )
        return sendNoContent(event)
      }),
    ),
  )
  router.get(
    `${PREFIX}/gateway/status`,
    defineEventHandler(() =>
      withGatewayError(async () => publicGatewayStatus(await gateway.status())),
    ),
  )
  router.post(
    `${PREFIX}/gateway/reapply`,
    defineEventHandler(() =>
      withGatewayError(async () => {
        await gateway.reapply()
        return { ok: true }
      }),
    ),
  )
  router.get(
    `${PREFIX}/gateway/credentials`,
    defineEventHandler(() =>
      withGatewayError(async () => ({
        items: (await gateway.listCredentials()).map(publicGatewayCredential),
      })),
    ),
  )
  router.post(
    `${PREFIX}/gateway/credentials`,
    defineEventHandler((event) =>
      withGatewayError(async () => {
        const body = await readGatewayBody(event, [
          'username',
          'password',
          'enabled',
          'portIds',
        ])
        const password = optionalString(body, 'password')
        const enabled = optionalBoolean(body, 'enabled')
        const portIds = optionalPortIds(body)
        setResponseHeader(event, 'cache-control', 'no-store')
        return publicCreatedCredential(
          await gateway.createCredential({
            username: requiredString(body, 'username'),
            ...(password === undefined ? {} : { password }),
            ...(enabled === undefined ? {} : { enabled }),
            ...(portIds === undefined ? {} : { portIds }),
          }),
        )
      }),
    ),
  )
  router.put(
    `${PREFIX}/gateway/credentials/:id`,
    defineEventHandler((event) =>
      withGatewayError(async () => {
        const body = await readGatewayBody(event, [
          'username',
          'enabled',
          'portIds',
        ])
        const username = optionalString(body, 'username')
        const enabled = optionalBoolean(body, 'enabled')
        const portIds = optionalPortIds(body)
        return publicGatewayCredential(
          await gateway.updateCredential(getRouterParam(event, 'id')!, {
            ...(username === undefined ? {} : { username }),
            ...(enabled === undefined ? {} : { enabled }),
            ...(portIds === undefined ? {} : { portIds }),
          }),
        )
      }),
    ),
  )
  router.delete(
    `${PREFIX}/gateway/credentials/:id`,
    defineEventHandler((event) =>
      withGatewayError(async () => {
        await gateway.deleteCredential(getRouterParam(event, 'id')!)
        return sendNoContent(event)
      }),
    ),
  )
  router.post(
    `${PREFIX}/gateway/credentials/:id/rotate`,
    defineEventHandler((event) =>
      withGatewayError(async () => {
        const body = await readGatewayBody(event, ['password'], true)
        setResponseHeader(event, 'cache-control', 'no-store')
        const rotated = await gateway.rotateCredential(
          getRouterParam(event, 'id')!,
          optionalString(body, 'password'),
        )
        return { id: rotated.id, password: rotated.password }
      }),
    ),
  )
  router.get(
    `${PREFIX}/gateway/revisions`,
    defineEventHandler(() =>
      withGatewayError(async () => ({
        items: (await gateway.listRevisions()).map(publicGatewayRevision),
      })),
    ),
  )
  async function subscriptionAction<T>(
    action: () => Promise<T> | T,
  ): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (error instanceof GatewayValidationError)
        return withGatewayError(() => Promise.reject(error))
      throw createError({
        statusCode: 502,
        statusMessage: 'subscription operation failed',
        data: { error: 'subscription operation failed' },
      })
    }
  }

  router.post(
    `${PREFIX}/gateway/imports/preview`,
    defineEventHandler((event) =>
      subscriptionAction(async () => {
        const type = getHeader(event, 'content-type') ?? ''
        let content: string
        if (type.toLowerCase().includes('multipart/form-data')) {
          let parts: Awaited<ReturnType<typeof readMultipartFormData>>
          try {
            parts = await readMultipartFormData(event)
          } catch {
            throw new GatewayValidationError('invalid request body')
          }
          const file = parts?.find((part) => part.name === 'file')
          if (!file?.data) throw new GatewayValidationError('file is required')
          content = file.data.toString('utf8')
        } else {
          const body = await readGatewayBody(event, ['content'])
          content = requiredString(body, 'content')
        }
        return publicImportPreview(gatewaySubscriptions.previewImport(content))
      }),
    ),
  )
  router.post(
    `${PREFIX}/gateway/imports/apply`,
    defineEventHandler((event) =>
      subscriptionAction(async () => {
        const body = await readGatewayBody(event, ['previewId', 'content'])
        if ((body.previewId === undefined) === (body.content === undefined))
          return invalidGatewayBody()
        const previewId = optionalString(body, 'previewId')
        const content = optionalString(body, 'content')
        const applied = await gatewaySubscriptions.applyImport({
          ...(previewId === undefined ? {} : { previewId }),
          ...(content === undefined ? {} : { content }),
        })
        return { imported: applied.imported }
      }),
    ),
  )
  router.get(
    `${PREFIX}/gateway/subscriptions`,
    defineEventHandler(() =>
      subscriptionAction(async () => ({
        items: (await gatewaySubscriptions.list()).map(
          publicGatewaySubscription,
        ),
      })),
    ),
  )
  router.post(
    `${PREFIX}/gateway/subscriptions`,
    defineEventHandler((event) =>
      subscriptionAction(async () => {
        const body = await readGatewayBody(event, [
          'name',
          'url',
          'intervalMinutes',
          'enabled',
        ])
        const intervalMinutes = optionalNumber(body, 'intervalMinutes')
        const enabled = optionalBoolean(body, 'enabled')
        return publicGatewaySubscription(
          await gatewaySubscriptions.create({
            name: requiredString(body, 'name'),
            url: requiredString(body, 'url'),
            ...(intervalMinutes === undefined ? {} : { intervalMinutes }),
            ...(enabled === undefined ? {} : { enabled }),
          }),
        )
      }),
    ),
  )
  router.put(
    `${PREFIX}/gateway/subscriptions/:id`,
    defineEventHandler((event) =>
      subscriptionAction(async () => {
        const body = await readGatewayBody(event, [
          'name',
          'url',
          'intervalMinutes',
          'enabled',
        ])
        const name = optionalString(body, 'name')
        const url = optionalString(body, 'url')
        const intervalMinutes = optionalNumber(body, 'intervalMinutes')
        const enabled = optionalBoolean(body, 'enabled')
        return publicGatewaySubscription(
          await gatewaySubscriptions.update(getRouterParam(event, 'id')!, {
            ...(name === undefined ? {} : { name }),
            ...(url === undefined ? {} : { url }),
            ...(intervalMinutes === undefined ? {} : { intervalMinutes }),
            ...(enabled === undefined ? {} : { enabled }),
          }),
        )
      }),
    ),
  )
  router.delete(
    `${PREFIX}/gateway/subscriptions/:id`,
    defineEventHandler((event) =>
      subscriptionAction(async () => {
        await gatewaySubscriptions.delete(getRouterParam(event, 'id')!)
        return sendNoContent(event)
      }),
    ),
  )
  router.post(
    `${PREFIX}/gateway/subscriptions/:id/sync`,
    defineEventHandler((event) =>
      subscriptionAction(async () =>
        publicGatewaySubscription(
          await gatewaySubscriptions.sync(getRouterParam(event, 'id')!),
        ),
      ),
    ),
  )
  router.post(
    `${PREFIX}/gateway/subscriptions/refresh`,
    defineEventHandler(() =>
      subscriptionAction(async () =>
        publicSubscriptionRefresh(
          await gatewaySubscriptions.refreshSubscriptions(),
        ),
      ),
    ),
  )
  app.use(router)
  return app
}
