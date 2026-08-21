import type {
  GatewayImportPreview,
  GatewayNode,
  GatewaySubscription,
} from '~/types/gateway'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import NodesPage from '../nodes.vue'

const nodes: GatewayNode[] = [
  {
    id: 'node-b',
    name: '新加坡 B',
    type: 'trojan',
    enabled: true,
    sourceIds: ['manual', 'subscription:subscription-b'],
    portIds: [1, 3],
    healthy: false,
    latency: null,
  },
  {
    id: 'node-a',
    name: '东京 A',
    type: 'vless',
    enabled: true,
    sourceIds: ['subscription:subscription-b'],
    portIds: [],
    healthy: true,
    latency: 42,
  },
]

const subscriptions: GatewaySubscription[] = [
  {
    id: 'subscription-b',
    name: '主订阅',
    urlMasked: 'https://example.com/***',
    intervalMinutes: 60,
    enabled: true,
    nodeCount: 2,
    createdAt: 1,
    updatedAt: 1,
  },
]

const importPreview: GatewayImportPreview = {
  previewId: 'preview-1',
  format: 'links',
  validCount: 1,
  skippedCount: 0,
  protocolCounts: { vless: 1 },
  errors: [],
  issues: [],
  nodes: [{ id: 'node-c', name: '洛杉矶 C', type: 'vless' }],
}

const NodeImportDialogStub = {
  props: ['preview', 'busy', 'error'],
  emits: ['preview-text', 'preview-file', 'apply', 'cancel'],
  template: `
    <div data-testid="import-dialog">
      <button data-testid="stub-preview" @click="$emit('preview-text', 'vless://example')">预览</button>
      <button data-testid="stub-apply" :disabled="!preview" @click="$emit('apply')">应用</button>
      <button data-testid="stub-cancel" @click="$emit('cancel')">取消</button>
      <span v-if="preview">{{ preview.validCount }} 个节点</span>
    </div>
  `,
}

const SubscriptionEditorStub = {
  props: ['subscription', 'busy'],
  emits: ['save', 'cancel'],
  template: `
    <div data-testid="subscription-editor">
      <button
        data-testid="stub-save-subscription"
        @click="$emit('save', subscription
          ? { name: '更新订阅', intervalMinutes: 120, enabled: false }
          : { name: '备用订阅', url: 'https://sub.example', intervalMinutes: 60, enabled: true })"
      >保存</button>
      <button @click="$emit('cancel')">取消</button>
    </div>
  `,
}

