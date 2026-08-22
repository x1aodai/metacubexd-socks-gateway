import type { GatewayHop, GatewayNode } from '~/types/gateway'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HopEditor from '../HopEditor.vue'

const nodes: GatewayNode[] = [
  {
    id: 'node-a',
    name: '东京 A',
    type: 'vless',
    enabled: true,
    sourceIds: ['manual'],
    portIds: [1],
    healthy: true,
    latency: 42,
  },
  {
    id: 'node-b',
    name: '新加坡 B',
    type: 'trojan',
    enabled: true,
    sourceIds: ['subscription:subscription-b'],
    portIds: [1, 2],
    healthy: false,
    latency: null,
  },
  {
    id: 'node-c',
    name: '法兰克福 C',
    type: 'ss',
    enabled: false,
    sourceIds: ['manual'],
    portIds: [],
  },
]

describe('hopEditor', () => {
  it('switches among all three modes without mutating its hop prop', async () => {
    const hop: GatewayHop = {
      mode: 'failover',
      nodeIds: ['node-a', 'node-b'],
    }
    const original = structuredClone(hop)
    const wrapper = mount(HopEditor, {
      props: { hopIndex: 0, modelValue: hop, nodes },
    })

    await wrapper.get('[aria-label="第一跳模式"]').setValue('manual')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      mode: 'manual',
      nodeIds: ['node-a'],
    })

    await wrapper.setProps({
      modelValue: { mode: 'manual', nodeIds: ['node-a'] },
    })
    await wrapper.get('[aria-label="第一跳模式"]').setValue('auto')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      mode: 'auto',
      nodeIds: ['node-a'],
    })
    expect(hop).toEqual(original)
  })

  it('preserves candidate selection order and reorders failover explicitly', async () => {
    const wrapper = mount(HopEditor, {
      props: {
        hopIndex: 0,
        modelValue: {
          mode: 'auto',
          nodeIds: ['node-a'],
        } satisfies GatewayHop,
        nodes,
      },
    })

    await wrapper.get('input[value="node-b"]').setValue(true)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      mode: 'auto',
      nodeIds: ['node-a', 'node-b'],
    })

    await wrapper.setProps({
      modelValue: {
        mode: 'failover',
        nodeIds: ['node-a', 'node-b'],
      },
    })
    await wrapper.get('[aria-label="上移 新加坡 B"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      mode: 'failover',
      nodeIds: ['node-b', 'node-a'],
    })
  })

  it('uses one explicit node selector for manual mode and emits removal', async () => {
    const wrapper = mount(HopEditor, {
      props: {
        hopIndex: 1,
        modelValue: { mode: 'manual', nodeIds: [] } satisfies GatewayHop,
        nodes,
      },
    })

    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0)
    await wrapper.get('[aria-label="第二跳固定节点"]').setValue('node-b')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      mode: 'manual',
      nodeIds: ['node-b'],
    })

    await wrapper.get('[aria-label="删除第二跳"]').trigger('click')
    expect(wrapper.emitted('remove')).toHaveLength(1)
  })

  it('prevents adding disabled nodes while still allowing their removal', async () => {
    const wrapper = mount(HopEditor, {
      props: {
        hopIndex: 0,
        modelValue: { mode: 'auto', nodeIds: [] } satisfies GatewayHop,
        nodes,
      },
    })

    expect(wrapper.get('input[value="node-c"]').attributes('disabled')).toBe('')

    await wrapper.setProps({
      modelValue: { mode: 'auto', nodeIds: ['node-c'] },
    })
    expect(
      wrapper.get('input[value="node-c"]').attributes('disabled'),
    ).toBeUndefined()
    await wrapper.get('input[value="node-c"]').setValue(false)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      mode: 'auto',
      nodeIds: [],
    })
  })
})
