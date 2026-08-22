import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  srcDir: '.',
  css: ['~/assets/css/main.css'],
  ssr: false,
  router: {
    options: {
      hashMode: true,
    },
  },
  typescript: {
    strict: true,
    shim: false,
  },
  app: {
    head: {
      charset: 'utf-8',
      htmlAttrs: { lang: 'zh-CN' },
      viewport:
        'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover',
      title: 'SOCKS 网关',
      meta: [{ name: 'theme-color', content: '#ffffff' }],
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
  compatibilityDate: '2025-01-01',
})
