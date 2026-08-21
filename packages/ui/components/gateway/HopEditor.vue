<script setup lang="ts">
import type { GatewayHop, GatewayMode, GatewayNode } from '~/types/gateway'
import { computed } from 'vue'
import StatusBadge from './StatusBadge.vue'

const props = defineProps<{
  hopIndex: number
  modelValue: GatewayHop
  nodes: GatewayNode[]
}>()

const emit = defineEmits<{
  'update:modelValue': [hop: GatewayHop]
  remove: []
}>()

const hopLabel = computed(() => (props.hopIndex === 0 ? '第一跳' : '第二跳'))
const selectedNodes = computed(() =>
  props.modelValue.nodeIds.map((id) => ({
    id,
    name: props.nodes.find((node) => node.id === id)?.name ?? id,
  })),
)

function emitHop(mode: GatewayMode, nodeIds: string[]) {
  emit('update:modelValue', { mode, nodeIds: [...nodeIds] })
}

function updateMode(event: Event) {
  const mode = (event.target as HTMLSelectElement).value as GatewayMode
  const nodeIds =
    mode === 'manual'
      ? props.modelValue.nodeIds.slice(0, 1)
      : props.modelValue.nodeIds
  emitHop(mode, nodeIds)
}

function updateManualNode(event: Event) {
  const nodeId = (event.target as HTMLSelectElement).value
  emitHop('manual', nodeId ? [nodeId] : [])
}

function toggleCandidate(nodeId: string, event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const nodeIds = checked
    ? [...props.modelValue.nodeIds, nodeId]
    : props.modelValue.nodeIds.filter((id) => id !== nodeId)
  emitHop(props.modelValue.mode, nodeIds)
}

function moveCandidate(fromIndex: number, toIndex: number) {
  if (
    props.modelValue.mode !== 'failover' ||
    toIndex < 0 ||
    toIndex >= props.modelValue.nodeIds.length
  )
    return

  const nodeIds = [...props.modelValue.nodeIds]
  const [nodeId] = nodeIds.splice(fromIndex, 1)
  nodeIds.splice(toIndex, 0, nodeId!)
  emitHop('failover', nodeIds)
}

function nodeHealth(node: GatewayNode) {
  if (!node.enabled) return 'disabled' as const
  if (node.healthy === true) return 'healthy' as const
  if (node.healthy === false) return 'unhealthy' as const
  return 'unknown' as const
}
</script>

<template>
  <fieldset class="rounded-lg border border-slate-200 bg-white p-4">
    <legend class="px-1 text-sm font-bold text-slate-900">
      {{ hopLabel }}
    </legend>
    <div
      class="flex flex-wrap items-center gap-3 border-b border-slate-100 pb-3"
    >
      <span class="text-xs text-slate-500">最多两个跳点，按顺序连接</span>
      <button
        type="button"
        class="ml-auto rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700"
        :aria-label="`删除${hopLabel}`"
        @click="emit('remove')"
      >
        删除此跳
      </button>
    </div>

    <label class="mt-4 grid gap-1.5 text-sm font-semibold text-slate-800">
      选择模式
      <select
        :value="modelValue.mode"
        :aria-label="`${hopLabel}模式`"
        class="h-10 rounded border border-slate-300 bg-white px-3 text-sm text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
        @change="updateMode"
      >
        <option value="manual">固定节点</option>
        <option value="auto">自动最优</option>
        <option value="failover">故障切换</option>
      </select>
    </label>

    <label
      v-if="modelValue.mode === 'manual'"
      class="mt-4 grid gap-1.5 text-sm font-semibold text-slate-800"
    >
      固定节点
      <select
        :value="modelValue.nodeIds[0] ?? ''"
        :aria-label="`${hopLabel}固定节点`"
        class="h-10 rounded border border-slate-300 bg-white px-3 text-sm text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
        @change="updateManualNode"
      >
        <option value="">请选择节点</option>
        <option
          v-for="node in nodes"
          :key="node.id"
          :value="node.id"
          :disabled="!node.enabled && !modelValue.nodeIds.includes(node.id)"
        >
          {{ node.name }} · {{ node.type }}{{ node.enabled ? '' : ' · 已停用' }}
        </option>
      </select>
    </label>

    <div v-else class="mt-4">
      <p class="text-sm font-semibold text-slate-800">
        {{ modelValue.mode === 'auto' ? '候选节点' : '故障切换顺序' }}
      </p>
      <p class="mt-1 text-xs text-slate-500">
        {{
          modelValue.mode === 'auto'
            ? '自动选择可用且延迟较低的节点。'
            : '从上到下尝试，使用按钮调整优先级。'
        }}
      </p>

      <div class="mt-3 grid gap-2">
        <label
          v-for="node in nodes"
          :key="node.id"
          class="flex min-h-11 items-center gap-3 rounded border border-slate-200 px-3 py-2 text-sm text-slate-800"
        >
          <input
            type="checkbox"
            :value="node.id"
            :checked="modelValue.nodeIds.includes(node.id)"
            :disabled="!node.enabled && !modelValue.nodeIds.includes(node.id)"
            class="h-4 w-4 accent-amber-600"
            @change="toggleCandidate(node.id, $event)"
          />
          <span class="min-w-0 flex-1 truncate font-medium">{{
            node.name
          }}</span>
          <span class="text-xs text-slate-500 uppercase">{{ node.type }}</span>
          <StatusBadge :health="nodeHealth(node)" />
        </label>
      </div>

      <ol
        v-if="modelValue.mode === 'failover' && selectedNodes.length"
        class="mt-4 grid gap-2 border-t border-slate-100 pt-4"
        aria-label="故障切换顺序"
      >
        <li
          v-for="(node, nodeIndex) in selectedNodes"
          :key="node.id"
          class="flex items-center gap-2 rounded bg-slate-50 px-3 py-2"
        >
          <span
            class="w-6 text-center font-mono text-xs font-bold text-amber-700"
          >
            {{ nodeIndex + 1 }}
          </span>
          <span
            class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800"
          >
            {{ node.name }}
          </span>
          <button
            type="button"
            class="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            :aria-label="`上移 ${node.name}`"
            :disabled="nodeIndex === 0"
            @click="moveCandidate(nodeIndex, nodeIndex - 1)"
          >
            上移
          </button>
          <button
            type="button"
            class="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            :aria-label="`下移 ${node.name}`"
            :disabled="nodeIndex === selectedNodes.length - 1"
            @click="moveCandidate(nodeIndex, nodeIndex + 1)"
          >
            下移
          </button>
        </li>
      </ol>
    </div>
  </fieldset>
</template>
