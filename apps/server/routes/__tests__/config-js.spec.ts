import { createServer } from 'node:http'
import { createApp, toNodeListener } from 'h3'
import { afterEach, describe, expect, it } from 'vitest'

// Spin the dynamic /config.js handler on an ephemeral port and fetch it. The
// handler reads runtime values via serverEnv() at request time.
async function start() {
  const handler = (await import('../config.js')).default
  const app = createApp()
  app.use(handler)
  const server = createServer(toNodeListener(app))
  await new Promise<void>((r) => server.listen(0, () => r()))
  const addr = server.address()
  const base = `http://127.0.0.1:${
    typeof addr === 'object' && addr ? addr.port : 0
  }`
  return { server, base }
}

describe('apps/server routes/config.js runtime config', () => {
  const original = process.env.CONTROL_TOKEN
  const originalGithubToken = process.env.GITHUB_TOKEN
  const originalDefaultBackendURL = process.env.DEFAULT_BACKEND_URL
  const originalPublicDirectAccess = process.env.PUBLIC_DIRECT_ACCESS
  const originalClashApiPort = process.env.CLASH_API_PORT
  afterEach(() => {
    if (original === undefined) delete process.env.CONTROL_TOKEN
    else process.env.CONTROL_TOKEN = original
    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = originalGithubToken
    if (originalDefaultBackendURL === undefined)
      delete process.env.DEFAULT_BACKEND_URL
    else process.env.DEFAULT_BACKEND_URL = originalDefaultBackendURL
    if (originalPublicDirectAccess === undefined)
      delete process.env.PUBLIC_DIRECT_ACCESS
    else process.env.PUBLIC_DIRECT_ACCESS = originalPublicDirectAccess
    if (originalClashApiPort === undefined) delete process.env.CLASH_API_PORT
    else process.env.CLASH_API_PORT = originalClashApiPort
  })

  it('never exposes CONTROL_TOKEN and serves no-store JS', async () => {
    process.env.CONTROL_TOKEN = 'super-secret'
    const { server, base } = await start()
    try {
      const res = await fetch(`${base}/config.js`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('javascript')
      expect(res.headers.get('cache-control')).toContain('no-store')
      const body = await res.text()
      expect(body).toContain('window.__METACUBEXD_CONFIG__')
      expect(body).not.toContain('controlToken')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('omits controlToken when CONTROL_TOKEN is unset', async () => {
    delete process.env.CONTROL_TOKEN
    const { server, base } = await start()
    try {
      const body = await (await fetch(`${base}/config.js`)).text()
      expect(body).toContain('window.__METACUBEXD_CONFIG__')
      expect(body).not.toContain('controlToken')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('injects an optional GitHub Releases token into the runtime UI config (#2135)', async () => {
    process.env.GITHUB_TOKEN = 'github-token'
    const { server, base } = await start()
    try {
      const body = await (await fetch(`${base}/config.js`)).text()
      expect(body).toContain('"githubToken":"github-token"')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('omits githubToken when GITHUB_TOKEN is unset', async () => {
    delete process.env.GITHUB_TOKEN
    const { server, base } = await start()
    try {
      const body = await (await fetch(`${base}/config.js`)).text()
      expect(body).not.toContain('githubToken')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('injects DEFAULT_BACKEND_URL as the connect-form default (#2155)', async () => {
    process.env.DEFAULT_BACKEND_URL = 'http://192.168.1.10:9090'
    const { server, base } = await start()
    try {
      const body = await (await fetch(`${base}/config.js`)).text()
      expect(body).toContain('"defaultBackendURL":"http://192.168.1.10:9090"')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('defaults defaultBackendURL to empty when DEFAULT_BACKEND_URL is unset', async () => {
    delete process.env.DEFAULT_BACKEND_URL
    const { server, base } = await start()
    try {
      const body = await (await fetch(`${base}/config.js`)).text()
      expect(body).toContain('"defaultBackendURL":""')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('advertises the direct controller port without exposing its secret', async () => {
    process.env.PUBLIC_DIRECT_ACCESS = 'true'
    process.env.CLASH_API_PORT = '19090'
    process.env.CLASH_SECRET = 'must-stay-server-side'
    const { server, base } = await start()
    try {
      const body = await (await fetch(`${base}/config.js`)).text()
      expect(body).toContain('"directClashApiPort":19090')
      expect(body).not.toContain('must-stay-server-side')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
