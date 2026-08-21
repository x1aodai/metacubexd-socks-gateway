<script setup lang="ts">
import { ref } from 'vue'
import Button from '~/components/Button.vue'
import Modal from '~/components/Modal.vue'

interface SecretPayload {
  title: string
  username: string
  password: string
}

const modalRef = ref<InstanceType<typeof Modal> | null>(null)
const title = ref('')
const username = ref('')
const password = ref('')

function open(payload: SecretPayload) {
  title.value = payload.title
  username.value = payload.username
  password.value = payload.password
  modalRef.value?.open()
}

function forget() {
  title.value = ''
  username.value = ''
  password.value = ''
}

function dismiss() {
  modalRef.value?.close()
}

defineExpose({ open })
</script>

<template>
  <Modal ref="modalRef" :title="title" @close="forget">
    <div v-if="password" class="grid gap-4" aria-live="polite">
      <p class="text-sm leading-6 text-slate-700">
        账号 <strong class="font-mono text-slate-950">{{ username }}</strong>
        的密码只显示这一次。关闭后无法再次查看，请立即保存到安全位置。
      </p>
      <code
        data-testid="credential-secret"
        class="block rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 font-mono text-sm font-bold break-all text-amber-950"
        >{{ password }}</code
      >
      <p class="text-xs leading-5 text-slate-500">
        页面不会把该密码保存到账号列表、日志或历史记录中。
      </p>
    </div>

    <template #actions>
      <Button
        data-testid="dismiss-secret"
        class="rounded border border-slate-800 bg-slate-900 px-4 py-2 text-sm font-bold text-white"
        @click="dismiss"
      >
        我已保存，关闭
      </Button>
    </template>
  </Modal>
</template>
