import type { MainEvent } from '@shared/ipc'

/**
 * The window's end of the feature bus (see src/main/bus.ts). A feature's
 * window code listens and answers on its own name only.
 */

type Handler = (message: unknown) => void
type Responder = (message: unknown) => unknown | Promise<unknown>

const handlers = new Map<string, Set<Handler>>()
const responders = new Map<string, Responder>()

/** Messages the main process sends with bus.send(feature, ...). */
export function onFeature(feature: string, handler: Handler): () => void {
  const set = handlers.get(feature) ?? new Set()
  set.add(handler)
  handlers.set(feature, set)
  return () => set.delete(handler)
}

/** Answer bus.request(feature, ...) from the main process. One responder per feature. */
export function answerFeature(feature: string, responder: Responder): void {
  responders.set(feature, responder)
}

/** Send to this feature's main-process code (bus.on(feature, ...)). */
export const sendFeature = (feature: string, message: unknown): void => window.jam.feature(feature, message)

/** Called once from App with every event from main. */
export function routeFeatureEvent(event: MainEvent): void {
  if (event.type === 'feature') {
    for (const handler of handlers.get(event.feature) ?? []) handler(event.message)
  } else if (event.type === 'feature-request') {
    const responder = responders.get(event.feature)
    if (!responder) return window.jam.featureReply(event.id, null, `No ${event.feature} feature is running in the window.`)
    Promise.resolve()
      .then(() => responder(event.message))
      .then(
        (result) => window.jam.featureReply(event.id, result),
        (error: unknown) => window.jam.featureReply(event.id, null, error instanceof Error ? error.message : String(error)),
      )
  }
}
