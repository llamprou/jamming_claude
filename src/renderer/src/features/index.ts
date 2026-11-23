/**
 * Features that run in the window (camera, looper, sampler...). Each lives in
 * its own folder here, exports a start() that subscribes to what it needs
 * (the feature bus, mic blocks, the voice registry), and is listed once below.
 * start() runs once when the window opens.
 */
import { start as camera } from './camera'
import { start as sampler } from './sampler'
import { start as screen } from './screen'
import { start as transport } from './transport'
import { start as whiteboard } from './whiteboard'
import { start as notation } from './notation'
import { start as log } from './log'
import { log as windowLog } from '../log'

const logError = windowLog.error

const features: Array<() => void | Promise<void>> = [
  log,
  sampler,
  transport,
  camera,
  screen,
  whiteboard,
  notation,
]

export function startFeatures(): void {
  for (const start of features)
    void Promise.resolve()
      .then(start)
      .catch((error) => {
        console.error('feature failed to start', error)
        logError('window', `feature ${start.name || '?'} failed to start`, error)
      })
}
