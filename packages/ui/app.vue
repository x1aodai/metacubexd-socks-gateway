<script setup lang="ts">
useHead({
  titleTemplate: (title) => (title ? `${title} - SOCKS 网关` : 'SOCKS 网关'),
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
