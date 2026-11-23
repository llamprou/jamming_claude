import { detectPitch, hzToMidi } from './pitch'
import { coverage, midiToHz, type Coverage } from './sampler'

/**
 * Turning a stretch of the player's audio into a playable instrument: find
 * the single notes that were heard cleanly, cut each one out at its onset,
 * check its pitch, level it, look for a sustain loop, and keep the best take
 * of each pitch. Pure signal processing on Float32Arrays; the window supplies
 * the audio and the transcript supplies the notes.
 */

/** A note the transcript heard, in seconds from the start of the audio being cut up. */
export interface HeardNote {
  pitch: number
  start: number
  duration: number
}

/* ---------- loudness over time ---------- */

/** Hop between envelope points, seconds. */
const HOP_SECONDS = 0.002

export interface Envelope {
  /** Peak absolute level per hop. */
  values: Float32Array
  /** Samples per hop. */
  hop: number
}

/** Peak level in each 2 ms of audio: fine enough to place an onset, coarse enough to be cheap. */
export function peakEnvelope(audio: Float32Array, sampleRate: number): Envelope {
  const hop = Math.max(1, Math.round(sampleRate * HOP_SECONDS))
  const values = new Float32Array(Math.ceil(audio.length / hop))
  for (let k = 0; k < values.length; k++) {
    let peak = 0
    const end = Math.min(audio.length, (k + 1) * hop)
    for (let i = k * hop; i < end; i++) {
      const a = Math.abs(audio[i]!)
      if (a > peak) peak = a
    }
    values[k] = peak
  }
  return { values, hop }
}

const heldCache = new WeakMap<Float32Array, Map<number, Float32Array>>()

/** Running maximum over `width` hops ending at each point: hides the ripple of the waveform itself. */
function held(values: Float32Array, width: number): Float32Array {
  const cached = heldCache.get(values)?.get(width)
  if (cached) return cached
  const out = new Float32Array(values.length)
  for (let k = 0; k < values.length; k++) {
    let peak = 0
    for (let j = Math.max(0, k - width + 1); j <= k; j++) if (values[j]! > peak) peak = values[j]!
    out[k] = peak
  }
  heldCache.set(values, (heldCache.get(values) ?? new Map()).set(width, out))
  return out
}

/** The level the room sits at when nothing is played: a low percentile of the envelope. */
export function noiseFloor(envelope: Envelope): number {
  if (envelope.values.length === 0) return 0
  const sorted = Float32Array.from(envelope.values).sort()
  return sorted[Math.floor(sorted.length * 0.1)]!
}

/* ---------- onsets and endings ---------- */

export interface Onset {
  /** Sample index where the note begins. */
  sample: number
  /** Peak level of the note's attack. */
  peak: number
  /** Level just before the onset relative to the peak: 0 = out of silence, 1 = no rise at all. */
  bleed: number
}

/**
 * Find where a note starts inside [from, to) (samples). The transcript's time
 * for a note is late and loose (analysis frames, message delays), so the
 * search looks for the steepest rise in level and walks back to its foot.
 */
export function findOnset(envelope: Envelope, from: number, to: number): Onset | null {
  const { values, hop } = envelope
  const smooth = held(values, 3)
  const a = Math.max(0, Math.floor(from / hop))
  const b = Math.min(values.length - 4, Math.ceil(to / hop))
  if (b <= a) return null
  // Steepest rise over 8 ms.
  let steepest = a
  let rise = -Infinity
  for (let k = a; k < b; k++) {
    const r = smooth[k + 4]! - smooth[k]!
    if (r > rise) {
      rise = r
      steepest = k
    }
  }
  if (rise <= 0) return null
  // The attack's peak: the loudest point in the 60 ms after the rise.
  let peak = 0
  for (let k = steepest; k < Math.min(values.length, steepest + 30); k++) if (values[k]! > peak) peak = values[k]!
  // Walk back to the foot of the rise.
  let k = steepest
  while (k > a && smooth[k - 1]! < smooth[k]! && smooth[k]! > peak * 0.05) k--
  // What was sounding in the 30 ms before: the tail of an earlier note, or noise.
  let before = 0
  let count = 0
  for (let j = Math.max(0, k - 16); j < k - 1; j++) {
    before += values[j]!
    count++
  }
  const bleed = count ? Math.min(1, before / count / peak) : 0
  return { sample: Math.max(0, (k - 1) * hop), peak, bleed }
}

