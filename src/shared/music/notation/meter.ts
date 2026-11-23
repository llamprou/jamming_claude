import type { NoteEvent } from '../types'
import { frac, type Fraction } from './rational'

/**
 * Meter analysis over a window of notes: tempo, beat phase, downbeat, time
 * signature and swing. It works offline on what was played; it does not track
 * the beat in real time. A real-time tracker can hand its beats to
 * `meterFromBeats` and get the same `MeterEstimate` the notation code consumes.
 */

export type TimeSignatureName = '4/4' | '3/4' | '6/8' | '12/8'

export interface MeterEstimate {
  timeSignature: TimeSignatureName
  numerator: number
  denominator: number
  /** True for 6/8 and 12/8, where the felt beat is a dotted quarter. */
  compound: boolean
  /** Felt beats in a bar: 4, 3, 2 (6/8) or 4 (12/8). */
  beatsPerBar: number
  /** Length of the felt beat in whole notes: 1/4, or 3/8 in compound time. */
  beatUnit: Fraction
  /** Felt beats per minute. */
  bpm: number
  beatSeconds: number
  /**
   * Session-clock times of the felt beats, following the playing if it drifts.
   * beats[0] is a downbeat at or just before the first note; every
   * `beatsPerBar`-th beat after it is a downbeat. Extends past the last note.
   */
  beats: number[]
  /** beats[0]. */
  downbeat: number
  /** Offbeat eighths are played late (long-short). Written as plain eighths with a swing marking. */
  swing: boolean
  /** Where the offbeat falls within the beat: 0.5 straight, about 0.67 for triplet swing. */
  swingRatio: number
  /** 0-1. */
  confidence: number
  source: 'estimated' | 'given'
}

export interface MeterOptions {
  /** Force the time signature; tempo and downbeat are still estimated. */
  timeSignature?: TimeSignatureName
  /** The notes are already on a known grid: length of a quarter note in seconds... */
  quarterSeconds?: number
  /** ...and the time of a bar line. */
  origin?: number
  /** Force the swing flag. */
  swing?: boolean
}

interface Signature {
  name: TimeSignatureName
  numerator: number
  denominator: number
  compound: boolean
  beatsPerBar: number
}

const SIGNATURES: Record<TimeSignatureName, Signature> = {
  '4/4': { name: '4/4', numerator: 4, denominator: 4, compound: false, beatsPerBar: 4 },
  '3/4': { name: '3/4', numerator: 3, denominator: 4, compound: false, beatsPerBar: 3 },
  '6/8': { name: '6/8', numerator: 6, denominator: 8, compound: true, beatsPerBar: 2 },
  '12/8': { name: '12/8', numerator: 12, denominator: 8, compound: true, beatsPerBar: 4 },
}

export const isTimeSignature = (text: string): text is TimeSignatureName => text in SIGNATURES

/** Length of one bar in whole notes. */
export const barLength = (meter: Pick<MeterEstimate, 'numerator' | 'denominator'>): Fraction => frac(meter.numerator, meter.denominator)

function build(sig: Signature, beats: number[], swing: boolean, swingRatio: number, confidence: number, source: MeterEstimate['source']): MeterEstimate {
  const intervals = beats.slice(1).map((t, i) => t - beats[i]!).sort((a, b) => a - b)
  const beatSeconds = intervals.length ? intervals[Math.floor(intervals.length / 2)]! : 0.5
  return {
    timeSignature: sig.name,
    numerator: sig.numerator,
    denominator: sig.denominator,
    compound: sig.compound,
    beatsPerBar: sig.beatsPerBar,
    beatUnit: sig.compound ? frac(3, 8) : frac(1, 4),
    bpm: Math.round((60 / beatSeconds) * 10) / 10,
    beatSeconds,
    beats,
    downbeat: beats[0]!,
    swing,
    swingRatio,
    confidence,
    source,
  }
}

/** A steady meter: `bpm` felt beats per minute from a downbeat at `downbeat` until `until`. */
export function fixedMeter(timeSignature: TimeSignatureName, bpm: number, downbeat: number, until: number, swing = false): MeterEstimate {
  const sig = SIGNATURES[timeSignature]
  const period = 60 / bpm
  const count = Math.max(sig.beatsPerBar, Math.ceil((until - downbeat) / period - 1e-6)) + 2
  const beats = Array.from({ length: count }, (_, i) => downbeat + i * period)
  return build(sig, beats, swing, swing ? 2 / 3 : 0.5, 1, 'given')
}

