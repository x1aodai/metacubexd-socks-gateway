import { fileURLToPath } from 'node:url'
import { defineNitroConfig } from 'nitropack/config'

// UI_DIST overrides the bundled static dashboard at runtime (set in Docker).
// Dev fallback resolves the sibling packages/ui generate output.
const uiDist =
  process.env.UI_DIST ||
  fileURLToPath(new URL('../../packages/ui/.output/public', import.meta.url))

export default defineNitroConfig({
  preset: 'node-server',
  // Pin so Nitro feature flags do not drift between builds.
  compatibilityDate: '2025-01-01',
  // Serve the prebuilt dashboard. maxAge: 1 year (hashed assets are immutable).
  publicAssets: [{ baseURL: '/', dir: uiDist, maxAge: 60 * 60 * 24 * 365 }],
  // Exclude test files from Nitro's middleware/routes scanner.
  ignore: ['**/__tests__/**', '**/*.spec.ts', '**/*.test.ts'],
})
