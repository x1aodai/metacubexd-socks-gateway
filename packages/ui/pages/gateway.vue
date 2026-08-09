<script setup lang="ts">
import type {
  GatewayAuditEntry,
  GatewayConfig,
  GatewayCredential,
  GatewayImportPreview,
  GatewayNode,
  GatewayOutboundMode,
  GatewayRevision,
  GatewayStatus,
  GatewaySubscription,
} from '~/types/gateway'
import {
  IconActivityHeartbeat,
  IconAlertTriangle,
  IconArrowBackUp,
  IconBolt,
  IconCheck,
  IconCloudDownload,
  IconCopy,
  IconDatabaseImport,
  IconEdit,
  IconFileUpload,
  IconHistory,
  IconKey,
  IconLock,
  IconLogout,
  IconNetwork,
  IconPlus,
  IconRefresh,
  IconRouter,
  IconServerBolt,
  IconShieldCheck,
  IconTrash,
  IconUser,
  IconX,
} from '@tabler/icons-vue'
import { toast } from 'vue-sonner'

const { t, locale } = useI18n()
const api = useGatewayApi()
const auth = useGatewayAuth()
const proxiesStore = useProxiesStore()

useHead({ title: computed(() => t('gateway.title')) })

const loading = ref(true)
const busy = ref('')
const loadError = ref('')
const gateway = ref<GatewayConfig | null>(null)
const status = ref<GatewayStatus | null>(null)
const credentials = ref<GatewayCredential[]>([])
const subscriptions = ref<GatewaySubscription[]>([])
const revisions = ref<GatewayRevision[]>([])
const audit = ref<GatewayAuditEntry[]>([])
const settingsForm = reactive({ enabled: true, port: 1080, udp: false })
const outboundMode = ref<GatewayOutboundMode>('manual')
const selectedNode = ref('')

const newCredential = reactive({ username: '', password: '', enabled: true })
const revealedSecret = ref<{ username: string; password: string } | null>(null)
const editingCredentialId = ref('')
const editingCredentialUsername = ref('')

const subscriptionFormOpen = ref(false)
const newSubscription = reactive({
  name: '',
  url: '',
  intervalMinutes: 360,
  enabled: true,
})
const editingSubscriptionId = ref('')
const editingSubscription = reactive({ name: '', intervalMinutes: 360 })

const importModal = ref<{ open: () => void; close: () => void } | null>(null)
const passwordModal = ref<{ open: () => void; close: () => void } | null>(null)
const passwordForm = reactive({ current: '', next: '', confirm: '' })
const importContent = ref('')
const importFileName = ref('')
const importPreview = ref<GatewayImportPreview | null>(null)
const importBusy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const mihomoNodes = ref<GatewayNode[]>([])

const nodes = computed<GatewayNode[]>(() => {
  const merged = [
    ...(gateway.value?.nodes || []),
    ...(status.value?.nodes || []),
    ...mihomoNodes.value,
  ]
  return Array.from(new Map(merged.map((node) => [node.id, node])).values())
})

const enabledCredentialCount = computed(
  () => credentials.value.filter((credential) => credential.enabled).length,
)
const isOnline = computed(
  () => status.value?.healthy === true && status.value?.running === true,
)

function formatDate(value?: number) {
  if (!value) return t('gateway.never')
  const time = value < 1_000_000_000_000 ? value * 1000 : value
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(time))
}

function errorText(error: unknown) {
  return error ? controlErrorMessage(error) : t('gateway.actionFailed')
}