/**
 * Where a note that starts at `onset` stops being usable, searching no further
 * than `limit` (samples): when it has died away to the noise floor, or just
 * before another sound starts on top of it.
 */
export function findEnd(envelope: Envelope, onset: number, limit: number, peak: number, floor: number): { sample: number; cutShort: boolean } {
  const { values, hop } = envelope
  const smooth = held(values, 15) // 30 ms hold
  const start = Math.floor(onset / hop) + 30 // past the attack
  const stop = Math.min(values.length, Math.floor(limit / hop))
  const silent = Math.max(peak * 0.004, floor * 1.5)
  for (let k = start; k < stop; k++) {
    if (smooth[k]! < silent) return { sample: k * hop, cutShort: false }
    // A new attack on top of the decay (much louder than 20-50 ms ago): stop just before it.
    if (values[k]! > smooth[k - 10]! * 1.8 && values[k]! > peak * 0.1) return { sample: Math.max(onset, (k - 4) * hop), cutShort: true }
  }
  return { sample: Math.min(limit, values.length * hop), cutShort: true }
}

/**
 * Drop silence before a recording's first sound (encoder padding, a late
 * start), leaving 2 ms of lead-in, so a note played from it starts on time.
 * Returns a view of the same samples.
 */
export function trimLeadingSilence(samples: Float32Array, sampleRate: number, threshold = 0.01): Float32Array {
  const peak = peakLevel(samples)
  if (peak === 0) return samples
  let first = 0
  while (first < samples.length && Math.abs(samples[first]!) < peak * threshold) first++
  return samples.subarray(Math.max(0, first - Math.round(sampleRate * 0.002)))
}

/* ---------- levelling ---------- */

/** RMS of the loudest 50 ms: a note's loudness where it is loudest, which is what the ear compares. */
export function loudness(samples: Float32Array, sampleRate: number): number {
  const window = Math.min(samples.length, Math.max(1, Math.round(sampleRate * 0.05)))
  if (window === 0) return 0
  let sum = 0
  for (let i = 0; i < window; i++) sum += samples[i]! * samples[i]!
  let best = sum
  for (let i = window; i < samples.length; i++) {
    sum += samples[i]! * samples[i]! - samples[i - window]! * samples[i - window]!
    if (sum > best) best = sum
  }
  return Math.sqrt(best / window)
}

export function peakLevel(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]!) > peak) peak = Math.abs(samples[i]!)
  return peak
}

/**
 * Scale a take so every take is about as loud as the others: aim for a common
 * loudness, but never let the peak go over `ceiling`. Returns a new array.
 */
export function normalise(samples: Float32Array, sampleRate: number, targetLoudness = 0.25, ceiling = 0.9): Float32Array {
  const level = loudness(samples, sampleRate)
  const peak = peakLevel(samples)
  if (level === 0 || peak === 0) return Float32Array.from(samples)
  const gain = Math.min(targetLoudness / level, ceiling / peak)
  return samples.map((s) => s * gain)
}

/** Remove any constant offset, and fade the ends so the cut does not click. Returns a new array. */
export function tidyEdges(samples: Float32Array, sampleRate: number, fadeInSeconds = 0.001, fadeOutSeconds = 0.015): Float32Array {
  const out = Float32Array.from(samples)
  let mean = 0
  for (let i = 0; i < out.length; i++) mean += out[i]!
  mean /= out.length || 1
  const fadeIn = Math.min(out.length, Math.round(sampleRate * fadeInSeconds))
  const fadeOut = Math.min(out.length, Math.round(sampleRate * fadeOutSeconds))
  for (let i = 0; i < out.length; i++) {
    let gain = 1
    if (i < fadeIn) gain = i / fadeIn
    if (i >= out.length - fadeOut) gain *= (out.length - 1 - i) / fadeOut
    out[i] = (out[i]! - mean) * gain
  }
  return out
}

