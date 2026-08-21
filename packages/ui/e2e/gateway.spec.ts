import type { ChildProcess } from 'node:child_process'
import type { Browser, BrowserContext, Page, Route } from 'playwright'
import type {
  GatewayCredential,
  GatewayNode,
  GatewayPort,
  GatewayRevision,
  GatewayStatus,
  GatewaySubscription,
} from '../types/gateway'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'

interface ApiCall {
  method: string
  path: string
  body?: unknown
}

interface MockGateway {
  authenticated: boolean
  password: string
  ports: GatewayPort[]
  nodes: GatewayNode[]
  credentials: GatewayCredential[]
  subscriptions: GatewaySubscription[]
  revisions: GatewayRevision[]
  status: GatewayStatus
  calls: ApiCall[]
}

function validatePort(value: string): string {
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`Invalid port: ${value}`)
  return String(port)
}

const PORT = validatePort(process.env.PORT || '4199')
const BASE_URL = `http://localhost:${PORT}`
const SERVER_ENTRY = resolve(process.cwd(), '.output/server/index.mjs')
const READY_TIMEOUT = 30_000

function gatewayFixture(): MockGateway {
  const ports: GatewayPort[] = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    port: 10_001 + index,
    enabled: index === 0,
    credentialIds: index === 0 ? ['credential-a'] : [],
    hops: index === 0 ? [{ mode: 'manual', nodeIds: ['node-a'] }] : [],
  }))
  const nodes: GatewayNode[] = [
    {
      id: 'node-a',
      name: '新加坡 A',
      type: 'vless',
      enabled: true,
      sourceIds: ['manual', 'subscription:subscription-a'],
      portIds: [1],
      healthy: true,
      latency: 68,
    },
    {
      id: 'node-b',
      name: '日本 B',
      type: 'trojan',
      enabled: true,
      sourceIds: ['subscription:subscription-a'],
      portIds: [],
      latency: null,
    },
  ]
  const credentials: GatewayCredential[] = [
    {
      id: 'credential-a',
      username: 'team-a',
      enabled: true,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      portIds: [1],
    },
  ]
  const subscriptions: GatewaySubscription[] = [
    {
      id: 'subscription-a',
      name: '主订阅',
      urlMasked: 'https://example.test/***',
      intervalMinutes: 60,
      enabled: true,
      nodeCount: 2,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      lastSyncAt: 1_700_000_000_000,
    },
  ]
  const now = 1_700_000_000_000
  const fixture: MockGateway = {
    authenticated: false,
    password: 'admin-password',
    ports,
    nodes,
    credentials,
    subscriptions,
    revisions: [{ id: 'revision-a', createdAt: now, reason: 'bootstrap' }],
    status: {
      services: {
        web: { state: 'running', health: 'healthy' },
        agent: { state: 'running', health: 'healthy' },
        mihomo: {
          state: 'running',
          health: 'healthy',
          controllerReachable: true,
        },
      },
      versions: { web: 'web-e2e', agent: 'agent-e2e', mihomo: 'mihomo-e2e' },
      listeners: [],
      ports: [],
      lastApply: {
        result: 'success',
        at: now,
        reason: 'bootstrap',
        errorCode: null,
      },
    },
    calls: [],
  }
  syncPortState(fixture)
  return fixture
}

