import type { GatewayCredential } from '~/types/gateway'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CredentialsPage from '../credentials.vue'

interface GatewayApiStub {
  listCredentials: ReturnType<typeof vi.fn>
  createCredential: ReturnType<typeof vi.fn>
  updateCredential: ReturnType<typeof vi.fn>
  deleteCredential: ReturnType<typeof vi.fn>
  rotateCredential: ReturnType<typeof vi.fn>
}

const alice: GatewayCredential = {
  id: 'credential-a',
  username: 'alice',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  portIds: [1, 10],
}

let api: GatewayApiStub

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
  api = {
    listCredentials: vi.fn().mockResolvedValue({ items: [alice] }),
    createCredential: vi.fn(),
    updateCredential: vi.fn(),
    deleteCredential: vi.fn(),
    rotateCredential: vi.fn(),
  }
  vi.stubGlobal('useGatewayApi', () => api)
  vi.stubGlobal('controlErrorMessage', () => '请求未完成，请稍后重试。')
  vi.stubGlobal('useHead', vi.fn())
})

async function mountPage() {
  const wrapper = mount(CredentialsPage)
  await flushPromises()
  return wrapper
}

describe('credentials page', () => {
  it('creates auto and custom passwords with any fixed-port selection', async () => {
    api.createCredential
      .mockResolvedValueOnce({
        ...alice,
        id: 'credential-auto',
        username: 'auto-user',
        portIds: [1, 10],
        password: 'auto-one-time-secret',
      })
      .mockResolvedValueOnce({
        ...alice,
        id: 'credential-custom',
        username: 'custom-user',
        portIds: [2],
        password: 'custom-one-time-secret',
      })
    const wrapper = await mountPage()

    expect(wrapper.findAll('[data-testid^="create-port-"]')).toHaveLength(10)
    await wrapper.get('[data-testid="create-username"]').setValue('auto-user')
    await wrapper.get('[data-testid="create-port-1"]').setValue(true)
    await wrapper.get('[data-testid="create-port-10"]').setValue(true)
    await wrapper.get('[data-testid="create-form"]').trigger('submit')
    await flushPromises()

    expect(api.createCredential).toHaveBeenNthCalledWith(1, {
      username: 'auto-user',
      enabled: true,
      portIds: [1, 10],
    })
    expect(wrapper.text()).toContain('auto-one-time-secret')
    await wrapper.get('[data-testid="dismiss-secret"]').trigger('click')
    expect(wrapper.text()).not.toContain('auto-one-time-secret')

    await wrapper.get('[data-testid="create-username"]').setValue('custom-user')
    await wrapper.get('[data-testid="create-custom-password"]').setValue()
    await wrapper
      .get('[data-testid="create-password"]')
      .setValue('chosen-password')
    await wrapper.get('[data-testid="create-port-2"]').setValue(true)
    await wrapper.get('[data-testid="create-form"]').trigger('submit')
    await flushPromises()

    expect(api.createCredential).toHaveBeenNthCalledWith(2, {
      username: 'custom-user',
      password: 'chosen-password',
      enabled: true,
      portIds: [2],
    })
    expect(wrapper.text()).toContain('custom-one-time-secret')
    expect(wrapper.text()).toContain('账号 custom-user 已创建')
  })

  it('edits username, enabled state, and the complete portIds replacement', async () => {
    api.updateCredential.mockResolvedValueOnce({
      ...alice,
      username: 'alice-renamed',
      enabled: false,
      portIds: [2, 9],
    })
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="edit-credential-a"]').trigger('click')
    await wrapper
      .get('[data-testid="edit-username-credential-a"]')
      .setValue('alice-renamed')
    await wrapper
      .get('[data-testid="edit-enabled-credential-a"]')
      .setValue(false)
    await wrapper
      .get('[data-testid="edit-port-1-credential-a"]')
      .setValue(false)
    await wrapper
      .get('[data-testid="edit-port-10-credential-a"]')
      .setValue(false)
    await wrapper.get('[data-testid="edit-port-2-credential-a"]').setValue(true)
    await wrapper.get('[data-testid="edit-port-9-credential-a"]').setValue(true)
    await wrapper
      .get('[data-testid="edit-form-credential-a"]')
      .trigger('submit')
    await flushPromises()

    expect(api.updateCredential).toHaveBeenCalledWith('credential-a', {
      username: 'alice-renamed',
      enabled: false,
      portIds: [2, 9],
    })
    expect(wrapper.text()).toContain('账号 alice-renamed 已保存')
  })

  it('stops, rotates, then deletes only after showing affected ports', async () => {
    api.updateCredential.mockResolvedValueOnce({ ...alice, enabled: false })
    api.rotateCredential.mockResolvedValueOnce({
      id: alice.id,
      password: 'rotated-one-time-secret',
    })
    api.deleteCredential.mockResolvedValueOnce(undefined)
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="disable-credential-a"]').trigger('click')
    await flushPromises()
    expect(api.updateCredential).toHaveBeenCalledWith('credential-a', {
      enabled: false,
    })
    expect(wrapper.text()).toContain('账号 alice 已停用')

    await wrapper.get('[data-testid="rotate-credential-a"]').trigger('click')
    await flushPromises()
    expect(api.rotateCredential).toHaveBeenCalledWith('credential-a')
    expect(wrapper.text()).toContain('rotated-one-time-secret')
    await wrapper.get('[data-testid="dismiss-secret"]').trigger('click')
    expect(wrapper.text()).not.toContain('rotated-one-time-secret')

    await wrapper.get('[data-testid="delete-credential-a"]').trigger('click')
    expect(api.deleteCredential).not.toHaveBeenCalled()
    const confirmation = wrapper.get('[data-testid="delete-confirmation"]')
    expect(confirmation.text()).toContain('10001')
    expect(confirmation.text()).toContain('10010')

    await wrapper
      .get('[data-testid="confirm-delete-credential-a"]')
      .trigger('click')
    await flushPromises()
    expect(api.deleteCredential).toHaveBeenCalledWith('credential-a')
    expect(
      wrapper.find('[data-testid="credential-row-credential-a"]').exists(),
    ).toBe(false)
    expect(wrapper.text()).toContain('账号 alice 已删除')
  })

  it('reports request failures inline without exposing raw errors', async () => {
    api.createCredential.mockRejectedValueOnce(
      new Error('sensitive downstream diagnostic'),
    )
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="create-username"]').setValue('failed-user')
    await wrapper.get('[data-testid="create-form"]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-testid="credential-feedback"]').text()).toContain(
      '操作失败，请稍后重试。',
    )
    expect(wrapper.text()).not.toContain('sensitive downstream diagnostic')
  })

  it('rejects invalid usernames and custom password lengths before sending', async () => {
    const wrapper = await mountPage()

    await wrapper.get('[data-testid="create-username"]').setValue('bad name')
    await wrapper.get('[data-testid="create-form"]').trigger('submit')
    expect(api.createCredential).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="credential-feedback"]').text()).toContain(
      '1–64 位安全字符',
    )

    await wrapper.get('[data-testid="create-username"]').setValue('valid-user')
    await wrapper.get('[data-testid="create-custom-password"]').setValue()
    await wrapper.get('[data-testid="create-password"]').setValue('too-short')
    await wrapper.get('[data-testid="create-form"]').trigger('submit')
    expect(api.createCredential).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="credential-feedback"]').text()).toContain(
      '12–128 个字符',
    )
  })
})