/**
 * Wrap beats that came from elsewhere (a real-time beat tracker, a click) as a
 * meter. `downbeatIndex` says which of them starts a bar.
 */
export function meterFromBeats(beats: number[], downbeatIndex: number, timeSignature: TimeSignatureName = '4/4', swing = false): MeterEstimate | null {
  if (beats.length < 2) return null
  const sig = SIGNATURES[timeSignature]
  const first = ((downbeatIndex % sig.beatsPerBar) + sig.beatsPerBar) % sig.beatsPerBar
  const head = beats[1]! - beats[0]!
  // Pad backwards so the list starts on a downbeat.
  const lead = first === 0 ? 0 : sig.beatsPerBar - first
  const padded = [...Array.from({ length: lead }, (_, i) => beats[0]! - (lead - i) * head), ...beats]
  return build(sig, padded, swing, swing ? 2 / 3 : 0.5, 1, 'given')
}

/** Position of a time in felt beats from the first downbeat (fractional; follows tempo drift). */
export function beatPosition(meter: Pick<MeterEstimate, 'beats'>, time: number): number {
  const b = meter.beats
  const last = b.length - 1
  if (time <= b[0]!) return (time - b[0]!) / (b[1]! - b[0]!)
  if (time >= b[last]!) return last + (time - b[last]!) / (b[last]! - b[last - 1]!)
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (b[mid]! <= time) lo = mid
    else hi = mid
  }
  return lo + (time - b[lo]!) / (b[hi]! - b[lo]!)
}

/* ---------- estimation ---------- */

interface Cluster {
  time: number
  salience: number
}

/** Notes that start together are one onset. Salience says how accented it sounds. */
function clusterOnsets(notes: NoteEvent[]): Cluster[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start)
  const groups: NoteEvent[][] = []
  for (const n of sorted) {
    const group = groups[groups.length - 1]
    if (group && n.start - group[0]!.start < 0.035) group.push(n)
    else groups.push([n])
  }
  // The bass line: onsets whose lowest note sits well below what the others have.
  const lows = groups.map((group) => Math.min(...group.map((n) => n.pitch)))
  const ranked = [...lows].sort((a, b) => a - b)
  const lowLine = ranked[Math.floor(ranked.length * 0.25)] ?? 0
  const middle = ranked[Math.floor(ranked.length / 2)] ?? 0
  return groups.map((group, i) => {
    const time = group.reduce((s, n) => s + n.start, 0) / group.length
    const loud = Math.sqrt(group.reduce((s, n) => s + 0.3 + n.velocity, 0))
    // A long gap after a note makes it sound accented, as does a low bass note.
    const next = groups[i + 1]?.[0]!.start
    const held = Math.max(...group.map((n) => n.duration))
    const length = Math.min(1.5, next === undefined ? held : Math.max(next - time, 0.05))
    const bass = lows[i]! <= lowLine && middle - lows[i]! >= 7 ? 1.8 : 1
    return { time, salience: loud * (0.5 + length) * bass }
  })
}

/** How strongly inter-onset intervals agree with a pulse of period `tau`: 1 when they are all multiples of it. */
function pulseStrength(pairs: Array<[number, number]>, total: number, tau: number): number {
  let sum = 0
  const k = (2 * Math.PI) / tau
  for (const [delta, weight] of pairs) sum += weight * Math.cos(k * delta)
  return total > 0 ? sum / total : 0
}