function formatAuditDetail(value: unknown) {
  if (!value) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatImportError(
  value: string | { code?: string; message: string; index?: number },
) {
  if (typeof value === 'string') return value
  const prefix = value.index == null ? '' : `#${value.index + 1} · `
  return `${prefix}${value.message}`
}

function syncForms(config: GatewayConfig) {
  settingsForm.enabled = config.enabled
  settingsForm.port = config.port
  settingsForm.udp = config.udp
  outboundMode.value = config.mode || 'manual'
  selectedNode.value = config.selectedNode || ''
}

async function loadGateway() {
  const [config, currentStatus] = await Promise.all([
    api.getGateway(),
    api.getGatewayStatus(),
  ])
  gateway.value = config
  status.value = currentStatus
  syncForms(config)
}

async function loadCredentials() {
  credentials.value = unwrapGatewayList(await api.listCredentials())
}

async function loadSubscriptions() {
  subscriptions.value = unwrapGatewayList(await api.listSubscriptions())
}

async function loadHistory() {
  const [revisionList, auditList] = await Promise.all([
    api.listRevisions(),
    api.listAudit(),
  ])
  revisions.value = unwrapGatewayList(revisionList).slice(0, 8)
  audit.value = unwrapGatewayList(auditList).slice(0, 12)
}

async function loadMihomoNodes() {
  try {
    await proxiesStore.fetchProxies()
    const managed = new Set([
      'GATEWAY',
      'MANUAL',
      'AUTO',
      'FAILOVER',
      'DIRECT',
      'REJECT',
      'GLOBAL',
    ])
    mihomoNodes.value = proxiesStore
      .nodeNames()
      .filter((name) => !managed.has(name) && !proxiesStore.isProxyGroup(name))
      .map((name) => {
        const node = proxiesStore.getNode(name)
        const latency = proxiesStore.getLatencyByName(name, null)
        return {
          id: name,
          name,
          type: node?.type,
          provider: node?.provider,
          healthy: node?.alive,
          latency: latency > 0 ? latency : null,
        }
      })
  } catch {
    // The listener can still be managed while Mihomo is stopped; the node list
    // becomes available after the next refresh once the controller is online.
    mihomoNodes.value = []
  }
}

async function refreshAll(showToast = false) {
  loading.value = true
  loadError.value = ''
  const results = await Promise.allSettled([
    loadGateway(),
    loadCredentials(),
    loadSubscriptions(),
    loadHistory(),
    loadMihomoNodes(),
  ])
  const rejected = results.find((result) => result.status === 'rejected')
  if (rejected?.status === 'rejected')
    loadError.value = errorText(rejected.reason)
  if (showToast && !rejected) toast.success(t('gateway.refreshed'))
  loading.value = false
}

async function runAction(key: string, action: () => Promise<void>) {
  if (busy.value) return
  busy.value = key
  try {
    await action()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    busy.value = ''
  }
}

function saveGateway() {
  return runAction('gateway', async () => {
    const updated = await api.updateGateway({ ...settingsForm })
    gateway.value = updated
    syncForms(updated)
    status.value = await api.getGatewayStatus()
    toast.success(t('gateway.settingsApplied'))
    await loadHistory()
  })
}

function saveOutbound() {
  return runAction('outbound', async () => {
    const nodeId =
      outboundMode.value === 'manual' ? selectedNode.value : undefined
    if (outboundMode.value === 'manual' && !nodeId) {
      toast.error(t('gateway.chooseNode'))
      return
    }
    const updated = await api.updateOutbound({
      mode: outboundMode.value,
      nodeId,
    })
    gateway.value = updated
    syncForms(updated)
    status.value = await api.getGatewayStatus()
    toast.success(t('gateway.outboundApplied'))
  })
}

function addCredential() {
  return runAction('credential-add', async () => {
    const created = await api.createCredential({ ...newCredential })
    if (created.password) {
      revealedSecret.value = {
        username: created.username,
        password: created.password,
      }
    }
    newCredential.username = ''
    newCredential.password = ''
    await loadCredentials()
    toast.success(t('gateway.credentialAdded'))
  })
}

function startCredentialEdit(item: GatewayCredential) {
  editingCredentialId.value = item.id
  editingCredentialUsername.value = item.username
}

function saveCredential(item: GatewayCredential) {
  return runAction(`credential-${item.id}`, async () => {
    await api.updateCredential(item.id, {
      username: editingCredentialUsername.value.trim(),
    })
    editingCredentialId.value = ''
    await loadCredentials()
    toast.success(t('gateway.saved'))
  })
}

function toggleCredential(item: GatewayCredential) {
  return runAction(`credential-${item.id}`, async () => {
    await api.updateCredential(item.id, { enabled: !item.enabled })
    await loadCredentials()
  })
}

function rotateCredential(item: GatewayCredential) {
  if (!window.confirm(t('gateway.rotateConfirm', { name: item.username })))
    return
  return runAction(`credential-${item.id}`, async () => {
    const updated = await api.rotateCredential(item.id)
    if (updated.password) {
      revealedSecret.value = {
        username: updated.username || item.username,
        password: updated.password,
      }
    }
    await loadCredentials()
    toast.success(t('gateway.rotated'))
  })
}

function deleteCredential(item: GatewayCredential) {
  if (!window.confirm(t('gateway.deleteConfirm', { name: item.username })))
    return
  return runAction(`credential-${item.id}`, async () => {
    await api.deleteCredential(item.id)
    await loadCredentials()
    toast.success(t('gateway.deleted'))
  })
}

async function copySecret(value: string) {
  await navigator.clipboard.writeText(value)
  toast.success(t('gateway.copied'))
}

function createSubscription() {
  return runAction('subscription-add', async () => {
    await api.createSubscription({ ...newSubscription })
    newSubscription.name = ''
    newSubscription.url = ''
    newSubscription.intervalMinutes = 360
    subscriptionFormOpen.value = false
    await Promise.all([
      loadSubscriptions(),
      loadGateway(),
      loadHistory(),
      loadMihomoNodes(),
    ])
    toast.success(t('gateway.subscriptionAdded'))
  })
}

function startSubscriptionEdit(item: GatewaySubscription) {
  editingSubscriptionId.value = item.id
  editingSubscription.name = item.name
  editingSubscription.intervalMinutes = item.intervalMinutes
}

function saveSubscription(item: GatewaySubscription) {
  return runAction(`subscription-${item.id}`, async () => {
    await api.updateSubscription(item.id, { ...editingSubscription })
    editingSubscriptionId.value = ''
    await loadSubscriptions()
    toast.success(t('gateway.saved'))
  })
}

function toggleSubscription(item: GatewaySubscription) {
  return runAction(`subscription-${item.id}`, async () => {
    await api.updateSubscription(item.id, { enabled: !item.enabled })
    await loadSubscriptions()
  })
}

function syncSubscription(item: GatewaySubscription) {
  return runAction(`subscription-${item.id}`, async () => {
    await api.syncSubscription(item.id)
    await Promise.all([
      loadSubscriptions(),
      loadGateway(),
      loadHistory(),
      loadMihomoNodes(),
    ])
    toast.success(t('gateway.subscriptionSynced'))
  })
}

function deleteSubscription(item: GatewaySubscription) {
  if (!window.confirm(t('gateway.deleteConfirm', { name: item.name }))) return
  return runAction(`subscription-${item.id}`, async () => {
    await api.deleteSubscription(item.id)
    await Promise.all([loadSubscriptions(), loadGateway(), loadMihomoNodes()])
    toast.success(t('gateway.deleted'))
  })
}

function resetImport() {
  importContent.value = ''
  importFileName.value = ''
  importPreview.value = null
  if (fileInput.value) fileInput.value.value = ''
}

async function onImportFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (file.size > 8 * 1024 * 1024) {
    toast.error(t('gateway.fileTooLarge'))
    return
  }
  importFileName.value = file.name
  importContent.value = await file.text()
  importPreview.value = null
}

