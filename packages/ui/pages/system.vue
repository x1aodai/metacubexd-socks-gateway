<script setup lang="ts">
import type {
  GatewayHealth,
  GatewayRevision,
  GatewayStatus,
  GatewaySubscriptionRefreshItem,
} from '~/types/gateway'
import { computed, onMounted, ref } from 'vue'
import StatusBadge from '~/components/gateway/StatusBadge.vue'
import {
  gatewayCodeLabel,
  gatewayErrorMessage,
  gatewayReasonLabel,
} from '~/utils/gatewayDisplay'

const api = useGatewayApi()
const auth = useGatewayAuth()
const status = ref<GatewayStatus | null>(null)
const revisions = ref<GatewayRevision[]>([])
const loading = ref(true)
const loadError = ref('')
const busyAction = ref<'reapply' | 'subscriptions' | 'password' | null>(null)
const actionMessage = ref<{ kind: 'success' | 'error'; text: string } | null>(
  null,
)
const refreshItems = ref<GatewaySubscriptionRefreshItem[]>([])
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const passwordMessage = ref<{ kind: 'success' | 'error'; text: string } | null>(
  null,
)

const stateLabels: Readonly<Record<string, string>> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  errored: '异常',
  unknown: '未知',
}

const services = computed(() => {
  if (!status.value) return []
  return [
    {
      name: 'Web',
      state: stateLabels[status.value.services.web.state] ?? '未知',
      health: status.value.services.web.health as GatewayHealth,
      version: status.value.versions.web,
      detail: '管理面板',
    },
    {
      name: 'Agent',
      state: stateLabels[status.value.services.agent.state] ?? '未知',
      health: status.value.services.agent.health as GatewayHealth,
      version: status.value.versions.agent,
      detail: '配置与运行控制',
    },
    {
      name: 'Mihomo',
      state: stateLabels[status.value.services.mihomo.state] ?? '未知',
      health: status.value.services.mihomo.health as GatewayHealth,
      version: status.value.versions.mihomo ?? '未知',
      detail: status.value.services.mihomo.controllerReachable
        ? '控制器可连接'
        : '控制器不可连接',
    },
  ]
})

const refreshSummary = computed(() => {
  const success = refreshItems.value.filter((item) => item.ok).length
  return {
    success,
    failed: refreshItems.value.length - success,
  }
})

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value))
}

async function loadSystem() {
  if (busyAction.value) return
  loading.value = true
  loadError.value = ''
  try {
    await refreshSystemView()
  } catch (error) {
    loadError.value = gatewayErrorMessage(error)
  } finally {
    loading.value = false
  }
}

async function refreshSystemView() {
  const [currentStatus, revisionResult] = await Promise.all([
    api.getGatewayStatus(),
    api.listRevisions(),
  ])
  status.value = currentStatus
  revisions.value = [...revisionResult.items]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 5)
}

async function reapply() {
  if (busyAction.value) return
  busyAction.value = 'reapply'
  actionMessage.value = null
  try {
    await api.reapplyGateway()
  } catch (error) {
    actionMessage.value = { kind: 'error', text: gatewayErrorMessage(error) }
    busyAction.value = null
    return
  }

  actionMessage.value = { kind: 'success', text: '当前配置已重新应用。' }
  try {
    await refreshSystemView()
  } catch (error) {
    actionMessage.value = {
      kind: 'error',
      text: `配置已重新应用，但状态刷新失败：${gatewayErrorMessage(error)}`,
    }
  }
  busyAction.value = null
}

async function refreshSubscriptions() {
  if (busyAction.value) return
  busyAction.value = 'subscriptions'
  actionMessage.value = null
  refreshItems.value = []
  let result: GatewaySubscriptionRefreshItem[]
  try {
    result = (await api.refreshSubscriptions()).items
  } catch (error) {
    actionMessage.value = { kind: 'error', text: gatewayErrorMessage(error) }
    busyAction.value = null
    return
  }

  refreshItems.value = result
  actionMessage.value = {
    kind: result.every((item) => item.ok) ? 'success' : 'error',
    text: result.length === 0 ? '没有需要刷新的订阅。' : '订阅刷新已完成。',
  }
  try {
    await refreshSystemView()
  } catch (error) {
    actionMessage.value = {
      kind: 'error',
      text: `订阅已刷新，但系统状态刷新失败：${gatewayErrorMessage(error)}`,
    }
  }
  busyAction.value = null
}

