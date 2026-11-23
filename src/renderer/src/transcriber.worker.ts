/// <reference lib="webworker" />
import * as tf from '@tensorflow/tfjs'
import modelUrl from '@spotify/basic-pitch/model/model.json?url'
import weightsUrl from '@spotify/basic-pitch/model/group1-shard1of1.bin?url'
import { createTranscriber, MODEL_SAMPLE_RATE, type RawNote, type Transcriber } from '@shared/music/polyphonic'

/**
 * Runs the polyphonic model off the UI and audio threads. One request at a
 * time: { id, audio } in, { id, notes } or { id, error } out.
 *
 * A worker created with the name "cpu" never tries the GPU; mic.ts starts one
 * of those if the GPU worker hangs.
 */

export type TranscribeRequest = { id: number; audio: Float32Array }
export type TranscribeResponse = { id: number; notes?: RawNote[]; error?: string; backend?: string; ms?: number }

let ready: Promise<Transcriber> | null = null

async function files(): Promise<[object, ArrayBuffer]> {
  const [json, weights] = await Promise.all([
    fetch(modelUrl).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`model file not found (${r.status})`)))),
    fetch(weightsUrl).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`model weights not found (${r.status})`)))),
  ])
  return [json as object, weights]
}

/** Two seconds of an A major triad: the GPU must hear A4 in it, or its numbers are not trustworthy. */
async function hearsTestChord(transcribe: Transcriber): Promise<boolean> {
  const audio = new Float32Array(MODEL_SAMPLE_RATE * 2)
  for (const pitch of [69, 73, 76]) {
    const hz = 440 * 2 ** ((pitch - 69) / 12)
    for (let i = 0; i < audio.length; i++) audio[i]! += 0.2 * Math.sin((2 * Math.PI * hz * i) / MODEL_SAMPLE_RATE) * Math.min(1, (audio.length - i) / 2000)
  }
  const notes = await transcribe(audio)
  return notes.some((n) => n.pitch === 69)
}

async function load(): Promise<Transcriber> {
  const [json, weights] = await files()
  // GPU if the machine offers it and it gives sane answers, otherwise plain CPU (slower, still correct).
  if (self.name !== 'cpu' && (await tf.setBackend('webgl').catch(() => false))) {
    try {
      await tf.ready()
      const transcribe = createTranscriber(json as Parameters<typeof createTranscriber>[0], weights)
      if (await hearsTestChord(transcribe)) return transcribe
    } catch {
      // fall through to the CPU
    }
  }
  await tf.setBackend('cpu')
  await tf.ready()
  return createTranscriber(json as Parameters<typeof createTranscriber>[0], weights)
}

self.onmessage = async (message: MessageEvent<TranscribeRequest>) => {
  const { id, audio } = message.data
  const started = performance.now()
  try {
    const transcribe = await (ready ??= load().catch((error: unknown) => {
      ready = null // try loading again next time instead of failing forever
      throw error
    }))
    const notes = await transcribe(audio)
    self.postMessage({ id, notes, backend: tf.getBackend(), ms: Math.round(performance.now() - started) } satisfies TranscribeResponse)
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error), backend: tf.getBackend() } satisfies TranscribeResponse)
  }
}
