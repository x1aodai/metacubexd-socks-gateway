<script setup lang="ts">
import type { GatewayHealth } from '~/types/gateway'
import { computed } from 'vue'

const props = defineProps<{
  health: GatewayHealth
}>()

const status = computed(() => {
  switch (props.health) {
    case 'healthy':
      return {
        label: '正常',
        className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
      }
    case 'unhealthy':
      return {
        label: '异常',
        className: 'border-red-200 bg-red-50 text-red-800',
      }
    case 'disabled':
      return {
        label: '已停用',
        className: 'border-slate-200 bg-slate-100 text-slate-600',
      }
    default:
      return {
        label: '未知',
        className: 'border-amber-200 bg-amber-50 text-amber-800',
      }
  }
})
</script>

<template>
  <span
    role="status"
    :data-health="health"
    class="inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold"
    :class="status.className"
  >
    {{ status.label }}
  </span>
</template>
