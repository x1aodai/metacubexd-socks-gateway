<script setup lang="ts">
import type { GatewayCredential } from '~/types/gateway'
import { onMounted, ref } from 'vue'
import Button from '~/components/Button.vue'
import CredentialSecretDialog from '~/components/gateway/CredentialSecretDialog.vue'
import { gatewayErrorMessage } from '~/utils/gatewayDisplay'

interface CredentialDraft {
  id: string
  username: string
  enabled: boolean
  portIds: number[]
}

interface Feedback {
  kind: 'success' | 'error'
  text: string
}

const api = useGatewayApi()
const portOptions = Array.from({ length: 10 }, (_, index) => ({
  id: index + 1,
  port: 10001 + index,
}))

const credentials = ref<GatewayCredential[]>([])
const loading = ref(true)
const loadError = ref('')
const feedback = ref<Feedback | null>(null)
const busyAction = ref<string | null>(null)
const editDraft = ref<CredentialDraft | null>(null)
const deleteCandidate = ref<GatewayCredential | null>(null)
const secretDialog = ref<InstanceType<typeof CredentialSecretDialog> | null>(
  null,
)

const createUsername = ref('')
const createEnabled = ref(true)
const createPortIds = ref<number[]>([])
const createAutoPassword = ref(true)
const createPassword = ref('')

useHead({ title: '账号' })

function sortedPortIds(portIds: number[]) {
  return [...new Set(portIds)].sort((left, right) => left - right)
}

function validUsername(username: string) {
  return /^[\w.@-]{1,64}$/.test(username)
}

function replaceCredential(updated: GatewayCredential) {
  credentials.value = credentials.value
    .map((credential) => (credential.id === updated.id ? updated : credential))
    .sort((left, right) => left.username.localeCompare(right.username))
}

function fail(prefix: string, error: unknown) {
  feedback.value = {
    kind: 'error',
    text: `${prefix}：${gatewayErrorMessage(error)}`,
  }
}

async function loadCredentials() {
  if (busyAction.value) return
  loading.value = true
  loadError.value = ''
  try {
    const result = await api.listCredentials()
    credentials.value = [...result.items].sort((left, right) =>
      left.username.localeCompare(right.username),
    )
  } catch (error) {
    loadError.value = gatewayErrorMessage(error)
  } finally {
    loading.value = false
  }
}

function resetCreateForm() {
  createUsername.value = ''
  createEnabled.value = true
  createPortIds.value = []
  createAutoPassword.value = true
  createPassword.value = ''
}

async function createCredential() {
  const username = createUsername.value.trim()
  if (!validUsername(username)) {
    feedback.value = {
      kind: 'error',
      text: '账号名称必须是 1–64 位安全字符（字母、数字、_、.、@、-）。',
    }
    return
  }
  if (
    !createAutoPassword.value &&
    (createPassword.value.length < 12 || createPassword.value.length > 128)
  ) {
    feedback.value = {
      kind: 'error',
      text: '自定义密码长度必须为 12–128 个字符。',
    }
    return
  }

  busyAction.value = 'create'
  feedback.value = null
  try {
    const created = await api.createCredential({
      username,
      ...(createAutoPassword.value ? {} : { password: createPassword.value }),
      enabled: createEnabled.value,
      portIds: sortedPortIds(createPortIds.value),
    })
    const { password, ...credential } = created
    credentials.value = [...credentials.value, credential].sort((left, right) =>
      left.username.localeCompare(right.username),
    )
    resetCreateForm()
    feedback.value = {
      kind: 'success',
      text: `账号 ${credential.username} 已创建。`,
    }
    secretDialog.value?.open({
      title: '账号创建成功',
      username: credential.username,
      password,
    })
  } catch (error) {
    fail('创建账号失败', error)
  } finally {
    busyAction.value = null
  }
}

function startEdit(credential: GatewayCredential) {
  editDraft.value = {
    id: credential.id,
    username: credential.username,
    enabled: credential.enabled,
    portIds: [...credential.portIds],
  }
  deleteCandidate.value = null
}

function cancelEdit() {
  editDraft.value = null
}

