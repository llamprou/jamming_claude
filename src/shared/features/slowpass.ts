import type { SlowPassStatus } from '../music/slowpass'

/** The part of main's FeatureBus the watcher needs. */
interface FeatureBusLike {
  on(feature: string, handler: (message: unknown) => void): unknown
}

/**
 * Bus traffic for the slow (polyphonic, chord-hearing) audio pass. The window
 * (audio/mic.ts) pushes a SlowPassStatus about once a second; main keeps the
 * latest so `listen` and `read_music` can say whether chords are being heard.
 */
export const SLOW_PASS = 'slowpass'

export type { SlowPassStatus }

/** Keep the latest status the window pushed. One watcher per bus, shared by every tool module. */
const watchers = new WeakMap<object, () => SlowPassStatus | null>()

export function watchSlowPass(bus: FeatureBusLike): () => SlowPassStatus | null {
  const existing = watchers.get(bus)
  if (existing) return existing
  let latest: SlowPassStatus | null = null
  bus.on(SLOW_PASS, (message) => {
    latest = message as SlowPassStatus
  })
  const read = () => latest
  watchers.set(bus, read)
  return read
}
