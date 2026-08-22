<script setup lang="ts">
import type { PortDraft } from '~/composables/usePortEditor'
import type {
  GatewayCredential,
  GatewayHealth,
  GatewayMode,
  GatewayNode,
  GatewayPort,
  GatewayPortStatus,
  GatewayStatus,
} from '~/types/gateway'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import PortEditor from '~/components/gateway/PortEditor.vue'
import StatusBadge from '~/components/gateway/StatusBadge.vue'
import { gatewayErrorMessage, gatewayReasonLabel } from '~/utils/gatewayDisplay'

const api = useGatewayApi()
const ports = ref<GatewayPort[]>([])
const nodes = ref<GatewayNode[]>([])
const credentials = ref<GatewayCredential[]>([])
const status = ref<GatewayStatus | null>(null)
const loading = ref(true)
const loadError = ref('')
const statusError = ref('')
const editingPortId = ref<number | null>(null)
const savingPortId = ref<number | null>(null)
const messages = ref<
  Record<number, { kind: 'success' | 'error'; text: string }>
>({})
let statusTimer: ReturnType<typeof setInterval> | undefined
let statusRefreshInFlight = false

const modeLabels: Record<GatewayMode, string> = {
  manual: '固定节点',
  auto: '自动最优',
  failover: '故障切换',
}

const statusByPortId = computed(
  () =>
    new Map<number, GatewayPortStatus>(
      status.value?.ports.map((item) => [item.id, item]) ?? [],
    ),
)
const nodeNames = computed(
  () => new Map(nodes.value.map((node) => [node.id, node.name])),
)

function portHealth(port: GatewayPort): GatewayHealth {
  return (
    statusByPortId.value.get(port.id)?.health ??
    (port.enabled ? 'unknown' : 'disabled')
  )
}

function configuredRoute(port: GatewayPort): string {
  if (port.hops.length === 0) return '未配置链路'
  return port.hops
    .map((hop, index) => `${index + 1}. ${modeLabels[hop.mode]}`)
    .join(' → ')
}

function activeRoute(port: GatewayPort): string {
  const current = statusByPortId.value.get(port.id)
  if (!port.enabled) return '端口已停用'
  if (!current?.hops.length) return '等待运行状态'
  return current.hops
    .map((hop) =>
      hop.activeNodeId
        ? (nodeNames.value.get(hop.activeNodeId) ?? hop.activeNodeId)
        : '尚未选出节点',
    )
    .join(' → ')
}

async function refreshStatus() {
  if (statusRefreshInFlight) return
  statusRefreshInFlight = true
  try {
    status.value = await api.getGatewayStatus()
    statusError.value = ''
  } catch (error) {
    statusError.value = gatewayErrorMessage(error)
  } finally {
    statusRefreshInFlight = false
  }
}

async function loadPage() {
  if (savingPortId.value !== null) return
  loading.value = true
  loadError.value = ''
  try {
    const [portResult, nodeResult, credentialResult, currentStatus] =
      await Promise.all([
        api.listPorts(),
        api.listNodes(),
        api.listCredentials(),
        api.getGatewayStatus(),
      ])
    ports.value = [...portResult.items].sort(
      (left, right) => left.id - right.id,
    )
    nodes.value = nodeResult.items
    credentials.value = credentialResult.items
    status.value = currentStatus
    statusError.value = ''
  } catch (error) {
    loadError.value = gatewayErrorMessage(error)
  } finally {
    loading.value = false
  }
}

async function savePort(port: GatewayPort, body: PortDraft) {
  if (savingPortId.value !== null) return
  savingPortId.value = port.id
  delete messages.value[port.id]
  try {
    const updated = await api.updatePort(port.id, body)
    ports.value = ports.value.map((item) =>
      item.id === updated.id ? updated : item,
    )
    await refreshStatus()
    editingPortId.value = null
    messages.value[port.id] = {
      kind: 'success',
      text: `端口 ${port.port} 已保存并应用`,
    }
  } catch (error) {
    messages.value[port.id] = {
      kind: 'error',
      text: gatewayErrorMessage(error),
    }
  } finally {
    savingPortId.value = null
  }
}