function syncPortState(fixture: MockGateway) {
  for (const node of fixture.nodes) {
    node.portIds = fixture.ports
      .filter((port) => port.hops.some((hop) => hop.nodeIds.includes(node.id)))
      .map((port) => port.id)
  }
  fixture.status.listeners = fixture.ports.map((port) => ({
    id: port.id,
    port: port.port,
    enabled: port.enabled,
    health: port.enabled ? 'healthy' : 'disabled',
    reachable: port.enabled ? true : null,
    errorCode: null,
  }))
  fixture.status.ports = fixture.ports.map((port) => ({
    id: port.id,
    port: port.port,
    enabled: port.enabled,
    health: port.enabled ? 'healthy' : 'disabled',
    hops: port.hops.map((hop, index) => ({
      index: (index + 1) as 1 | 2,
      mode: hop.mode,
      activeNodeId: hop.nodeIds[0] ?? null,
      health: hop.nodeIds.length ? 'healthy' : 'unknown',
    })),
  }))
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function body<T>(route: Route): T {
  return route.request().postDataJSON() as T
}

async function handleGatewayApi(route: Route, fixture: MockGateway) {
  const request = route.request()
  const method = request.method()
  const path = new URL(request.url()).pathname.replace(/^\/api\/?/, '')
  const data = request.postData() ? request.postDataJSON() : undefined
  fixture.calls.push({
    method,
    path,
    ...(data === undefined ? {} : { body: data }),
  })

  if (method === 'GET' && path === 'auth/me') {
    await json(
      route,
      fixture.authenticated
        ? { authenticated: true, user: 'admin', csrfToken: 'csrf-e2e' }
        : { authenticated: false },
    )
    return
  }
  if (method === 'POST' && path === 'auth/login') {
    const input = body<{ password: string }>(route)
    if (input.password !== fixture.password) {
      await json(route, { error: 'invalid credentials' }, 401)
      return
    }
    fixture.authenticated = true
    await json(route, {
      authenticated: true,
      user: 'admin',
      csrfToken: 'csrf-e2e',
    })
    return
  }
  if (method === 'POST' && path === 'auth/logout') {
    fixture.authenticated = false
    await json(route, { ok: true })
    return
  }
  if (!fixture.authenticated) {
    await json(route, { error: 'unauthorized' }, 401)
    return
  }
  if (method === 'PUT' && path === 'auth/password') {
    const input = body<{ currentPassword: string; newPassword: string }>(route)
    if (input.currentPassword !== fixture.password) {
      await json(route, { error: 'invalid current password' }, 400)
      return
    }
    fixture.password = input.newPassword
    fixture.authenticated = false
    await json(route, { ok: true })
    return
  }

  if (method === 'GET' && path === 'control/gateway/ports') {
    await json(route, { items: fixture.ports })
    return
  }
  const portMatch = path.match(/^control\/gateway\/ports\/(\d+)$/)
  if (method === 'PUT' && portMatch) {
    const id = Number(portMatch[1])
    const input = body<Partial<GatewayPort>>(route)
    const index = fixture.ports.findIndex((port) => port.id === id)
    fixture.ports[index] = { ...fixture.ports[index]!, ...input, id }
    syncPortState(fixture)
    await json(route, fixture.ports[index])
    return
  }

  if (method === 'GET' && path === 'control/gateway/nodes') {
    await json(route, { items: fixture.nodes })
    return
  }
  const nodeTestMatch = path.match(/^control\/gateway\/nodes\/([^/]+)\/test$/)
  if (method === 'POST' && nodeTestMatch) {
    const node = fixture.nodes.find((item) => item.id === nodeTestMatch[1])
    if (node) {
      node.healthy = true
      node.latency = 42
    }
    await json(route, { reachable: true, latencyMs: 42 })
    return
  }
  const nodeImpactMatch = path.match(
    /^control\/gateway\/nodes\/([^/]+)\/impact$/,
  )
  if (method === 'GET' && nodeImpactMatch) {
    const node = fixture.nodes.find((item) => item.id === nodeImpactMatch[1])
    await json(route, { affectedPortIds: node?.portIds ?? [] })
    return
  }
  const nodeMatch = path.match(/^control\/gateway\/nodes\/([^/]+)$/)
  if (method === 'PUT' && nodeMatch) {
    const node = fixture.nodes.find((item) => item.id === nodeMatch[1])!
    Object.assign(node, body<Pick<GatewayNode, 'enabled'>>(route))
    await json(route, node)
    return
  }
  if (method === 'DELETE' && nodeMatch) {
    fixture.nodes = fixture.nodes.filter((item) => item.id !== nodeMatch[1])
    await route.fulfill({ status: 204 })
    return
  }
  if (method === 'POST' && path === 'control/gateway/imports/preview') {
    await json(route, {
      previewId: 'preview-a',
      format: 'links',
      validCount: 1,
      skippedCount: 0,
      protocolCounts: { vless: 1 },
      errors: [],
      issues: [],
      nodes: [{ id: 'node-imported', name: '东京 导入节点', type: 'vless' }],
    })
    return
  }
  if (method === 'POST' && path === 'control/gateway/imports/apply') {
    if (!fixture.nodes.some((node) => node.id === 'node-imported')) {
      fixture.nodes.push({
        id: 'node-imported',
        name: '东京 导入节点',
        type: 'vless',
        enabled: true,
        sourceIds: ['manual'],
        portIds: [],
        latency: null,
      })
    }
    await json(route, { imported: 1 })
    return
  }

  if (method === 'GET' && path === 'control/gateway/subscriptions') {
    await json(route, { items: fixture.subscriptions })
    return
  }
  if (method === 'POST' && path === 'control/gateway/subscriptions') {
    const input = body<{
      name: string
      url: string
      intervalMinutes: number
      enabled: boolean
    }>(route)
    const subscription: GatewaySubscription = {
      id: 'subscription-b',
      name: input.name,
      urlMasked: `${new URL(input.url).origin}/***`,
      intervalMinutes: input.intervalMinutes,
      enabled: input.enabled,
      nodeCount: 1,
      createdAt: 1_700_000_100_000,
      updatedAt: 1_700_000_100_000,
    }
    fixture.subscriptions.push(subscription)
    await json(route, subscription)
    return
  }
  if (method === 'POST' && path === 'control/gateway/subscriptions/refresh') {
    await json(route, {
      items: fixture.subscriptions.map((subscription) => ({
        id: subscription.id,
        ok: true,
        nodeCount: subscription.nodeCount,
      })),
    })
    return
  }
  const subscriptionActionMatch = path.match(
    /^control\/gateway\/subscriptions\/([^/]+)\/sync$/,
  )
  if (method === 'POST' && subscriptionActionMatch) {
    const subscription = fixture.subscriptions.find(
      (item) => item.id === subscriptionActionMatch[1],
    )!
    subscription.lastSyncAt = 1_700_000_200_000
    subscription.updatedAt = 1_700_000_200_000
    await json(route, subscription)
    return
  }
  const subscriptionMatch = path.match(
    /^control\/gateway\/subscriptions\/([^/]+)$/,
  )
  if (method === 'PUT' && subscriptionMatch) {
    const subscription = fixture.subscriptions.find(
      (item) => item.id === subscriptionMatch[1],
    )!
    const input = body<Partial<GatewaySubscription> & { url?: string }>(route)
    Object.assign(subscription, input, { updatedAt: 1_700_000_300_000 })
    if (input.url) subscription.urlMasked = `${new URL(input.url).origin}/***`
    await json(route, subscription)
    return
  }
  if (method === 'DELETE' && subscriptionMatch) {
    fixture.subscriptions = fixture.subscriptions.filter(
      (item) => item.id !== subscriptionMatch[1],
    )
    await route.fulfill({ status: 204 })
    return
  }

  if (method === 'GET' && path === 'control/gateway/credentials') {
    await json(route, { items: fixture.credentials })
    return
  }
  if (method === 'POST' && path === 'control/gateway/credentials') {
    const input = body<{
      username: string
      enabled: boolean
      portIds: number[]
    }>(route)
    const credential: GatewayCredential = {
      id: 'credential-b',
      username: input.username,
      enabled: input.enabled,
      portIds: input.portIds,
      createdAt: 1_700_000_100_000,
      updatedAt: 1_700_000_100_000,
    }
    fixture.credentials.push(credential)
    await json(route, { ...credential, password: 'created-secret-once' })
    return
  }
  const credentialRotateMatch = path.match(
    /^control\/gateway\/credentials\/([^/]+)\/rotate$/,
  )
  if (method === 'POST' && credentialRotateMatch) {
    await json(route, {
      id: credentialRotateMatch[1],
      password: 'rotated-secret-once',
    })
    return
  }
  const credentialMatch = path.match(/^control\/gateway\/credentials\/([^/]+)$/)
  if (method === 'PUT' && credentialMatch) {
    const credential = fixture.credentials.find(
      (item) => item.id === credentialMatch[1],
    )!
    Object.assign(credential, body<Partial<GatewayCredential>>(route), {
      updatedAt: 1_700_000_200_000,
    })
    await json(route, credential)
    return
  }
  if (method === 'DELETE' && credentialMatch) {
    fixture.credentials = fixture.credentials.filter(
      (item) => item.id !== credentialMatch[1],
    )
    await route.fulfill({ status: 204 })
    return
  }

  if (method === 'GET' && path === 'control/gateway/status') {
    await json(route, fixture.status)
    return
  }
  if (method === 'POST' && path === 'control/gateway/reapply') {
    const now = 1_700_000_400_000
    fixture.status.lastApply = {
      result: 'success',
      at: now,
      reason: 'gateway.reapply',
      errorCode: null,
    }
    fixture.revisions.push({
      id: 'revision-b',
      createdAt: now,
      reason: 'gateway.reapply',
    })
    await json(route, { ok: true })
    return
  }
  if (method === 'GET' && path === 'control/gateway/revisions') {
    await json(route, { items: fixture.revisions })
    return
  }

  await json(route, { error: `unhandled mock route: ${method} ${path}` }, 404)
}

async function waitForServer() {
  const deadline = Date.now() + READY_TIMEOUT
  while (Date.now() < deadline) {
    try {
      if ((await fetch(BASE_URL)).ok) return
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`Preview did not start within ${READY_TIMEOUT}ms`)
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true })
  } catch (error) {
    if (process.platform === 'win32')
      return chromium.launch({ channel: 'chrome', headless: true })
    throw error
  }
}

