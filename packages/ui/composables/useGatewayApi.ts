import type {
  GatewayAuditEntry,
  GatewayAuthSession,
  GatewayConfig,
  GatewayCredential,
  GatewayCredentialSecret,
  GatewayImportPreview,
  GatewayListResponse,
  GatewayOutboundMode,
  GatewayRevision,
  GatewayStatus,
  GatewaySubscription,
} from '~/types/gateway'
import ky from 'ky'

const REQUEST_TIMEOUT = 20_000
const IMPORT_TIMEOUT = 45_000
let responseCsrfToken = ''

export function resolveGatewayApiBase(): string {
  if (typeof window === 'undefined' || !window.location?.origin) return '/api'
  return `${window.location.origin.replace(/\/$/, '')}/api`
}

export function readGatewayCsrfCookie(cookie = ''): string {
  const accepted = new Set(['csrf_token', 'csrfToken', 'XSRF-TOKEN'])
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const key = part.slice(0, separator).trim()
    if (!accepted.has(key)) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return part.slice(separator + 1).trim()
    }
  }
  return ''
}

export function unwrapGatewayList<T>(value: GatewayListResponse<T>): T[] {
  return Array.isArray(value)
    ? value
    : Array.isArray(value.items)
      ? value.items
      : []
}

export function getGatewayCsrfToken(): string {
  if (responseCsrfToken) return responseCsrfToken
  return typeof document === 'undefined'
    ? ''
    : readGatewayCsrfCookie(document.cookie)
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
  const headerToken = response.headers.get('X-CSRF-Token')
  const body = (await response.json()) as T
  const bodyToken =
    body && typeof body === 'object' && 'csrfToken' in body
      ? String((body as { csrfToken?: unknown }).csrfToken || '')
      : ''
  if (headerToken || bodyToken) responseCsrfToken = headerToken || bodyToken
  return body
}

interface RawImportPreview {
  previewId?: string
  nodes?: Array<{ id: string; originalName?: string; type?: string }>
  issues?: Array<{ code?: string; message: string; index?: number }>
  summary?: {
    valid?: number
    skipped?: number
    protocols?: Record<string, number>
  }
}

function normalizeImportPreview(
  value: GatewayImportPreview | RawImportPreview,
): GatewayImportPreview {
  if ('validCount' in value) return value
  return {
    previewId: value.previewId,
    validCount: value.summary?.valid || 0,
    skippedCount: value.summary?.skipped || 0,
    protocolCounts: value.summary?.protocols || {},
    errors: value.issues || [],
    // Deliberately project only display-safe fields. The parser's internal
    // `proxy` object may contain UUIDs/passwords and must never reach the UI.
    nodes: value.nodes?.map((node) => ({
      id: node.id,
      name: node.originalName || node.id,
      type: node.type,
    })),
  }
}

