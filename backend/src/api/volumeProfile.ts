import type { FastifyInstance } from 'fastify'
import { getAdvancedMetricsSnapshot } from '../data/advancedMetricsState'
import { buildVolumeProfile } from '../data/volumeProfileService'

export async function registerVolumeProfile(app: FastifyInstance): Promise<void> {
  // Summary snapshot from in-memory state (updated every 60s by the poller)
  app.get('/api/volume-profile', async (_req, reply) => {
    const snapshot = getAdvancedMetricsSnapshot()
    if (!snapshot?.profile) {
      return reply.code(503).send({ error: 'Volume Profile not yet calculated' })
    }
    return reply.send(snapshot.profile)
  })

  // Full profile with complete profileData[] buckets — reads from incremental in-memory state
  app.get('/api/volume-profile/detail', async (_req, reply) => {
    const result = await buildVolumeProfile('SPY')
    if (!result) {
      return reply.code(503).send({ error: 'Volume Profile not yet calculated' })
    }
    return reply.send(result)
  })
}