async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null || server.signalCode !== null) return
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => server.kill('SIGKILL'), 5_000)
    server.once('exit', () => {
      clearTimeout(timeout)
      resolvePromise()
    })
    server.kill('SIGTERM')
  })
}

async function expectPath(page: Page, path: string) {
  await expect
    .poll(() => new URL(page.url()).hash, { timeout: 10_000 })
    .toContain(`#${path}`)
}

async function openAuthenticated(
  page: Page,
  fixture: MockGateway,
  path: string,
) {
  fixture.authenticated = true
  await page.goto(`${BASE_URL}/#${path}`, { waitUntil: 'domcontentloaded' })
  await expectPath(page, path)
}

describe('gateway core flows', () => {
  let server: ChildProcess | null = null
  let browser: Browser | null = null
  let context: BrowserContext | null = null
  let page: Page
  let fixture: MockGateway

  beforeAll(async () => {
    server = spawn(process.execPath, [SERVER_ENTRY], {
      stdio: 'inherit',
      env: { ...process.env, PORT, MOCK_MODE: 'true' },
    })
    await waitForServer()
    browser = await launchBrowser()
  }, 120_000)

  beforeEach(async () => {
    if (!browser) throw new Error('Browser was not initialized')
    fixture = gatewayFixture()
    context = await browser.newContext({
      locale: 'zh-CN',
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 1000 },
    })
    page = await context.newPage()
    await page.route('**/api/**', (route) => handleGatewayApi(route, fixture))
  })

  afterEach(async () => {
    await context?.close()
    context = null
  })

  afterAll(async () => {
    await browser?.close()
    if (server) await stopServer(server)
  })

  it('redirects unauthenticated users, logs in, and saves one-hop and two-hop ports', async () => {
    await page.goto(`${BASE_URL}/#/ports`, { waitUntil: 'domcontentloaded' })
    await expectPath(page, '/login')

    await page.locator('#admin-password').fill('admin-password')
    await page.getByRole('button', { name: '登录' }).click()
    await expectPath(page, '/ports')
    await expect.poll(() => page.getByTestId('port-row').count()).toBe(10)
    await expect(
      page.getByText('10001', { exact: true }).count(),
    ).resolves.toBe(1)
    await expect(
      page.getByText('10010', { exact: true }).count(),
    ).resolves.toBe(1)

    await page.getByTestId('edit-port-1').click()
    await page.getByLabel('第一跳固定节点').selectOption('node-b')
    await page.getByTestId('save-port').click()
    await page.getByTestId('port-message-1').waitFor()
    expect(fixture.ports[0]?.hops).toEqual([
      { mode: 'manual', nodeIds: ['node-b'] },
    ])

    await page.getByTestId('edit-port-1').click()
    await page.getByTestId('add-hop').click()
    await page.getByLabel('第二跳固定节点').selectOption('node-a')
    await page.getByTestId('save-port').click()
    await expect
      .poll(() => fixture.ports[0]?.hops.length, { timeout: 10_000 })
      .toBe(2)
    const updates = fixture.calls.filter(
      (call) =>
        call.method === 'PUT' && call.path === 'control/gateway/ports/1',
    )
    expect(updates).toHaveLength(2)
  })

  it('manages imported nodes, subscriptions, health, enablement, and confirmed batch deletion', async () => {
    await openAuthenticated(page, fixture, '/nodes')
    await expect.poll(() => page.getByTestId('node-row').count()).toBe(2)

    await page.getByTestId('open-import').click()
    await page.locator('dialog textarea').fill('vless://example-node')
    await page.getByTestId('preview-text').click()
    await page.getByRole('heading', { name: '导入预览' }).waitFor()
    await page.getByTestId('apply-import').click()
    await page.getByText('东京 导入节点', { exact: true }).waitFor()

    await page.getByTestId('test-node-node-a').click()
    await expect
      .poll(() => page.getByTestId('node-message-node-a').textContent())
      .toContain('检测成功 · 42 ms')
    await page.getByTestId('toggle-node-node-a').click()
    await expect
      .poll(() => page.getByTestId('toggle-node-node-a').textContent())
      .toContain('启用')
    await page.getByTestId('toggle-node-node-a').click()
    await expect
      .poll(() => page.getByTestId('toggle-node-node-a').textContent())
      .toContain('停用')

    await page.getByTestId('new-subscription').click()
    await page.getByLabel('订阅名称').fill('备用订阅')
    await page.getByLabel('订阅地址').fill('https://backup.test/list')
    await page.getByLabel('更新间隔（分钟）').fill('30')
    await page.getByRole('button', { name: '保存订阅' }).click()
    await page.getByText('备用订阅', { exact: true }).waitFor()

    await page.getByTestId('edit-subscription-subscription-b').click()
    await page.getByLabel('订阅名称').fill('备用订阅（已更新）')
    await page.getByRole('button', { name: '保存订阅' }).click()
    await page.getByText('备用订阅（已更新）', { exact: true }).waitFor()
    await page.getByTestId('sync-subscription-subscription-b').click()
    await expect
      .poll(() => page.getByRole('status').first().textContent())
      .toContain('同步完成')
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByTestId('delete-subscription-subscription-b').click()
    await expect
      .poll(() => page.getByText('备用订阅（已更新）', { exact: true }).count())
      .toBe(0)

    await page.getByTestId('select-node-node-a').check()
    await page.getByTestId('select-node-node-b').check()
    await page.getByTestId('delete-selected').click()
    await page.getByTestId('impact-dialog').waitFor()
    await expect(
      page.getByTestId('impact-dialog').getByText('10001').count(),
    ).resolves.toBe(1)
    await page.getByTestId('confirm-impact').click()
    await page.getByTestId('delete-result-node-b').waitFor()
    const deletes = fixture.calls
      .filter(
        (call) =>
          call.method === 'DELETE' &&
          call.path.startsWith('control/gateway/nodes/'),
      )
      .map((call) => call.path)
    expect(deletes).toEqual([
      'control/gateway/nodes/node-a',
      'control/gateway/nodes/node-b',
    ])
  })

  it('creates and binds an account, shows each secret once, then rotates, disables, and deletes it', async () => {
    await openAuthenticated(page, fixture, '/credentials')
    await page.getByTestId('credential-row-credential-a').waitFor()

    await page.getByTestId('create-username').fill('team-b')
    await page.getByTestId('create-port-1').check()
    await page.getByTestId('create-port-2').check()
    await page.getByTestId('create-submit').click()
    await expect(
      page.getByTestId('credential-secret').textContent(),
    ).resolves.toBe('created-secret-once')
    await page.getByTestId('dismiss-secret').click()
    await expect
      .poll(() => page.getByTestId('credential-secret').count())
      .toBe(0)
    await expect(page.locator('body').textContent()).resolves.not.toContain(
      'created-secret-once',
    )

    await page.getByTestId('edit-credential-b').click()
    await page.getByTestId('edit-username-credential-b').fill('team-renamed')
    await page.getByTestId('edit-port-1-credential-b').uncheck()
    await page.getByTestId('edit-port-3-credential-b').check()
    await page.getByTestId('save-credential-b').click()
    await page
      .getByTestId('credential-row-credential-b')
      .getByText('team-renamed', { exact: true })
      .waitFor()

    await page.getByTestId('rotate-credential-b').click()
    await expect(
      page.getByTestId('credential-secret').textContent(),
    ).resolves.toBe('rotated-secret-once')
    await page.getByTestId('dismiss-secret').click()
    await expect
      .poll(() => page.getByTestId('credential-secret').count())
      .toBe(0)
    await page.getByTestId('disable-credential-b').click()
    await page
      .getByTestId('credential-row-credential-b')
      .getByText('已停用', { exact: true })
      .waitFor()

    await page.getByTestId('delete-credential-b').click()
    await expect(
      page.getByTestId('delete-confirmation').textContent(),
    ).resolves.toContain('10002、10003')
    await page.getByTestId('confirm-delete-credential-b').click()
    await expect
      .poll(() => page.getByTestId('credential-row-credential-b').count())
      .toBe(0)
  })

  it('exposes only four navigation entries and performs the system maintenance flows', async () => {
    await openAuthenticated(page, fixture, '/system')
    await page.getByRole('heading', { name: '系统', exact: true }).waitFor()

    const navigation = page.getByRole('navigation', { name: '桌面导航' })
    await expect(navigation.locator('a').allTextContents()).resolves.toEqual([
      '端口',
      '节点',
      '账号',
      '系统',
    ])
    await expect(page.locator('a[href*="#/overview"]').count()).resolves.toBe(0)
    await expect(page.locator('a[href*="#/proxies"]').count()).resolves.toBe(0)
    await expect(
      page.locator('a[href*="#/connections"]').count(),
    ).resolves.toBe(0)
    await expect(page.getByTestId('listener-row').count()).resolves.toBe(10)
    await page.getByText('web-e2e', { exact: true }).waitFor()
    await page.getByText('agent-e2e', { exact: true }).waitFor()
    await page.getByText('mihomo-e2e', { exact: true }).waitFor()

    await page.getByTestId('reapply-gateway').click()
    await expect
      .poll(() => page.getByTestId('system-action-message').textContent())
      .toContain('当前配置已重新应用')
    await page.getByTestId('refresh-subscriptions').click()
    await page.getByTestId('subscription-refresh-result').waitFor()
    await expect(
      page.getByTestId('subscription-refresh-result').textContent(),
    ).resolves.toContain('1 项成功，0 项失败')

    await page.getByTestId('current-password').fill('admin-password')
    await page.getByTestId('new-password').fill('new-admin-password')
    await page.getByTestId('confirm-password').fill('new-admin-password')
    await page
      .getByTestId('password-form')
      .getByRole('button', { name: '修改密码' })
      .click()
    await expectPath(page, '/login')
    const passwordCall = fixture.calls.find(
      (call) => call.method === 'PUT' && call.path === 'auth/password',
    )
    expect(passwordCall?.body).toEqual({
      currentPassword: 'admin-password',
      newPassword: 'new-admin-password',
    })
  })
})