onMounted(() => {
  void loadPage()
  statusTimer = setInterval(() => void refreshStatus(), 5_000)
})

onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer)
})
</script>

<template>
  <main class="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
    <header class="border-b border-slate-200 pb-6">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 class="text-3xl font-black tracking-tight text-slate-950">
            端口
          </h1>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            固定管理
            10001–10010。每个端口独立绑定账号，并配置一跳或两跳出站链路。
          </p>
        </div>
        <button
          type="button"
          data-testid="refresh-ports"
          class="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
          :disabled="savingPortId !== null"
          @click="loadPage"
        >
          刷新
        </button>
      </div>

      <div
        v-if="status?.lastApply"
        class="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-slate-200 bg-white px-4 py-3 text-sm"
      >
        <span class="font-bold text-slate-900">最近应用</span>
        <span
          :class="
            status.lastApply.result === 'success'
              ? 'text-emerald-700'
              : 'text-red-700'
          "
        >
          {{ status.lastApply.result === 'success' ? '成功' : '失败' }}
        </span>
        <span class="font-mono text-xs text-slate-500">
          {{ gatewayReasonLabel(status.lastApply.reason) }}
        </span>
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
      v-else-if="statusError"
      role="status"
      class="mt-5 rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
    >
      运行状态暂时不可用：{{ statusError }}
    </p>

    <div
      v-if="loading && ports.length === 0"
      class="mt-6 rounded border border-slate-200 bg-white p-8 text-center text-sm text-slate-600"
    >
      正在读取端口配置…
    </div>

    <section v-else class="mt-6 grid gap-3" aria-label="固定 SOCKS 端口">
      <article
        v-for="port in ports"
        :key="port.id"
        data-testid="port-row"
        class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
      >
        <div
          class="grid gap-4 px-4 py-4 sm:grid-cols-[140px_120px_1fr_1fr_auto] sm:items-center sm:px-5"
        >
          <div>
            <p class="font-mono text-xs font-bold text-amber-700">
              槽位 {{ String(port.id).padStart(2, '0') }}
            </p>
            <p class="mt-1 font-mono text-lg font-black text-slate-950">
              {{ port.port }}
            </p>
          </div>

          <div>
            <p class="mb-1 text-xs font-semibold text-slate-500">状态</p>
            <StatusBadge :health="portHealth(port)" />
          </div>

          <div>
            <p class="text-xs font-semibold text-slate-500">账号与配置</p>
            <p class="mt-1 text-sm font-bold text-slate-900">
              {{ port.credentialIds.length }} 个账号 ·
              {{ port.hops.length === 0 ? '无跳点' : `${port.hops.length} 跳` }}
            </p>
            <p class="mt-1 text-xs text-slate-600">
              {{ configuredRoute(port) }}
            </p>
          </div>

          <div>
            <p class="text-xs font-semibold text-slate-500">当前活动链路</p>
            <p class="mt-1 text-sm font-semibold break-all text-slate-800">
              {{ activeRoute(port) }}
            </p>
          </div>

          <button
            type="button"
            :data-testid="`edit-port-${port.id}`"
            class="rounded border border-slate-800 bg-slate-900 px-4 py-2 text-sm font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
            :disabled="savingPortId !== null"
            @click="editingPortId = editingPortId === port.id ? null : port.id"
          >
            {{ editingPortId === port.id ? '收起' : '编辑' }}
          </button>
        </div>

        <p
          v-if="messages[port.id]"
          :data-testid="`port-message-${port.id}`"
          role="status"
          class="border-t px-5 py-3 text-sm font-semibold"
          :class="
            messages[port.id]!.kind === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-800'
          "
        >
          {{ messages[port.id]!.text }}
        </p>

        <div
          v-if="editingPortId === port.id"
          class="border-t border-slate-200 bg-slate-50 p-4 sm:p-5"
        >
          <PortEditor
            :port="port"
            :nodes="nodes"
            :credentials="credentials"
            :saving="savingPortId === port.id"
            @save="savePort(port, $event)"
            @cancel="editingPortId = null"
          />
        </div>
      </article>
    </section>
  </main>
</template>
