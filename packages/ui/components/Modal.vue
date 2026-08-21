<script setup lang="ts">
import { IconX } from '@tabler/icons-vue'
import { computed, ref, useId } from 'vue'

interface Props {
  title?: string
  size?: 'md' | 'xl'
  beforeClose?: () => boolean
}

const props = withDefaults(defineProps<Props>(), {
  size: 'md',
  beforeClose: undefined,
})

const emit = defineEmits<{
  close: []
}>()

const dialogRef = ref<HTMLDialogElement | null>(null)
const titleId = useId()
const modalSizeClass = computed(() =>
  props.size === 'xl' ? 'max-w-6xl' : 'max-w-2xl',
)

function open() {
  if (!dialogRef.value?.open) dialogRef.value?.showModal()
}

function close(force = false) {
  if (!force && props.beforeClose && !props.beforeClose()) return
  dialogRef.value?.close()
  emit('close')
}

function closeFromBackdrop(event: MouseEvent) {
  if (event.target === dialogRef.value) close()
}

defineExpose({ open, close })
</script>

<template>
  <dialog
    ref="dialogRef"
    class="fixed inset-0 z-50 m-auto max-h-[90vh] w-[95%] overflow-hidden rounded-2xl border border-base-300 bg-base-100 p-0 text-base-content shadow-xl backdrop:bg-black/40 sm:w-11/12"
    :class="modalSizeClass"
    aria-modal="true"
    :aria-labelledby="title ? titleId : undefined"
    @cancel.prevent="close()"
    @click="closeFromBackdrop"
  >
    <div class="flex max-h-[90vh] flex-col">
      <header
        class="flex shrink-0 items-center justify-between border-b border-base-300 bg-base-200 px-5 py-4"
      >
        <div class="flex items-center gap-3 text-lg font-bold">
          <slot name="icon" />
          <span :id="titleId">{{ title }}</span>
        </div>
        <button
          type="button"
          aria-label="关闭"
          class="flex h-9 w-9 items-center justify-center rounded-lg border border-base-300 text-base-content/65 hover:bg-base-300 hover:text-base-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          @click="close()"
        >
          <IconX :size="18" aria-hidden="true" />
        </button>
      </header>

      <div class="flex-1 overflow-y-auto p-5">
        <slot />
      </div>

      <footer
        v-if="$slots.actions"
        class="flex shrink-0 justify-end gap-2 border-t border-base-300 bg-base-200 px-5 py-4"
      >
        <slot name="actions" />
      </footer>
    </div>
  </dialog>
</template>
