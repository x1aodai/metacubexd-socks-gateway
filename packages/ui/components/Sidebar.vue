<script setup lang="ts">
import {
  IconPlugConnected,
  IconPower,
  IconServerBolt,
  IconSettings,
  IconUser,
} from '@tabler/icons-vue'

const route = useRoute()
const auth = useGatewayAuth()

const navItems = [
  { to: '/ports', label: '端口', icon: IconPlugConnected },
  { to: '/nodes', label: '节点', icon: IconServerBolt },
  { to: '/credentials', label: '账号', icon: IconUser },
  { to: '/system', label: '系统', icon: IconSettings },
] as const

function isActive(path: string) {
  return route.path === path
}

async function logout() {
  await auth.logout().catch(() => undefined)
  await navigateTo('/login', { replace: true })
}
</script>

<template>
  <div class="flex min-h-0 flex-1 bg-base-100 text-base-content">
    <aside
      class="hidden w-56 shrink-0 flex-col border-r border-base-300 bg-base-200 lg:flex"
    >
      <div class="border-b border-base-300 px-5 py-5">
        <LogoText />
      </div>

      <nav aria-label="桌面导航" class="flex flex-1 flex-col gap-1 p-3">
        <NuxtLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          :class="
            isActive(item.to)
              ? 'bg-primary text-primary-content'
              : 'text-base-content/70 hover:bg-base-300 hover:text-base-content'
          "
          :aria-current="isActive(item.to) ? 'page' : undefined"
        >
          <component :is="item.icon" :size="19" aria-hidden="true" />
          <span>{{ item.label }}</span>
        </NuxtLink>
      </nav>

      <div class="border-t border-base-300 p-3">
        <button
          type="button"
          aria-label="退出登录"
          class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-base-content/70 hover:bg-base-300 hover:text-base-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          @click="logout"
        >
          <IconPower :size="19" aria-hidden="true" />
          <span>退出</span>
        </button>
      </div>
    </aside>

    <section class="flex min-w-0 flex-1 flex-col">
      <header
        class="flex h-14 shrink-0 items-center border-b border-base-300 bg-base-200 px-4 lg:hidden"
      >
        <LogoText />
      </header>

      <div class="flex min-h-0 flex-1 flex-col overflow-auto">
        <slot />
      </div>

      <nav
        aria-label="移动导航"
        class="grid shrink-0 grid-cols-5 border-t border-base-300 bg-base-200 pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <NuxtLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex min-w-0 flex-col items-center gap-1 px-1 py-2 text-xs no-underline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
          :class="
            isActive(item.to)
              ? 'text-primary'
              : 'text-base-content/65 hover:text-base-content'
          "
          :aria-current="isActive(item.to) ? 'page' : undefined"
        >
          <component :is="item.icon" :size="18" aria-hidden="true" />
          <span>{{ item.label }}</span>
        </NuxtLink>
        <button
          type="button"
          aria-label="退出登录"
          class="flex min-w-0 flex-col items-center gap-1 px-1 py-2 text-xs text-base-content/65 hover:text-base-content focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
          @click="logout"
        >
          <IconPower :size="18" aria-hidden="true" />
          <span>退出</span>
        </button>
      </nav>
    </section>
  </div>
</template>
