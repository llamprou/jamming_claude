/**
 * The sampler's arithmetic, free of any audio API: which recorded note to use
 * for a requested pitch, how fast to play it, what the loudness envelope is,
 * and a reference renderer that turns those decisions into samples. The
 * window's sampler voice makes the same decisions with WebAudio nodes; tests
 * and offline checks use `renderNote`.
 */

export type DrumVoice = 'kick' | 'snare' | 'rim' | 'clap' | 'hatClosed' | 'hatPedal' | 'hatOpen' | 'tomLow' | 'tomMid' | 'tomHigh' | 'crash' | 'ride' | 'perc'

/** One recorded note (or drum hit) and when to use it. */
export interface Zone {
  /** Key into the instrument's audio: a file name, or a generated buffer's id. */
  sample: string
  /** MIDI pitch the recording sounds at. Unused for drums. */
  pitch: number
  /** How far the recording is from `pitch`, in cents (positive = sharp). Playback corrects for it. */
  tuneCents?: number
  /** Velocity layer, 0-1, inclusive. Absent = any velocity. */
  loVel?: number
  hiVel?: number
  /** Sustain loop, in seconds into the sample. Absent = play through once. */
  loop?: { start: number; end: number }
  /** Drums: which piece of the kit this hit is. */
  drum?: DrumVoice
  /** Linear gain for this zone alone (balancing takes). */
  gain?: number
}

export interface InstrumentDef {
  /** Short unique id the agent uses, e.g. "piano", "my-guitar". */
  name: string
  /** What it is, in a few words. */
  label: string
  kind: 'pitched' | 'drums'
  /** 'sampled' = real recordings shipped with the app; 'synthesized' = generated stand-in; 'captured' = built from the player's own sound. */
  origin: 'sampled' | 'synthesized' | 'captured'
  zones: Zone[]
  /** Seconds. */
  attack?: number
  release?: number
  /** Overall linear gain. */
  gain?: number
  /** Where the sound came from and its licence, for stock instruments. */
  credit?: string
}

/* ---------- zone selection ---------- */

const GM_DRUMS: Record<number, DrumVoice> = {
  35: 'kick', 36: 'kick',
  37: 'rim', 38: 'snare', 39: 'clap', 40: 'snare',
  41: 'tomLow', 43: 'tomLow', 45: 'tomMid', 47: 'tomMid', 48: 'tomHigh', 50: 'tomHigh',
  42: 'hatClosed', 44: 'hatPedal', 46: 'hatOpen',
  49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash',
  51: 'ride', 53: 'ride', 59: 'ride',
}

/** Which piece of the kit a General MIDI drum note means. */
export function gmDrumVoice(note: number): DrumVoice {
  const known = GM_DRUMS[note]
  if (known) return known
  if (note < 35) return 'kick'
  return 'perc'
}

/** If the kit lacks a piece, the nearest thing it might have, in order of preference. */
const DRUM_FALLBACK: Record<DrumVoice, DrumVoice[]> = {
  kick: ['tomLow'],
  snare: ['rim', 'clap'],
  rim: ['snare', 'hatClosed'],
  clap: ['snare', 'rim'],
  hatClosed: ['hatPedal', 'hatOpen', 'perc'],
  hatPedal: ['hatClosed', 'hatOpen'],
  hatOpen: ['hatClosed', 'ride', 'crash'],
  tomLow: ['tomMid', 'tomHigh', 'kick'],
  tomMid: ['tomLow', 'tomHigh'],
  tomHigh: ['tomMid', 'tomLow'],
  crash: ['ride', 'hatOpen'],
  ride: ['crash', 'hatOpen'],
  perc: ['rim', 'hatClosed', 'tomHigh'],
}

function inLayer(zone: Zone, velocity: number): boolean {
  return velocity >= (zone.loVel ?? 0) && velocity <= (zone.hiVel ?? 1)
}

