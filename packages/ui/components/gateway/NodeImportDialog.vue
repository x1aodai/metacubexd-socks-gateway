<script setup lang="ts">
import type { GatewayImportPreview } from '~/types/gateway'
import { onMounted, ref } from 'vue'
import Modal from '~/components/Modal.vue'
import { gatewayErrorMessage } from '~/utils/gatewayDisplay'

defineProps<{
  preview: GatewayImportPreview | null
  busy: boolean
  error: string
}>()

const emit = defineEmits<{
  'preview-text': [content: string]
  'preview-file': [file: File]
  apply: []
  cancel: []
}>()

const modalRef = ref<InstanceType<typeof Modal> | null>(null)
const content = ref('')
const formatLabels: Readonly<Record<string, string>> = {
  'mihomo-config': 'Mihomo 配置',
  provider: '代理提供者配置',
  links: '分享链接',
  'base64-links': 'Base64 分享链接',
  unknown: '未知格式',
}

function previewText() {
  const value = content.value.trim()
  if (value) emit('preview-text', value)
}

function previewFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) emit('preview-file', file)
}

function dismiss() {
  modalRef.value?.close()
}

onMounted(() => modalRef.value?.open())
</script>

<template>
  <Modal
    ref="modalRef"
    title="导入节点"
    size="xl"
    :before-close="() => !busy"
    @close="emit('cancel')"
  >
    <div class="grid gap-5">
      <p class="text-sm text-slate-600">
        粘贴分享链接、Mihomo YAML 或
        JSON，也可以选择本地文件。预览不会修改现有节点。
      </p>

      <label class="grid gap-2 text-sm font-bold text-slate-800">
        文本内容
        <textarea
          v-model="content"
          rows="7"
          class="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm font-normal text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
          placeholder="粘贴 vless://、trojan:// 或完整配置"
        />
      </label>

      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="preview-text"
          class="rounded bg-slate-900 px-4 py-2 text-sm font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:cursor-not-allowed disabled:bg-slate-300"
          :disabled="busy || !content.trim()"
          @click="previewText"
        >
          预览文本
        </button>
        <label
          class="cursor-pointer rounded border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-800 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-amber-600"
        >
          选择文件并预览
          <input
            type="file"
            class="sr-only"
            accept=".txt,.yaml,.yml,.json,text/plain,application/json,application/yaml"
            :disabled="busy"
            @change="previewFile"
          />
        </label>
        <span v-if="busy" role="status" class="text-sm text-slate-600">
          正在处理预览…
        </span>
      </div>

      <p
        v-if="error"
        role="alert"
        class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
      >
        {{ error }}
      </p>

      <section
        v-if="preview"
        class="rounded-xl border border-amber-200 bg-amber-50 p-4"
        aria-labelledby="import-preview-title"
      >
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="import-preview-title" class="font-black text-amber-950">
              导入预览
            </h3>
            <p class="mt-1 text-sm text-amber-900">
              {{ preview.validCount }} 个有效节点 ·
              {{ preview.skippedCount }} 个跳过
            </p>
          </div>
          <span class="text-xs font-bold text-amber-800">
            {{ formatLabels[preview.format] ?? '未知格式' }}
          </span>
        </div>

        <ul class="mt-4 grid gap-2 sm:grid-cols-2">
          <li
            v-for="node in preview.nodes"
            :key="node.id"
            class="rounded border border-amber-200 bg-white px-3 py-2 text-sm"
          >
            <span class="font-bold text-slate-900">{{ node.name }}</span>
            <span class="ml-2 text-xs text-slate-500 uppercase">
              {{ node.type }}
            </span>
          </li>
        </ul>

        <ul
          v-if="preview.issues.length || preview.errors.length"
          class="mt-4 list-disc space-y-1 pl-5 text-sm text-red-800"
        >
          <li
            v-for="issue in preview.issues"
            :key="`${issue.code}-${issue.index}`"
          >
            {{ gatewayErrorMessage(issue.message) }}
          </li>
          <template v-if="preview.issues.length === 0">
            <li v-for="message in preview.errors" :key="message">
              {{ gatewayErrorMessage(message) }}
            </li>
          </template>
        </ul>
      </section>
    </div>

    <template #actions>
      <button
        type="button"
        data-testid="cancel-import"
        class="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700"
        :disabled="busy"
        @click="dismiss"
      >
        取消
      </button>
      <button
        type="button"
        data-testid="apply-import"
        class="rounded bg-amber-600 px-4 py-2 text-sm font-black text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        :disabled="busy || !preview || preview.validCount === 0"
        @click="emit('apply')"
      >
        确认导入
      </button>
    </template>
  </Modal>
</template>
