/// <reference lib="webworker" />
import * as tf from '@tensorflow/tfjs'
import modelUrl from '@spotify/basic-pitch/model/model.json?url'
import weightsUrl from '@spotify/basic-pitch/model/group1-shard1of1.bin?url'
import { createTranscriber, type RawNote, type Transcriber } from '@shared/music/polyphonic'

/**
 * Runs the polyphonic model off the UI and audio threads. One request at a
 * time: { id, audio } in, { id, notes } or { id, error } out.
 */

export type TranscribeRequest = { id: number; audio: Float32Array }
export type TranscribeResponse = { id: number; notes?: RawNote[]; error?: string; backend?: string; ms?: number }

let ready: Promise<Transcriber> | null = null

async function load(): Promise<Transcriber> {
  // GPU if the machine offers it, otherwise plain CPU (slower, still correct).
  if (!(await tf.setBackend('webgl').catch(() => false))) await tf.setBackend('cpu')
  await tf.ready()
  const [json, weights] = await Promise.all([fetch(modelUrl).then((r) => r.json()), fetch(weightsUrl).then((r) => r.arrayBuffer())])
  return createTranscriber(json, weights)
}

self.onmessage = async (message: MessageEvent<TranscribeRequest>) => {
  const { id, audio } = message.data
  const started = performance.now()
  try {
    const transcribe = await (ready ??= load())
    const notes = await transcribe(audio)
    self.postMessage({ id, notes, backend: tf.getBackend(), ms: Math.round(performance.now() - started) } satisfies TranscribeResponse)
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies TranscribeResponse)
  }
}
