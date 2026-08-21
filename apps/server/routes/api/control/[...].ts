import {
  createError,
  defineEventHandler,
  fromNodeMiddleware,
  toNodeListener,
} from 'h3'
import { getAgent } from '../../../lib/supervisor'
import serverPackage from '../../../package.json'

// The agent router is an h3 app whose internal routes are absolute,
// i.e. it answers '/api/control/...'. Because this file lives at
// routes/api/control/[...].ts it only receives requests already under
// '/api/control', and we forward the ORIGINAL url (event.node.req.url still
// carries the full '/api/control/...' path) to the agent listener.
const agent = getAgent()
const listener = toNodeListener(agent.router)

const forward = fromNodeMiddleware((req, res, _next) => {
  // toNodeListener fully handles the response (including 404s) and catches
  // errors itself, returning void — the agent owns the entire /api/control
  // namespace, so there is nothing to forward to `next`. (_next is kept only
  // so h3 selects the typed NodeMiddleware overload for req/res.)
  listener(req, res)
})

export default defineEventHandler(async (event) => {
  const path = event.path.split('?')[0] ?? event.path
  if (path === '/api/control/gateway/status' && event.method === 'GET') {
    if (!agent.gateway)
      throw createError({
        statusCode: 503,
        statusMessage: 'Gateway unavailable',
      })
    const status = await agent.gateway.status().catch(() => {
      throw createError({
        statusCode: 500,
        statusMessage: 'Gateway status unavailable',
      })
    })
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
        web: { state: 'running', health: 'healthy' },
      },
      versions: {
        agent: status.versions.agent,
        mihomo: status.versions.mihomo,
        web: serverPackage.version,
      },
      listeners: status.listeners.map((listenerStatus) => ({
        id: listenerStatus.id,
        port: listenerStatus.port,
        enabled: listenerStatus.enabled,
        health: listenerStatus.health,
        reachable: listenerStatus.reachable,
        errorCode: listenerStatus.errorCode,
      })),
      ports: status.ports.map((portStatus) => ({
        id: portStatus.id,
        port: portStatus.port,
        enabled: portStatus.enabled,
        health: portStatus.health,
        hops: portStatus.hops.map((hopStatus) => ({
          index: hopStatus.index,
          mode: hopStatus.mode,
          activeNodeId: hopStatus.activeNodeId,
          health: hopStatus.health,
        })),
      })),
      lastApply: status.lastApply
        ? {
            result: status.lastApply.result,
            at: status.lastApply.at,
            reason: status.lastApply.reason,
            errorCode: status.lastApply.errorCode,
          }
        : null,
    }
  }

  delete event.node.req.headers.cookie
  delete event.node.req.headers['x-csrf-token']
  delete event.node.req.headers.authorization
  return forward(event)
})