/** Prefer zones whose velocity layer contains the note; if none does, use the layer closest to it. */
function velocityCandidates(zones: Zone[], velocity: number): Zone[] {
  const fitting = zones.filter((z) => inLayer(z, velocity))
  if (fitting.length) return fitting
  const distance = (z: Zone) => Math.min(Math.abs(velocity - (z.loVel ?? 0)), Math.abs(velocity - (z.hiVel ?? 1)))
  const best = Math.min(...zones.map(distance))
  return zones.filter((z) => distance(z) === best)
}

/**
 * The zone to play for a note: for pitched instruments the recording nearest
 * in pitch (ties go to the lower recording, shifted up); for drums the hit for
 * that General MIDI note. Null only if the instrument has no zones.
 */
export function pickZone(def: InstrumentDef, pitch: number, velocity = 0.8): Zone | null {
  if (def.zones.length === 0) return null
  if (def.kind === 'drums') {
    const wanted = gmDrumVoice(pitch)
    for (const voice of [wanted, ...DRUM_FALLBACK[wanted]]) {
      const hits = def.zones.filter((z) => z.drum === voice)
      if (hits.length) return velocityCandidates(hits, velocity)[0]!
    }
    return null
  }
  let best: Zone | null = null
  for (const zone of velocityCandidates(def.zones, velocity)) {
    if (!best) best = zone
    else {
      const d = Math.abs(zone.pitch - pitch)
      const bestD = Math.abs(best.pitch - pitch)
      if (d < bestD || (d === bestD && zone.pitch < best.pitch)) best = zone
    }
  }
  return best
}

/* ---------- pitch ---------- */

export const midiToHz = (pitch: number): number => 440 * 2 ** ((pitch - 69) / 12)

/** How fast to play a zone's recording so it sounds at `pitch`. 1 = as recorded. */
export function playbackRate(zone: Zone, pitch: number): number {
  return 2 ** ((pitch - zone.pitch - (zone.tuneCents ?? 0) / 100) / 12)
}

/* ---------- envelope ---------- */

export interface NoteEnvelope {
  /** Gain at the top of the attack. */
  peak: number
  /** Seconds from note start to full level. */
  attack: number
  /** Seconds from note start at which the release begins. */
  releaseAt: number
  /** Time constant of the exponential release, seconds. */
  releaseTau: number
  /** Seconds from note start at which the source can be stopped. */
  stopAt: number
  /** One-shots ignore the note's length and play the whole recording. */
  oneShot: boolean
}

/** Louder notes are louder, on a curve gentler than linear power so soft notes stay audible. */
export const velocityGain = (velocity: number): number => Math.max(0, Math.min(1, velocity)) ** 1.5

/**
 * The loudness shape of one note. `sampleSeconds` is the length of the zone's
 * recording and `rate` its playback rate, so an unlooped note never outlasts
 * its recording.
 */
export function noteEnvelope(def: InstrumentDef, zone: Zone, velocity: number, duration: number, sampleSeconds: number, rate: number): NoteEnvelope {
  const peak = velocityGain(velocity) * (def.gain ?? 1) * (zone.gain ?? 1)
  const length = sampleSeconds / rate
  if (def.kind === 'drums') return { peak, attack: 0, releaseAt: length, releaseTau: 0.01, stopAt: length, oneShot: true }
  const attack = def.attack ?? 0.004
  const release = def.release ?? 0.25
  const releaseAt = Math.max(duration, attack)
  const end = releaseAt + release
  return { peak, attack, releaseAt, releaseTau: release / 5, stopAt: zone.loop ? end : Math.min(end, length), oneShot: false }
}

/** Envelope gain at `t` seconds into the note. */
export function envelopeAt(env: NoteEnvelope, t: number): number {
  if (t < 0 || t >= env.stopAt) return 0
  if (env.oneShot) return env.peak
  if (t < env.attack) return (env.peak * t) / env.attack
  if (t < env.releaseAt) return env.peak
  return env.peak * Math.exp(-(t - env.releaseAt) / env.releaseTau)
}

/* ---------- reference renderer ---------- */

/**
 * Render one note from a zone's recording: resample to the requested pitch,
 * loop if the zone loops, apply the envelope. Linear interpolation; the
 * window's voice lets WebAudio do the same job.
 */
