import type {
  GatewayAuthSession,
  GatewayCollection,
  GatewayCreatedCredential,
  GatewayCredential,
  GatewayImportApplyInput,
  GatewayImportPreview,
  GatewayNode,
  GatewayNodeImpact,
  GatewayNodeTestResult,
  GatewayPort,
  GatewayRevision,
  GatewayRotatedCredential,
  GatewayStatus,
  GatewaySubscription,
  GatewaySubscriptionRefreshResult,
} from '~/types/gateway'
import ky from 'ky'

const REQUEST_TIMEOUT = 20_000
const IMPORT_TIMEOUT = 45_000
let responseCsrfToken = ''

export function resolveGatewayApiBase(): string {
  if (typeof window === 'undefined' || !window.location?.origin) return '/api'
  return `${window.location.origin.replace(/\/$/, '')}/api`
}

export function getGatewayCsrfToken(): string {
  return responseCsrfToken
}

function mutationOptions(json?: unknown) {
  const token = getGatewayCsrfToken()
  return {
    ...(json === undefined ? {} : { json }),
    headers: token ? { 'X-CSRF-Token': token } : undefined,
  }
}

async function parseJson<T>(request: Promise<Response>): Promise<T> {
  const response = await request
  const body = (await response.json()) as T
  if (body && typeof body === 'object' && 'authenticated' in body) {
    if ((body as { authenticated?: unknown }).authenticated === false)
      responseCsrfToken = ''
  }
  if (body && typeof body === 'object' && 'csrfToken' in body) {
    const token = (body as { csrfToken?: unknown }).csrfToken
    if (typeof token === 'string') responseCsrfToken = token
  }
  return body
}

