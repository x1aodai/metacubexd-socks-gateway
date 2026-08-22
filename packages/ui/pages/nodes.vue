<script setup lang="ts">
import type { SubscriptionEditorInput } from '~/components/gateway/SubscriptionEditor.vue'
import type {
  GatewayImportPreview,
  GatewayNode,
  GatewaySubscription,
} from '~/types/gateway'
import { computed, onMounted, ref } from 'vue'
import ConfirmImpactDialog from '~/components/gateway/ConfirmImpactDialog.vue'
import NodeImportDialog from '~/components/gateway/NodeImportDialog.vue'
import StatusBadge from '~/components/gateway/StatusBadge.vue'
import SubscriptionEditor from '~/components/gateway/SubscriptionEditor.vue'
import { gatewayCodeLabel, gatewayErrorMessage } from '~/utils/gatewayDisplay'

interface PendingNodeDelete {
  nodes: Array<Pick<GatewayNode, 'id' | 'name'>>
  affectedPortIds: number[]
}

interface DeleteResult {
  id: string
  name: string
  ok: boolean
  error?: string
}

const api = useGatewayApi()
const nodes = ref<GatewayNode[]>([])
const subscriptions = ref<GatewaySubscription[]>([])
const loading = ref(true)
const loadError = ref('')
const notice = ref<{ kind: 'success' | 'error'; text: string } | null>(null)
const nodeMessages = ref<Record<string, string>>({})
const busyNodeIds = ref<string[]>([])
const selectedNodeIds = ref<string[]>([])

const importOpen = ref(false)
const importBusy = ref(false)
const importError = ref('')
const importPreview = ref<GatewayImportPreview | null>(null)

const subscriptionEditorOpen = ref(false)
const editingSubscription = ref<GatewaySubscription | null>(null)
const subscriptionBusy = ref(false)

const collectingImpact = ref(false)
const deleteBusy = ref(false)
const pendingDelete = ref<PendingNodeDelete | null>(null)
const deleteResults = ref<DeleteResult[]>([])

const selectedCount = computed(() => selectedNodeIds.value.length)
const subscriptionNames = computed(
  () =>
    new Map(
      subscriptions.value.map((subscription) => [
        subscription.id,
        subscription.name,
      ]),
    ),
)
const pageBusy = computed(
  () =>
    busyNodeIds.value.length > 0 ||
    importBusy.value ||
    subscriptionBusy.value ||
    collectingImpact.value ||
    deleteBusy.value,
)

function setNodeBusy(id: string, busy: boolean) {
  busyNodeIds.value = busy
    ? [...busyNodeIds.value, id]
    : busyNodeIds.value.filter((value) => value !== id)
}

function nodeHealth(node: GatewayNode) {
  if (!node.enabled) return 'disabled' as const
  if (node.healthy === true) return 'healthy' as const
  if (node.healthy === false) return 'unhealthy' as const
  return 'unknown' as const
}

function nodeSourceLabel(node: GatewayNode): string {
  if (node.sourceIds.length === 0) return '来源未知'
  return node.sourceIds
    .map((sourceId) => {
      if (sourceId === 'manual') return '手动导入'
      if (!sourceId.startsWith('subscription:')) return '其他来源'
      const name = subscriptionNames.value.get(sourceId.slice(13))
      return name ? `订阅：${name}` : '订阅来源'
    })
    .join('、')
}

function nodePortLabel(node: GatewayNode): string {
  if (node.portIds.length === 0) return '未被端口引用'
  return node.portIds.map((portId) => 10_000 + portId).join('、')
}

function replaceNode(updated: GatewayNode) {
  nodes.value = nodes.value.map((node) =>
    node.id === updated.id ? updated : node,
  )
}

function replaceNodes(updated: GatewayNode[]) {
  nodes.value = updated
  const availableIds = new Set(updated.map((node) => node.id))
  selectedNodeIds.value = selectedNodeIds.value.filter((id) =>
    availableIds.has(id),
  )
}