/* ---------- pitch of a take ---------- */

/** Halve the sample rate by averaging pairs: enough for pitch detection and four times cheaper. */
function halve(audio: Float32Array): Float32Array {
  const out = new Float32Array(audio.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = (audio[2 * i]! + audio[2 * i + 1]!) / 2
  return out
}

/**
 * The pitch of a cut-out note as a fractional MIDI number, or null if no
 * steady pitch is found. Measures a few frames after the attack and takes the
 * middle value. `expected` narrows the search (and the cost) without letting
 * an octave error through: the search still spans more than an octave each way.
 */
export function measurePitch(samples: Float32Array, sampleRate: number, expected?: number): number | null {
  let audio = samples
  let rate = sampleRate
  if (rate >= 40000 && (expected === undefined || expected < 96)) {
    audio = halve(audio)
    rate /= 2
  }
  // The detector treats quiet frames as silence, so measure at a standard level.
  const peak = peakLevel(audio)
  if (peak === 0) return null
  audio = audio.map((s) => (s * 0.8) / peak)
  const expectedHz = expected === undefined ? undefined : midiToHz(expected)
  const minHz = expectedHz ? expectedHz / 2.6 : 35
  const maxHz = expectedHz ? Math.min(rate / 4, expectedHz * 2.6) : 2000
  // Long enough for the search to see three periods of the lowest pitch it might find.
  const frame = Math.min(audio.length, Math.max(1024, Math.ceil((rate / minHz) * 3)))
  if (frame < (rate / minHz) * 2.2) return null
  const found: number[] = []
  for (const offsetSeconds of [0.03, 0.12, 0.25]) {
    const at = Math.round(offsetSeconds * rate)
    if (at + frame > audio.length) break
    const hz = detectPitch(audio.subarray(at, at + frame), rate, { minHz, maxHz })
    if (hz) found.push(hzToMidi(hz))
  }
  if (found.length === 0) {
    const hz = detectPitch(audio.subarray(0, frame), rate, { minHz, maxHz })
    if (hz) found.push(hzToMidi(hz))
  }
  if (found.length === 0) return null
  found.sort((a, b) => a - b)
  return found[Math.floor(found.length / 2)]!
}

/* ---------- sustain loops ---------- */

export interface LoopPoints {
  /** Samples. */
  start: number
  end: number
  /** 0-1: how closely the waveform at the loop end matches the loop start. */
  match: number
}

/**
 * Find a stretch of a held note that can repeat without a bump, so the note
 * can be sustained longer than it was recorded. Only for sounds that hold
 * their level (bowed, blown, sung, organ); a plucked or struck note that is
 * dying away has no loop and returns null: it is played through once.
 */
export function findLoop(samples: Float32Array, sampleRate: number, hz: number): LoopPoints | null {
  const period = sampleRate / hz
  if (samples.length < sampleRate * 0.4) return null
  const envelope = peakEnvelope(samples, sampleRate)
  const smooth = held(envelope.values, 25)
  const peak = Math.max(...smooth)
  const levelAt = (fraction: number) => smooth[Math.min(smooth.length - 1, Math.floor(smooth.length * fraction))]!
  // Still near full level most of the way through?
  if (levelAt(0.4) < peak * 0.5 || levelAt(0.8) < levelAt(0.4) * 0.6) return null

  const from = Math.max(Math.round(sampleRate * 0.12), Math.round(samples.length * 0.3))
  const target = Math.round(samples.length * 0.85)
  if (target - from < Math.max(sampleRate * 0.1, period * 8)) return null
  // Start on an upward zero crossing.
  let start = from
  while (start < target && !(samples[start]! <= 0 && samples[start + 1]! > 0)) start++
  const compare = Math.max(32, Math.min(1024, Math.round(period * 2)))
  let best: LoopPoints | null = null
  const periods = Math.floor((target - start) / period)
  for (let n = periods; n >= Math.max(8, periods - 6); n--) {
    const centre = start + Math.round(n * period)
    for (let end = centre - 2; end <= centre + 2; end++) {
      if (end + compare >= samples.length) continue
      let difference = 0
      let energy = 0
      for (let i = 0; i < compare; i++) {
        const d = samples[start + i]! - samples[end + i]!
        difference += d * d
        energy += samples[start + i]! * samples[start + i]!
      }
      const match = energy === 0 ? 0 : Math.max(0, 1 - Math.sqrt(difference / energy))
      if (!best || match > best.match) best = { start, end, match }
    }
  }
  return best && best.match >= 0.85 ? best : null
}

/* ---------- which heard notes can be used ---------- */

/**
 * Notes that sounded alone: nothing else overlaps them by more than a blink.
 * Chords and smeared runs are no use as samples, because the cut-out audio
 * would contain several pitches.
 */
export function isolatedNotes(notes: HeardNote[], overlapSeconds = 0.03): HeardNote[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start)
  return sorted.filter((note, i) => {
    const end = note.start + note.duration
    return !sorted.some((other, j) => j !== i && other.start < end - overlapSeconds && other.start + other.duration > note.start + overlapSeconds)
  })
}

