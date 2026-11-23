import type { MainEvent } from '@shared/ipc'

type Handler = (message: unknown) => void

/**
 * The channel between a feature's main-process code (usually a tool module)
 * and its code in the window. Features talk only on their own name, so adding
 * one never touches another's messages or the core IPC contract.
 */
export class FeatureBus {
  private handlers = new Map<string, Set<Handler>>()
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private nextId = 1

  constructor(private readonly emit: (event: MainEvent) => void) {}

  /** Fire-and-forget to the window. */
  send(feature: string, message: unknown): void {
    this.emit({ type: 'feature', feature, message })
  }

  /** Ask the window for something (a camera frame, a recording) and wait for it. */
  request<T = unknown>(feature: string, message: unknown, timeoutMs = 10_000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The window did not answer the ${feature} request in time.`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.emit({ type: 'feature-request', id, feature, message })
    })
  }

  /** Listen for messages the window sends on this feature's name. */
  on(feature: string, handler: Handler): () => void {
    const set = this.handlers.get(feature) ?? new Set()
    set.add(handler)
    this.handlers.set(feature, set)
    return () => set.delete(handler)
  }

  /** Wired to IPC in main/index.ts. */
  deliver(feature: string, message: unknown): void {
    for (const handler of this.handlers.get(feature) ?? []) handler(message)
  }

  /** Wired to IPC in main/index.ts. */
  settle(id: number, result: unknown, error?: string): void {
    const request = this.pending.get(id)
    if (!request) return
    this.pending.delete(id)
    clearTimeout(request.timer)
    if (error) request.reject(new Error(error))
    else request.resolve(result)
  }
}