function replaceSubscription(updated: GatewaySubscription) {
  subscriptions.value = subscriptions.value.map((subscription) =>
    subscription.id === updated.id ? updated : subscription,
  )
}

async function loadPage() {
  if (pageBusy.value) return
  loading.value = true
  loadError.value = ''
  try {
    const [nodeResult, subscriptionResult] = await Promise.all([
      api.listNodes(),
      api.listSubscriptions(),
    ])
    replaceNodes(nodeResult.items)
    subscriptions.value = subscriptionResult.items
  } catch (error) {
    loadError.value = gatewayErrorMessage(error)
  } finally {
    loading.value = false
  }
}

async function testNode(node: GatewayNode) {
  setNodeBusy(node.id, true)
  delete nodeMessages.value[node.id]
  try {
    const result = await api.testNode(node.id)
    replaceNode({
      ...node,
      healthy: result.reachable,
      latency: result.latencyMs ?? null,
    })
    nodeMessages.value[node.id] = result.reachable
      ? `检测成功${result.latencyMs === undefined ? '' : ` · ${result.latencyMs} ms`}`
      : `检测失败${result.errorCode ? ` · ${gatewayCodeLabel(result.errorCode)}` : ''}`
  } catch (error) {
    nodeMessages.value[node.id] = gatewayErrorMessage(error)
  } finally {
    setNodeBusy(node.id, false)
  }
}

async function toggleNode(node: GatewayNode) {
  setNodeBusy(node.id, true)
  try {
    const updated = await api.updateNode(node.id, { enabled: !node.enabled })
    replaceNode(updated)
    notice.value = {
      kind: 'success',
      text: `节点“${node.name}”已${updated.enabled ? '启用' : '停用'}`,
    }
  } catch (error) {
    nodeMessages.value[node.id] = gatewayErrorMessage(error)
  } finally {
    setNodeBusy(node.id, false)
  }
}

async function prepareSelectedDelete() {
  if (!selectedNodeIds.value.length || collectingImpact.value) return
  collectingImpact.value = true
  notice.value = null
  try {
    const selected = nodes.value
      .filter((node) => selectedNodeIds.value.includes(node.id))
      .sort((left, right) => left.id.localeCompare(right.id))
    const impacts = await Promise.all(
      selected.map((node) => api.getNodeImpact(node.id)),
    )
    pendingDelete.value = {
      nodes: selected.map(({ id, name }) => ({ id, name })),
      affectedPortIds: Array.from(
        new Set(impacts.flatMap((impact) => impact.affectedPortIds)),
      ).sort((left, right) => left - right),
    }
  } catch (error) {
    notice.value = { kind: 'error', text: gatewayErrorMessage(error) }
  } finally {
    collectingImpact.value = false
  }
}

async function confirmSelectedDelete() {
  if (!pendingDelete.value || deleteBusy.value) return
  deleteBusy.value = true
  const results: DeleteResult[] = []
  const deletedIds = new Set<string>()

  for (const node of pendingDelete.value.nodes) {
    try {
      await api.deleteNode(node.id, true)
      deletedIds.add(node.id)
      results.push({ ...node, ok: true })
    } catch (error) {
      results.push({
        ...node,
        ok: false,
        error: gatewayErrorMessage(error),
      })
    }
  }

  deleteResults.value = results
  nodes.value = nodes.value.filter((node) => !deletedIds.has(node.id))
  selectedNodeIds.value = selectedNodeIds.value.filter(
    (id) => !deletedIds.has(id),
  )
  pendingDelete.value = null
  deleteBusy.value = false
}

function openImport() {
  importPreview.value = null
  importError.value = ''
  importOpen.value = true
}

async function previewImportText(content: string) {
  importBusy.value = true
  importError.value = ''
  try {
    importPreview.value = await api.previewImport({ content })
  } catch (error) {
    importError.value = gatewayErrorMessage(error)
  } finally {
    importBusy.value = false
  }
}

async function previewImportFile(file: File) {
  importBusy.value = true
  importError.value = ''
  try {
    importPreview.value = await api.previewImportFile(file)
  } catch (error) {
    importError.value = gatewayErrorMessage(error)
  } finally {
    importBusy.value = false
  }
}

