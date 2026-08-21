import type { PortDraft } from '../usePortEditor'
import { describe, expect, it } from 'vitest'
import {
  previewGatewayChain,
  usePortEditor,
  validatePortDraft,
} from '../usePortEditor'

function port(overrides: Partial<PortDraft> = {}): PortDraft {
  return {
    enabled: false,
    credentialIds: [],
    hops: [],
    ...overrides,
  }
}

describe('local gateway port editor', () => {
  it('accepts zero, one, or two hops only when the port state permits them', () => {
    expect(validatePortDraft(port())).toEqual([])
    expect(validatePortDraft(port({ enabled: true }))).toEqual([
      '启用端口至少绑定一个账号',
      '启用端口必须配置一到两跳',
    ])
    expect(
      validatePortDraft(
        port({
          enabled: true,
          credentialIds: ['credential-1'],
          hops: [{ mode: 'manual', nodeIds: ['node-1'] }],
        }),
      ),
    ).toEqual([])
    expect(
      validatePortDraft(
        port({
          enabled: true,
          credentialIds: ['credential-1'],
          hops: [
            { mode: 'auto', nodeIds: ['node-1'] },
            { mode: 'failover', nodeIds: ['node-2', 'node-3'] },
          ],
        }),
      ),
    ).toEqual([])

    expect(
      validatePortDraft(
        port({
          enabled: true,
          hops: [
            { mode: 'manual', nodeIds: ['node-1'] },
            { mode: 'auto', nodeIds: ['node-2'] },
            { mode: 'failover', nodeIds: ['node-3'] },
          ],
        }),
      ),
    ).toContain('端口最多只能配置两跳')
  })

  it('validates manual, auto, and failover candidates', () => {
    expect(
      validatePortDraft(
        port({ hops: [{ mode: 'manual', nodeIds: ['node-1', 'node-2'] }] }),
      ),
    ).toContain('固定模式必须且只能选择一个节点')
    expect(
      validatePortDraft(port({ hops: [{ mode: 'auto', nodeIds: [] }] })),
    ).toContain('自动最优模式至少选择一个节点')
    expect(
      validatePortDraft(port({ hops: [{ mode: 'failover', nodeIds: [] }] })),
    ).toContain('故障切换模式至少选择一个节点')
    expect(
      validatePortDraft(
        port({
          hops: [{ mode: 'failover', nodeIds: ['node-1', 'node-1'] }],
        }),
      ),
    ).toContain('同一跳不能重复选择节点')
  })

  it('rejects the same node in consecutive hops', () => {
    expect(
      validatePortDraft(
        port({
          hops: [
            { mode: 'manual', nodeIds: ['node-1'] },
            { mode: 'auto', nodeIds: ['node-1', 'node-2'] },
          ],
        }),
      ),
    ).toContain('相邻两跳不能使用同一个节点')
  })

  it('adds and removes at most two hops and previews without sharing references', () => {
    const original = port()
    const editor = usePortEditor(original)

    editor.addHop()
    editor.draft.value.hops[0]!.nodeIds = ['node-1']
    editor.addHop()
    editor.draft.value.hops[1]!.mode = 'auto'
    editor.draft.value.hops[1]!.nodeIds = ['node-2']
    editor.addHop()
    expect(editor.draft.value.hops).toHaveLength(2)

    const preview = previewGatewayChain(editor.draft.value)
    preview[0]!.nodeIds.push('preview-only')
    expect(editor.draft.value.hops[0]!.nodeIds).toEqual(['node-1'])
    expect(original.hops).toEqual([])

    editor.removeHop(0)
    expect(editor.draft.value.hops).toEqual([
      { mode: 'auto', nodeIds: ['node-2'] },
    ])
  })
})
