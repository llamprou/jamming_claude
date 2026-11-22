import { MODEL_SAMPLE_RATE, type RawNote } from './polyphonic'
import type { NoteEvent } from './types'

/** Streaming linear resampler: feed blocks at any rate, get 22.05 kHz out. */
export class Resampler {
  private position = 0
  private last = 0

  constructor(
    private readonly sourceRate: number,
    private readonly targetRate = MODEL_SAMPLE_RATE,
  ) {}

  process(block: Float32Array): Float32Array {
    const step = this.sourceRate / this.targetRate
    const out: number[] = []
    // `position` is measured in source samples relative to this block; -1 is `last`.
    while (this.position < block.length - 1) {
      const index = Math.floor(this.position)
      const fraction = this.position - index
      const a = index < 0 ? this.last : block[index]!
      const b = block[index + 1]!
      out.push(a + (b - a) * fraction)
      this.position += step
    }
    this.position -= block.length
    this.last = block[block.length - 1] ?? this.last
    return Float32Array.from(out)
  }
}

/** The most recent stretch of audio, addressable by session time. */
export class AudioRing {
  private readonly buffer: Float32Array
  private written = 0
  /** Session time of the sample that will be written next. */
  private endTime = 0

  constructor(
    seconds: number,
    private readonly sampleRate = MODEL_SAMPLE_RATE,
  ) {
    this.buffer = new Float32Array(Math.ceil(seconds * sampleRate))
  }

  /** Append samples; `endTime` is the session time at the end of this block. */
  push(samples: Float32Array, endTime: number): void {
    for (let i = 0; i < samples.length; i++) this.buffer[(this.written + i) % this.buffer.length] = samples[i]!
    this.written += samples.length
    this.endTime = endTime
  }

  get end(): number {
    return this.endTime
  }

  get start(): number {
    return this.endTime - Math.min(this.written, this.buffer.length) / this.sampleRate
  }

  /** Samples covering [from, to), clamped to what is still held. */
  slice(from: number, to: number): { audio: Float32Array; from: number } {
    const clampedFrom = Math.max(from, this.start)
    const count = Math.max(0, Math.round((Math.min(to, this.endTime) - clampedFrom) * this.sampleRate))
    const first = this.written - Math.round((this.endTime - clampedFrom) * this.sampleRate)
    const audio = new Float32Array(count)
    for (let i = 0; i < count; i++) audio[i] = this.buffer[(((first + i) % this.buffer.length) + this.buffer.length) % this.buffer.length]!
    return { audio, from: clampedFrom }
  }
}

export interface Correction {
  from: number
  to: number
  notes: NoteEvent[]
}

export interface SlowPassOptions {
  /** Run the model once this much new audio is waiting. */
  hopSeconds?: number
  /** Audio before the new stretch given to the model as context (not re-committed). */
  contextSeconds?: number
  /** The newest audio is held back: a note cut off by the window edge is heard whole next time. */
  marginSeconds?: number
  /**
   * Most audio one run may commit. If the model cannot keep up (no GPU), older
   * audio is left as the fast pass heard it so corrections stay recent.
   */
  maxStretchSeconds?: number
  /** Below this RMS a stretch counts as silence and the model is skipped. */
  silenceRms?: number
}

/**
 * Decides when to run the polyphonic model and which stretch of the transcript
 * each run may overwrite. Windows overlap, but every moment is committed once:
 *
 *   |-- context --|------ committed this run ------|- margin -|
 *                 ^ committedUntil                            ^ now
 */
export class SlowPass {
  private committedUntil: number | null = null
  private busy = false
  private readonly hop: number
  private readonly context: number
  private readonly margin: number
  private readonly silenceRms: number
  private readonly maxStretch: number

  constructor(
    private readonly ring: AudioRing,
    private readonly transcribe: (audio: Float32Array) => Promise<RawNote[]>,
    private readonly onCorrection: (correction: Correction) => void,
    options: SlowPassOptions = {},
  ) {
    this.hop = options.hopSeconds ?? 3
    this.context = options.contextSeconds ?? 1.5
    this.margin = options.marginSeconds ?? 0.6
    this.silenceRms = options.silenceRms ?? 0.004
    this.maxStretch = options.maxStretchSeconds ?? 8
  }

  get running(): boolean {
    return this.busy
  }

  /** Call often (e.g. on every audio block). Returns true if a run was started. */
  tick(): boolean {
    if (this.busy) return false
    const now = this.ring.end
    this.committedUntil ??= this.ring.start
    // If the model fell far behind (or audio paused), skip ahead rather than queue up stale work.
    this.committedUntil = Math.max(this.committedUntil, this.ring.start)
    const to = now - this.margin
    if (to - this.committedUntil < this.hop) return false
    this.committedUntil = Math.max(this.committedUntil, to - this.maxStretch)
    void this.run(this.committedUntil, to, now)
    return true
  }

  private async run(from: number, to: number, now: number): Promise<void> {
    this.busy = true
    try {
      const window = this.ring.slice(from - this.context, now)
      let notes: NoteEvent[] = []
      if (rms(window.audio) >= this.silenceRms) {
        const raw = await this.transcribe(window.audio)
        notes = raw
          .map((n) => ({ ...n, start: n.start + window.from }))
          .filter((n) => n.start >= from && n.start < to)
          .map((n) => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: Math.min(1, n.amplitude), source: 'audio' as const, confidence: Math.min(1, n.amplitude) }))
      }
      this.committedUntil = to
      this.onCorrection({ from, to, notes })
    } catch {
      // A failed run leaves the fast pass's notes in place; the next tick retries from the same point.
    } finally {
      this.busy = false
    }
  }
}

export function rms(audio: Float32Array): number {
  if (audio.length === 0) return 0
  let sum = 0
  for (let i = 0; i < audio.length; i++) sum += audio[i]! * audio[i]!
  return Math.sqrt(sum / audio.length)
}
