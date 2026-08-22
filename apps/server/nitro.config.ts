import { defineNitroConfig } from 'nitropack/config'

export default defineNitroConfig({
  preset: 'node-server',
  // Pin so Nitro feature flags do not drift between builds.
  compatibilityDate: '2025-01-01',
  // The catch-all route serves the runtime-injected UI bundle. Keeping Nitro's
  // generated static handler enabled would intercept those files first.
  serveStatic: false,
  // Exclude test files from Nitro's middleware/routes scanner.
  ignore: ['**/__tests__/**', '**/*.spec.ts', '**/*.test.ts'],
})