async function changePassword() {
  if (busyAction.value) return
  passwordMessage.value = null
  if (newPassword.value.length < 12 || newPassword.value.length > 256) {
    passwordMessage.value = {
      kind: 'error',
      text: '新密码长度必须为 12–256 个字符。',
    }
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    passwordMessage.value = {
      kind: 'error',
      text: '两次输入的新密码不一致。',
    }
    return
  }

  busyAction.value = 'password'
  try {
    await api.changePassword(currentPassword.value, newPassword.value)
  } catch (error) {
    passwordMessage.value = {
      kind: 'error',
      text: gatewayErrorMessage(error),
    }
    busyAction.value = null
    return
  }

  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  passwordMessage.value = {
    kind: 'success',
    text: '管理员密码已修改，请重新登录。',
  }
  await auth.logout().catch(() => undefined)
  try {
    await navigateTo('/login', { replace: true })
  } catch {
    passwordMessage.value = {
      kind: 'success',
      text: '管理员密码已修改，请手动返回登录页。',
    }
  }
  busyAction.value = null
}

onMounted(() => void loadSystem())
</script>

<template>
  <main class="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
    <header
      class="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-6"
    >
      <div>
        <h1 class="text-3xl font-black tracking-tight text-slate-950">系统</h1>
        <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          查看核心服务和固定端口状态，并执行少量必要的维护操作。
        </p>
      </div>
      <button
        type="button"
        class="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
        :disabled="loading || busyAction !== null"
        @click="loadSystem"
      >
        刷新状态
      </button>
    </header>

    <p
      v-if="loadError"
      role="alert"
      class="mt-5 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-900"
    >
      {{ loadError }}
    </p>

    <div
      v-if="loading && !status"
      class="mt-6 rounded border border-slate-200 bg-white p-8 text-center text-sm text-slate-600"
    >
      正在读取系统状态…
    </div>

    <template v-else-if="status">
      <section class="mt-6 grid gap-3 md:grid-cols-3" aria-label="核心服务">
        <article
          v-for="service in services"
          :key="service.name"
          class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-lg font-black text-slate-950">
                {{ service.name }}
              </h2>
              <p class="mt-1 text-xs text-slate-500">{{ service.detail }}</p>
            </div>
            <StatusBadge :health="service.health" />
          </div>
          <dl
            class="mt-5 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 text-sm"
          >
            <div>
              <dt class="text-xs font-semibold text-slate-500">运行状态</dt>
              <dd class="mt-1 font-mono font-bold text-slate-800">
                {{ service.state }}
              </dd>
            </div>
            <div>
              <dt class="text-xs font-semibold text-slate-500">版本</dt>
              <dd class="mt-1 font-mono font-bold break-all text-slate-800">
                {{ service.version }}
              </dd>
            </div>
          </dl>
        </article>
      </section>

      <section
        class="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 class="text-lg font-black text-slate-950">维护操作</h2>
            <p class="mt-1 text-sm text-slate-600">
              重新应用只使用已保存配置，不会改变端口或节点选择。
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="reapply-gateway"
              class="rounded border border-slate-800 bg-slate-900 px-4 py-2 text-sm font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:cursor-not-allowed disabled:bg-slate-300"
              :disabled="busyAction !== null"
              @click="reapply"
            >
              {{ busyAction === 'reapply' ? '正在应用…' : '重新应用配置' }}
            </button>
            <button
              type="button"
              data-testid="refresh-subscriptions"
              class="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:cursor-not-allowed disabled:text-slate-400"
              :disabled="busyAction !== null"
              @click="refreshSubscriptions"
            >
              {{
                busyAction === 'subscriptions' ? '正在刷新…' : '刷新全部订阅'
              }}
            </button>
          </div>
        </div>

        <p
          v-if="actionMessage"
          data-testid="system-action-message"
          role="status"
          class="mt-4 rounded border px-4 py-3 text-sm font-semibold"
          :class="
            actionMessage.kind === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-800'
          "
        >
          {{ actionMessage.text }}
        </p>

        <div
          v-if="refreshItems.length"
          data-testid="subscription-refresh-result"
          class="mt-4 rounded border border-slate-200 bg-slate-50 p-4 text-sm"
        >
          <p class="font-bold text-slate-900">
            {{ refreshSummary.success }} 项成功，{{ refreshSummary.failed }}
            项失败
          </p>
          <ul class="mt-2 grid gap-1 text-xs text-slate-700">
            <li v-for="item in refreshItems" :key="item.id">
              {{ item.id }}：{{
                item.ok
                  ? `${item.nodeCount} 个节点`
                  : gatewayErrorMessage(item.error)
              }}
            </li>
          </ul>
        </div>
      </section>

      <section
        class="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
      >
        <div class="border-b border-slate-200 px-5 py-4">
          <h2 class="text-lg font-black text-slate-950">SOCKS 监听端口</h2>
          <p class="mt-1 text-sm text-slate-600">固定为 TCP 10001–10010。</p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead class="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th class="px-5 py-3 font-bold">槽位</th>
                <th class="px-5 py-3 font-bold">端口</th>
                <th class="px-5 py-3 font-bold">配置</th>
                <th class="px-5 py-3 font-bold">监听状态</th>
                <th class="px-5 py-3 font-bold">探测</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr
                v-for="listener in status.listeners"
                :key="listener.id"
                data-testid="listener-row"
              >
                <td class="px-5 py-3 font-mono text-xs text-amber-700">
                  {{ String(listener.id).padStart(2, '0') }}
                </td>
                <td class="px-5 py-3 font-mono font-bold text-slate-950">
                  {{ listener.port }}
                </td>
                <td class="px-5 py-3 text-slate-700">
                  {{ listener.enabled ? '已启用' : '已停用' }}
                </td>
                <td class="px-5 py-3">
                  <StatusBadge :health="listener.health" />
                </td>
                <td class="px-5 py-3 text-slate-700">
                  {{
                    listener.reachable === null
                      ? '未探测'
                      : listener.reachable
                        ? '可连接'
                        : listener.errorCode
                          ? gatewayCodeLabel(listener.errorCode)
                          : '不可连接'
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="mt-6 grid gap-6 lg:grid-cols-2">
        <section
          class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h2 class="text-lg font-black text-slate-950">最近应用</h2>
          <div
            v-if="status.lastApply"
            class="mt-4 rounded border border-slate-200 p-4 text-sm"
          >
            <p class="font-bold text-slate-900">
              {{
                status.lastApply.result === 'success' ? '应用成功' : '应用失败'
              }}
            </p>
            <p class="mt-1 font-mono text-xs text-slate-600">
              {{ formatTime(status.lastApply.at) }} ·
              {{ gatewayReasonLabel(status.lastApply.reason) }}
            </p>
            <p v-if="status.lastApply.errorCode" class="mt-2 text-red-700">
              {{ gatewayCodeLabel(status.lastApply.errorCode) }}
            </p>
          </div>
          <p v-else class="mt-4 text-sm text-slate-500">尚无应用记录。</p>

          <h3
            class="mt-5 border-t border-slate-100 pt-4 text-sm font-black text-slate-900"
          >
            最近保存版本
          </h3>
          <ul
            v-if="revisions.length"
            class="mt-3 grid gap-2 text-xs text-slate-700"
          >
            <li
              v-for="revision in revisions"
              :key="revision.id"
              class="flex flex-wrap justify-between gap-2 rounded bg-slate-50 px-3 py-2"
            >
              <span class="font-mono">{{
                gatewayReasonLabel(revision.reason)
              }}</span>
              <span>{{ formatTime(revision.createdAt) }}</span>
            </li>
          </ul>
          <p v-else class="mt-3 text-sm text-slate-500">尚无保存版本。</p>
        </section>

        <section
          class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h2 class="text-lg font-black text-slate-950">修改管理员密码</h2>
          <p class="mt-1 text-sm text-slate-600">
            新密码需要 12–256 个字符；修改后所有会话立即失效。
          </p>
          <form
            data-testid="password-form"
            class="mt-4 grid gap-3"
            @submit.prevent="changePassword"
          >
            <label class="grid gap-1.5 text-sm font-semibold text-slate-800">
              当前密码
              <input
                v-model="currentPassword"
                data-testid="current-password"
                type="password"
                autocomplete="current-password"
                required
                class="h-10 rounded border border-slate-300 bg-white px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
              />
            </label>
            <label class="grid gap-1.5 text-sm font-semibold text-slate-800">
              新密码
              <input
                v-model="newPassword"
                data-testid="new-password"
                type="password"
                autocomplete="new-password"
                required
                minlength="12"
                maxlength="256"
                class="h-10 rounded border border-slate-300 bg-white px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
              />
            </label>
            <label class="grid gap-1.5 text-sm font-semibold text-slate-800">
              再次输入新密码
              <input
                v-model="confirmPassword"
                data-testid="confirm-password"
                type="password"
                autocomplete="new-password"
                required
                class="h-10 rounded border border-slate-300 bg-white px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
              />
            </label>

            <p
              v-if="passwordMessage"
              data-testid="password-message"
              role="status"
              class="rounded border px-3 py-2 text-sm"
              :class="
                passwordMessage.kind === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-red-200 bg-red-50 text-red-800'
              "
            >
              {{ passwordMessage.text }}
            </p>

            <button
              type="submit"
              class="mt-1 rounded bg-amber-600 px-4 py-2.5 text-sm font-black text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              :disabled="busyAction !== null"
            >
              {{ busyAction === 'password' ? '正在修改…' : '修改密码' }}
            </button>
          </form>
        </section>
      </div>
    </template>
  </main>
</template>