async function refreshNodesAfterMutation(completedText: string) {
  try {
    replaceNodes((await api.listNodes()).items)
  } catch (error) {
    notice.value = {
      kind: 'error',
      text: `${completedText}，但列表刷新失败：${gatewayErrorMessage(error)}`,
    }
  }
}

async function applyImport() {
  if (!importPreview.value || importBusy.value) return
  importBusy.value = true
  importError.value = ''
  let imported: number
  try {
    const result = await api.applyImport({
      previewId: importPreview.value.previewId,
    })
    imported = result.imported
  } catch (error) {
    importError.value = gatewayErrorMessage(error)
    importBusy.value = false
    return
  }

  importOpen.value = false
  importPreview.value = null
  notice.value = { kind: 'success', text: `已导入 ${imported} 个节点` }
  await refreshNodesAfterMutation('节点已导入')
  importBusy.value = false
}

function openNewSubscription() {
  if (subscriptionBusy.value) return
  editingSubscription.value = null
  subscriptionEditorOpen.value = true
}

function openSubscription(subscription: GatewaySubscription) {
  if (subscriptionBusy.value) return
  editingSubscription.value = subscription
  subscriptionEditorOpen.value = true
}

async function saveSubscription(input: SubscriptionEditorInput) {
  if (subscriptionBusy.value) return
  subscriptionBusy.value = true
  let saved: GatewaySubscription
  let action: '添加' | '更新'
  try {
    if (editingSubscription.value) {
      saved = await api.updateSubscription(editingSubscription.value.id, input)
      replaceSubscription(saved)
      action = '更新'
    } else {
      if (!input.url) {
        notice.value = { kind: 'error', text: '请输入订阅地址' }
        subscriptionBusy.value = false
        return
      }
      saved = await api.createSubscription({
        name: input.name,
        url: input.url,
        intervalMinutes: input.intervalMinutes,
        enabled: input.enabled,
      })
      subscriptions.value = [...subscriptions.value, saved]
      action = '添加'
    }
  } catch (error) {
    notice.value = { kind: 'error', text: gatewayErrorMessage(error) }
    subscriptionBusy.value = false
    return
  }

  subscriptionEditorOpen.value = false
  notice.value = saved.lastError
    ? {
        kind: 'error',
        text: `订阅“${saved.name}”已${action}，但自动同步失败：${gatewayErrorMessage(saved.lastError)}`,
      }
    : { kind: 'success', text: `订阅“${saved.name}”已${action}` }
  await refreshNodesAfterMutation(`订阅“${saved.name}”已${action}`)
  subscriptionBusy.value = false
}

async function syncSubscription(subscription: GatewaySubscription) {
  if (subscriptionBusy.value) return
  subscriptionBusy.value = true
  let updated: GatewaySubscription
  try {
    updated = await api.syncSubscription(subscription.id)
  } catch (error) {
    notice.value = { kind: 'error', text: gatewayErrorMessage(error) }
    subscriptionBusy.value = false
    return
  }

  replaceSubscription(updated)
  notice.value = {
    kind: 'success',
    text: `订阅“${subscription.name}”同步完成`,
  }
  await refreshNodesAfterMutation(`订阅“${subscription.name}”已同步`)
  subscriptionBusy.value = false
}

async function deleteSubscription(subscription: GatewaySubscription) {
  if (subscriptionBusy.value) return
  if (!window.confirm(`确认删除订阅“${subscription.name}”？`)) return
  subscriptionBusy.value = true
  try {
    await api.deleteSubscription(subscription.id)
  } catch (error) {
    notice.value = { kind: 'error', text: gatewayErrorMessage(error) }
    subscriptionBusy.value = false
    return
  }

  subscriptions.value = subscriptions.value.filter(
    (item) => item.id !== subscription.id,
  )
  notice.value = {
    kind: 'success',
    text: `订阅“${subscription.name}”已删除`,
  }
  await refreshNodesAfterMutation(`订阅“${subscription.name}”已删除`)
  subscriptionBusy.value = false
}