/**
 * Find single notes in audio with no transcript to go by (a saved recording):
 * split at rises in level, then name each piece by its pitch. Monophonic only.
 */
export function detectNotes(audio: Float32Array, sampleRate: number): HeardNote[] {
  const envelope = peakEnvelope(audio, sampleRate)
  const { values, hop } = envelope
  const smooth = held(values, 3)
  const floor = noiseFloor(envelope)
  const top = Math.max(0, ...values)
  const onsets: number[] = []
  let lowest = Infinity
  let lowestAt = 0
  for (let k = 0; k < smooth.length; k++) {
    const level = smooth[k]!
    // Only the last 60 ms count as "before".
    if (level < lowest || k - lowestAt > 30) {
      lowest = level
      lowestAt = k
    }
    const last = onsets[onsets.length - 1]
    if (level > Math.max(lowest * 2.5, floor * 4, top * 0.08) && (last === undefined || k - last > 40)) {
      onsets.push(k)
      lowest = level
      lowestAt = k
    }
  }
  const notes: HeardNote[] = []
  onsets.forEach((k, i) => {
    const start = k * hop
    const end = Math.min(audio.length, (onsets[i + 1] ?? values.length) * hop)
    const pitch = measurePitch(audio.subarray(start, end), sampleRate)
    if (pitch !== null) notes.push({ pitch: Math.round(pitch), start: start / sampleRate, duration: (end - start) / sampleRate })
  })
  return notes
}

/* ---------- cutting out takes ---------- */

export interface Take {
  /** MIDI pitch (whole number) the take is filed under. */
  pitch: number
  /** How far the recording is from that pitch, in cents. */
  tuneCents: number
  /** Cut, tidied and levelled audio. */
  samples: Float32Array
  /** Seconds into the source audio where the take begins. */
  start: number
  /** Sustain loop in seconds into the take, if the note holds its level. */
  loop?: { start: number; end: number }
  /** Higher is better; used to choose between takes of the same pitch. */
  score: number
}

export type RejectReason = 'overlapping' | 'no clear attack' | 'too short' | 'pitch unclear' | 'pitch mismatch' | 'clipped' | 'too quiet'

export interface CaptureOptions {
  /** Shortest usable take, seconds. */
  minSeconds?: number
  /** Longest a take is kept, seconds. */
  maxSeconds?: number
  /** How far before the transcript's time the true onset may be, seconds. */
  searchBefore?: number
  searchAfter?: number
  /** Report coverage against this many semitones of shifting. */
  maxShift?: number
}

