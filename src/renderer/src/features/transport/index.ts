import { TRANSPORT, type TransportPush, type TransportRequest } from '@shared/features/transport'
import { answerFeature, onFeature } from '../bus'
import { engine } from './engine'

/**
 * The transport: plays clips and recorded audio as layers that stay in time
 * with the player. Driven entirely over the feature bus by
 * src/main/agent/tools/transport.ts; the engine is in engine.ts and the
 * arithmetic in src/shared/music/transport/.
 */
export function start(): void {
  engine.listen()
  answerFeature(TRANSPORT, (message) => engine.handle(message as TransportRequest))
  onFeature(TRANSPORT, (message) => {
    const push = message as TransportPush
    if (push.type === 'beat') engine.heard(push.player)
  })
  // Escape silences everything, loops included.
  window.addEventListener('keydown', (event) => event.key === 'Escape' && engine.stopAll())
}
