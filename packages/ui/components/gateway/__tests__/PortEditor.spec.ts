import type {
  GatewayCredential,
  GatewayNode,
  GatewayPort,
} from '~/types/gateway'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HopEditor from '../HopEditor.vue'
import PortEditor from '../PortEditor.vue'

const nodes: GatewayNode[] = [
  {
    id: 'node-a',
    name: '东京 A',
    type: 'vless',
    enabled: true,
    sourceIds: ['manual'],
    portIds: [1],
  },
  {
    id: 'node-b',
    name: '新加坡 B',
    type: 'trojan',
    enabled: true,
    sourceIds: ['manual'],
    portIds: [],
  },
  {
    id: 'node-c',
    name: '已停用节点',
    type: 'ss',
    enabled: false,
    sourceIds: ['manual'],
    portIds: [],
  },
]

const credentials: GatewayCredential[] = [
  {
    id: 'credential-a',
    username: 'alice',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    portIds: [1],
  },
  {
    id: 'credential-b',
    username: 'bob',
    enabled: false,
    createdAt: 1,
    updatedAt: 1,
    portIds: [],
  },
]

function port(overrides: Partial<GatewayPort> = {}): GatewayPort {
  return {
    id: 1,
    port: 10001,
    enabled: true,
    credentialIds: ['credential-a'],
    hops: [{ mode: 'manual', nodeIds: ['node-a'] }],
    ...overrides,
  }
}

describe('portEditor', () => {
  it('emits one complete save body and never mutates the source port', async () => {
    const source = port()
    const original = structuredClone(source)
    const wrapper = mount(PortEditor, {
      props: { port: source, nodes, credentials },
    })

    wrapper.getComponent(HopEditor).vm.$emit('update:modelValue', {
      mode: 'failover',
      nodeIds: ['node-b', 'node-a'],
    })
    await wrapper.vm.$nextTick()
    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('save')).toEqual([
      [
        {
          enabled: true,
          credentialIds: ['credential-a'],
          hops: [
            {
              mode: 'failover',
              nodeIds: ['node-b', 'node-a'],
            },
          ],
        },
      ],
    ])
    expect(source).toEqual(original)

    await wrapper.get('[data-testid="cancel-port"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('shows inline validation and blocks incomplete saves', () => {
    const wrapper = mount(PortEditor, {
      props: {
        port: port({ credentialIds: [], hops: [] }),
        nodes,
        credentials,
      },
    })

    expect(wrapper.text()).toContain('启用端口至少绑定一个账号')
    expect(wrapper.text()).toContain('启用端口必须配置一到两跳')
    expect(
      wrapper.get('[data-testid="save-port"]').attributes('disabled'),
    ).toBe('')
  })

  it('blocks duplicate submits while a save is in progress', async () => {
    const wrapper = mount(PortEditor, {
      props: { port: port(), nodes, credentials, saving: true },
    })

    expect(
      wrapper.get('[data-testid="save-port"]').attributes('disabled'),
    ).toBe('')
    expect(wrapper.get('[data-testid="save-port"]').text()).toBe('正在应用…')

    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('save')).toBeUndefined()
  })

  it('requires enabled credentials and node candidates for an enabled port', async () => {
    const wrapper = mount(PortEditor, {
      props: {
        port: port({
          credentialIds: ['credential-b'],
          hops: [{ mode: 'auto', nodeIds: ['node-c'] }],
        }),
        nodes,
        credentials,
      },
    })

    expect(wrapper.text()).toContain('至少绑定一个已启用账号')
    expect(wrapper.text()).toContain('至少选择一个已启用节点')
    expect(
      wrapper.get('[data-testid="save-port"]').attributes('disabled'),
    ).toBe('')

    await wrapper.get('input[value="credential-a"]').setValue(true)
    wrapper.getComponent(HopEditor).vm.$emit('update:modelValue', {
      mode: 'auto',
      nodeIds: ['node-c', 'node-a'],
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('至少绑定一个已启用账号')
    expect(wrapper.text()).not.toContain('至少选择一个已启用节点')
  })

  it('renders a two-hop chain preview and removes only the local hop', async () => {
    const source = port({
      hops: [
        { mode: 'auto', nodeIds: ['node-a'] },
        { mode: 'failover', nodeIds: ['node-b'] },
      ],
    })
    const wrapper = mount(PortEditor, {
      props: { port: source, nodes, credentials },
    })

    const preview = wrapper.get('[data-testid="chain-preview"]')
    expect(preview.text()).toContain('第一跳 · 自动最优 · 东京 A')
    expect(preview.text()).toContain('第二跳 · 故障切换 · 新加坡 B')
    expect(wrapper.get('[data-testid="add-hop"]').attributes('disabled')).toBe(
      '',
    )

    wrapper.findAllComponents(HopEditor)[1]!.vm.$emit('remove')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAllComponents(HopEditor)).toHaveLength(1)
    expect(source.hops).toHaveLength(2)
  })
})