export interface CaptureResult {
  /** Best take of each pitch, ascending. */
  takes: Take[]
  /** How many notes were offered and why the unused ones were set aside. */
  heard: number
  rejected: Partial<Record<RejectReason, number>>
  /** Clean takes that lost to a better take of the same pitch. */
  duplicates: number
  coverage: Coverage | null
}

/**
 * Cut the usable single notes out of `audio`. `notes` are what the transcript
 * heard, timed from the start of `audio`; their times are trusted only
 * roughly, their pitches are checked against the audio itself.
 */
export function captureTakes(audio: Float32Array, sampleRate: number, notes: HeardNote[], options: CaptureOptions = {}): CaptureResult {
  const minSeconds = options.minSeconds ?? 0.15
  const maxSeconds = options.maxSeconds ?? 4
  const searchBefore = options.searchBefore ?? 0.15
  const searchAfter = options.searchAfter ?? 0.06
  const envelope = peakEnvelope(audio, sampleRate)
  const floor = noiseFloor(envelope)
  const sorted = [...notes].sort((a, b) => a.start - b.start)
  const usable = new Set(isolatedNotes(sorted))
  const rejected: CaptureResult['rejected'] = {}
  const reject = (reason: RejectReason) => void (rejected[reason] = (rejected[reason] ?? 0) + 1)
  const best = new Map<number, Take>()
  let clean = 0

  for (const [index, note] of sorted.entries()) {
    if (!usable.has(note)) {
      reject('overlapping')
      continue
    }
    // Do not search back into the attack of the note before.
    const earliest = Math.max(note.start - searchBefore, (sorted[index - 1]?.start ?? -Infinity) + 0.02)
    const onset = findOnset(envelope, earliest * sampleRate, (note.start + searchAfter) * sampleRate)
    if (!onset || onset.bleed > 0.3) {
      reject('no clear attack')
      continue
    }
    if (onset.peak < Math.max(0.01, floor * 4)) {
      reject('too quiet')
      continue
    }
    if (onset.peak >= 0.99) {
      reject('clipped')
      continue
    }
    // The take may ring on past the note's transcribed end, but not into the next note.
    const next = sorted.find((other) => other !== note && other.start > note.start + 0.03)
    const limit = Math.min(audio.length, onset.sample + maxSeconds * sampleRate, next ? (next.start - 0.05) * sampleRate : Infinity)
    const end = findEnd(envelope, onset.sample, limit, onset.peak, floor)
    const length = end.sample - onset.sample
    if (length < minSeconds * sampleRate) {
      reject('too short')
      continue
    }
    const raw = audio.subarray(onset.sample, end.sample)
    const measured = measurePitch(raw, sampleRate, note.pitch)
    if (measured === null) {
      reject('pitch unclear')
      continue
    }
    if (Math.abs(measured - note.pitch) > 0.7) {
      reject('pitch mismatch')
      continue
    }
    clean++
    const samples = normalise(tidyEdges(raw, sampleRate), sampleRate)
    const seconds = length / sampleRate
    const tuneCents = Math.round((measured - note.pitch) * 100)
    // Prefer long, loud, in-tune takes that came out of silence.
    const score = Math.min(seconds, 2) * (0.5 + Math.min(onset.peak, 0.5)) * (1 - onset.bleed) * (1 - Math.abs(tuneCents) / 200)
    const previous = best.get(note.pitch)
    if (previous && previous.score >= score) continue
    const loop = findLoop(samples, sampleRate, midiToHz(measured))
    best.set(note.pitch, {
      pitch: note.pitch,
      tuneCents,
      samples,
      start: onset.sample / sampleRate,
      loop: loop ? { start: loop.start / sampleRate, end: loop.end / sampleRate } : undefined,
      score,
    })
  }

  const takes = [...best.values()].sort((a, b) => a.pitch - b.pitch)
  return { takes, heard: sorted.length, rejected, duplicates: clean - takes.length, coverage: coverage(takes.map((t) => t.pitch), options.maxShift ?? 3) }
}
