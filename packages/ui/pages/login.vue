<script setup lang="ts">
import {
  IconKey,
  IconLock,
  IconNetwork,
  IconShieldLock,
} from '@tabler/icons-vue'

definePageMeta({ layout: 'blank' })

const { t } = useI18n()
const route = useRoute()
const auth = useGatewayAuth()
const password = ref('')
const loading = ref(false)
const errorMessage = ref('')

useHead({ title: computed(() => t('gateway.loginTitle')) })

async function submit() {
  if (!password.value || loading.value) return
  loading.value = true
  errorMessage.value = ''
  try {
    await auth.login(password.value)
    const requested = Array.isArray(route.query.redirect)
      ? route.query.redirect[0]
      : route.query.redirect
    const destination =
      requested?.startsWith('/') && !requested.startsWith('//')
        ? requested
        : '/gateway'
    await navigateTo(destination, { replace: true })
  } catch (error) {
    errorMessage.value = error
      ? controlErrorMessage(error)
      : t('gateway.loginFailed')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main
    class="gateway-login relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 sm:p-8"
  >
    <div
      class="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      <div class="gateway-login__grid absolute inset-0 opacity-40" />
      <div
        class="absolute -top-24 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full bg-primary/12 blur-3xl"
      />
    </div>

    <div
      class="relative grid w-full max-w-4xl overflow-hidden rounded-2xl border border-base-content/10 bg-base-200 lg:grid-cols-[1.1fr_0.9fr]"
    >
      <section
        class="hidden min-h-[34rem] flex-col justify-between border-r border-base-content/10 p-10 lg:flex"
      >
        <div class="flex items-center gap-3">
          <div
            class="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary"
          >
            <IconNetwork :size="22" />
          </div>
          <LogoText />
        </div>
        <div>
          <p
            class="mb-3 font-mono text-xs tracking-[0.18em] text-primary uppercase"
          >
            {{ t('gateway.secureConsole') }}
          </p>
          <h1
            class="max-w-md text-4xl leading-tight font-bold tracking-tight text-base-content"
          >
            {{ t('gateway.loginHeadline') }}
          </h1>
          <p class="mt-4 max-w-md text-sm leading-6 text-base-content/60">
            {{ t('gateway.loginDescription') }}
          </p>
        </div>
        <div class="flex items-center gap-2 text-xs text-base-content/50">
          <IconShieldLock :size="16" class="text-success" />
          {{ t('gateway.sessionProtected') }}
        </div>
      </section>

      <section class="flex min-h-[32rem] items-center p-6 sm:p-10">
        <form class="w-full" @submit.prevent="submit">
          <div class="mb-8 lg:hidden">
            <div class="mb-6 flex items-center gap-3">
              <div
                class="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary"
              >
                <IconNetwork :size="22" />
              </div>
              <LogoText />
            </div>
          </div>

          <div class="mb-7 flex items-start gap-3">
            <div
              class="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-base-300 text-primary"
            >
              <IconLock :size="20" />
            </div>
            <div>
              <h2 class="text-xl font-bold">{{ t('gateway.loginTitle') }}</h2>
              <p class="mt-1 text-xs text-base-content/55">
                {{ t('gateway.loginHint') }}
              </p>
            </div>
          </div>

          <label class="form-control block">
            <span class="mb-2 block text-xs font-semibold text-base-content/70">
              {{ t('gateway.adminPassword') }}
            </span>
            <div
              class="flex items-center rounded-lg border border-base-content/15 bg-base-100 px-3 focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20"
            >
              <IconKey :size="17" class="shrink-0 text-base-content/40" />
              <input
                v-model="password"
                type="password"
                autocomplete="current-password"
                autofocus
                required
                class="min-w-0 flex-1 border-0 bg-transparent px-3 py-3 text-sm outline-none placeholder:text-base-content/35"
                :placeholder="t('gateway.passwordPlaceholder')"
              />
            </div>
          </label>

          <div
            v-if="errorMessage"
            role="alert"
            class="mt-4 rounded-lg border border-error/20 bg-error/10 px-3 py-2.5 text-xs text-error"
          >
            {{ errorMessage }}
          </div>

          <Button
            type="submit"
            :loading="loading"
            :disabled="!password"
            class="mt-6 w-full btn-primary"
          >
            {{ t('gateway.signIn') }}
          </Button>
        </form>
      </section>
    </div>
  </main>
</template>

<style scoped>
.gateway-login {
  background:
    radial-gradient(
      circle at 15% 80%,
      color-mix(in oklab, var(--color-accent) 8%, transparent),
      transparent 32%
    ),
    var(--color-base-100);
}

.gateway-login__grid {
  background-image:
    linear-gradient(
      color-mix(in oklab, var(--color-base-content) 5%, transparent) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      color-mix(in oklab, var(--color-base-content) 5%, transparent) 1px,
      transparent 1px
    );
  background-size: 32px 32px;
}
</style>
