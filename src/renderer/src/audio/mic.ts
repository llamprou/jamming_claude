import type { NoteEvent } from '@shared/music/types'
import { detectPitch, hzToMidi } from '@shared/music/pitch'
import { AudioRing, Resampler, SlowPass, type Correction } from '@shared/music/slowpass'
import tapWorkletUrl from '../tap.worklet.js?url&no-inline'
import type { TranscribeRequest, TranscribeResponse } from '../transcriber.worker'
import { audioContext, publishMicBlock } from './context'

export interface MicHandle {
  stop(): void
}

/**
 * Open the mic once and split it two ways:
 *  - speech path: echo-cancelled, downsampled to 16 kHz PCM16 for speech-to-text
 *  - music path, fast: a monophonic pitch tracker puts single notes on screen
 *    within tens of milliseconds.
 *  - music path, slow: every few seconds a polyphonic model in a worker
 *    re-hears the same audio (chords included) and its notes replace the fast
 *    pass's guesses for that stretch.
 */
export async function startMic(opts: {
  onSpeechPcm(pcm16: ArrayBuffer): void
  onNotes(notes: NoteEvent[]): void
  onCorrection(correction: Correction): void
  /** Reports which engine the slow pass is running on, and how long a run takes. */
  onEngine?(description: string): void
  /** Mic loudness, 0-1, a few times a second: drives the on-screen presence. */
  onLevel?(level: number): void
  now(): number
}): Promise<MicHandle> {
  const audio = audioContext()
  await audio.resume()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  })
  await audio.audioWorklet.addModule(tapWorkletUrl)
  const source = audio.createMediaStreamSource(stream)
  const tap = new AudioWorkletNode(audio, 'tap')
  source.connect(tap)

  // Slow pass: keep the last 30 s at the model's sample rate and let the
  // scheduler decide when a stretch is ready to be re-heard.
  const worker = new Worker(new URL('../transcriber.worker.ts', import.meta.url), { type: 'module' })
  const pending = new Map<number, { resolve(notes: NonNullable<TranscribeResponse['notes']>): void; reject(error: Error): void }>()
  let requestId = 0
  worker.onmessage = (message: MessageEvent<TranscribeResponse>) => {
    const { id, notes, error, backend, ms } = message.data
    const request = pending.get(id)
    pending.delete(id)
    if (notes) {
      opts.onEngine?.(`polyphonic pass on ${backend}, ${ms} ms`)
      request?.resolve(notes)
    } else {
      opts.onEngine?.(`polyphonic pass failed: ${error}`)
      request?.reject(new Error(error))
    }
  }
  let levelTick = 0
  const modelRate = new Resampler(audio.sampleRate)
  const ring = new AudioRing(30)
  const slowPass = new SlowPass(
    ring,
    (samples) =>
      new Promise((resolve, reject) => {
        const id = ++requestId
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, audio: samples } satisfies TranscribeRequest, [samples.buffer])
      }),
    opts.onCorrection,
  )

  const ratio = audio.sampleRate / 16000
  let resamplePhase = 0
  let speech: number[] = []

  const frameSize = 2048
  let frame = new Float32Array(frameSize)
  let filled = 0
  let current: { pitch: number; start: number; frames: number } | null = null

  const closeNote = (end: number) => {
    if (current && current.frames >= 2) {
      opts.onNotes([{ pitch: current.pitch, start: current.start, duration: Math.max(end - current.start, 0.05), velocity: 0.7, source: 'audio', confidence: 0.5 }])
    }
    current = null
  }

  tap.port.onmessage = (message: MessageEvent<Float32Array>) => {
    const block = message.data
    publishMicBlock(block, audio.sampleRate, opts.now())

    if (opts.onLevel && ++levelTick % 12 === 0) {
      let sum = 0
      for (let i = 0; i < block.length; i++) sum += block[i]! * block[i]!
      opts.onLevel(Math.min(1, Math.sqrt(sum / block.length) * 8))
    }

    ring.push(modelRate.process(block), opts.now())
    slowPass.tick()

    for (; resamplePhase < block.length; resamplePhase += ratio) {
      speech.push(Math.max(-1, Math.min(1, block[Math.floor(resamplePhase)]!)) * 32767)
    }
    resamplePhase -= block.length
    if (speech.length >= 1280) {
      opts.onSpeechPcm(Int16Array.from(speech).buffer) // 80 ms chunks
      speech = []
    }

    let offset = 0
    while (offset < block.length) {
      const take = Math.min(frameSize - filled, block.length - offset)
      frame.set(block.subarray(offset, offset + take), filled)
      filled += take
      offset += take
      if (filled < frameSize) break
      const hz = detectPitch(frame, audio.sampleRate)
      const time = opts.now()
      const pitch = hz ? Math.round(hzToMidi(hz)) : null
      if (pitch === null || (current && pitch !== current.pitch)) closeNote(time)
      if (pitch !== null) {
        if (!current) current = { pitch, start: time, frames: 1 }
        else current.frames += 1
      }
      // 50% overlap between analysis frames
      frame.copyWithin(0, frameSize / 2)
      filled = frameSize / 2
    }
  }

  return {
    stop() {
      tap.port.onmessage = null
      worker.terminate()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      frame = new Float32Array(0)
    },
  }
}