describe('nodes page', () => {
  const api = {
    listNodes: vi.fn(),
    updateNode: vi.fn(),
    testNode: vi.fn(),
    getNodeImpact: vi.fn(),
    deleteNode: vi.fn(),
    previewImport: vi.fn(),
    previewImportFile: vi.fn(),
    applyImport: vi.fn(),
    listSubscriptions: vi.fn(),
    createSubscription: vi.fn(),
    updateSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    syncSubscription: vi.fn(),
  }

  beforeEach(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: {
        configurable: true,
        value: vi.fn(function (this: HTMLDialogElement) {
          this.setAttribute('open', '')
        }),
      },
      close: {
        configurable: true,
        value: vi.fn(function (this: HTMLDialogElement) {
          this.removeAttribute('open')
        }),
      },
    })
    vi.clearAllMocks()
    api.listNodes.mockResolvedValue({ items: structuredClone(nodes) })
    api.updateNode.mockImplementation(
      async (id: string, body: { enabled: boolean }) => ({
        ...nodes.find((node) => node.id === id)!,
        enabled: body.enabled,
      }),
    )
    api.testNode.mockResolvedValue({ reachable: true, latencyMs: 38 })
    api.getNodeImpact.mockResolvedValue({ affectedPortIds: [] })
    api.deleteNode.mockResolvedValue(undefined)
    api.previewImport.mockResolvedValue(importPreview)
    api.previewImportFile.mockResolvedValue(importPreview)
    api.applyImport.mockResolvedValue({ imported: 1 })
    api.listSubscriptions.mockResolvedValue({
      items: structuredClone(subscriptions),
    })
    api.createSubscription.mockResolvedValue({
      ...subscriptions[0],
      id: 'subscription-a',
      name: '备用订阅',
    })
    api.updateSubscription.mockResolvedValue({
      ...subscriptions[0],
      name: '更新订阅',
      intervalMinutes: 120,
      enabled: false,
    })
    api.deleteSubscription.mockResolvedValue(undefined)
    api.syncSubscription.mockResolvedValue({
      ...subscriptions[0],
      lastSyncAt: 100,
    })
    vi.stubGlobal('useGatewayApi', () => api)
    vi.stubGlobal('controlErrorMessage', (error: unknown) =>
      error instanceof Error ? error.message : '操作失败',
    )
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function render() {
    return mount(NodesPage, {
      global: {
        stubs: {
          NodeImportDialog: NodeImportDialogStub,
          SubscriptionEditor: SubscriptionEditorStub,
        },
      },
    })
  }

  it('shows every node source and the fixed ports that reference it', async () => {
    const wrapper = render()
    await flushPromises()

    const sources = wrapper.get('[data-testid="node-sources-node-b"]').text()
    expect(sources).toContain('手动导入')
    expect(sources).toContain('订阅：主订阅')
    expect(wrapper.get('[data-testid="node-ports-node-b"]').text()).toContain(
      '10001、10003',
    )
    expect(wrapper.get('[data-testid="node-ports-node-a"]').text()).toContain(
      '未被端口引用',
    )
  })

  it('loads nodes only from the gateway client and supports test plus enable toggles', async () => {
    const wrapper = render()
    await flushPromises()

    expect(api.listNodes).toHaveBeenCalledOnce()
    expect(wrapper.findAll('[data-testid="node-row"]')).toHaveLength(2)

    await wrapper.get('[data-testid="test-node-node-b"]').trigger('click')
    await flushPromises()
    expect(api.testNode).toHaveBeenCalledWith('node-b')
    expect(wrapper.get('[data-testid="node-message-node-b"]').text()).toContain(
      '38 ms',
    )
    expect(
      wrapper
        .get('[data-testid="node-health-node-b"]')
        .attributes('data-health'),
    ).toBe('healthy')

    await wrapper.get('[data-testid="toggle-node-node-a"]').trigger('click')
    await flushPromises()
    expect(api.updateNode).toHaveBeenCalledWith('node-a', { enabled: false })
    expect(wrapper.text()).toContain('节点“东京 A”已停用')
  })

  it('collects impacts concurrently, confirms once, and deletes in stable ID order with per-item results', async () => {
    const impactResolvers = new Map<
      string,
      (value: { affectedPortIds: number[] }) => void
    >()
    api.getNodeImpact.mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          impactResolvers.set(id, resolve)
        }),
    )
    const deleted: string[] = []
    api.deleteNode.mockImplementation(async (id: string) => {
      deleted.push(id)
      if (id === 'node-b') throw new Error('sensitive deletion diagnostic')
    })
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="select-node-node-b"]').setValue(true)
    await wrapper.get('[data-testid="select-node-node-a"]').setValue(true)
    await wrapper.get('[data-testid="delete-selected"]').trigger('click')
    await nextTick()
    expect(api.getNodeImpact).toHaveBeenCalledTimes(2)
    expect(api.deleteNode).not.toHaveBeenCalled()

    impactResolvers.get('node-b')!({ affectedPortIds: [3, 1] })
    impactResolvers.get('node-a')!({ affectedPortIds: [1, 2] })
    await flushPromises()

    const dialog = wrapper.get('[data-testid="impact-dialog"]')
    expect(dialog.text()).toContain('10001')
    expect(dialog.text()).toContain('10002')
    expect(dialog.text()).toContain('10003')
    expect(wrapper.findAll('[data-testid="impact-dialog"]')).toHaveLength(1)

    await wrapper.get('[data-testid="confirm-impact"]').trigger('click')
    await flushPromises()

    expect(deleted).toEqual(['node-a', 'node-b'])
    expect(api.deleteNode.mock.calls).toEqual([
      ['node-a', true],
      ['node-b', true],
    ])
    expect(
      wrapper.get('[data-testid="delete-result-node-a"]').text(),
    ).toContain('已删除')
    expect(
      wrapper.get('[data-testid="delete-result-node-b"]').text(),
    ).toContain('操作失败，请稍后重试。')
  })

  it('previews and applies an import before refreshing the gateway node list', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="open-import"]').trigger('click')
    await wrapper.get('[data-testid="stub-preview"]').trigger('click')
    await flushPromises()
    expect(api.previewImport).toHaveBeenCalledWith({
      content: 'vless://example',
    })
    expect(wrapper.get('[data-testid="import-dialog"]').text()).toContain(
      '1 个节点',
    )

    await wrapper.get('[data-testid="stub-apply"]').trigger('click')
    await flushPromises()
    expect(api.applyImport).toHaveBeenCalledWith({ previewId: 'preview-1' })
    expect(api.listNodes).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('已导入 1 个节点')
  })

  it('creates, edits, syncs, and deletes subscriptions with inline feedback', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="new-subscription"]').trigger('click')
    await wrapper.get('[data-testid="stub-save-subscription"]').trigger('click')
    await flushPromises()
    expect(api.createSubscription).toHaveBeenCalledWith({
      name: '备用订阅',
      url: 'https://sub.example',
      intervalMinutes: 60,
      enabled: true,
    })
    expect(api.listNodes).toHaveBeenCalledTimes(2)

    await wrapper
      .get('[data-testid="edit-subscription-subscription-b"]')
      .trigger('click')
    await wrapper.get('[data-testid="stub-save-subscription"]').trigger('click')
    await flushPromises()
    expect(api.updateSubscription).toHaveBeenCalledWith('subscription-b', {
      name: '更新订阅',
      intervalMinutes: 120,
      enabled: false,
    })
    expect(api.listNodes).toHaveBeenCalledTimes(3)

    await wrapper
      .get('[data-testid="sync-subscription-subscription-b"]')
      .trigger('click')
    await flushPromises()
    expect(api.syncSubscription).toHaveBeenCalledWith('subscription-b')
    expect(api.listNodes).toHaveBeenCalledTimes(4)

    await wrapper
      .get('[data-testid="delete-subscription-subscription-b"]')
      .trigger('click')
    await flushPromises()
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(api.deleteSubscription).toHaveBeenCalledWith('subscription-b')
    expect(api.listNodes).toHaveBeenCalledTimes(5)
    expect(wrapper.text()).toContain('订阅“主订阅”已删除')
  })

  it('keeps completed mutations closed when the follow-up node refresh fails', async () => {
    api.listNodes
      .mockResolvedValueOnce({ items: structuredClone(nodes) })
      .mockRejectedValueOnce(new Error('refresh failed'))
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="open-import"]').trigger('click')
    await wrapper.get('[data-testid="stub-preview"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="stub-apply"]').trigger('click')
    await flushPromises()

    expect(api.applyImport).toHaveBeenCalledOnce()
    expect(wrapper.find('[data-testid="import-dialog"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('节点已导入，但列表刷新失败')
  })

  it('surfaces automatic subscription sync failures returned by create', async () => {
    api.createSubscription.mockResolvedValueOnce({
      ...subscriptions[0],
      id: 'subscription-failed',
      name: '失效订阅',
      nodeCount: 0,
      lastError: 'subscription refresh failed',
    })
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="new-subscription"]').trigger('click')
    await wrapper.get('[data-testid="stub-save-subscription"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('订阅“失效订阅”已添加')
    expect(wrapper.text()).toContain('自动同步失败')
    expect(wrapper.text()).toContain('订阅刷新失败')
  })

  it('locks every subscription action while a sync is in flight and refreshes nodes afterward', async () => {
    let resolveSync!: (value: GatewaySubscription) => void
    api.syncSubscription.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSync = resolve
      }),
    )
    api.listNodes.mockResolvedValueOnce({ items: structuredClone(nodes) })
    api.listNodes.mockResolvedValueOnce({
      items: [
        ...structuredClone(nodes),
        {
          id: 'node-c',
          name: '洛杉矶 C',
          type: 'vless',
          enabled: true,
          sourceIds: ['manual'],
          portIds: [],
        },
      ],
    })
    const wrapper = render()
    await flushPromises()

    await wrapper
      .get('[data-testid="sync-subscription-subscription-b"]')
      .trigger('click')
    await nextTick()

    for (const testId of [
      'new-subscription',
      'edit-subscription-subscription-b',
      'sync-subscription-subscription-b',
      'delete-subscription-subscription-b',
    ]) {
      expect(
        wrapper.get(`[data-testid="${testId}"]`).attributes('disabled'),
      ).toBe('')
    }

    resolveSync({ ...subscriptions[0]!, lastSyncAt: 100 })
    await flushPromises()

    expect(api.listNodes).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('洛杉矶 C')
  })
})
