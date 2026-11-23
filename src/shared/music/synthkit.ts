import type { DrumVoice, InstrumentDef, Zone } from './sampler'
import { midiToHz } from './sampler'

/**
 * Stand-in instruments generated in code, used only when the real sample set
 * has not been fetched (see scripts/fetch-samples.mjs). They are synthesized
 * models, not recordings, and are labelled that way everywhere: a plucked
 * string (Karplus-Strong) for guitar and bass, a two-operator FM electric
 * piano, and a small synthesized drum kit. Everything is deterministic.
 */

/** Small seeded noise source so a given note always renders the same. */
function noise(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
}

function toPeak(samples: Float32Array, peak = 0.9): Float32Array {
  let max = 0
  for (let i = 0; i < samples.length; i++) max = Math.max(max, Math.abs(samples[i]!))
  if (max > 0) for (let i = 0; i < samples.length; i++) samples[i] = (samples[i]! * peak) / max
  return samples
}

function fadeOut(samples: Float32Array, sampleRate: number, seconds = 0.03): Float32Array {
  const n = Math.min(samples.length, Math.round(seconds * sampleRate))
  for (let i = 0; i < n; i++) samples[samples.length - 1 - i]! *= i / n
  return samples
}

export interface PluckOptions {
  /** Seconds for the note to fall by 60 dB. */
  decaySeconds: number
  /** 0-1: how much of the high end survives each trip round the string. Lower is duller and dies faster up top. */
  brightness: number
  /** 0-1: where along the string it is plucked; shapes which harmonics are missing. */
  pickPosition: number
  /** 0-1: softness of the pluck (low-pass on the excitation). */
  softness: number
}

/**
 * A plucked string by the Karplus-Strong method: a burst of noise circulating
 * in a delay line one period long, losing a little treble each time round. An
 * all-pass stage makes up the fraction of a sample the delay line cannot, so
 * the note is in tune.
 */
export function pluck(hz: number, seconds: number, sampleRate: number, options: PluckOptions): Float32Array {
  const blend = 0.5 * (1 - options.brightness) // 0 = no damping, 0.5 = the classic two-point average
  const period = sampleRate / hz
  // Loop delay = delay line + damping filter (about `blend` samples) + all-pass (`fraction` samples).
  const length = Math.max(2, Math.floor(period - blend - 0.1))
  const fraction = period - blend - length
  const allpass = (1 - fraction) / (1 + fraction)
  const feedback = Math.exp(-6.91 / (hz * options.decaySeconds))

  const random = noise(Math.round(hz * 1000))
  const line = new Float32Array(length)
  let low = 0
  for (let i = 0; i < length; i++) {
    low += (1 - options.softness) * (random() - low)
    line[i] = low
  }
  // Plucking at a point cancels the harmonics that have a node there.
  const pick = Math.max(1, Math.round(length * options.pickPosition))
  const excitation = Float32Array.from(line)
  for (let i = 0; i < length; i++) line[i] = excitation[i]! - excitation[(i + pick) % length]!
  let mean = 0
  for (let i = 0; i < length; i++) mean += line[i]!
  mean /= length
  for (let i = 0; i < length; i++) line[i]! -= mean

  const out = new Float32Array(Math.round(seconds * sampleRate))
  let previous = 0
  let allpassIn = 0
  let allpassOut = 0
  for (let i = 0; i < out.length; i++) {
    const at = i % length
    const current = line[at]!
    out[i] = current
    const damped = (1 - blend) * current + blend * previous
    previous = current
    allpassOut = allpass * damped + allpassIn - allpass * allpassOut
    allpassIn = damped
    line[at] = allpassOut * feedback
  }
  return fadeOut(toPeak(out), sampleRate)
}

/**
 * An electric-piano-like tone by FM: a sine whose phase is pushed around by
 * another sine at the same pitch (the body) and briefly by one far above it
 * (the bell of the attack). Brighter when struck, mellowing as it rings.
 */