export function useGatewayApi() {
  const client = ky.create({
    prefix: resolveGatewayApiBase(),
    credentials: 'include',
    timeout: REQUEST_TIMEOUT,
    retry: 0,
  })

  return {
    login: (password: string) =>
      parseJson<GatewayAuthSession>(
        client.post('auth/login', { json: { password } }),
      ),
    logout: async () => {
      await client.post('auth/logout', mutationOptions())
      responseCsrfToken = ''
    },
    getSession: () => parseJson<GatewayAuthSession>(client.get('auth/me')),
    changePassword: (currentPassword: string, newPassword: string) =>
      parseJson<{ ok: true }>(
        client.put(
          'auth/password',
          mutationOptions({ currentPassword, newPassword }),
        ),
      ),

    getGateway: () => parseJson<GatewayConfig>(client.get('control/gateway')),
    updateGateway: (body: Pick<GatewayConfig, 'enabled' | 'port' | 'udp'>) =>
      parseJson<GatewayConfig>(
        client.put('control/gateway', mutationOptions(body)),
      ),
    getGatewayStatus: () =>
      parseJson<GatewayStatus>(client.get('control/gateway/status')),
    updateOutbound: (body: { mode: GatewayOutboundMode; nodeId?: string }) =>
      parseJson<GatewayConfig>(
        client.put('control/gateway/outbound', mutationOptions(body)),
      ),

    listCredentials: () =>
      parseJson<GatewayListResponse<GatewayCredential>>(
        client.get('control/gateway/credentials'),
      ),
    createCredential: (body: {
      username: string
      password?: string
      enabled?: boolean
    }) =>
      parseJson<GatewayCredentialSecret>(
        client.post('control/gateway/credentials', mutationOptions(body)),
      ),
    updateCredential: (
      id: string,
      body: { username?: string; enabled?: boolean },
    ) =>
      parseJson<GatewayCredential>(
        client.put(
          `control/gateway/credentials/${encodeURIComponent(id)}`,
          mutationOptions(body),
        ),
      ),
    deleteCredential: async (id: string) => {
      await client.delete(
        `control/gateway/credentials/${encodeURIComponent(id)}`,
        mutationOptions(),
      )
    },
    rotateCredential: (id: string, password?: string) =>
      parseJson<GatewayCredentialSecret>(
        client.post(
          `control/gateway/credentials/${encodeURIComponent(id)}/rotate`,
          mutationOptions(password ? { password } : {}),
        ),
      ),

    previewImport: (body: { content: string; fileName?: string }) =>
      parseJson<GatewayImportPreview | RawImportPreview>(
        client.post('control/import/preview', {
          ...mutationOptions(body),
          timeout: IMPORT_TIMEOUT,
        }),
      ).then(normalizeImportPreview),
    previewImportFile: (file: File) => {
      const form = new FormData()
      form.set('file', file)
      const token = getGatewayCsrfToken()
      return parseJson<GatewayImportPreview | RawImportPreview>(
        client.post('control/import/preview', {
          body: form,
          headers: token ? { 'X-CSRF-Token': token } : undefined,
          timeout: IMPORT_TIMEOUT,
        }),
      ).then(normalizeImportPreview)
    },
    applyImport: (body: {
      previewId?: string
      content?: string
      fileName?: string
    }) =>
      parseJson<{ imported: number; gateway?: GatewayConfig }>(
        client.post('control/import/apply', {
          ...mutationOptions(body),
          timeout: IMPORT_TIMEOUT,
        }),
      ),

    listSubscriptions: () =>
      parseJson<GatewayListResponse<GatewaySubscription>>(
        client.get('control/subscriptions'),
      ),
    createSubscription: (body: {
      name: string
      url: string
      intervalMinutes: number
      enabled: boolean
    }) =>
      parseJson<GatewaySubscription>(
        client.post('control/subscriptions', mutationOptions(body)),
      ),
    updateSubscription: (
      id: string,
      body: Partial<
        Pick<GatewaySubscription, 'name' | 'intervalMinutes' | 'enabled'>
      >,
    ) =>
      parseJson<GatewaySubscription>(
        client.put(
          `control/subscriptions/${encodeURIComponent(id)}`,
          mutationOptions(body),
        ),
      ),
    deleteSubscription: async (id: string) => {
      await client.delete(
        `control/subscriptions/${encodeURIComponent(id)}`,
        mutationOptions(),
      )
    },
    syncSubscription: (id: string) =>
      parseJson<GatewaySubscription>(
        client.post(
          `control/subscriptions/${encodeURIComponent(id)}/sync`,
          mutationOptions(),
        ),
      ),

    listRevisions: () =>
      parseJson<GatewayListResponse<GatewayRevision>>(
        client.get('control/revisions'),
      ),
    rollbackRevision: (id: string) =>
      parseJson<GatewayConfig>(
        client.post(
          `control/revisions/${encodeURIComponent(id)}/rollback`,
          mutationOptions(),
        ),
      ),
    listAudit: () =>
      parseJson<GatewayListResponse<GatewayAuditEntry>>(
        client.get('control/audit'),
      ),
  }
}