async function previewImport() {
  if (!importContent.value.trim()) return
  importBusy.value = true
  try {
    importPreview.value = await api.previewImport({
      content: importContent.value,
      fileName: importFileName.value || undefined,
    })
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    importBusy.value = false
  }
}

async function applyImport() {
  if (!importPreview.value) return
  importBusy.value = true
  try {
    const result = await api.applyImport({
      previewId: importPreview.value.previewId,
      ...(!importPreview.value.previewId
        ? {
            content: importContent.value,
            fileName: importFileName.value || undefined,
          }
        : {}),
    })
    toast.success(t('gateway.importedCount', { count: result.imported }))
    importModal.value?.close()
    resetImport()
    await Promise.all([loadGateway(), loadHistory(), loadMihomoNodes()])
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    importBusy.value = false
  }
}

function rollback(revision: GatewayRevision) {
  if (!window.confirm(t('gateway.rollbackConfirm'))) return
  return runAction(`revision-${revision.id}`, async () => {
    const updated = await api.rollbackRevision(revision.id)
    gateway.value = updated
    syncForms(updated)
    await Promise.all([loadGateway(), loadHistory()])
    toast.success(t('gateway.rolledBack'))
  })
}

async function logout() {
  try {
    await auth.logout()
  } catch {
    await auth.check(true)
  } finally {
    await navigateTo('/login', { replace: true })
  }
}

async function changeAdminPassword() {
  if (passwordForm.next !== passwordForm.confirm) {
    toast.error(t('gateway.passwordMismatch'))
    return
  }
  await runAction('admin-password', async () => {
    await api.changePassword(passwordForm.current, passwordForm.next)
    passwordForm.current = ''
    passwordForm.next = ''
    passwordForm.confirm = ''
    passwordModal.value?.close()
    await auth.check(true)
    toast.success(t('gateway.adminPasswordChanged'))
    await navigateTo('/login', { replace: true })
  })
}

function resetPasswordForm() {
  passwordForm.current = ''
  passwordForm.next = ''
  passwordForm.confirm = ''
}

onMounted(() => refreshAll())

useIntervalFn(async () => {
  try {
    status.value = await api.getGatewayStatus()
  } catch {
    if (status.value) status.value = { ...status.value, healthy: false }
  }
}, 10_000)
</script>