function findPulse(clusters: Cluster[]): { tau: number; strength: number } {
  const pairs: Array<[number, number]> = []
  let total = 0
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length && j - i <= 40; j++) {
      const delta = clusters[j]!.time - clusters[i]!.time
      if (delta > 4) break
      const weight = clusters[i]!.salience * clusters[j]!.salience
      pairs.push([delta, weight])
      total += weight
    }
  }
  const taus: number[] = []
  for (let tau = 0.1; tau <= 0.8; tau *= 1.004) taus.push(tau)
  const strengths = taus.map((tau) => pulseStrength(pairs, total, tau))
  const peak = Math.max(...strengths)
  // The slowest pulse that explains the onsets nearly as well as the best one:
  // finer grids always fit, so the coarsest good one is the real pulse.
  let chosen = strengths.indexOf(peak)
  for (let i = taus.length - 2; i > 0; i--) {
    if (strengths[i]! >= strengths[i - 1]! && strengths[i]! >= strengths[i + 1]! && strengths[i]! >= 0.72 * peak) {
      chosen = i
      break
    }
  }
  let tau = taus[chosen]!
  let strength = strengths[chosen]!
  for (let f = 0.994; f <= 1.006; f += 0.0005) {
    const s = pulseStrength(pairs, total, taus[chosen]! * f)
    if (s > strength) {
      strength = s
      tau = taus[chosen]! * f
    }
  }
  return { tau, strength }
}

interface PulseGrid {
  /** Fractional pulse index of a time. */
  position(time: number): number
  /** Time of a pulse index. */
  time(index: number): number
}

/** Follow the pulse through the onsets so the grid bends with small tempo changes. */
function trackPulse(clusters: Cluster[], tau: number): PulseGrid {
  // Start phase from the first few seconds.
  const head = clusters.filter((c) => c.time <= clusters[0]!.time + Math.max(4, tau * 8))
  let re = 0
  let im = 0
  for (const c of head) {
    const angle = (2 * Math.PI * (c.time - clusters[0]!.time)) / tau
    re += c.salience * Math.cos(angle)
    im += c.salience * Math.sin(angle)
  }
  let anchor = clusters[0]!.time + (Math.atan2(im, re) / (2 * Math.PI)) * tau
  let index = 0
  let period = tau
  const ks = [0]
  const ts = [anchor]
  for (const c of clusters) {
    const steps = Math.round((c.time - anchor) / period)
    const error = c.time - (anchor + steps * period)
    if (Math.abs(error) > 0.22 * period || steps < 0) continue
    // Gentle gains: timing jitter must not shake the grid, but a real change of tempo is followed.
    if (steps > 0) period = Math.min(tau * 1.12, Math.max(tau * 0.88, period + (0.04 * error) / steps))
    anchor = anchor + steps * period + 0.25 * error
    index += steps
    if (steps > 0) {
      ks.push(index)
      ts.push(anchor)
    } else {
      ts[ts.length - 1] = anchor
    }
  }
  const lastPeriod = period
  return {
    position(time) {
      const last = ks.length - 1
      if (time <= ts[0]!) return ks[0]! + (time - ts[0]!) / tau
      if (time >= ts[last]!) return ks[last]! + (time - ts[last]!) / lastPeriod
      let lo = 0
      let hi = last
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (ts[mid]! <= time) lo = mid
        else hi = mid
      }
      return ks[lo]! + ((time - ts[lo]!) / (ts[hi]! - ts[lo]!)) * (ks[hi]! - ks[lo]!)
    },
    time(k) {
      const last = ks.length - 1
      if (k <= ks[0]!) return ts[0]! + (k - ks[0]!) * tau
      if (k >= ks[last]!) return ts[last]! + (k - ks[last]!) * lastPeriod
      let lo = 0
      let hi = last
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (ks[mid]! <= k) lo = mid
        else hi = mid
      }
      return ts[lo]! + ((k - ks[lo]!) / (ks[hi]! - ks[lo]!)) * (ts[hi]! - ts[lo]!)
    },
  }
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 2) return 0
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]!
    mb += b[i]!
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb)
    da += (a[i]! - ma) ** 2
    db += (b[i]! - mb) ** 2
  }
  return da < 1e-12 || db < 1e-12 ? 0 : num / Math.sqrt(da * db)
}

interface Hypothesis {
  sig: Signature
  /** Pulses in one felt beat. */
  perBeat: number
  /** The beat divides in three but is written in 4/4 with a swing marking. */
  swing: boolean
}

const BAR_WEIGHTS: Record<number, number[]> = { 2: [2, 1], 3: [2, 1, 1], 4: [3, 1, 2, 1] }