export function electricPiano(hz: number, seconds: number, sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate))
  const ring = Math.max(0.8, 3.2 - Math.log2(hz / 110) * 0.45) // higher notes ring shorter
  const twoPi = 2 * Math.PI
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate
    const attack = Math.min(1, t / 0.003)
    const body = Math.sin(twoPi * hz * t + 1.4 * Math.exp(-t / (ring * 0.35)) * Math.sin(twoPi * hz * t))
    const bell = Math.sin(twoPi * hz * t + 0.9 * Math.exp(-t / 0.08) * Math.sin(twoPi * hz * 14 * t)) * Math.exp(-t / 0.25)
    out[i] = attack * Math.exp(-t / (ring * 0.4)) * (body + 0.35 * bell)
  }
  return fadeOut(toPeak(out), sampleRate)
}

/** One synthesized drum hit. */
export function drumHit(voice: DrumVoice, sampleRate: number): Float32Array {
  const random = noise(voice.length * 7919 + voice.charCodeAt(0))
  const twoPi = 2 * Math.PI
  const make = (seconds: number, at: (t: number, i: number) => number) => {
    const out = new Float32Array(Math.round(seconds * sampleRate))
    for (let i = 0; i < out.length; i++) out[i] = at(i / sampleRate, i)
    return fadeOut(toPeak(out), sampleRate, 0.01)
  }
  // Noise with the low end removed: each sample minus a running average of those before it.
  let average = 0
  const hiss = (sharpness: number) => {
    const n = random()
    average += sharpness * (n - average)
    return n - average
  }
  // A drum skin: a sine that drops in pitch as it rings.
  const skin = (t: number, from: number, to: number, drop: number) => Math.sin(twoPi * (to * t + ((from - to) * drop) * (1 - Math.exp(-t / drop))))
  // Cymbals: several unrelated square-ish partials, as in classic drum machines.
  const metal = (t: number) => [263, 400, 421, 474, 587, 845].reduce((sum, f) => sum + Math.sign(Math.sin(twoPi * f * 6.1 * t)), 0) / 6

  switch (voice) {
    case 'kick':
      return make(0.45, (t) => skin(t, 160, 48, 0.035) * Math.exp(-t / 0.13) + 0.25 * hiss(0.5) * Math.exp(-t / 0.004))
    case 'snare':
      return make(0.3, (t) => 0.5 * (skin(t, 260, 185, 0.02) + 0.6 * Math.sin(twoPi * 331 * t)) * Math.exp(-t / 0.06) + 0.8 * hiss(0.25) * Math.exp(-t / 0.075))
    case 'rim':
      return make(0.08, (t) => (Math.sin(twoPi * 1720 * t) + 0.6 * Math.sin(twoPi * 520 * t) + 0.4 * hiss(0.3)) * Math.exp(-t / 0.012))
    case 'clap':
      return make(0.3, (t) => hiss(0.12) * (Math.exp(-(t % 0.011) / 0.004) * (t < 0.033 ? 1 : 0) + Math.exp(-Math.max(0, t - 0.033) / 0.07) * (t >= 0.033 ? 1 : 0)))
    case 'hatClosed':
      return make(0.07, (t) => (0.6 * hiss(0.08) + 0.4 * metal(t)) * Math.exp(-t / 0.014))
    case 'hatPedal':
      return make(0.05, (t) => (0.6 * hiss(0.1) + 0.4 * metal(t)) * Math.exp(-t / 0.008))
    case 'hatOpen':
      return make(0.5, (t) => (0.6 * hiss(0.08) + 0.4 * metal(t)) * Math.exp(-t / 0.13))
    case 'tomLow':
      return make(0.5, (t) => skin(t, 150, 85, 0.05) * Math.exp(-t / 0.16) + 0.1 * hiss(0.4) * Math.exp(-t / 0.01))
    case 'tomMid':
      return make(0.45, (t) => skin(t, 200, 125, 0.05) * Math.exp(-t / 0.14) + 0.1 * hiss(0.4) * Math.exp(-t / 0.01))
    case 'tomHigh':
      return make(0.4, (t) => skin(t, 270, 175, 0.05) * Math.exp(-t / 0.12) + 0.1 * hiss(0.4) * Math.exp(-t / 0.01))
    case 'crash':
      return make(1.6, (t) => (0.7 * hiss(0.15) + 0.3 * metal(t)) * Math.exp(-t / 0.4))
    case 'ride':
      return make(1.2, (t) => (0.35 * hiss(0.06) + 0.45 * metal(t * 1.31) + 0.2 * Math.sin(twoPi * 3100 * t)) * (0.5 * Math.exp(-t / 0.03) + 0.5 * Math.exp(-t / 0.4)))
    case 'perc':
      return make(0.12, (t) => (Math.sin(twoPi * 880 * t) + 0.5 * Math.sin(twoPi * 1330 * t)) * Math.exp(-t / 0.03))
  }
}

