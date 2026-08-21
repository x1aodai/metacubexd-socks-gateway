import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Parallel encrypted-state tests can exceed Vitest's 5s default.
    testTimeout: 15_000,
  },
})
