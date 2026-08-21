import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import CredentialSecretDialog from '../CredentialSecretDialog.vue'

beforeEach(() => {
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
})

describe('credential secret dialog', () => {
  it('shows a password once and clears every component-held reference on close', async () => {
    const wrapper = mount(CredentialSecretDialog)
    const dialog = wrapper.vm as unknown as {
      open: (payload: {
        title: string
        username: string
        password: string
      }) => void
    }

    dialog.open({
      title: '账号创建成功',
      username: 'alice',
      password: 'first-one-time-secret',
    })
    await nextTick()

    expect(wrapper.text()).toContain('账号创建成功')
    expect(wrapper.text()).toContain('alice')
    expect(wrapper.text()).toContain('first-one-time-secret')

    await wrapper.get('[data-testid="dismiss-secret"]').trigger('click')
    expect(wrapper.text()).not.toContain('alice')
    expect(wrapper.text()).not.toContain('first-one-time-secret')

    dialog.open({
      title: '密码已轮换',
      username: 'bob',
      password: 'second-one-time-secret',
    })
    await nextTick()
    expect(wrapper.text()).not.toContain('first-one-time-secret')
    expect(wrapper.text()).toContain('second-one-time-secret')
  })

  it('also forgets the password when the native dialog close control is used', async () => {
    const wrapper = mount(CredentialSecretDialog)
    ;(
      wrapper.vm as unknown as {
        open: (payload: {
          title: string
          username: string
          password: string
        }) => void
      }
    ).open({
      title: '密码已轮换',
      username: 'alice',
      password: 'native-close-secret',
    })
    await nextTick()

    await wrapper.get('button[aria-label="关闭"]').trigger('click')
    expect(wrapper.text()).not.toContain('native-close-secret')
  })
})
