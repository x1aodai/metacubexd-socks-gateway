import { defineNitroPlugin } from 'nitropack/runtime'
import { getAgent } from '../lib/supervisor'

export default defineNitroPlugin(async (nitroApp) => {
  const { supervisor, gateway, gatewaySubscriptions } = getAgent()
  if (!gateway || !gatewaySubscriptions)
    throw new Error('gateway managers are not configured')

  nitroApp.hooks.hook('close', async () => {
    gatewaySubscriptions.stop()
    await supervisor.dispose()
  })

  await gateway.bootstrap()
  gatewaySubscriptions.start()
})
