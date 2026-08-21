<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Modal from '~/components/Modal.vue'

const props = defineProps<{
  title: string
  message: string
  affectedPortIds: number[]
  busy: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const modalRef = ref<InstanceType<typeof Modal> | null>(null)

function dismiss() {
  modalRef.value?.close()
}

onMounted(() => modalRef.value?.open())
</script>

<template>
  <Modal
    ref="modalRef"
    :title="title"
    :before-close="() => !props.busy"
    @close="emit('cancel')"
  >
    <div data-testid="impact-dialog">
      <p class="text-sm leading-6 text-red-900">{{ message }}</p>
      <p class="mt-5 text-sm font-bold text-slate-900">受影响端口</p>
      <ul v-if="affectedPortIds.length" class="mt-3 flex flex-wrap gap-2">
        <li
          v-for="portId in affectedPortIds"
          :key="portId"
          class="rounded border border-red-200 bg-red-50 px-3 py-1.5 font-mono text-sm font-bold text-red-900"
        >
          {{ 10000 + portId }}
        </li>
      </ul>
      <p v-else class="mt-2 text-sm text-slate-600">没有端口引用所选项目。</p>
    </div>

    <template #actions>
      <button
        type="button"
        class="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700"
        :disabled="busy"
        @click="dismiss"
      >
        取消
      </button>
      <button
        type="button"
        data-testid="confirm-impact"
        class="rounded bg-red-700 px-4 py-2 text-sm font-black text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        :disabled="busy"
        @click="emit('confirm')"
      >
        {{ busy ? '正在处理…' : '确认继续' }}
      </button>
    </template>
  </Modal>
</template>
