import * as tf from '@tensorflow/tfjs'
import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch'

/**
 * The slow, accurate half of audio transcription: Spotify's Basic Pitch, a
 * small neural network that hears several notes at once. It runs locally (in a
 * Web Worker in the app, on the CPU in tests) on a few seconds of audio at a
 * time. The fast YIN tracker shows something now; this corrects it shortly after.
 */

export const MODEL_SAMPLE_RATE = 22050

export interface RawNote {
  pitch: number
  /** Seconds from the start of the audio that was transcribed. */
  start: number
  duration: number
  /** 0-1, how strongly the model heard it. */
  amplitude: number
}

export interface TranscribeOptions {
  /** Onset sensitivity, 0-1. Lower hears more note starts. */
  onsetThreshold?: number
  /** Sustain sensitivity, 0-1. Lower holds notes longer. */
  frameThreshold?: number
  /** Notes quieter than this are dropped as ghosts. */
  minAmplitude?: number
  minDurationSeconds?: number
}

export type Transcriber = (audio: Float32Array, options?: TranscribeOptions) => Promise<RawNote[]>

/** tfjs model.json as shipped in @spotify/basic-pitch/model. */
interface ModelJson {
  modelTopology: object
  weightsManifest: Array<{ weights: tf.io.WeightsManifestEntry[] }>
  format?: string
  generatedBy?: string
  convertedBy?: string
}

/**
 * Build a transcriber from the model's two files, however the caller loaded
 * them (fetch in the app, fs in tests).
 */
export function createTranscriber(modelJson: ModelJson, weights: ArrayBuffer): Transcriber {
  const model = tf.loadGraphModel(
    tf.io.fromMemory({
      modelTopology: modelJson.modelTopology,
      weightSpecs: modelJson.weightsManifest.flatMap((group) => group.weights),
      weightData: weights,
      format: modelJson.format,
      generatedBy: modelJson.generatedBy,
      convertedBy: modelJson.convertedBy,
    }),
  )
  const basicPitch = new BasicPitch(model)

  return async (audio, options = {}) => {
    const frames: number[][] = []
    const onsets: number[][] = []
    await basicPitch.evaluateModel(
      audio,
      (f, o) => {
        frames.push(...f)
        onsets.push(...o)
      },
      () => undefined,
    )
    const minFrames = Math.max(3, Math.round((options.minDurationSeconds ?? 0.06) * (MODEL_SAMPLE_RATE / 256)))
    const events = noteFramesToTime(outputToNotesPoly(frames, onsets, options.onsetThreshold ?? 0.5, options.frameThreshold ?? 0.3, minFrames))
    const raw = events.map((e) => ({ pitch: e.pitchMidi, start: Math.max(0, e.startTimeSeconds), duration: e.durationSeconds, amplitude: e.amplitude }))
    return removeGhosts(raw, options.minAmplitude ?? 0.45)
  }
}

/**
 * Drop what the model tends to hallucinate: faint notes, and faint notes that
 * sit on a harmonic (octave, twelfth, two octaves) of a louder note sounding
 * at the same time.
 */
export function removeGhosts(notes: RawNote[], minAmplitude = 0.45): RawNote[] {
  const HARMONICS = [12, 19, 24, 28]
  const overlaps = (a: RawNote, b: RawNote) => a.start < b.start + b.duration && b.start < a.start + a.duration
  return notes
    .filter((n) => n.amplitude >= minAmplitude)
    .filter((n, _i, kept) => !kept.some((o) => o !== n && HARMONICS.includes(n.pitch - o.pitch) && overlaps(n, o) && n.amplitude < o.amplitude * 0.75))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}