/**
 * How well accents fit a hypothesis whose bar starts at pulse `phase`. Two
 * questions are kept apart so that one cannot stand in for the other: do beats
 * outweigh the pulses between them, and do the beats themselves follow the
 * strong-weak pattern of the bar.
 */
function fitMeter(accents: number[], h: Hypothesis, phase: number): number {
  const d = h.perBeat
  const n = h.sig.beatsPerBar
  const bar = d * n
  const place = (k: number): number => (((k - phase) % bar) + bar) % bar
  // When the pulse is the beat there is nothing between beats to compare with;
  // that reading gets a modest fixed credit, which a real beat-offbeat contrast beats.
  let beatFit = 0.25
  if (d > 1) {
    const shape = accents.map((_, k) => {
      const q = place(k) % d
      // Half beats (the eighths under a sixteenth pulse) carry a little weight too.
      return q === 0 ? 1 : (d === 4 && q === 2) || (d === 6 && q % 2 === 0) ? 0.4 : 0
    })
    beatFit = pearson(accents, shape)
  }
  const beats: number[] = []
  const weights: number[] = []
  accents.forEach((a, k) => {
    if (place(k) % d !== 0) return
    beats.push(a)
    weights.push(BAR_WEIGHTS[n]![place(k) / d]!)
  })
  // A few beats say little about the bar; trust them in proportion.
  const trust = Math.min(1, beats.length / 12)
  const barFit = pearson(beats, weights)
  // Bars resemble each other: the beat accents repeat at the bar's length.
  const repeat = beats.length >= 2 * n ? pearson(beats.slice(0, beats.length - n), beats.slice(n)) : 0
  // Getting the beat right matters more than the shape of the bar.
  return beatFit + trust * (0.5 * barFit + 0.3 * repeat)
}

// People feel a beat near 120 a minute most readily, and hardly ever one below 45 or above 210.
const tempoPrior = (bpm: number): number => Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.65) ** 2) - (bpm < 45 || bpm > 210 ? 1 : 0)
const SIGNATURE_PRIOR: Record<TimeSignatureName, number> = { '4/4': 0.08, '3/4': 0, '6/8': 0, '12/8': -0.1 }
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

/**
 * Estimate the meter of a stretch of playing. Returns null when there are too
 * few onsets to tell (fewer than four).
 */
