<script setup lang="ts">
import type { GatewaySubscription } from '~/types/gateway'
import { computed, ref, watch } from 'vue'

export interface SubscriptionEditorInput {
  name: string
  url?: string
  intervalMinutes: number
  enabled: boolean
}

const props = defineProps<{
  subscription: GatewaySubscription | null
  busy: boolean
}>()

const emit = defineEmits<{
  save: [input: SubscriptionEditorInput]
  cancel: []
}>()

const name = ref('')
const url = ref('')
const intervalMinutes = ref(60)
const enabled = ref(true)

function reset() {
  name.value = props.subscription?.name ?? ''
  url.value = ''
  intervalMinutes.value = props.subscription?.intervalMinutes ?? 60
  enabled.value = props.subscription?.enabled ?? true
}

watch(() => props.subscription, reset, { immediate: true })

const errors = computed(() => {
  const result: string[] = []
  if (!name.value.trim()) result.push('请输入订阅名称')
  else if (name.value.trim().length > 100)
    result.push('订阅名称最多 100 个字符')
  if (!props.subscription && !url.value.trim()) result.push('请输入订阅地址')
  if (
    !Number.isInteger(intervalMinutes.value) ||
    intervalMinutes.value < 15 ||
    intervalMinutes.value > 43_200
  )
    result.push('更新间隔必须是 15–43200 的整数分钟')
  return result
})

function submit() {
  if (errors.value.length || props.busy) return
  const nextUrl = url.value.trim()
  emit('save', {
    name: name.value.trim(),
    ...(nextUrl ? { url: nextUrl } : {}),
    intervalMinutes: intervalMinutes.value,
    enabled: enabled.value,
  })
}
</script>

<template>
  <form
    class="grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-5"
    @submit.prevent="submit"
  >
    <header>
      <h3 class="text-lg font-black text-slate-950">
        {{ subscription ? '编辑订阅' : '添加订阅' }}
      </h3>
      <p v-if="subscription" class="mt-1 text-xs text-slate-500">
        当前地址：{{ subscription.urlMasked }}。地址留空表示保持不变。
      </p>
    </header>

    <label class="grid gap-1.5 text-sm font-bold text-slate-800">
      订阅名称
      <input
        v-model="name"
        type="text"
        required
        maxlength="100"
        class="h-10 rounded border border-slate-300 bg-white px-3 font-normal text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
      />
    </label>

    <label class="grid gap-1.5 text-sm font-bold text-slate-800">
      订阅地址{{ subscription ? '（可选）' : '' }}
      <input
        v-model="url"
        type="url"
        :required="!subscription"
        autocomplete="off"
        class="h-10 rounded border border-slate-300 bg-white px-3 font-normal text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
        placeholder="https://example.com/subscription"
      />
    </label>

    <label class="grid gap-1.5 text-sm font-bold text-slate-800">
      更新间隔（分钟）
      <input
        v-model.number="intervalMinutes"
        type="number"
        min="15"
        max="43200"
        step="1"
        required
        class="h-10 rounded border border-slate-300 bg-white px-3 font-normal text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
      />
    </label>

    <label class="flex items-center gap-3 text-sm font-bold text-slate-800">
      <input
        v-model="enabled"
        type="checkbox"
        class="h-4 w-4 accent-amber-600"
      />
      启用自动同步
    </label>

    <div
      v-if="errors.length"
      role="alert"
      class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900"
    >
      <ul class="list-disc space-y-1 pl-5">
        <li v-for="error in errors" :key="error">{{ error }}</li>
      </ul>
    </div>

    <footer class="flex justify-end gap-3 border-t border-slate-200 pt-4">
      <button
        type="button"
        class="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700"
        :disabled="busy"
        @click="emit('cancel')"
      >
        取消
      </button>
      <button
        type="submit"
        class="rounded bg-amber-600 px-4 py-2 text-sm font-black text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        :disabled="busy || errors.length > 0"
      >
        {{ busy ? '正在保存…' : '保存订阅' }}
      </button>
    </footer>
  </form>
</template>
