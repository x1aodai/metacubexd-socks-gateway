<script setup lang="ts">
import type { Component } from 'vue'
import { computed } from 'vue'

interface Props {
  type?: 'button' | 'submit' | 'reset'
  loading?: boolean
  disabled?: boolean
  icon?: Component
  class?: string
}

const props = withDefaults(defineProps<Props>(), {
  type: 'button',
  loading: false,
  disabled: false,
})

defineEmits<{
  click: [event: MouseEvent]
}>()

const buttonClass = computed(() => props.class || '')
const needsBtnClass = computed(() => buttonClass.value.includes('btn-'))
</script>

<template>
  <button
    :type="type"
    class="inline-flex items-center justify-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    :class="[
      needsBtnClass && 'btn',
      buttonClass,
      loading && 'btn-disabled cursor-wait',
    ]"
    :disabled="disabled || loading"
    :aria-busy="loading"
    @click="$emit('click', $event)"
  >
    <span v-if="loading" aria-hidden="true">…</span>
    <component :is="icon" v-if="icon" />
    <slot v-else />
  </button>
</template>
