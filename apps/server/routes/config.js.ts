import { defineEventHandler, setHeader } from 'h3'
import { serverEnv } from '../lib/supervisor'

// Runtime dashboard config, served to the SPA as `window.__METACUBEXD_CONFIG__`
// before the app boots (index.html loads /config.js synchronously in <head>).
//
// The dashboard and control API share an origin. Authentication uses an
// HttpOnly session cookie, so no administrator credential is injected here.
// GITHUB_TOKEN is still exposed when configured for authenticated release API
// limits; operators should leave it unset unless that feature is required.
// DEFAULT_BACKEND_URL pre-fills the connect form (#2155) — unlike the panel
// container's NUXT_PUBLIC_* mapping, the UI here is statically generated, so
// this dynamic route is the only runtime channel that can carry the value.
export default defineEventHandler((event) => {
  const { githubToken, defaultBackendURL } = serverEnv()
  const config: Record<string, unknown> = {
    defaultBackendURL,
    serverMode: true,
  }
  if (githubToken) config.githubToken = githubToken
  setHeader(event, 'content-type', 'text/javascript; charset=utf-8')
  // Never cache: runtime values must track the environment across restarts.
  setHeader(event, 'cache-control', 'no-store')
  return `window.__METACUBEXD_CONFIG__ = ${JSON.stringify(config)}\n`
})
