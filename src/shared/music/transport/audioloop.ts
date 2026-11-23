/**
 * Looping the player's actual sound: a rolling buffer of mic samples that can
 * be cut by session time, and the timing of one loop pass with its crossfade.
 */

/**
 * Turns "this block arrived at session time T" into a steady sample clock.
 * Blocks reach the main thread late by a varying amount but never early, so
 * the earliest arrival seen (relative to the running sample count) is the
 * best estimate of when samples really happened.
 */
export class SampleClock {
  private offset = Infinity
  private lateRun = 0

  constructor(private readonly sampleRate: number) {}

  /** `samplesEnd` is the total number of samples received once this block is counted. */
  observe(samplesEnd: number, arrival: number): void {
    const candidate = arrival - samplesEnd / this.sampleRate
    if (candidate <= this.offset) {
      this.offset = candidate
      this.lateRun = 0
      return
    }
    // Consistently late by a lot means samples were lost (the count fell behind): start over.
    if (candidate - this.offset > 0.08) {
      if (++this.lateRun > 200) {
        this.offset = candidate
        this.lateRun = 0
      }
    } else {
      this.lateRun = 0
      // Let the estimate creep up slowly so real clock drift is followed.
      this.offset += Math.min(candidate - this.offset, 3e-7)
    }
  }

  /** Session time at which sample number `index` (0-based count from the start) was captured. */
  timeOf(index: number): number {
    return this.offset + index / this.sampleRate
  }

  indexAt(time: number): number {
    return Math.round((time - this.offset) * this.sampleRate)
  }

  get ready(): boolean {
    return this.offset !== Infinity
  }
}

export class RollingAudio {
  private readonly buffer: Float32Array
  private written = 0
  private readonly clock: SampleClock

  constructor(
    seconds: number,
    readonly sampleRate: number,
  ) {
    this.buffer = new Float32Array(Math.ceil(seconds * sampleRate))
    this.clock = new SampleClock(sampleRate)
  }

  /** Append a block; `arrival` is the session time it was received (the end of the block). */
  push(block: Float32Array, arrival: number): void {
    const size = this.buffer.length
    let at = this.written % size
    for (let i = 0; i < block.length; i++) {
      this.buffer[at] = block[i]!
      if (++at === size) at = 0
    }
    this.written += block.length
    this.clock.observe(this.written, arrival)
  }

  /** Session time of the oldest sample still held. */
  get start(): number {
    return this.clock.timeOf(Math.max(0, this.written - this.buffer.length))
  }

  /** Session time just after the newest sample. */
  get end(): number {
    return this.clock.timeOf(this.written)
  }

  /** Samples for [from, to), or null if any of that stretch is not held (too old, or not recorded yet). */
  slice(from: number, to: number): Float32Array | null {
    if (!this.clock.ready) return null
    const first = this.clock.indexAt(from)
    const last = this.clock.indexAt(to)
    if (last <= first || first < Math.max(0, this.written - this.buffer.length) || last > this.written) return null
    const out = new Float32Array(last - first)
    const size = this.buffer.length
    for (let i = 0; i < out.length; i++) out[i] = this.buffer[(first + i) % size]!
    return out
  }
}

/** Root-mean-square level, to tell a real take from silence. */
export function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}

export interface AudioTake {
  samples: Float32Array
  sampleRate: number
  /** Seconds of audio before the loop's first beat (the lead-in that is faded up under the previous pass). */
  lead: number
  /** Seconds from the first beat to the loop point, as recorded. */
  length: number
}

/**
 * Cut a take for looping: the loop itself plus a short lead-in before it (so
 * each pass can fade in under the end of the last) and whatever tail is on
 * hand after it (so a pass can run a little long if the tempo has eased).
 */
export function cutTake(audio: RollingAudio, startTime: number, endTime: number, fade: number): AudioTake | null {
  const length = endTime - startTime
  if (!(length > 0)) return null
  const from = Math.max(startTime - fade, audio.start)
  if (from > startTime) return null
  const to = Math.min(endTime + Math.min(length * 0.25, 1), audio.end)
  if (to < endTime) return null
  const samples = audio.slice(from, to)
  return samples ? { samples, sampleRate: audio.sampleRate, lead: startTime - from, length } : null
}

export interface PassPlan {
  /** When to start the source, and where in the take. */
  sourceStart: number
  offset: number
  /** Gain goes 0 to 1 between these times. */
  fadeInFrom: number
  fadeInTo: number
}

/**
 * Timing of one pass whose first beat should sound at `passTime`. The source
 * starts a lead-in early and fades up to full exactly on the beat; the
 * previous pass is faded down over the same stretch (see `fadeOutFor`), which
 * makes the seam an equal-gain crossfade with the downbeat's attack intact.
 * If `passTime` is too close to `earliest` for the whole lead-in, the lead-in
 * is shortened rather than the beat moved.
 */
export function planPass(take: AudioTake, passTime: number, earliest: number): PassPlan {
  const lead = Math.max(0, Math.min(take.lead, passTime - earliest))
  if (passTime < earliest) {
    // Late: start now, from the right place in the take, with a quick fade to avoid a click.
    return { sourceStart: earliest, offset: take.lead + (earliest - passTime), fadeInFrom: earliest, fadeInTo: earliest + 0.005 }
  }
  return { sourceStart: passTime - lead, offset: take.lead - lead, fadeInFrom: passTime - lead, fadeInTo: passTime }
}

/** The previous pass fades out over the stretch the next one fades in. */
export const fadeOutFor = (next: PassPlan): { from: number; to: number } => ({ from: next.fadeInFrom, to: Math.max(next.fadeInTo, next.fadeInFrom + 0.005) })