<template>
  <div class="gateway-console flex h-full min-h-0 flex-col overflow-hidden">
    <header class="shrink-0 border-b border-base-content/10 px-2 pb-4 sm:px-3">
      <div class="flex flex-wrap items-center gap-3">
        <div
          class="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/12 text-primary"
        >
          <IconServerBolt :size="23" />
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h1 class="text-xl font-bold tracking-tight">
              {{ t('gateway.title') }}
            </h1>
            <span
              class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold"
              :class="
                isOnline
                  ? 'bg-success/12 text-success'
                  : 'bg-error/12 text-error'
              "
            >
              <span class="h-1.5 w-1.5 rounded-full bg-current" />
              {{ isOnline ? t('gateway.online') : t('gateway.offline') }}
            </span>
          </div>
          <p class="mt-0.5 text-xs text-base-content/50">
            {{ t('gateway.subtitle') }}
          </p>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <Button
            :icon="IconRefresh"
            :loading="loading"
            class="btn-ghost btn-sm"
            :aria-label="t('gateway.refresh')"
            @click="refreshAll(true)"
          />
          <Button class="btn-ghost btn-sm" @click="passwordModal?.open()">
            <IconUser :size="17" />
            <span class="hidden md:inline">{{
              auth.user.value || 'admin'
            }}</span>
          </Button>
          <Button class="btn-ghost btn-sm" @click="logout">
            <IconLogout :size="17" />
            <span class="hidden sm:inline">{{ t('gateway.logout') }}</span>
          </Button>
        </div>
      </div>

      <div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div class="gateway-metric">
          <span>{{ t('gateway.listener') }}</span>
          <strong class="tabular-nums"
            >0.0.0.0:{{ gateway?.port || '—' }}</strong
          >
        </div>
        <div class="gateway-metric">
          <span>{{ t('gateway.activeOutbound') }}</span>
          <strong class="truncate">{{
            status?.activeNodeName || status?.activeNode || 'REJECT'
          }}</strong>
        </div>
        <div class="gateway-metric">
          <span>{{ t('gateway.credentials') }}</span>
          <strong class="tabular-nums"
            >{{ enabledCredentialCount }} / {{ credentials.length }}</strong
          >
        </div>
        <div class="gateway-metric">
          <span>{{ t('gateway.lastApplied') }}</span>
          <strong class="truncate text-xs">{{
            formatDate(status?.lastAppliedAt)
          }}</strong>
        </div>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 py-4 sm:px-3">
      <div
        v-if="loadError"
        role="alert"
        class="mb-4 flex items-start gap-2 rounded-xl border border-warning/25 bg-warning/8 p-3 text-sm text-warning"
      >
        <IconAlertTriangle :size="18" class="mt-0.5 shrink-0" />
        <span class="min-w-0 flex-1 break-words">{{ loadError }}</span>
        <button
          class="press-tactile rounded-md p-1"
          :aria-label="t('gateway.dismiss')"
          @click="loadError = ''"
        >
          <IconX :size="16" />
        </button>
      </div>

      <div
        v-if="loading && !gateway"
        class="flex h-64 items-center justify-center"
      >
        <span class="loading loading-lg loading-ring text-primary" />
      </div>

      <div v-else class="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <section class="gateway-panel xl:col-span-5">
          <div class="gateway-panel__heading">
            <div>
              <p class="gateway-kicker">SOCKS5 LISTENER</p>
              <h2>{{ t('gateway.listenerSettings') }}</h2>
            </div>
            <IconRouter :size="20" class="text-primary" />
          </div>
          <form class="grid gap-4" @submit.prevent="saveGateway">
            <label class="gateway-switch-row">
              <span>
                <strong>{{ t('gateway.gatewayEnabled') }}</strong>
                <small>{{ t('gateway.gatewayEnabledHint') }}</small>
              </span>
              <input
                v-model="settingsForm.enabled"
                type="checkbox"
                class="toggle toggle-primary toggle-sm"
              />
            </label>
            <div class="grid grid-cols-[1fr_auto] gap-3">
              <label class="form-control">
                <span class="gateway-label">{{ t('gateway.port') }}</span>
                <input
                  v-model.number="settingsForm.port"
                  type="number"
                  min="1080"
                  max="1099"
                  required
                  class="input-bordered input w-full bg-base-100 tabular-nums input-sm"
                />
              </label>
              <label class="form-control min-w-24">
                <span class="gateway-label">UDP</span>
                <span
                  class="flex h-8 items-center justify-between gap-3 rounded-lg border border-base-content/15 bg-base-100 px-3"
                >
                  <span class="text-xs">{{
                    settingsForm.udp ? 'ON' : 'OFF'
                  }}</span>
                  <input
                    v-model="settingsForm.udp"
                    type="checkbox"
                    class="toggle toggle-primary toggle-xs"
                  />
                </span>
              </label>
            </div>
            <div
              class="rounded-lg border border-info/15 bg-info/6 px-3 py-2 text-xs leading-5 text-base-content/60"
            >
              {{ t('gateway.portHint') }}
            </div>
            <Button
              type="submit"
              :loading="busy === 'gateway'"
              class="justify-self-end btn-primary btn-sm"
            >
              {{ t('gateway.applySettings') }}
            </Button>
          </form>
        </section>

        <section class="gateway-panel xl:col-span-7">
          <div class="gateway-panel__heading">
            <div>
              <p class="gateway-kicker">EGRESS POLICY</p>
              <h2>{{ t('gateway.outboundPolicy') }}</h2>
            </div>
            <IconNetwork :size="20" class="text-primary" />
          </div>
          <div
            class="grid gap-2 sm:grid-cols-3"
            role="radiogroup"
            :aria-label="t('gateway.outboundPolicy')"
          >
            <label
              v-for="mode in [
                'manual',
                'auto',
                'failover',
              ] as GatewayOutboundMode[]"
              :key="mode"
              class="gateway-mode"
              :class="{ 'gateway-mode--active': outboundMode === mode }"
            >
              <input
                v-model="outboundMode"
                type="radio"
                class="sr-only"
                :value="mode"
              />
              <strong>{{ mode.toUpperCase() }}</strong>
              <small>{{ t(`gateway.mode_${mode}`) }}</small>
            </label>
          </div>
          <div v-if="outboundMode === 'manual'" class="mt-4">
            <label class="form-control">
              <span class="gateway-label">{{ t('gateway.manualNode') }}</span>
              <select
                v-model="selectedNode"
                class="select-bordered select w-full bg-base-100 select-sm"
              >
                <option value="" disabled>{{ t('gateway.chooseNode') }}</option>
                <option v-for="node in nodes" :key="node.id" :value="node.id">
                  {{ node.name }} · {{ node.type || 'PROXY'
                  }}{{ node.latency != null ? ` · ${node.latency}ms` : '' }}
                </option>
              </select>
            </label>
          </div>
          <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-start gap-2 text-xs text-base-content/55">
              <IconShieldCheck
                :size="16"
                class="mt-0.5 shrink-0 text-success"
              />
              <span>{{ t('gateway.noDirect') }}</span>
            </div>
            <Button
              :loading="busy === 'outbound'"
              class="btn-primary btn-sm"
              @click="saveOutbound"
            >
              {{ t('gateway.switchOutbound') }}
            </Button>
          </div>
        </section>

        <section class="gateway-panel xl:col-span-12">
          <div class="gateway-panel__heading flex-wrap">
            <div>
              <p class="gateway-kicker">ACCESS CONTROL</p>
              <h2>{{ t('gateway.credentialManagement') }}</h2>
            </div>
            <span class="text-xs text-base-content/45">{{
              t('gateway.passwordNeverReturned')
            }}</span>
          </div>

          <div
            v-if="revealedSecret"
            class="mb-4 rounded-xl border border-warning/25 bg-warning/8 p-3"
          >
            <div class="mb-2 flex items-center justify-between gap-2">
              <strong class="text-sm text-warning">{{
                t('gateway.saveSecretNow')
              }}</strong>
              <button
                class="press-tactile rounded-md p-1 text-base-content/50 hover:text-base-content"
                :aria-label="t('gateway.dismiss')"
                @click="revealedSecret = null"
              >
                <IconX :size="16" />
              </button>
            </div>
            <div class="grid gap-2 sm:grid-cols-2">
              <button
                class="gateway-secret"
                @click="copySecret(revealedSecret.username)"
              >
                <span>{{ t('gateway.username') }}</span
                ><code>{{ revealedSecret.username }}</code
                ><IconCopy :size="15" />
              </button>
              <button
                class="gateway-secret"
                @click="copySecret(revealedSecret.password)"
              >
                <span>{{ t('gateway.password') }}</span
                ><code>{{ revealedSecret.password }}</code
                ><IconCopy :size="15" />
              </button>
            </div>
          </div>

          <form
            class="mb-4 grid gap-2 rounded-xl bg-base-300/55 p-3 sm:grid-cols-[1fr_1fr_auto_auto]"
            @submit.prevent="addCredential"
          >
            <input
              v-model.trim="newCredential.username"
              required
              autocomplete="off"
              class="input-bordered input bg-base-100 input-sm"
              :placeholder="t('gateway.username')"
            />
            <input
              v-model="newCredential.password"
              required
              minlength="12"
              type="password"
              autocomplete="new-password"
              class="input-bordered input bg-base-100 input-sm"
              :placeholder="t('gateway.passwordMin')"
            />
            <label class="flex items-center gap-2 px-2 text-xs">
              <input
                v-model="newCredential.enabled"
                type="checkbox"
                class="checkbox checkbox-sm checkbox-primary"
              />
              {{ t('gateway.enabled') }}
            </label>
            <Button
              type="submit"
              :loading="busy === 'credential-add'"
              class="btn-primary btn-sm"
            >
              <IconPlus :size="16" />{{ t('gateway.addAccount') }}
            </Button>
          </form>

          <div class="overflow-x-auto rounded-xl border border-base-content/10">
            <table class="table min-w-[720px] table-sm">
              <thead class="bg-base-300/60 text-[0.6875rem] uppercase">
                <tr>
                  <th>{{ t('gateway.username') }}</th>
                  <th>{{ t('gateway.status') }}</th>
                  <th>{{ t('gateway.updated') }}</th>
                  <th class="text-right">{{ t('gateway.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="item in credentials"
                  :key="item.id"
                  class="border-base-content/8"
                >
                  <td>
                    <div
                      v-if="editingCredentialId === item.id"
                      class="flex items-center gap-1"
                    >
                      <input
                        v-model.trim="editingCredentialUsername"
                        class="input-bordered input max-w-48 bg-base-100 input-xs"
                      />
                      <button
                        class="btn btn-square btn-ghost text-success btn-xs"
                        :aria-label="t('gateway.saved')"
                        @click="saveCredential(item)"
                      >
                        <IconCheck :size="15" />
                      </button>
                      <button
                        class="btn btn-square btn-ghost btn-xs"
                        :aria-label="t('gateway.cancel')"
                        @click="editingCredentialId = ''"
                      >
                        <IconX :size="15" />
                      </button>
                    </div>
                    <span v-else class="flex items-center gap-2 font-medium"
                      ><IconUser :size="15" class="text-base-content/40" />{{
                        item.username
                      }}</span
                    >
                  </td>
                  <td>
                    <button
                      class="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs"
                      :class="
                        item.enabled
                          ? 'bg-success/10 text-success'
                          : 'bg-base-content/8 text-base-content/45'
                      "
                      @click="toggleCredential(item)"
                    >
                      <span class="h-1.5 w-1.5 rounded-full bg-current" />{{
                        item.enabled
                          ? t('gateway.enabled')
                          : t('gateway.disabled')
                      }}
                    </button>
                  </td>
                  <td class="text-xs text-base-content/50 tabular-nums">
                    {{ formatDate(item.updatedAt) }}
                  </td>
                  <td>
                    <div class="flex justify-end gap-1">
                      <button
                        class="btn btn-square btn-ghost btn-xs"
                        :aria-label="t('gateway.edit')"
                        @click="startCredentialEdit(item)"
                      >
                        <IconEdit :size="15" />
                      </button>
                      <button
                        class="btn btn-square btn-ghost btn-xs"
                        :aria-label="t('gateway.rotate')"
                        @click="rotateCredential(item)"
                      >
                        <IconKey :size="15" />
                      </button>
                      <button
                        class="btn btn-square btn-ghost text-error btn-xs"
                        :aria-label="t('gateway.delete')"
                        @click="deleteCredential(item)"
                      >
                        <IconTrash :size="15" />
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="!credentials.length">
                  <td
                    colspan="4"
                    class="py-8 text-center text-sm text-base-content/40"
                  >
                    {{ t('gateway.noCredentials') }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="gateway-panel xl:col-span-12">
          <div class="gateway-panel__heading flex-wrap">
            <div>
              <p class="gateway-kicker">NODE SOURCES</p>
              <h2>{{ t('gateway.nodesAndSubscriptions') }}</h2>
            </div>
            <div class="flex gap-2">
              <Button class="btn-ghost btn-sm" @click="importModal?.open()"
                ><IconDatabaseImport :size="16" />{{
                  t('gateway.importNodes')
                }}</Button
              >
              <Button
                class="btn-primary btn-sm"
                @click="subscriptionFormOpen = !subscriptionFormOpen"
                ><IconPlus :size="16" />{{
                  t('gateway.addSubscription')
                }}</Button
              >
            </div>
          </div>

          <form
            v-if="subscriptionFormOpen"
            class="mb-4 grid gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3 md:grid-cols-[1fr_2fr_9rem_auto_auto]"
            @submit.prevent="createSubscription"
          >
            <input
              v-model.trim="newSubscription.name"
              required
              class="input-bordered input bg-base-100 input-sm"
              :placeholder="t('gateway.subscriptionName')"
            />
            <input
              v-model.trim="newSubscription.url"
              required
              type="url"
              autocomplete="off"
              class="input-bordered input bg-base-100 input-sm"
              :placeholder="t('gateway.subscriptionUrl')"
            />
            <input
              v-model.number="newSubscription.intervalMinutes"
              required
              type="number"
              min="15"
              class="input-bordered input bg-base-100 tabular-nums input-sm"
              :aria-label="t('gateway.intervalMinutes')"
            />
            <label class="flex items-center gap-2 px-2 text-xs"
              ><input
                v-model="newSubscription.enabled"
                type="checkbox"
                class="checkbox checkbox-sm checkbox-primary"
              />{{ t('gateway.enabled') }}</label
            >
            <div class="flex gap-1">
              <Button
                type="submit"
                :loading="busy === 'subscription-add'"
                class="btn-primary btn-sm"
                >{{ t('gateway.add') }}</Button
              ><Button
                class="btn-ghost btn-sm"
                @click="subscriptionFormOpen = false"
                >{{ t('gateway.cancel') }}</Button
              >
            </div>
          </form>

          <div class="grid gap-3 lg:grid-cols-2">
            <article
              v-for="item in subscriptions"
              :key="item.id"
              class="gateway-subscription"
            >
              <div class="flex min-w-0 flex-1 items-start gap-3">
                <div
                  class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  :class="
                    item.lastError
                      ? 'bg-error/10 text-error'
                      : 'bg-info/10 text-info'
                  "
                >
                  <IconCloudDownload :size="18" />
                </div>
                <div class="min-w-0 flex-1">
                  <template v-if="editingSubscriptionId === item.id">
                    <div class="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
                      <input
                        v-model.trim="editingSubscription.name"
                        class="input-bordered input bg-base-100 input-xs"
                      />
                      <input
                        v-model.number="editingSubscription.intervalMinutes"
                        min="15"
                        type="number"
                        class="input-bordered input bg-base-100 input-xs"
                      />
                      <div class="flex">
                        <button
                          class="btn btn-square btn-ghost text-success btn-xs"
                          @click="saveSubscription(item)"
                        >
                          <IconCheck :size="15" /></button
                        ><button
                          class="btn btn-square btn-ghost btn-xs"
                          @click="editingSubscriptionId = ''"
                        >
                          <IconX :size="15" />
                        </button>
                      </div>
                    </div>
                  </template>
                  <template v-else>
                    <div class="flex items-center gap-2">
                      <h3 class="truncate text-sm font-semibold">
                        {{ item.name }}
                      </h3>
                      <span
                        class="rounded-full bg-base-300 px-2 py-0.5 text-[0.625rem] tabular-nums"
                        >{{ item.nodeCount }} {{ t('gateway.nodes') }}</span
                      >
                    </div>
                    <p
                      class="mt-1 truncate font-mono text-[0.6875rem] text-base-content/40"
                    >
                      {{ item.urlMasked }}
                    </p>
                    <p
                      v-if="item.lastError"
                      class="mt-1 truncate text-xs text-error"
                    >
                      {{ item.lastError }}
                    </p>
                    <p
                      v-else
                      class="mt-1 text-[0.6875rem] text-base-content/45"
                    >
                      {{
                        t('gateway.everyMinutes', {
                          count: item.intervalMinutes,
                        })
                      }}
                      · {{ formatDate(item.lastSyncAt) }}
                    </p>
                  </template>
                </div>
              </div>
              <div
                class="mt-3 flex items-center justify-between border-t border-base-content/8 pt-2"
              >
                <button
                  class="inline-flex items-center gap-1.5 text-xs"
                  :class="
                    item.enabled ? 'text-success' : 'text-base-content/40'
                  "
                  @click="toggleSubscription(item)"
                >
                  <span class="h-1.5 w-1.5 rounded-full bg-current" />{{
                    item.enabled ? t('gateway.enabled') : t('gateway.disabled')
                  }}
                </button>
                <div class="flex gap-1">
                  <button
                    class="btn btn-square btn-ghost btn-xs"
                    :aria-label="t('gateway.edit')"
                    @click="startSubscriptionEdit(item)"
                  >
                    <IconEdit :size="15" /></button
                  ><button
                    class="btn btn-square btn-ghost btn-xs"
                    :aria-label="t('gateway.sync')"
                    @click="syncSubscription(item)"
                  >
                    <IconRefresh :size="15" /></button
                  ><button
                    class="btn btn-square btn-ghost text-error btn-xs"
                    :aria-label="t('gateway.delete')"
                    @click="deleteSubscription(item)"
                  >
                    <IconTrash :size="15" />
                  </button>
                </div>
              </div>
            </article>
            <div
              v-if="!subscriptions.length"
              class="col-span-full rounded-xl border border-dashed border-base-content/15 py-10 text-center text-sm text-base-content/40"
            >
              {{ t('gateway.noSubscriptions') }}
            </div>
          </div>
        </section>

        <section class="gateway-panel xl:col-span-6">
          <div class="gateway-panel__heading">
            <div>
              <p class="gateway-kicker">LAST-GOOD CONFIG</p>
              <h2>{{ t('gateway.revisions') }}</h2>
            </div>
            <IconHistory :size="20" class="text-primary" />
          </div>
          <ol class="space-y-1">
            <li
              v-for="item in revisions"
              :key="item.id"
              class="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-base-content/5"
            >
              <span
                class="h-2 w-2 shrink-0 rounded-full"
                :class="item.active ? 'bg-success' : 'bg-base-content/20'"
              />
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-medium">
                  {{ item.reason || item.summary || item.id }}
                </p>
                <p class="text-[0.6875rem] text-base-content/40 tabular-nums">
                  {{ formatDate(item.createdAt) }}
                </p>
              </div>
              <button
                v-if="!item.active"
                class="btn btn-ghost btn-xs"
                @click="rollback(item)"
              >
                <IconArrowBackUp :size="14" />{{ t('gateway.rollback') }}
              </button>
              <span
                v-else
                class="text-[0.6875rem] font-semibold text-success"
                >{{ t('gateway.current') }}</span
              >
            </li>
            <li
              v-if="!revisions.length"
              class="py-8 text-center text-sm text-base-content/40"
            >
              {{ t('gateway.noRevisions') }}
            </li>
          </ol>
        </section>

        <section class="gateway-panel xl:col-span-6">
          <div class="gateway-panel__heading">
            <div>
              <p class="gateway-kicker">SECURITY JOURNAL</p>
              <h2>{{ t('gateway.audit') }}</h2>
            </div>
            <IconActivityHeartbeat :size="20" class="text-primary" />
          </div>
          <ol class="space-y-1">
            <li
              v-for="(item, index) in audit"
              :key="item.id || `${item.ts || item.at}-${index}`"
              class="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-base-content/5"
            >
              <IconCheck
                v-if="item.result !== 'failure'"
                :size="14"
                class="text-success"
              /><IconAlertTriangle v-else :size="14" class="text-error" />
              <span class="min-w-0 truncate"
                >{{ item.action
                }}<span v-if="item.detail" class="text-base-content/40">
                  · {{ formatAuditDetail(item.detail) }}</span
                ></span
              >
              <time
                class="text-[0.6875rem] text-base-content/40 tabular-nums"
                >{{ formatDate(item.at || item.ts) }}</time
              >
            </li>
            <li
              v-if="!audit.length"
              class="py-8 text-center text-sm text-base-content/40"
            >
              {{ t('gateway.noAudit') }}
            </li>
          </ol>
        </section>
      </div>
    </div>

    <Modal
      ref="importModal"
      :title="t('gateway.importNodes')"
      size="xl"
      @close="resetImport"
    >
      <template #icon><IconDatabaseImport :size="21" /></template>
      <div class="grid gap-5 lg:grid-cols-2">
        <div>
          <label class="gateway-label mb-2 block">{{
            t('gateway.pasteLinks')
          }}</label>
          <textarea
            v-model="importContent"
            rows="14"
            class="textarea-bordered textarea w-full resize-y bg-base-200 font-mono text-xs leading-5"
            :placeholder="t('gateway.importPlaceholder')"
            @input="importPreview = null"
          />
          <label
            class="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-base-content/20 bg-base-200 px-4 py-4 text-sm transition-colors hover:border-primary/40 hover:text-primary"
          >
            <IconFileUpload :size="19" />
            <span>{{ importFileName || t('gateway.chooseFile') }}</span>
            <input
              ref="fileInput"
              type="file"
              accept=".yaml,.yml,.txt,text/plain,application/yaml"
              class="sr-only"
              @change="onImportFile"
            />
          </label>
          <p class="mt-2 text-[0.6875rem] text-base-content/45">
            {{ t('gateway.importFormats') }}
          </p>
        </div>
        <div class="rounded-xl bg-base-200 p-4">
          <div
            v-if="!importPreview"
            class="flex min-h-64 flex-col items-center justify-center text-center text-base-content/40"
          >
            <IconBolt :size="30" class="mb-3 text-primary/50" />
            <p class="text-sm font-medium">{{ t('gateway.previewFirst') }}</p>
            <p class="mt-1 max-w-xs text-xs leading-5">
              {{ t('gateway.previewHint') }}
            </p>
          </div>
          <template v-else>
            <div class="grid grid-cols-2 gap-2">
              <div class="rounded-lg bg-success/8 p-3">
                <span class="text-xs text-base-content/50">{{
                  t('gateway.valid')
                }}</span
                ><strong
                  class="mt-1 block text-2xl text-success tabular-nums"
                  >{{ importPreview.validCount }}</strong
                >
              </div>
              <div class="rounded-lg bg-warning/8 p-3">
                <span class="text-xs text-base-content/50">{{
                  t('gateway.skipped')
                }}</span
                ><strong
                  class="mt-1 block text-2xl text-warning tabular-nums"
                  >{{ importPreview.skippedCount }}</strong
                >
              </div>
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
              <span
                v-for="(count, protocol) in importPreview.protocolCounts"
                :key="protocol"
                class="rounded-md bg-base-300 px-2 py-1 font-mono text-xs"
                >{{ protocol }} · {{ count }}</span
              >
            </div>
            <ul
              v-if="importPreview.errors.length"
              class="mt-4 max-h-40 space-y-1 overflow-y-auto text-xs text-error"
            >
              <li v-for="(error, index) in importPreview.errors" :key="index">
                {{ formatImportError(error) }}
              </li>
            </ul>
          </template>
        </div>
      </div>
      <template #actions>
        <Button class="btn-ghost btn-sm" @click="importModal?.close()">{{
          t('gateway.cancel')
        }}</Button>
        <Button
          v-if="!importPreview"
          :loading="importBusy"
          :disabled="!importContent.trim()"
          class="btn-primary btn-sm"
          @click="previewImport"
          >{{ t('gateway.preview') }}</Button
        >
        <Button
          v-else
          :loading="importBusy"
          :disabled="importPreview.validCount === 0"
          class="btn-primary btn-sm"
          @click="applyImport"
          >{{ t('gateway.applyImport') }}</Button
        >
      </template>
    </Modal>

    <Modal
      ref="passwordModal"
      :title="t('gateway.changeAdminPassword')"
      @close="resetPasswordForm"
    >
      <template #icon><IconLock :size="21" /></template>
      <form class="grid gap-4" @submit.prevent="changeAdminPassword">
        <label class="form-control">
          <span class="gateway-label mb-2">{{
            t('gateway.currentPassword')
          }}</span>
          <input
            v-model="passwordForm.current"
            type="password"
            required
            autocomplete="current-password"
            class="input-bordered input bg-base-200"
          />
        </label>
        <label class="form-control">
          <span class="gateway-label mb-2">{{ t('gateway.newPassword') }}</span>
          <input
            v-model="passwordForm.next"
            type="password"
            required
            minlength="12"
            autocomplete="new-password"
            class="input-bordered input bg-base-200"
          />
        </label>
        <label class="form-control">
          <span class="gateway-label mb-2">{{
            t('gateway.confirmPassword')
          }}</span>
          <input
            v-model="passwordForm.confirm"
            type="password"
            required
            minlength="12"
            autocomplete="new-password"
            class="input-bordered input bg-base-200"
          />
        </label>
        <p class="text-xs leading-5 text-base-content/50">
          {{ t('gateway.passwordChangeHint') }}
        </p>
      </form>
      <template #actions>
        <Button class="btn-ghost btn-sm" @click="passwordModal?.close()">{{
          t('gateway.cancel')
        }}</Button>
        <Button
          :loading="busy === 'admin-password'"
          :disabled="
            !passwordForm.current ||
            passwordForm.next.length < 12 ||
            !passwordForm.confirm
          "
          class="btn-primary btn-sm"
          @click="changeAdminPassword"
          >{{ t('gateway.changePassword') }}</Button
        >
      </template>
    </Modal>
  </div>
</template>

<style scoped>
@reference '~/assets/css/main.css';

.gateway-console {
  font-variant-numeric: tabular-nums;
}
.gateway-metric {
  @apply flex min-w-0 flex-col rounded-lg border border-base-content/8 bg-base-200/70 px-3 py-2;
}
.gateway-metric span {
  @apply text-[0.625rem] font-semibold tracking-wide text-base-content/40 uppercase;
}
.gateway-metric strong {
  @apply mt-0.5 text-sm font-semibold;
}
.gateway-panel {
  @apply rounded-2xl border border-base-content/10 bg-base-200 p-4;
  animation: spring-up var(--dur-page) var(--ease-snappy) backwards;
}
.gateway-panel__heading {
  @apply mb-4 flex items-center justify-between gap-3 border-b border-base-content/8 pb-3;
}
.gateway-panel__heading h2 {
  @apply mt-0.5 text-base font-semibold;
}
.gateway-kicker {
  @apply font-mono text-[0.625rem] font-semibold tracking-[0.14em] text-primary uppercase;
}
.gateway-label {
  @apply text-[0.6875rem] font-semibold text-base-content/55;
}
.gateway-switch-row {
  @apply flex items-center justify-between gap-4 rounded-xl bg-base-300/55 px-3 py-3;
}
.gateway-switch-row span {
  @apply flex flex-col;
}
.gateway-switch-row strong {
  @apply text-sm font-medium;
}
.gateway-switch-row small {
  @apply mt-0.5 text-xs text-base-content/45;
}
.gateway-mode {
  @apply flex cursor-pointer flex-col rounded-xl border border-base-content/10 bg-base-300/45 p-3;
  transition:
    transform var(--dur-fast) var(--ease-spring-soft),
    border-color var(--dur-fast) var(--ease-soft),
    background-color var(--dur-fast) var(--ease-soft);
}
.gateway-mode:active {
  transform: scale(0.98);
}
.gateway-mode strong {
  @apply font-mono text-xs tracking-wider;
}
.gateway-mode small {
  @apply mt-1 text-[0.6875rem] leading-4 text-base-content/45;
}
.gateway-mode--active {
  @apply border-primary/40 bg-primary/10 text-primary;
}
.gateway-mode--active small {
  @apply text-base-content/65;
}
.gateway-secret {
  @apply grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg border border-warning/15 bg-base-100 px-3 py-2 text-left;
}
.gateway-secret span {
  @apply text-[0.625rem] font-semibold text-base-content/45 uppercase;
}
.gateway-secret code {
  @apply truncate text-xs text-base-content;
}
.gateway-subscription {
  @apply rounded-xl border border-base-content/10 bg-base-300/35 p-3;
}
</style>