export type StandIn = 'piano' | 'guitar' | 'bass' | 'drums'

export interface GeneratedInstrument {
  def: InstrumentDef
  sampleRate: number
  /** Audio for each zone, keyed by `zone.sample`. */
  samples: Map<string, Float32Array>
}

const DRUM_VOICES: DrumVoice[] = ['kick', 'snare', 'rim', 'clap', 'hatClosed', 'hatPedal', 'hatOpen', 'tomLow', 'tomMid', 'tomHigh', 'crash', 'ride', 'perc']

/** Build one stand-in instrument as a multi-sample set: a note every three semitones across its range. */
export function generateStandIn(which: StandIn, sampleRate = 32000): GeneratedInstrument {
  const samples = new Map<string, Float32Array>()
  const zones: Zone[] = []
  const every3 = (low: number, high: number, render: (pitch: number) => Float32Array) => {
    for (let pitch = low; pitch <= high; pitch += 3) {
      const id = `${which}-${pitch}`
      samples.set(id, render(pitch))
      zones.push({ sample: id, pitch })
    }
  }
  const credit = 'Generated in code by this app; not a recording.'
  if (which === 'drums') {
    for (const voice of DRUM_VOICES) {
      samples.set(voice, drumHit(voice, sampleRate))
      zones.push({ sample: voice, pitch: 0, drum: voice })
    }
    return { sampleRate, samples, def: { name: 'drums', label: 'Synthesized drum kit (stand-in, not sampled)', kind: 'drums', origin: 'synthesized', zones, gain: 0.5, credit } }
  }
  if (which === 'guitar') {
    every3(40, 79, (pitch) => pluck(midiToHz(pitch), 3, sampleRate, { decaySeconds: 3.5, brightness: 0.55, pickPosition: 0.18, softness: 0.35 }))
    return { sampleRate, samples, def: { name: 'guitar', label: 'Synthesized plucked string (stand-in for guitar, not sampled)', kind: 'pitched', origin: 'synthesized', zones, release: 0.2, gain: 0.35, credit } }
  }
  if (which === 'bass') {
    every3(28, 58, (pitch) => pluck(midiToHz(pitch), 3, sampleRate, { decaySeconds: 5, brightness: 0.25, pickPosition: 0.3, softness: 0.8 }))
    return { sampleRate, samples, def: { name: 'bass', label: 'Synthesized plucked string (stand-in for bass, not sampled)', kind: 'pitched', origin: 'synthesized', zones, release: 0.12, gain: 0.5, credit } }
  }
  every3(33, 96, (pitch) => electricPiano(midiToHz(pitch), 3, sampleRate))
  return { sampleRate, samples, def: { name: 'piano', label: 'Synthesized electric piano (stand-in for piano, not sampled)', kind: 'pitched', origin: 'synthesized', zones, release: 0.3, gain: 0.35, credit } }
}
