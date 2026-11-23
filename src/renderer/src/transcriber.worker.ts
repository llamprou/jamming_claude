/// <reference lib="webworker" />
import * as tf from '@tensorflow/tfjs'
import modelUrl from '@spotify/basic-pitch/model/model.json?url'
import weightsUrl from '@spotify/basic-pitch/model/group1-shard1of1.bin?url'
import { createTranscriber, MODEL_SAMPLE_RATE, type RawNote, type Transcriber } from '@shared/music/polyphonic'
import { entry, errorData, type LogEntry, type LogLevel } from '@shared/log'

/**
 * Runs the polyphonic model off the UI and audio threads. One request at a
 * time: { id, audio } in, { id, notes } or { id, error } out.
 *
 * A worker created with the name "cpu" never tries the GPU; mic.ts starts one
 * of those if the GPU worker hangs.
 */

export type TranscribeRequest = { id: number; audio: Float32Array }
/** An answer to a request, or (with `log` and no id) a diagnostic entry for mic.ts to forward to the log file. */
export type TranscribeResponse = { id?: number; notes?: RawNote[]; error?: string; stack?: string; backend?: string; ms?: number; log?: LogEntry }

const log = (level: LogLevel, message: string, data?: Record<string, unknown>) =>
  self.postMessage({ log: entry(level, `worker:${self.name || 'auto'}`, message, data) } satisfies TranscribeResponse)

self.addEventListener('error', (event) => log('error', `uncaught error: ${event.message}`, { ...errorData(event.error), line: event.lineno }))
self.addEventListener('unhandledrejection', (event) => log('error', 'unhandled promise rejection', errorData(event.reason)))

let ready: Promise<Transcriber> | null = null

async function files(): Promise<[object, ArrayBuffer]> {
  const started = performance.now()
  const [json, weights] = await Promise.all([
    fetch(modelUrl).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`model file not found (${r.status})`)))),
    fetch(weightsUrl).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`model weights not found (${r.status})`)))),
  ])
  log('info', 'model files fetched', { ms: Math.round(performance.now() - started), weightsBytes: weights.byteLength })
  return [json as object, weights]
}

/** Two seconds of an A major triad: the GPU must hear A4 in it, or its numbers are not trustworthy. */
async function hearsTestChord(transcribe: Transcriber): Promise<boolean> {
  const audio = new Float32Array(MODEL_SAMPLE_RATE * 2)
  for (const pitch of [69, 73, 76]) {
    const hz = 440 * 2 ** ((pitch - 69) / 12)
    for (let i = 0; i < audio.length; i++) audio[i]! += 0.2 * Math.sin((2 * Math.PI * hz * i) / MODEL_SAMPLE_RATE) * Math.min(1, (audio.length - i) / 2000)
  }
  const started = performance.now()
  const notes = await transcribe(audio)
  const ok = notes.some((n) => n.pitch === 69)
  log(ok ? 'info' : 'warn', `GPU sanity check ${ok ? 'passed' : 'FAILED'} (test chord A C# E)`, {
    ms: Math.round(performance.now() - started),
    notes: notes.length,
    pitchesHeard: [...new Set(notes.map((n) => n.pitch))].sort((a, b) => a - b).slice(0, 12),
  })
  return ok
}

async function load(): Promise<Transcriber> {
  const started = performance.now()
  log('info', 'model load started', { wantGpu: self.name !== 'cpu' })
  const [json, weights] = await files()
  // GPU if the machine offers it and it gives sane answers, otherwise plain CPU (slower, still correct).
  if (self.name === 'cpu') log('info', 'skipping the GPU: this worker was started for the CPU')
  else {
    let webgl: unknown = false
    try {
      webgl = await tf.setBackend('webgl')
    } catch (error) {
      log('warn', 'webgl backend threw', errorData(error))
    }
    if (!webgl) log('warn', 'webgl backend unavailable; falling back to CPU')
    else {
      try {
        await tf.ready()
        const gl = glInfo()
        log('info', 'webgl backend ready', gl)
        const transcribe = createTranscriber(json as Parameters<typeof createTranscriber>[0], weights)
        if (await hearsTestChord(transcribe)) {
          log('info', 'model loaded', { backend: tf.getBackend(), ms: Math.round(performance.now() - started) })
          return transcribe
        }
        log('warn', 'falling back to CPU: the GPU gave wrong answers on the test chord')
      } catch (error) {
        log('warn', 'falling back to CPU: the GPU failed while loading or testing the model', errorData(error))
      }
    }
  }
  await tf.setBackend('cpu')
  await tf.ready()
  const transcribe = createTranscriber(json as Parameters<typeof createTranscriber>[0], weights)
  log('info', 'model loaded', { backend: tf.getBackend(), ms: Math.round(performance.now() - started) })
  return transcribe
}

/** What WebGL reports about itself, for telling GPUs apart in the log. */
function glInfo(): Record<string, unknown> {
  try {
    const flags = tf.env().getFlags()
    return { webglVersion: flags.WEBGL_VERSION, float32: flags.WEBGL_RENDER_FLOAT32_ENABLED, maxTextureSize: flags.WEBGL_MAX_TEXTURE_SIZE }
  } catch {
    return {}
  }
}

self.onmessage = async (message: MessageEvent<TranscribeRequest>) => {
  const { id, audio } = message.data
  const started = performance.now()
  try {
    const transcribe = await (ready ??= load().catch((error: unknown) => {
      ready = null // try loading again next time instead of failing forever
      log('error', 'model load failed; will retry on the next request', errorData(error))
      throw error
    }))
    const notes = await transcribe(audio)
    self.postMessage({ id, notes, backend: tf.getBackend(), ms: Math.round(performance.now() - started) } satisfies TranscribeResponse)
  } catch (error) {
    const { error: text, stack } = errorData(error) as { error: string; stack?: string }
    self.postMessage({ id, error: text, stack, backend: tf.getBackend(), ms: Math.round(performance.now() - started) } satisfies TranscribeResponse)
  }
}
