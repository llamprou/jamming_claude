/**
 * Features that run in the window (camera, looper, sampler...). Each lives in
 * its own folder here, exports a start() that subscribes to what it needs
 * (the feature bus, mic blocks, the voice registry), and is listed once below.
 * start() runs once when the window opens.
 */
import { start as camera } from './camera'

const features: Array<() => void | Promise<void>> = [camera]

export function startFeatures(): void {
  for (const start of features) void Promise.resolve().then(start).catch((error) => console.error('feature failed to start', error))
}
