import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  flushPromises,
  mount,
  RouterLinkStub,
  shallowMount,
} from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import App from '../../../app.vue'
import BlankLayout from '../../../layouts/blank.vue'
import DefaultLayout from '../../../layouts/default.vue'
import IndexPage from '../../../pages/index.vue'
import LoginPage from '../../../pages/login.vue'
import Button from '../../Button.vue'
import LogoText from '../../LogoText.vue'
import Modal from '../../Modal.vue'
import Sidebar from '../../Sidebar.vue'

const navigateTo = vi.fn()
const auth = {
  check: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}

beforeEach(() => {
  navigateTo.mockReset()
  navigateTo.mockResolvedValue(undefined)
  auth.check.mockReset()
  auth.login.mockReset()
  auth.logout.mockReset()
  vi.stubGlobal('navigateTo', navigateTo)
  vi.stubGlobal('useRoute', () => ({ path: '/ports', fullPath: '/ports' }))
  vi.stubGlobal('useGatewayAuth', () => auth)
  vi.stubGlobal('useHead', vi.fn())
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal(
    'defineNuxtRouteMiddleware',
    (middleware: unknown) => middleware,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('gateway shell navigation', () => {
  it('renders the same four Chinese destinations on desktop and mobile', () => {
    const wrapper = mount(Sidebar, {
      global: {
        stubs: {
          LogoText: true,
          NuxtLink: RouterLinkStub,
        },
      },
      slots: { default: '<p>页面内容</p>' },
    })
    const expected = [
      ['/ports', '端口'],
      ['/nodes', '节点'],
      ['/credentials', '账号'],
      ['/system', '系统'],
    ]

    for (const label of ['桌面导航', '移动导航']) {
      const navigation = wrapper.get(`nav[aria-label="${label}"]`)
      const links = navigation.findAllComponents(RouterLinkStub)
      expect(links).toHaveLength(expected.length)
      for (const [index, [path, text]] of expected.entries()) {
        expect(links[index]!.props('to')).toBe(path)
        expect(links[index]!.text()).toBe(text)
      }
    }

    expect(wrapper.text()).not.toMatch(/概览|代理|规则|连接|流量|日志|配置/)
    expect(wrapper.findAll('button[aria-label="退出登录"]')).toHaveLength(2)
  })

  it('logs out and always returns to the login page', async () => {
    auth.logout.mockRejectedValueOnce(new TypeError('network failed'))
    const wrapper = mount(Sidebar, {
      global: {
        stubs: { LogoText: true, NuxtLink: RouterLinkStub },
      },
    })

    await wrapper.get('button[aria-label="退出登录"]').trigger('click')
    await flushPromises()

    expect(auth.logout).toHaveBeenCalledOnce()
    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true })
  })

  it('uses /ports for the logo, root redirect, and successful login', async () => {
    const logo = mount(LogoText, {
      global: { stubs: { NuxtLink: RouterLinkStub } },
    })
    expect(logo.getComponent(RouterLinkStub).props('to')).toBe('/ports')
    expect(logo.text()).toBe('SOCKS网关')

    shallowMount(IndexPage)
    expect(navigateTo).toHaveBeenCalledWith('/ports', { replace: true })
    navigateTo.mockClear()

    auth.login.mockResolvedValueOnce('authenticated')
    const login = mount(LoginPage, {
      global: {
        components: { Button, LogoText },
        stubs: { NuxtLink: RouterLinkStub },
      },
    })
    await login.get('input[type="password"]').setValue('not-a-real-password')
    await login.get('form').trigger('submit')
    await flushPromises()

    expect(auth.login).toHaveBeenCalledWith('not-a-real-password')
    expect(navigateTo).toHaveBeenCalledWith('/ports', { replace: true })
  })

  it('keeps only /login public and fails closed everywhere else', async () => {
    const { default: AuthMiddleware } =
      await import('../../../middleware/auth.global')
    auth.check.mockResolvedValue('unauthenticated')

    await AuthMiddleware(
      { path: '/login', fullPath: '/login' } as never,
      {} as never,
    )
    expect(navigateTo).not.toHaveBeenCalled()

    await AuthMiddleware(
      { path: '/nodes', fullPath: '/nodes?filter=active' } as never,
      {} as never,
    )
    expect(navigateTo).toHaveBeenCalledWith(
      { path: '/login', query: { redirect: '/nodes?filter=active' } },
      { replace: true },
    )

    navigateTo.mockClear()
    auth.check.mockResolvedValueOnce('authenticated')
    await AuthMiddleware(
      { path: '/login', fullPath: '/login' } as never,
      {} as never,
    )
    expect(navigateTo).toHaveBeenCalledWith('/ports', { replace: true })
  })

  it('fixes both layouts and the app chrome to the light theme', () => {
    const defaultLayout = shallowMount(DefaultLayout, {
      global: { stubs: { Sidebar: true } },
    })
    const blankLayout = shallowMount(BlankLayout)
    const app = shallowMount(App, {
      global: {
        stubs: {
          NuxtLayout: { template: '<div><slot /></div>' },
          NuxtPage: { template: '<div data-testid="nuxt-page" />' },
          PwaUpdatePrompt: true,
          Toaster: {
            props: ['theme'],
            template: '<div data-testid="toaster" :data-theme="theme" />',
          },
        },
      },
    })

    expect(defaultLayout.attributes('data-theme')).toBe('light')
    expect(blankLayout.attributes('data-theme')).toBe('light')
    expect(
      app.get('[data-testid="nuxt-page"]').attributes('transition'),
    ).toBeUndefined()
    expect(app.find('[data-testid="toaster"]').exists()).toBe(false)
  })

  it('keeps focus and immediate native dialog close without animations', async () => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: {
        configurable: true,
        value: vi.fn(function (this: HTMLDialogElement) {
          this.setAttribute('open', '')
        }),
      },
      close: {
        configurable: true,
        value: vi.fn(function (this: HTMLDialogElement) {
          this.removeAttribute('open')
        }),
      },
    })

    const button = mount(Button, { slots: { default: '保存' } })
    expect(button.get('button').classes()).toContain('focus-visible:outline-2')
    expect(button.get('button').classes()).not.toContain('btn-press')

    const modal = mount(Modal, {
      props: { title: '确认操作' },
      slots: { default: '<p>内容</p>' },
    })
    ;(modal.vm as unknown as { open: () => void }).open()
    await nextTick()
    expect(modal.get('dialog').attributes()).toHaveProperty('open')

    await modal.get('button[aria-label="关闭"]').trigger('click')
    expect(modal.get('dialog').attributes()).not.toHaveProperty('open')
    expect(modal.emitted('close')).toHaveLength(1)
  })

  it('contains no legacy shell stores, language/theme switches, or animation hooks', () => {
    const sources = [
      '../../Sidebar.vue',
      '../../LogoText.vue',
      '../../Button.vue',
      '../../Modal.vue',
      '../../../layouts/default.vue',
      '../../../layouts/blank.vue',
      '../../../app.vue',
      '../../../pages/index.vue',
      '../../../pages/login.vue',
      '../../../middleware/auth.global.ts',
    ].map((path) =>
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'),
    )
    const shell = sources.join('\n')

    expect(shell).not.toMatch(
      /useConfigStore|useEndpointStore|useI18n|ThemeSwitcher|LangSwitcher/,
    )
    expect(shell).not.toMatch(
      /<Transition|transition-|animate-|duration-\d|scale-|rotate-/,
    )
  })
})
