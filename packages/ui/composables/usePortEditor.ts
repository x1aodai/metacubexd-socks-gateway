import type { GatewayHop, GatewayMode, GatewayPort } from '~/types/gateway'
import { computed, ref } from 'vue'

export type PortDraft = Pick<GatewayPort, 'enabled' | 'credentialIds' | 'hops'>

function clonePortDraft(source: PortDraft): PortDraft {
  return {
    enabled: source.enabled,
    credentialIds: [...source.credentialIds],
    hops: previewGatewayChain(source),
  }
}

export function previewGatewayChain(source: PortDraft): GatewayHop[] {
  return source.hops.map((hop) => ({
    mode: hop.mode,
    nodeIds: [...hop.nodeIds],
  }))
}

export function validatePortDraft(source: PortDraft): string[] {
  const errors: string[] = []

  if (source.enabled && source.credentialIds.length === 0)
    errors.push('启用端口至少绑定一个账号')
  if (source.hops.length > 2) errors.push('端口最多只能配置两跳')
  else if (source.enabled && source.hops.length === 0)
    errors.push('启用端口必须配置一到两跳')

  for (const hop of source.hops) {
    if (hop.mode === 'manual' && hop.nodeIds.length !== 1)
      errors.push('固定模式必须且只能选择一个节点')
    if (hop.mode === 'auto' && hop.nodeIds.length === 0)
      errors.push('自动最优模式至少选择一个节点')
    if (hop.mode === 'failover' && hop.nodeIds.length === 0)
      errors.push('故障切换模式至少选择一个节点')
    if (new Set(hop.nodeIds).size !== hop.nodeIds.length)
      errors.push('同一跳不能重复选择节点')
  }

  if (source.hops.length === 2) {
    const firstHopNodes = new Set(source.hops[0]!.nodeIds)
    if (source.hops[1]!.nodeIds.some((nodeId) => firstHopNodes.has(nodeId)))
      errors.push('相邻两跳不能使用同一个节点')
  }

  return errors
}

export function usePortEditor(source: PortDraft) {
  const draft = ref(clonePortDraft(source))
  const errors = computed(() => validatePortDraft(draft.value))
  const valid = computed(() => errors.value.length === 0)
  const preview = computed(() => previewGatewayChain(draft.value))

  function reset(next: PortDraft = source) {
    draft.value = clonePortDraft(next)
  }

  function addHop(mode: GatewayMode): boolean {
    if (draft.value.hops.length >= 2) return false
    draft.value.hops.push({ mode, nodeIds: [] })
    return true
  }

  function removeHop(index: number): boolean {
    if (!draft.value.hops[index]) return false
    draft.value.hops.splice(index, 1)
    return true
  }

  function moveFailoverNode(
    hopIndex: number,
    fromIndex: number,
    toIndex: number,
  ): boolean {
    const hop = draft.value.hops[hopIndex]
    if (
      hop?.mode !== 'failover' ||
      !Number.isInteger(fromIndex) ||
      !Number.isInteger(toIndex) ||
      fromIndex < 0 ||
      fromIndex >= hop.nodeIds.length ||
      toIndex < 0 ||
      toIndex >= hop.nodeIds.length
    )
      return false

    const nodeIds = [...hop.nodeIds]
    const [nodeId] = nodeIds.splice(fromIndex, 1)
    nodeIds.splice(toIndex, 0, nodeId!)
    hop.nodeIds = nodeIds
    return true
  }

  return {
    draft,
    errors,
    valid,
    preview,
    reset,
    addHop,
    removeHop,
    moveFailoverNode,
  }
}
