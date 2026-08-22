<script setup lang="ts">
import type { PortDraft } from '~/composables/usePortEditor'
import type {
  GatewayCredential,
  GatewayHop,
  GatewayMode,
  GatewayNode,
  GatewayPort,
} from '~/types/gateway'
import { computed, watch } from 'vue'
import { previewGatewayChain, usePortEditor } from '~/composables/usePortEditor'
import HopEditor from './HopEditor.vue'

const props = withDefaults(
  defineProps<{
    port: GatewayPort
    nodes: GatewayNode[]
    credentials: GatewayCredential[]
    saving?: boolean
  }>(),
  { saving: false },
)

const emit = defineEmits<{
  save: [body: PortDraft]
  cancel: []
}>()

const { draft, errors, reset, addHop, removeHop } = usePortEditor(props.port)

const resourceErrors = computed(() => {
  if (!draft.value.enabled) return []
  const messages: string[] = []
  const enabledCredentialIds = new Set(
    props.credentials
      .filter((credential) => credential.enabled)
      .map((credential) => credential.id),
  )
  const enabledNodeIds = new Set(
    props.nodes.filter((node) => node.enabled).map((node) => node.id),
  )
  if (!draft.value.credentialIds.some((id) => enabledCredentialIds.has(id)))
    messages.push('启用端口至少绑定一个已启用账号')
  for (const [index, hop] of draft.value.hops.entries()) {
    if (!hop.nodeIds.some((id) => enabledNodeIds.has(id)))
      messages.push(
        `${index === 0 ? '第一跳' : '第二跳'}至少选择一个已启用节点`,
      )
  }
  return messages
})
const allErrors = computed(() => [...errors.value, ...resourceErrors.value])
const canSave = computed(
  () =>
    errors.value.length === 0 &&
    resourceErrors.value.length === 0 &&
    !props.saving,
)

watch(
  () => props.port,
  (port) => reset(port),
)

const modeLabels: Record<GatewayMode, string> = {
  manual: '固定节点',
  auto: '自动最优',
  failover: '故障切换',
}

function toggleCredential(credentialId: string, event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  draft.value.credentialIds = checked
    ? [...draft.value.credentialIds, credentialId]
    : draft.value.credentialIds.filter((id) => id !== credentialId)
}

function updateHop(index: number, hop: GatewayHop) {
  draft.value.hops[index] = {
    mode: hop.mode,
    nodeIds: [...hop.nodeIds],
  }
}

function nodeName(id: string) {
  return props.nodes.find((node) => node.id === id)?.name ?? id
}

function save() {
  if (!canSave.value) return
  emit('save', {
    enabled: draft.value.enabled,
    credentialIds: [...draft.value.credentialIds],
    hops: previewGatewayChain(draft.value),
  })
}
</script>