async function saveEdit() {
  const draft = editDraft.value
  if (!draft) return
  const username = draft.username.trim()
  if (!validUsername(username)) {
    feedback.value = {
      kind: 'error',
      text: '账号名称必须是 1–64 位安全字符（字母、数字、_、.、@、-）。',
    }
    return
  }

  busyAction.value = `edit:${draft.id}`
  feedback.value = null
  try {
    const updated = await api.updateCredential(draft.id, {
      username,
      enabled: draft.enabled,
      portIds: sortedPortIds(draft.portIds),
    })
    replaceCredential(updated)
    cancelEdit()
    feedback.value = {
      kind: 'success',
      text: `账号 ${updated.username} 已保存。`,
    }
  } catch (error) {
    fail('保存账号失败', error)
  } finally {
    busyAction.value = null
  }
}

async function disableCredential(credential: GatewayCredential) {
  busyAction.value = `disable:${credential.id}`
  feedback.value = null
  try {
    const updated = await api.updateCredential(credential.id, {
      enabled: false,
    })
    replaceCredential(updated)
    feedback.value = {
      kind: 'success',
      text: `账号 ${updated.username} 已停用。`,
    }
  } catch (error) {
    fail('停用账号失败', error)
  } finally {
    busyAction.value = null
  }
}

async function rotateCredential(credential: GatewayCredential) {
  busyAction.value = `rotate:${credential.id}`
  feedback.value = null
  try {
    const rotated = await api.rotateCredential(credential.id)
    feedback.value = {
      kind: 'success',
      text: `账号 ${credential.username} 的密码已轮换。`,
    }
    secretDialog.value?.open({
      title: '密码已轮换',
      username: credential.username,
      password: rotated.password,
    })
  } catch (error) {
    fail('轮换密码失败', error)
  } finally {
    busyAction.value = null
  }
}

function requestDelete(credential: GatewayCredential) {
  deleteCandidate.value = credential
  editDraft.value = null
  feedback.value = null
}

function affectedPorts(credential: GatewayCredential) {
  if (credential.portIds.length === 0) return '未绑定任何端口'
  return sortedPortIds(credential.portIds)
    .map((portId) => String(10000 + portId))
    .join('、')
}

async function confirmDelete() {
  const credential = deleteCandidate.value
  if (!credential) return

  busyAction.value = `delete:${credential.id}`
  feedback.value = null
  try {
    await api.deleteCredential(credential.id)
    credentials.value = credentials.value.filter(
      (item) => item.id !== credential.id,
    )
    deleteCandidate.value = null
    feedback.value = {
      kind: 'success',
      text: `账号 ${credential.username} 已删除。`,
    }
  } catch (error) {
    fail('删除账号失败', error)
  } finally {
    busyAction.value = null
  }
}

onMounted(() => void loadCredentials())
</script>

