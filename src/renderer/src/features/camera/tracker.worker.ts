/// <reference lib="webworker" />
import { HandLandmarker } from '@mediapipe/tasks-vision'
// The ES-module build of the wasm loader: a module worker cannot importScripts().
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url&no-inline'
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url&no-inline'

/**
 * Runs MediaPipe's hand landmark model off the UI thread. Everything it loads
 * (wasm loader, wasm binary, model) is one of the app's own files: the page's
 * Content-Security-Policy allows nothing else, and the app must work offline.
 *
 * The model is not in the npm package. `node scripts/fetch-vision-assets.mjs`
 * downloads it into assets/vision/ (gitignored); the glob below picks it up at
 * build time, and is empty, rather than a build error, when it is missing.
 */
const models = import.meta.glob<string>('../../../../../assets/vision/hand_landmarker.task', { query: '?url&no-inline', import: 'default', eager: true })
const modelUrl = Object.values(models)[0]

export type TrackerRequest = { type: 'init' } | { type: 'frame'; id: number; bitmap: ImageBitmap }

export interface RawHand {
  /** MediaPipe's own label; see toHand in camera.ts for how it is read. */
  label: 'Left' | 'Right'
  score: number
  landmarks: Array<{ x: number; y: number; z: number }>
}

export type TrackerResponse =
  | { type: 'ready' }
  | { type: 'failed'; error: string }
  | { type: 'hands'; id: number; hands: RawHand[]; ms: number }
  | { type: 'error'; id: number; error: string }

let ready: Promise<HandLandmarker> | null = null

async function load(): Promise<HandLandmarker> {
  if (!modelUrl) throw new Error('The hand tracking model is not installed. Run: node scripts/fetch-vision-assets.mjs, then rebuild.')
  // MediaPipe hands every picture to the model through a WebGL texture, even when the model itself runs on the CPU.
  // Without WebGL it does not fail, it hangs; so check first.
  if (!new OffscreenCanvas(1, 1).getContext('webgl2')) throw new Error('Hand tracking needs WebGL, which this machine is not offering.')
  return HandLandmarker.createFromOptions(
    { wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl },
    {
      // CPU: about as fast as GPU for a model this small, and it behaves the same on every machine.
      baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    },
  )
}

const reply = (message: TrackerResponse) => self.postMessage(message)
const text = (error: unknown) => (error instanceof Error ? error.message : String(error))

self.onmessage = async (message: MessageEvent<TrackerRequest>) => {
  const request = message.data
  if (request.type === 'init') {
    try {
      await (ready ??= load())
      reply({ type: 'ready' })
    } catch (error) {
      ready = null
      reply({ type: 'failed', error: text(error) })
    }
    return
  }
  const started = performance.now()
  try {
    const tracker = await (ready ??= load())
    // VIDEO mode wants strictly increasing millisecond timestamps.
    const result = tracker.detectForVideo(request.bitmap, started)
    const hands: RawHand[] = result.landmarks.map((landmarks, i) => {
      const category = result.handedness[i]?.[0]
      return {
        label: category?.categoryName === 'Left' ? 'Left' : 'Right',
        score: category?.score ?? 0,
        landmarks: landmarks.map(({ x, y, z }) => ({ x, y, z })),
      }
    })
    reply({ type: 'hands', id: request.id, hands, ms: performance.now() - started })
  } catch (error) {
    reply({ type: 'error', id: request.id, error: text(error) })
  } finally {
    request.bitmap.close()
  }
}