export function useGatewayApi() {
  const client = ky.create({
    prefix: resolveGatewayApiBase(),
    credentials: 'include',
    timeout: REQUEST_TIMEOUT,
    retry: 0,
  })
  const gatewayPath = 'control/gateway'
  const encodeId = (id: string) => encodeURIComponent(id)

  return {
    async login(password: string) {
      responseCsrfToken = ''
      return parseJson<GatewayAuthSession>(
        client.post('auth/login', { json: { password } }),
      )
    },
    async logout() {
      try {
        await client.post('auth/logout', mutationOptions())
      } finally {
        responseCsrfToken = ''
      }
    },
    getSession: () => parseJson<GatewayAuthSession>(client.get('auth/me')),
    async changePassword(currentPassword: string, newPassword: string) {
      const result = await parseJson<{ ok: true }>(
        client.put(
          'auth/password',
          mutationOptions({ currentPassword, newPassword }),
        ),
      )
      responseCsrfToken = ''
      return result
    },

    listPorts: () =>
      parseJson<GatewayCollection<GatewayPort>>(
        client.get(`${gatewayPath}/ports`),
      ),
    updatePort: (
      id: number,
      body: Partial<Pick<GatewayPort, 'enabled' | 'credentialIds' | 'hops'>>,
    ) =>
      parseJson<GatewayPort>(
        client.put(`${gatewayPath}/ports/${id}`, mutationOptions(body)),
      ),

    listNodes: () =>
      parseJson<GatewayCollection<GatewayNode>>(
        client.get(`${gatewayPath}/nodes`),
      ),
    updateNode: (id: string, body: { enabled: boolean }) =>
      parseJson<GatewayNode>(
        client.put(
          `${gatewayPath}/nodes/${encodeId(id)}`,
          mutationOptions(body),
        ),
      ),
    testNode: (id: string) =>
      parseJson<GatewayNodeTestResult>(
        client.post(
          `${gatewayPath}/nodes/${encodeId(id)}/test`,
          mutationOptions(),
        ),
      ),
    getNodeImpact: (id: string) =>
      parseJson<GatewayNodeImpact>(
        client.get(`${gatewayPath}/nodes/${encodeId(id)}/impact`),
      ),
    deleteNode: async (id: string, confirmed: boolean) => {
      await client.delete(
        `${gatewayPath}/nodes/${encodeId(id)}`,
        mutationOptions({ confirmed }),
      )
    },

    previewImport: (body: { content: string }) =>
      parseJson<GatewayImportPreview>(
        client.post(`${gatewayPath}/imports/preview`, {
          ...mutationOptions(body),
          timeout: IMPORT_TIMEOUT,
        }),
      ),
    previewImportFile: (file: File) => {
      const form = new FormData()
      form.set('file', file)
      const token = getGatewayCsrfToken()
      return parseJson<GatewayImportPreview>(
        client.post(`${gatewayPath}/imports/preview`, {
          body: form,
          headers: token ? { 'X-CSRF-Token': token } : undefined,
          timeout: IMPORT_TIMEOUT,
        }),
      )
    },
    applyImport: (body: GatewayImportApplyInput) =>
      parseJson<{ imported: number }>(
        client.post(`${gatewayPath}/imports/apply`, {
          ...mutationOptions(body),
          timeout: IMPORT_TIMEOUT,
        }),
      ),

    listSubscriptions: () =>
      parseJson<GatewayCollection<GatewaySubscription>>(
        client.get(`${gatewayPath}/subscriptions`),
      ),
    createSubscription: (body: {
      name: string
      url: string
      intervalMinutes?: number
      enabled?: boolean
    }) =>
      parseJson<GatewaySubscription>(
        client.post(`${gatewayPath}/subscriptions`, mutationOptions(body)),
      ),
    updateSubscription: (
      id: string,
      body: Partial<
        Pick<GatewaySubscription, 'name' | 'intervalMinutes' | 'enabled'> & {
          url: string
        }
      >,
    ) =>
      parseJson<GatewaySubscription>(
        client.put(
          `${gatewayPath}/subscriptions/${encodeId(id)}`,
          mutationOptions(body),
        ),
      ),
    deleteSubscription: async (id: string) => {
      await client.delete(
        `${gatewayPath}/subscriptions/${encodeId(id)}`,
        mutationOptions(),
      )
    },
    syncSubscription: (id: string) =>
      parseJson<GatewaySubscription>(
        client.post(
          `${gatewayPath}/subscriptions/${encodeId(id)}/sync`,
          mutationOptions(),
        ),
      ),
    refreshSubscriptions: () =>
      parseJson<GatewaySubscriptionRefreshResult>(
        client.post(`${gatewayPath}/subscriptions/refresh`, mutationOptions()),
      ),

    listCredentials: () =>
      parseJson<GatewayCollection<GatewayCredential>>(
        client.get(`${gatewayPath}/credentials`),
      ),
    createCredential: (body: {
      username: string
      password?: string
      enabled?: boolean
      portIds?: number[]
    }) =>
      parseJson<GatewayCreatedCredential>(
        client.post(`${gatewayPath}/credentials`, mutationOptions(body)),
      ),
    updateCredential: (
      id: string,
      body: {
        username?: string
        enabled?: boolean
        portIds?: number[]
      },
    ) =>
      parseJson<GatewayCredential>(
        client.put(
          `${gatewayPath}/credentials/${encodeId(id)}`,
          mutationOptions(body),
        ),
      ),
    deleteCredential: async (id: string) => {
      await client.delete(
        `${gatewayPath}/credentials/${encodeId(id)}`,
        mutationOptions(),
      )
    },
    rotateCredential: (id: string, password?: string) =>
      parseJson<GatewayRotatedCredential>(
        client.post(
          `${gatewayPath}/credentials/${encodeId(id)}/rotate`,
          mutationOptions(password === undefined ? undefined : { password }),
        ),
      ),

    getGatewayStatus: () =>
      parseJson<GatewayStatus>(client.get(`${gatewayPath}/status`)),
    reapplyGateway: () =>
      parseJson<{ ok: true }>(
        client.post(`${gatewayPath}/reapply`, mutationOptions()),
      ),
    listRevisions: () =>
      parseJson<GatewayCollection<GatewayRevision>>(
        client.get(`${gatewayPath}/revisions`),
      ),
  }
}