onMounted(() => void loadPage())
</script>

<template>
  <main class="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
    <header class="border-b border-slate-200 pb-6">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 class="text-3xl font-black tracking-tight text-slate-950">
            节点
          </h1>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            管理所有端口共享的节点库。检测与停用不会自动改变固定路由或链路跳数。
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
            :disabled="loading || pageBusy"
            @click="loadPage"
          >
            刷新
          </button>
          <button
            type="button"
            data-testid="open-import"
            class="rounded bg-slate-900 px-4 py-2 text-sm font-black text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
            :disabled="loading || pageBusy"
            @click="openImport"
          >
            导入节点
          </button>
        </div>
      </div>
    </header>

    <p
      v-if="loadError"
      role="alert"
      class="mt-5 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-900"
    >
      {{ loadError }}
    </p>
    <p
      v-if="notice"
      role="status"
      class="mt-5 rounded border p-4 text-sm font-semibold"
      :class="
        notice.kind === 'success'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
          : 'border-red-200 bg-red-50 text-red-900'
      "
    >
      {{ notice.text }}
    </p>

    <section class="mt-7" aria-labelledby="node-list-title">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="node-list-title" class="text-lg font-black text-slate-950">
            节点库
          </h2>
          <p class="mt-1 text-sm text-slate-600">
            已选择 {{ selectedCount }} 个节点
          </p>
        </div>
        <button
          type="button"
          data-testid="delete-selected"
          class="rounded border border-red-300 bg-red-50 px-4 py-2 text-sm font-black text-red-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
          :disabled="selectedCount === 0 || pageBusy"
          @click="prepareSelectedDelete"
        >
          {{ collectingImpact ? '正在检查影响…' : '删除所选节点' }}
        </button>
      </div>

      <div
        v-if="loading && nodes.length === 0"
        class="mt-4 rounded border border-slate-200 bg-white p-8 text-center text-sm text-slate-600"
      >
        正在读取节点…
      </div>
      <div v-else class="mt-4 grid gap-3">
        <article
          v-for="node in nodes"
          :key="node.id"
          data-testid="node-row"
          class="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5"
        >
          <div
            class="grid gap-4 sm:grid-cols-[auto_1fr_120px_100px_auto] sm:items-center"
          >
            <input
              v-model="selectedNodeIds"
              type="checkbox"
              :value="node.id"
              :data-testid="`select-node-${node.id}`"
              :aria-label="`选择 ${node.name}`"
              class="h-4 w-4 accent-amber-600"
              :disabled="pageBusy"
            />
            <div class="min-w-0">
              <p class="truncate text-sm font-black text-slate-950">
                {{ node.name }}
              </p>
              <p
                :data-testid="`node-sources-${node.id}`"
                class="mt-1 text-xs text-slate-500"
              >
                来源：{{ nodeSourceLabel(node) }}
              </p>
              <p
                :data-testid="`node-ports-${node.id}`"
                class="mt-1 font-mono text-xs text-slate-500"
              >
                引用端口：{{ nodePortLabel(node) }}
              </p>
            </div>
            <div>
              <p class="mb-1 text-xs font-semibold text-slate-500">协议</p>
              <p class="text-sm font-bold text-slate-800 uppercase">
                {{ node.type }}
              </p>
            </div>
            <div>
              <p class="mb-1 text-xs font-semibold text-slate-500">状态</p>
              <StatusBadge
                :data-testid="`node-health-${node.id}`"
                :health="nodeHealth(node)"
              />
              <p class="mt-1 font-mono text-xs text-slate-500">
                {{ node.latency == null ? '—' : `${node.latency} ms` }}
              </p>
            </div>
            <div class="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                :data-testid="`test-node-${node.id}`"
                class="rounded border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="pageBusy"
                @click="testNode(node)"
              >
                检测
              </button>
              <button
                type="button"
                :data-testid="`toggle-node-${node.id}`"
                class="rounded border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-black text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="pageBusy"
                @click="toggleNode(node)"
              >
                {{ node.enabled ? '停用' : '启用' }}
              </button>
            </div>
          </div>
          <p
            v-if="nodeMessages[node.id]"
            :data-testid="`node-message-${node.id}`"
            role="status"
            class="mt-3 border-t border-slate-100 pt-3 text-sm font-semibold text-slate-700"
          >
            {{ nodeMessages[node.id] }}
          </p>
        </article>
        <p
          v-if="!loading && nodes.length === 0"
          class="rounded border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-600"
        >
          暂无节点，请先导入分享链接或配置文件。
        </p>
      </div>

      <ul
        v-if="deleteResults.length"
        class="mt-4 grid gap-2"
        aria-label="删除结果"
      >
        <li
          v-for="result in deleteResults"
          :key="result.id"
          :data-testid="`delete-result-${result.id}`"
          class="rounded border px-4 py-3 text-sm font-semibold"
          :class="
            result.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          "
        >
          {{ result.name }}：{{ result.ok ? '已删除' : result.error }}
        </li>
      </ul>
    </section>

    <section
      class="mt-10 border-t border-slate-200 pt-7"
      aria-labelledby="subscriptions-title"
    >
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="subscriptions-title"
            class="text-lg font-black text-slate-950"
          >
            订阅
          </h2>
          <p class="mt-1 text-sm text-slate-600">
            维护远程节点来源并按需同步单项订阅。
          </p>
        </div>
        <button
          type="button"
          data-testid="new-subscription"
          class="rounded bg-amber-600 px-4 py-2 text-sm font-black text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
          :disabled="pageBusy"
          @click="openNewSubscription"
        >
          添加订阅
        </button>
      </div>

      <SubscriptionEditor
        v-if="subscriptionEditorOpen"
        class="mt-4"
        :subscription="editingSubscription"
        :busy="subscriptionBusy"
        @save="saveSubscription"
        @cancel="subscriptionEditorOpen = false"
      />

      <div class="mt-4 grid gap-3">
        <article
          v-for="subscription in subscriptions"
          :key="subscription.id"
          class="grid gap-4 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm sm:grid-cols-[1fr_150px_auto] sm:items-center sm:px-5"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-black text-slate-950">
              {{ subscription.name }}
            </p>
            <p class="mt-1 truncate font-mono text-xs text-slate-500">
              {{ subscription.urlMasked }}
            </p>
          </div>
          <div class="text-sm text-slate-700">
            <p>
              <strong>{{ subscription.nodeCount }}</strong> 个节点
            </p>
            <p class="mt-1 text-xs text-slate-500">
              每 {{ subscription.intervalMinutes }} 分钟 ·
              {{ subscription.enabled ? '已启用' : '已停用' }}
            </p>
          </div>
          <div class="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              :data-testid="`edit-subscription-${subscription.id}`"
              class="rounded border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700"
              :disabled="pageBusy"
              @click="openSubscription(subscription)"
            >
              编辑
            </button>
            <button
              type="button"
              :data-testid="`sync-subscription-${subscription.id}`"
              class="rounded border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-black text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="pageBusy"
              @click="syncSubscription(subscription)"
            >
              同步
            </button>
            <button
              type="button"
              :data-testid="`delete-subscription-${subscription.id}`"
              class="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs font-black text-red-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="pageBusy"
              @click="deleteSubscription(subscription)"
            >
              删除
            </button>
          </div>
        </article>
      </div>
    </section>

    <NodeImportDialog
      v-if="importOpen"
      :preview="importPreview"
      :busy="importBusy"
      :error="importError"
      @preview-text="previewImportText"
      @preview-file="previewImportFile"
      @apply="applyImport"
      @cancel="importOpen = false"
    />

    <ConfirmImpactDialog
      v-if="pendingDelete"
      title="确认删除所选节点"
      message="确认后将按稳定节点 ID 顺序逐项删除。失去最后一个候选的链路可能缩短，空链路端口会停用。"
      :affected-port-ids="pendingDelete.affectedPortIds"
      :busy="deleteBusy"
      @confirm="confirmSelectedDelete"
      @cancel="pendingDelete = null"
    />
  </main>
</template>