<template>
  <main class="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
    <header class="border-b border-slate-200 pb-6">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 class="text-3xl font-black tracking-tight text-slate-950">
            账号
          </h1>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            每个账号可绑定任意固定端口。停用或删除账号可能让关联端口自动停用。
          </p>
        </div>
        <Button
          class="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-800"
          :disabled="loading || Boolean(busyAction)"
          @click="loadCredentials"
        >
          刷新
        </Button>
      </div>
    </header>

    <p
      v-if="loadError"
      role="alert"
      class="mt-5 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-900"
    >
      读取账号失败：{{ loadError }}
    </p>

    <p
      v-if="feedback"
      data-testid="credential-feedback"
      :role="feedback.kind === 'error' ? 'alert' : 'status'"
      class="mt-5 rounded border px-4 py-3 text-sm font-semibold"
      :class="
        feedback.kind === 'success'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-red-200 bg-red-50 text-red-800'
      "
    >
      {{ feedback.text }}
    </p>

    <section
      class="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div class="border-b border-slate-200 pb-4">
        <h2 class="text-lg font-black text-slate-950">创建账号</h2>
        <p class="mt-1 text-sm text-slate-600">
          可让系统生成高强度密码，也可输入自定义密码。
        </p>
      </div>

      <form
        data-testid="create-form"
        class="mt-5 grid gap-5"
        @submit.prevent="createCredential"
      >
        <div class="grid gap-4 md:grid-cols-2">
          <label class="grid gap-2 text-sm font-bold text-slate-800">
            账号名称
            <input
              v-model="createUsername"
              data-testid="create-username"
              required
              pattern="[A-Za-z0-9_.@-]{1,64}"
              maxlength="64"
              autocomplete="off"
              class="rounded border border-slate-300 bg-white px-3 py-2.5 font-normal outline-none focus:border-amber-600 focus:ring-2 focus:ring-amber-100"
              placeholder="例如：team-a"
            />
          </label>

          <label
            class="flex items-center gap-3 self-end rounded border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-800"
          >
            <input
              v-model="createEnabled"
              type="checkbox"
              class="h-4 w-4 accent-amber-700"
            />
            创建后立即启用
          </label>
        </div>

        <fieldset>
          <legend class="text-sm font-bold text-slate-800">初始密码</legend>
          <div class="mt-2 flex flex-wrap gap-3">
            <label
              class="flex items-center gap-2 rounded border border-slate-200 px-3 py-2 text-sm"
            >
              <input
                v-model="createAutoPassword"
                data-testid="create-auto-password"
                type="radio"
                name="create-password-mode"
                :value="true"
                class="accent-amber-700"
              />
              系统自动生成
            </label>
            <label
              class="flex items-center gap-2 rounded border border-slate-200 px-3 py-2 text-sm"
            >
              <input
                v-model="createAutoPassword"
                data-testid="create-custom-password"
                type="radio"
                name="create-password-mode"
                :value="false"
                class="accent-amber-700"
              />
              使用自定义密码
            </label>
          </div>
          <input
            v-if="!createAutoPassword"
            v-model="createPassword"
            data-testid="create-password"
            type="password"
            required
            minlength="12"
            maxlength="128"
            autocomplete="new-password"
            class="mt-3 w-full max-w-md rounded border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-amber-600 focus:ring-2 focus:ring-amber-100"
            placeholder="输入自定义密码"
          />
        </fieldset>

        <fieldset>
          <legend class="text-sm font-bold text-slate-800">绑定端口</legend>
          <p class="mt-1 text-xs text-slate-500">可不选、单选或多选。</p>
          <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <label
              v-for="option in portOptions"
              :key="option.id"
              class="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm font-bold text-slate-800"
            >
              <input
                v-model="createPortIds"
                :data-testid="`create-port-${option.id}`"
                type="checkbox"
                :value="option.id"
                class="h-4 w-4 accent-amber-700"
              />
              {{ option.port }}
            </label>
          </div>
        </fieldset>

        <div>
          <Button
            data-testid="create-submit"
            type="submit"
            :loading="busyAction === 'create'"
            :disabled="Boolean(busyAction)"
            class="rounded border border-slate-800 bg-slate-900 px-5 py-2.5 text-sm font-bold text-white"
          >
            创建账号
          </Button>
        </div>
      </form>
    </section>

    <section
      v-if="deleteCandidate"
      data-testid="delete-confirmation"
      class="mt-6 rounded-xl border border-red-300 bg-red-50 p-5"
      aria-labelledby="delete-heading"
    >
      <h2 id="delete-heading" class="text-lg font-black text-red-950">
        确认删除账号 {{ deleteCandidate.username }}
      </h2>
      <p class="mt-2 text-sm leading-6 text-red-900">
        删除会解除以下端口的账号绑定：
        <strong class="font-mono">{{ affectedPorts(deleteCandidate) }}</strong>
        。若端口失去最后一个启用账号，后端会自动停用该端口。
      </p>
      <div class="mt-4 flex flex-wrap gap-2">
        <Button
          :data-testid="`confirm-delete-${deleteCandidate.id}`"
          :loading="busyAction === `delete:${deleteCandidate.id}`"
          :disabled="Boolean(busyAction)"
          class="rounded border border-red-800 bg-red-800 px-4 py-2 text-sm font-bold text-white"
          @click="confirmDelete"
        >
          确认删除
        </Button>
        <Button
          class="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-800"
          :disabled="Boolean(busyAction)"
          @click="deleteCandidate = null"
        >
          取消
        </Button>
      </div>
    </section>

    <section class="mt-6" aria-label="账号列表">
      <div class="mb-3 flex items-baseline justify-between gap-3">
        <h2 class="text-lg font-black text-slate-950">现有账号</h2>
        <span class="font-mono text-xs text-slate-500">
          {{ credentials.length }} 个账号
        </span>
      </div>

      <div
        v-if="loading && credentials.length === 0"
        class="rounded border border-slate-200 bg-white p-8 text-center text-sm text-slate-600"
      >
        正在读取账号…
      </div>
      <div
        v-else-if="credentials.length === 0"
        class="rounded border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-600"
      >
        尚未创建账号。
      </div>

      <div v-else class="grid gap-3">
        <article
          v-for="credential in credentials"
          :key="credential.id"
          :data-testid="`credential-row-${credential.id}`"
          class="rounded-xl border border-slate-200 bg-white shadow-sm"
        >
          <div
            class="grid gap-4 p-5 lg:grid-cols-[1fr_1.4fr_auto] lg:items-center"
          >
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="font-mono text-lg font-black text-slate-950">
                  {{ credential.username }}
                </h3>
                <span
                  class="rounded-full border px-2 py-0.5 text-xs font-bold"
                  :class="
                    credential.enabled
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                      : 'border-slate-300 bg-slate-100 text-slate-600'
                  "
                >
                  {{ credential.enabled ? '已启用' : '已停用' }}
                </span>
              </div>
              <p class="mt-1 text-xs break-all text-slate-500">
                ID {{ credential.id }}
              </p>
            </div>

            <div>
              <p class="text-xs font-bold text-slate-500">绑定端口</p>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <span
                  v-for="portId in sortedPortIds(credential.portIds)"
                  :key="portId"
                  class="rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs font-bold text-slate-700"
                >
                  {{ 10000 + portId }}
                </span>
                <span
                  v-if="credential.portIds.length === 0"
                  class="text-sm text-slate-500"
                >
                  未绑定端口
                </span>
              </div>
            </div>

            <div class="flex flex-wrap gap-2 lg:justify-end">
              <Button
                :data-testid="`edit-${credential.id}`"
                class="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-800"
                :disabled="Boolean(busyAction)"
                @click="startEdit(credential)"
              >
                编辑
              </Button>
              <Button
                v-if="credential.enabled"
                :data-testid="`disable-${credential.id}`"
                :loading="busyAction === `disable:${credential.id}`"
                :disabled="Boolean(busyAction)"
                class="rounded border border-amber-700 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900"
                @click="disableCredential(credential)"
              >
                停用
              </Button>
              <Button
                :data-testid="`rotate-${credential.id}`"
                :loading="busyAction === `rotate:${credential.id}`"
                :disabled="Boolean(busyAction)"
                class="rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-bold text-white"
                @click="rotateCredential(credential)"
              >
                轮换密码
              </Button>
              <Button
                :data-testid="`delete-${credential.id}`"
                :disabled="Boolean(busyAction)"
                class="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm font-bold text-red-800"
                @click="requestDelete(credential)"
              >
                删除
              </Button>
            </div>
          </div>

          <form
            v-if="editDraft?.id === credential.id"
            :data-testid="`edit-form-${credential.id}`"
            class="grid gap-5 border-t border-slate-200 bg-slate-50 p-5"
            @submit.prevent="saveEdit"
          >
            <div class="grid gap-4 md:grid-cols-2">
              <label class="grid gap-2 text-sm font-bold text-slate-800">
                账号名称
                <input
                  v-model="editDraft.username"
                  :data-testid="`edit-username-${credential.id}`"
                  required
                  pattern="[A-Za-z0-9_.@-]{1,64}"
                  maxlength="64"
                  class="rounded border border-slate-300 bg-white px-3 py-2.5 font-normal outline-none focus:border-amber-600 focus:ring-2 focus:ring-amber-100"
                />
              </label>
              <label
                class="flex items-center gap-3 self-end rounded border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-800"
              >
                <input
                  v-model="editDraft.enabled"
                  :data-testid="`edit-enabled-${credential.id}`"
                  type="checkbox"
                  class="h-4 w-4 accent-amber-700"
                />
                启用账号
              </label>
            </div>

            <fieldset>
              <legend class="text-sm font-bold text-slate-800">绑定端口</legend>
              <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                <label
                  v-for="option in portOptions"
                  :key="option.id"
                  class="flex items-center gap-2 rounded border border-slate-200 bg-white px-3 py-2 font-mono text-sm font-bold text-slate-800"
                >
                  <input
                    v-model="editDraft.portIds"
                    :data-testid="`edit-port-${option.id}-${credential.id}`"
                    type="checkbox"
                    :value="option.id"
                    class="h-4 w-4 accent-amber-700"
                  />
                  {{ option.port }}
                </label>
              </div>
            </fieldset>

            <div class="flex flex-wrap gap-2">
              <Button
                :data-testid="`save-${credential.id}`"
                type="submit"
                :loading="busyAction === `edit:${credential.id}`"
                :disabled="Boolean(busyAction)"
                class="rounded border border-slate-800 bg-slate-900 px-4 py-2 text-sm font-bold text-white"
              >
                保存
              </Button>
              <Button
                class="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-800"
                :disabled="Boolean(busyAction)"
                @click="cancelEdit"
              >
                取消
              </Button>
            </div>
          </form>
        </article>
      </div>
    </section>

    <CredentialSecretDialog ref="secretDialog" />
  </main>
</template>
