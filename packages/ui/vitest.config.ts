import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    include: ['e2e/**/*.spec.ts', '**/__tests__/**/*.spec.ts'],
    // Increase timeout for e2e tests
    testTimeout: 60000,
    hookTimeout: 60000,
    // Use jsdom environment for DOM API support
    environment: 'jsdom',
    unstubGlobals: true,
  },
})