export function renderNote(
  samples: Float32Array,
  sampleRate: number,
  def: InstrumentDef,
  zone: Zone,
  note: { pitch: number; velocity: number; duration: number },
  outRate = sampleRate,
): Float32Array {
  const rate = def.kind === 'drums' ? 1 : playbackRate(zone, note.pitch)
  const env = noteEnvelope(def, zone, note.velocity, note.duration, samples.length / sampleRate, rate)
  const out = new Float32Array(Math.max(0, Math.ceil(env.stopAt * outRate)))
  const step = (rate * sampleRate) / outRate
  const loopStart = zone.loop ? zone.loop.start * sampleRate : 0
  const loopEnd = zone.loop ? Math.min(zone.loop.end * sampleRate, samples.length - 1) : 0
  let position = 0
  for (let i = 0; i < out.length; i++) {
    if (zone.loop && position >= loopEnd) position = loopStart + ((position - loopEnd) % (loopEnd - loopStart))
    const index = Math.floor(position)
    if (index >= samples.length - 1) break
    const fraction = position - index
    out[i] = (samples[index]! + (samples[index + 1]! - samples[index]!) * fraction) * envelopeAt(env, i / outRate)
    position += step
  }
  return out
}

/* ---------- coverage ---------- */

export interface Coverage {
  /** Recorded pitches, ascending. */
  pitches: number[]
  low: number
  high: number
  /** Stretches between neighbouring recordings where some note needs more than `maxShift` semitones of shifting. */
  gaps: Array<{ from: number; to: number; semitones: number }>
  /** The furthest any note between the lowest and highest recording must be shifted. */
  largestShift: number
  /** Lowest and highest note playable within `maxShift` of a recording. */
  comfortableLow: number
  comfortableHigh: number
  maxShift: number
}

/** How well a set of recorded pitches covers the keyboard when neighbours are pitch-shifted to fill in. */
export function coverage(recorded: number[], maxShift = 3): Coverage | null {
  const pitches = [...new Set(recorded)].sort((a, b) => a - b)
  if (pitches.length === 0) return null
  const gaps: Coverage['gaps'] = []
  let largestShift = 0
  for (let i = 1; i < pitches.length; i++) {
    const semitones = pitches[i]! - pitches[i - 1]!
    largestShift = Math.max(largestShift, Math.floor(semitones / 2))
    if (semitones > 2 * maxShift + 1) gaps.push({ from: pitches[i - 1]!, to: pitches[i]!, semitones })
  }
  const low = pitches[0]!
  const high = pitches[pitches.length - 1]!
  return { pitches, low, high, gaps, largestShift, comfortableLow: low - maxShift, comfortableHigh: high + maxShift, maxShift }
}

/* ---------- which instrument plays a track ---------- */

export type TrackRole = 'chords' | 'melody' | 'bass' | 'drums' | 'solo'
export const TRACK_ROLES: TrackRole[] = ['chords', 'melody', 'bass', 'drums', 'solo']

/** What each part plays on until the player asks for something else. */
export const DEFAULT_INSTRUMENTS: Record<TrackRole, string> = { chords: 'piano', melody: 'piano', bass: 'bass', drums: 'drums', solo: 'guitar' }

/**
 * The instrument name for a track: an explicit choice for its role wins; then
 * a General MIDI program that plainly names a guitar or bass; then the role's
 * default. Program 0 is every track's default, so it carries no information.
 */
export function instrumentForTrack(track: { role: TrackRole; program: number }, chosen: Partial<Record<TrackRole, string>>): string {
  const explicit = chosen[track.role]
  if (explicit) return explicit
  if (track.role === 'drums') return DEFAULT_INSTRUMENTS.drums
  if (track.program >= 1 && track.program <= 7) return 'piano'
  if (track.program >= 24 && track.program <= 31) return 'guitar'
  if (track.program >= 32 && track.program <= 39) return 'bass'
  return DEFAULT_INSTRUMENTS[track.role]
}
