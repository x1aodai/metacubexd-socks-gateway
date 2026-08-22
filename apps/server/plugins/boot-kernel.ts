import { defineNitroPlugin } from 'nitropack/runtime'
import { getAgent } from '../lib/supervisor'

export default defineNitroPlugin(async (nitroApp) => {
  const { supervisor, gateway, gatewaySubscriptions } = getAgent()

  nitroApp.hooks.hook('close', async () => {
    gatewaySubscriptions.stop()
    await supervisor.dispose()
  })

  await gateway.bootstrap()
  gatewaySubscriptions.start()
})