export function analyseMeter(notes: NoteEvent[], opts: MeterOptions = {}): MeterEstimate | null {
  const clusters = clusterOnsets(notes)
  if (clusters.length < 4) return null
  const known = opts.quarterSeconds !== undefined
  const first = clusters[0]!.time
  const lastEnd = Math.max(...notes.map((n) => n.start + n.duration))

  let tau: number
  let strength = 1
  let grid: PulseGrid
  if (known) {
    tau = opts.quarterSeconds! / 2
    const origin = opts.origin ?? first
    grid = { position: (t) => (t - origin) / tau, time: (k) => origin + k * tau }
  } else {
    ;({ tau, strength } = findPulse(clusters))
    grid = trackPulse(clusters, tau)
  }

  // Accent per pulse, starting at the pulse of the first onset.
  const base = known ? Math.floor(grid.position(first) + 0.25) : Math.round(grid.position(first))
  const indexed = clusters.map((c) => {
    const position = grid.position(c.time) - base
    return { ...c, position, k: Math.round(position), off: Math.abs(position - Math.round(position)) }
  })
  const length = Math.max(...indexed.map((c) => c.k)) + 1
  const accents = new Array<number>(length).fill(0)
  for (const c of indexed) if (c.off <= 0.25 && c.k >= 0) accents[c.k]! += c.salience

  // Long-short playing leaves the middle of every three pulses empty.
  const thirds = [0, 0, 0]
  for (const c of indexed) if (c.off <= 0.25) thirds[((c.k % 3) + 3) % 3]! += 1
  const emptiest = thirds.indexOf(Math.min(...thirds))
  const swingLike = !known && thirds[emptiest]! <= 0.1 * clusters.length && thirds[(emptiest + 1) % 3]! >= 0.2 * clusters.length

  const hypotheses: Hypothesis[] = []
  const wanted = (name: TimeSignatureName): boolean => !opts.timeSignature || opts.timeSignature === name
  if (known) {
    for (const name of ['4/4', '3/4'] as const) if (wanted(name)) hypotheses.push({ sig: SIGNATURES[name], perBeat: 2, swing: false })
    for (const name of ['6/8', '12/8'] as const) if (wanted(name)) hypotheses.push({ sig: SIGNATURES[name], perBeat: 3, swing: false })
  } else {
    for (const perBeat of [1, 2, 4]) {
      for (const name of ['4/4', '3/4'] as const) if (wanted(name)) hypotheses.push({ sig: SIGNATURES[name], perBeat, swing: false })
    }
    const forcedCompound = opts.timeSignature === '6/8' || opts.timeSignature === '12/8'
    if (swingLike && !forcedCompound && wanted('4/4') && opts.swing !== false) {
      hypotheses.push({ sig: SIGNATURES['4/4'], perBeat: 3, swing: true })
    } else {
      for (const perBeat of forcedCompound ? [1, 3, 6] : [3, 6]) {
        for (const name of ['6/8', '12/8'] as const) if (wanted(name)) hypotheses.push({ sig: SIGNATURES[name], perBeat, swing: false })
      }
    }
  }

  let best: { h: Hypothesis; phase: number; score: number } | null = null
  const bySignature = new Map<string, number>()
  for (const h of hypotheses) {
    const bar = h.perBeat * h.sig.beatsPerBar
    let fit = -Infinity
    let phase = 0
    if (known) {
      // The bar line is given: absolute pulse 0.
      phase = (((-base) % bar) + bar) % bar
      fit = fitMeter(accents, h, phase)
    } else {
      for (let p = 0; p < bar; p++) {
        // Music usually starts on a downbeat; a small nudge settles ties.
        const score = fitMeter(accents, h, p) + (p === 0 ? 0.05 : 0)
        if (score > fit) {
          fit = score
          phase = p
        }
      }
    }
    const score = fit + (known ? 0 : 0.5 * tempoPrior(60 / (h.perBeat * tau))) + SIGNATURE_PRIOR[h.sig.name]
    if (!best || score > best.score) best = { h, phase, score }
    bySignature.set(h.sig.name, Math.max(bySignature.get(h.sig.name) ?? -Infinity, score))
  }
  if (!best) return null
  const { h, phase } = best

  // Beats from the bar line at or before the first onset to past the last note.
  const bar = h.perBeat * h.sig.beatsPerBar
  const start = base + (phase > 0 ? phase - bar : 0)
  const beats: number[] = []
  for (let k = start; ; k += h.perBeat) {
    const time = grid.time(k)
    beats.push(time)
    if (time > lastEnd && beats.length > h.sig.beatsPerBar) break
    if (beats.length > 4000) break
  }

  // Swing: offbeats sit near two thirds of the beat, and little sits near one third.
  let swing = h.swing
  let swingRatio = 0.5
  if (!h.sig.compound) {
    const fractions = clusters.map((c) => {
      const position = beatPosition({ beats }, c.time)
      return position - Math.floor(position)
    })
    const offbeat = fractions.filter((f) => f > 0.15 && f < 0.85)
    const late = offbeat.filter((f) => f >= 0.57 && f <= 0.76)
    if (late.length >= 3 && late.length >= 0.6 * offbeat.length) {
      swing = true
      swingRatio = late.reduce((s, f) => s + f, 0) / late.length
    } else if (swing) swingRatio = 2 / 3
  }
  if (opts.swing !== undefined) {
    swing = opts.swing && !h.sig.compound
    if (swing && swingRatio === 0.5) swingRatio = 2 / 3
  }

  const rival = Math.max(-1, ...[...bySignature].filter(([name]) => name !== h.sig.name).map(([, score]) => score))
  const margin = bySignature.size > 1 ? clamp01((best.score - rival) / 0.3) : 1
  return build(h.sig, beats, swing, swingRatio, clamp01(0.6 * margin + 0.4 * clamp01(strength)), 'estimated')
}

/** "6/8, dotted quarter = 80, straight" for text contexts. */
export function meterToText(meter: MeterEstimate): string {
  const beat = meter.compound ? 'dotted quarter' : 'quarter'
  return `${meter.timeSignature}, ${beat} = ${Math.round(meter.bpm)}${meter.swing ? ', swing' : ', straight'}`
}
