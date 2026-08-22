import type { GatewaySubscription } from '~/types/gateway'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SubscriptionEditor from '../SubscriptionEditor.vue'

const subscription: GatewaySubscription = {
  id: 'subscription-a',
  name: '主订阅',
  urlMasked: 'https://example.com/…',
  intervalMinutes: 60,
  enabled: true,
  nodeCount: 2,
  createdAt: 1,
  updatedAt: 1,
}

describe('subscription editor', () => {
  it('matches the server name and interval limits before saving', async () => {
    const wrapper = mount(SubscriptionEditor, {
      props: { subscription: null, busy: false },
    })
    const inputs = wrapper.findAll('input')
    const name = inputs.find((input) => input.attributes('type') === 'text')!
    const url = inputs.find((input) => input.attributes('type') === 'url')!
    const interval = inputs.find(
      (input) => input.attributes('type') === 'number',
    )!

    await name.setValue('a'.repeat(101))
    await url.setValue('https://example.com/sub')
    await interval.setValue(14)
    expect(wrapper.text()).toContain('订阅名称最多 100 个字符')
    expect(wrapper.text()).toContain('15–43200')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBe('')

    await name.setValue('备用订阅')
    await interval.setValue(43_200)
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('save')).toEqual([
      [
        {
          name: '备用订阅',
          url: 'https://example.com/sub',
          intervalMinutes: 43_200,
          enabled: true,
        },
      ],
    ])
  })

  it('allows an existing subscription to keep its masked URL', async () => {
    const wrapper = mount(SubscriptionEditor, {
      props: { subscription, busy: false },
    })

    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({
      name: '主订阅',
      intervalMinutes: 60,
      enabled: true,
    })
  })
})
