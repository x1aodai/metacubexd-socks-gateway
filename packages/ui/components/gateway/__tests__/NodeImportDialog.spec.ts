import type { GatewayImportPreview } from '~/types/gateway'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NodeImportDialog from '../NodeImportDialog.vue'

const preview: GatewayImportPreview = {
  previewId: 'preview-1',
  format: 'links',
  validCount: 2,
  skippedCount: 1,
  protocolCounts: { vless: 1, trojan: 1 },
  errors: ['unsupported proxy protocol'],
  issues: [
    {
      code: 'unsupported-protocol',
      message: 'unsupported proxy protocol',
      index: 3,
    },
  ],
  nodes: [
    { id: 'node-a', name: '东京 A', type: 'vless' },
    { id: 'node-b', name: '新加坡 B', type: 'trojan' },
  ],
}

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

describe('nodeImportDialog', () => {
  it('emits trimmed text for preview without applying it', async () => {
    const wrapper = mount(NodeImportDialog, {
      props: { preview: null, busy: false, error: '' },
    })

    await wrapper.get('textarea').setValue('  vless://example  ')
    await wrapper.get('[data-testid="preview-text"]').trigger('click')

    expect(wrapper.emitted('preview-text')).toEqual([['vless://example']])
    expect(wrapper.emitted('apply')).toBeUndefined()
  })

  it('accepts a local file for preview', async () => {
    const wrapper = mount(NodeImportDialog, {
      props: { preview: null, busy: false, error: '' },
    })
    const file = new File(['proxies: []'], 'nodes.yaml', {
      type: 'application/yaml',
    })
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [file],
    })

    await input.trigger('change')

    expect(wrapper.emitted('preview-file')).toEqual([[file]])
  })

  it('shows only the safe preview and requires an explicit apply', async () => {
    const wrapper = mount(NodeImportDialog, {
      props: { preview, busy: false, error: '' },
    })

    expect(wrapper.text()).toContain('2 个有效节点')
    expect(wrapper.text()).toContain('东京 A')
    expect(wrapper.text()).toContain('新加坡 B')
    expect(wrapper.text()).toContain('导入内容包含不支持的协议')

    await wrapper.get('[data-testid="apply-import"]').trigger('click')
    await wrapper.get('[data-testid="cancel-import"]').trigger('click')
    expect(wrapper.emitted('apply')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
