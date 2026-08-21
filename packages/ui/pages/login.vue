<script setup lang="ts">
import { IconLock } from '@tabler/icons-vue'

definePageMeta({ layout: 'blank' })

const auth = useGatewayAuth()
const password = ref('')
const loading = ref(false)
const errorMessage = ref('')

useHead({ title: '管理员登录' })

async function submit() {
  if (!password.value || loading.value) return
  loading.value = true
  errorMessage.value = ''

  try {
    const state = await auth.login(password.value)
    if (state !== 'authenticated') {
      errorMessage.value = '登录失败，请检查管理员密码后重试。'
      return
    }
    await navigateTo('/ports', { replace: true })
  } catch {
    errorMessage.value = '登录失败，请检查管理员密码后重试。'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-base-100 p-4">
    <section
      class="w-full max-w-sm rounded-2xl border border-base-300 bg-base-200 p-6 shadow-sm sm:p-8"
    >
      <LogoText />

      <div class="mt-8 flex items-start gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
        >
          <IconLock :size="20" aria-hidden="true" />
        </span>
        <div>
          <h1 class="text-xl font-bold">管理员登录</h1>
          <p class="mt-1 text-sm text-base-content/60">
            输入管理员密码进入 SOCKS 网关。
          </p>
        </div>
      </div>

      <form class="mt-6" @submit.prevent="submit">
        <label for="admin-password" class="block text-sm font-medium">
          管理员密码
        </label>
        <input
          id="admin-password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          autofocus
          required
          class="mt-2 w-full rounded-lg border border-base-300 bg-base-100 px-3 py-2.5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          placeholder="请输入管理员密码"
        />

        <p
          v-if="errorMessage"
          role="alert"
          class="mt-3 rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-sm text-error"
        >
          {{ errorMessage }}
        </p>

        <Button
          type="submit"
          :loading="loading"
          :disabled="!password"
          class="mt-5 w-full btn-primary"
        >
          登录
        </Button>
      </form>
    </section>
  </main>
</template>