<template>
  <form
    class="grid gap-5 rounded-xl border border-slate-200 bg-slate-50 p-5 text-slate-900 shadow-sm"
    @submit.prevent="save"
  >
    <header
      class="flex flex-wrap items-start gap-4 border-b border-slate-200 pb-4"
    >
      <div>
        <p class="font-mono text-xs font-bold tracking-widest text-amber-700">
          端口槽位 {{ String(port.id).padStart(2, '0') }}
        </p>
        <h2 class="mt-1 text-xl font-black tracking-tight">
          SOCKS {{ port.port }}
        </h2>
        <p class="mt-1 text-sm text-slate-600">固定端口号不可修改</p>
      </div>
      <label
        class="ml-auto flex items-center gap-3 rounded-lg border border-slate-300 bg-white px-3 py-2"
      >
        <span class="text-sm font-bold text-slate-800">启用端口</span>
        <input
          v-model="draft.enabled"
          type="checkbox"
          aria-label="启用端口"
          class="h-5 w-5 accent-amber-600"
        />
      </label>
    </header>

    <section aria-labelledby="port-credentials-title">
      <div class="flex items-end justify-between gap-4">
        <div>
          <h3
            id="port-credentials-title"
            class="text-sm font-black text-slate-900"
          >
            允许登录的账号
          </h3>
          <p class="mt-1 text-xs text-slate-500">
            启用端口至少需要一个已启用账号
          </p>
        </div>
        <span class="font-mono text-xs font-bold text-slate-500">
          {{ draft.credentialIds.length }} 已绑定
        </span>
      </div>

      <div class="mt-3 grid gap-2 sm:grid-cols-2">
        <label
          v-for="credential in credentials"
          :key="credential.id"
          class="flex min-h-11 items-center gap-3 rounded border border-slate-200 bg-white px-3 py-2 text-sm"
        >
          <input
            type="checkbox"
            :value="credential.id"
            :checked="draft.credentialIds.includes(credential.id)"
            :disabled="
              !credential.enabled &&
              !draft.credentialIds.includes(credential.id)
            "
            class="h-4 w-4 accent-amber-600 disabled:cursor-not-allowed"
            @change="toggleCredential(credential.id, $event)"
          />
          <span class="min-w-0 flex-1 truncate font-semibold text-slate-800">
            {{ credential.username }}
          </span>
          <span
            class="rounded border px-2 py-0.5 text-xs font-semibold"
            :class="
              credential.enabled
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-slate-200 bg-slate-100 text-slate-500'
            "
          >
            {{ credential.enabled ? '可用' : '已停用' }}
          </span>
        </label>
      </div>
    </section>

    <section aria-labelledby="port-route-title">
      <div class="flex items-end justify-between gap-4">
        <div>
          <h3 id="port-route-title" class="text-sm font-black text-slate-900">
            出站链路
          </h3>
          <p class="mt-1 text-xs text-slate-500">按第一跳、第二跳的顺序连接</p>
        </div>
        <button
          type="button"
          data-testid="add-hop"
          class="rounded border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
          :disabled="draft.hops.length >= 2"
          @click="addHop"
        >
          添加一跳
        </button>
      </div>

      <div class="mt-3 grid gap-3">
        <HopEditor
          v-for="(hop, index) in draft.hops"
          :key="index"
          :hop-index="index"
          :model-value="hop"
          :nodes="nodes"
          @update:model-value="updateHop(index, $event)"
          @remove="removeHop(index)"
        />
        <div
          v-if="draft.hops.length === 0"
          class="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500"
        >
          尚未配置跳点。停用端口可以保留空链路。
        </div>
      </div>
    </section>

    <section
      data-testid="chain-preview"
      class="rounded-lg border border-amber-200 bg-amber-50 p-4"
      aria-labelledby="chain-preview-title"
    >
      <h3 id="chain-preview-title" class="text-sm font-black text-amber-950">
        链路预览
      </h3>
      <ol
        v-if="draft.hops.length"
        class="mt-2 grid gap-1.5 text-sm text-amber-950"
      >
        <li v-for="(hop, index) in draft.hops" :key="index">
          {{ index === 0 ? '第一跳' : '第二跳' }} · {{ modeLabels[hop.mode] }} ·
          {{ hop.nodeIds.map(nodeName).join('、') || '未选择节点' }}
        </li>
      </ol>
      <p v-else class="mt-2 text-sm text-amber-900">当前没有出站链路</p>
    </section>

    <div
      v-if="allErrors.length"
      role="alert"
      class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900"
    >
      <p class="font-black">请先修正以下问题</p>
      <ul class="mt-2 list-disc space-y-1 pl-5">
        <li v-for="error in allErrors" :key="error">{{ error }}</li>
      </ul>
    </div>

    <footer class="flex justify-end gap-3 border-t border-slate-200 pt-4">
      <button
        type="button"
        data-testid="cancel-port"
        class="rounded border border-slate-300 bg-white px-5 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700"
        :disabled="saving"
        @click="emit('cancel')"
      >
        取消
      </button>
      <button
        type="submit"
        data-testid="save-port"
        class="rounded bg-amber-600 px-5 py-2.5 text-sm font-black text-white hover:bg-amber-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600"
        :disabled="!canSave"
      >
        {{ saving ? '正在应用…' : '确认保存并应用' }}
      </button>
    </footer>
  </form>
</template>
