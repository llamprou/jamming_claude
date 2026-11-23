import type { NoteEvent } from '../types'
import { beatAt, nextDownbeat, timeAt, type BeatGrid } from './grid'

/**
 * Beat tracking: follow the player's tempo and beat phase from note onsets.
 *
 * Each update looks at the last few seconds of onsets (recent ones count
 * more) and does two things:
 *  1. Acquire: score every tempo and phase by how well onsets land on that
 *     grid's beats and subdivisions, with a prior that favours staying near
 *     the previous answer (so the tracker does not hop between half and
 *     double time, or between on-beat and off-beat).
 *  2. Lock: assign each onset to its nearest grid position and fit a straight
 *     line through (position, time). The slope is the beat period right now,
 *     which is what follows gradual drift; onsets that sit off the grid are
 *     left out, so extra notes do little harm and missing ones none.
 *
 * Because it re-reads a window rather than consuming a stream, notes that the
 * slow transcription pass rewrites after the fact are simply picked up.
 * Beat numbers carry over from one update to the next, and the downbeat is a
 * running guess from accents and phrase starts.
 */

export interface TrackerOptions {
  beatsPerBar?: number
  minBpm?: number
  maxBpm?: number
  /** How far back each update looks. */
  windowSeconds?: number
  /** Onsets this old count half as much. */
  halfLifeSeconds?: number
  /** Seconds to add to a note's start before use, e.g. to undo a known detection delay for a source. */
  onsetOffset?: (note: NoteEvent) => number
}

export interface BeatEstimate {
  grid: BeatGrid
  /** 0-1: how much of the recent playing sits on this grid. Below about 0.5, do not rely on it. */
  confidence: number
  /** Distinct onsets used. */
  onsets: number
  /** Session time of the update. */
  at: number
}

interface Onset {
  time: number
  weight: number
  /** How much this onset sounds like a strong beat: notes struck together, low notes, loudness. */
  accent: number
  /** Seconds since the onset before it (or since the start of what was looked at). */
  gap: number
}

/** How far before the window to look for the silence that marks a phrase start. */
const LEAD_IN = 2

/** How much of the measured tempo curvature to believe. */
const CURVE_TRUST = 0.7
const PHASE_BINS = 40
const TIMING_SIGMA = 0.03

/** Merge notes struck together into single onsets. Exported for tests. */
export function clusterOnsets(notes: NoteEvent[], offset: (note: NoteEvent) => number = () => 0): Onset[] {
  const sorted = notes.map((note) => ({ note, time: note.start + offset(note) })).sort((a, b) => a.time - b.time)
  const onsets: Onset[] = []
  let group: typeof sorted = []
  const flush = () => {
    if (group.length === 0) return
    const velocity = group.reduce((sum, g) => sum + g.note.velocity, 0) / group.length
    const confidence = group.reduce((sum, g) => sum + g.note.confidence, 0) / group.length
    const size = Math.min(group.length, 4)
    const low = Math.min(...group.map((g) => g.note.pitch)) < 48 ? 0.5 : 0
    onsets.push({
      time: group.reduce((sum, g) => sum + g.time, 0) / group.length,
      weight: (0.4 + 0.6 * velocity) * (0.5 + 0.5 * confidence) * (1 + 0.25 * (size - 1)),
      accent: (size + low) * (0.4 + 0.6 * velocity),
      gap: 0,
    })
    group = []
  }
  for (const entry of sorted) {
    if (group.length && entry.time - group[0]!.time > 0.035) flush()
    group.push(entry)
  }
  flush()
  return onsets
}

export class BeatTracker {
  private current: BeatEstimate | null = null
  /** Accent heard on each beat of the bar, decaying; index 0 is the current downbeat. */
  private barAccent: number[]
  /** How many onsets went into each entry of barAccent (decaying alike). */
  private barCount: number[]
  private accentSeenUntil = -Infinity
  private readonly options: Required<Omit<TrackerOptions, 'onsetOffset'>> & Pick<TrackerOptions, 'onsetOffset'>

  constructor(options: TrackerOptions = {}) {
    this.options = { beatsPerBar: 4, minBpm: 60, maxBpm: 180, windowSeconds: 10, halfLifeSeconds: 3, ...options }
    this.barAccent = new Array<number>(this.options.beatsPerBar).fill(0)
    this.barCount = new Array<number>(this.options.beatsPerBar).fill(0)
  }

  get estimate(): BeatEstimate | null {
    return this.current
  }

  /** Session time of beat `n` on the tracked grid, or null before any tempo is found. */
  beatTime(n: number): number | null {
    return this.current ? timeAt(this.current.grid, n) : null
  }

  /** Session time of the first downbeat at or after `after`. */
  nextDownbeatTime(after: number): number | null {
    return this.current ? timeAt(this.current.grid, nextDownbeat(this.current.grid, after)) : null
  }

  reset(): void {
    this.current = null
    this.barAccent.fill(0)
    this.barCount.fill(0)
    this.accentSeenUntil = -Infinity
  }

  /** Change the meter. The beat is kept; the downbeat guess starts over. */
  setBeatsPerBar(beatsPerBar: number): void {
    if (beatsPerBar === this.options.beatsPerBar) return
    this.options.beatsPerBar = beatsPerBar
    this.barAccent = new Array<number>(beatsPerBar).fill(0)
    this.barCount = new Array<number>(beatsPerBar).fill(0)
    if (this.current) this.current = { ...this.current, grid: { ...this.current.grid, beatsPerBar } }
  }

  /**
   * Feed the notes heard so far (any superset of the last `windowSeconds`
   * will do) and get the current estimate. Call a few times a second.
   */
  update(notes: NoteEvent[], now: number): BeatEstimate | null {
    const { windowSeconds, halfLifeSeconds, beatsPerBar } = this.options
    const from = now - windowSeconds
    // A little from before the window too, only to know whether its first onset follows a silence.
    const heard = clusterOnsets(
      notes.filter((n) => n.start >= from - LEAD_IN - 0.5 && n.start <= now + 0.5),
      this.options.onsetOffset,
    ).filter((o) => o.time <= now)
    let before = from - LEAD_IN
    for (const onset of heard) {
      onset.gap = onset.time - before
      before = onset.time
    }
    const onsets = heard.filter((o) => o.time >= from)
    const previous = this.current

    if (onsets.length < 4) {
      // Not enough to go on: keep counting on the old grid, trusting it less the longer the silence.
      if (previous) this.current = { ...previous, confidence: previous.confidence * 0.5 ** ((now - previous.at) / 8), onsets: onsets.length, at: now }
      return this.current
    }

    const recency = (time: number) => 0.5 ** ((now - time) / halfLifeSeconds)
    const acquired = this.acquire(onsets, now, recency)
    const locked = lock(onsets, acquired.period, acquired.lastBeat, recency)

    // Number the beats so they continue from the previous estimate.
    let anchorBeat = 0
    if (previous) anchorBeat = Math.round(beatAt(previous.grid, locked.lastBeat))
    let grid: BeatGrid = { bpm: 60 / locked.period, anchorTime: locked.lastBeat, anchorBeat, beatsPerBar }

    grid = this.findDownbeat(grid, onsets, now, previous === null)

    const silence = Math.max(0, now - onsets[onsets.length - 1]!.time - 2 * locked.period)
    const confidence = locked.support * Math.min(1, onsets.length / 6) * (0.5 + 0.5 * acquired.coverage) * 0.5 ** (silence / 8)
    this.current = { grid, confidence: Math.max(0, Math.min(1, confidence)), onsets: onsets.length, at: now }
    return this.current
  }

  /** Coarse search over tempo and phase. Returns the beat period and the time of the last beat at or before `now`. */
  private acquire(onsets: Onset[], now: number, recency: (time: number) => number): { period: number; lastBeat: number; coverage: number } {
    const { minBpm, maxBpm } = this.options
    const previous = this.current && this.current.confidence > 0.3 ? this.current : null
    const weights = onsets.map((o) => o.weight * recency(o.time))
    const total = weights.reduce((a, b) => a + b, 0)
    const histogram = new Float64Array(PHASE_BINS)
    const kernel = new Float64Array(PHASE_BINS)
    let best = { score: -Infinity, period: 0.5, phase: 0, coverage: 0 }

    for (let bpm = minBpm; bpm <= maxBpm; bpm += 1) {
      const period = 60 / bpm
      histogram.fill(0)
      for (let i = 0; i < onsets.length; i++) {
        // How long before `now` the onset is, as a fraction of a beat.
        const phase = ((now - onsets[i]!.time) / period) % 1
        histogram[Math.min(PHASE_BINS - 1, Math.floor(phase * PHASE_BINS))]! += weights[i]!
      }
      // What an onset is worth by its distance from the beat: full on the beat,
      // less on the half beat, a little on the quarter beat.
      for (let d = 0; d < PHASE_BINS; d++) {
        const x = d / PHASE_BINS
        const near = (position: number) => {
          const distance = Math.min(Math.abs(x - position), 1 - Math.abs(x - position)) * period
          return Math.exp(-(distance * distance) / (2 * TIMING_SIGMA * TIMING_SIGMA))
        }
        kernel[d] = Math.max(near(0), 0.5 * near(0.5), 0.2 * near(0.25), 0.2 * near(0.75))
      }

      let tempoPrior = Math.exp(-0.5 * (Math.log2(bpm / 105) / 0.7) ** 2)
      let expectedPhase = -1
      if (previous) {
        const octaves = Math.log2(bpm / previous.grid.bpm)
        tempoPrior *= 0.3 + 0.7 * Math.exp(-0.5 * (octaves / 0.07) ** 2)
        if (Math.abs(octaves) < 0.09) expectedPhase = ((beatAt(previous.grid, now) % 1) + 1) % 1
      }

      for (let j = 0; j < PHASE_BINS; j++) {
        let score = 0
        for (let b = 0; b < PHASE_BINS; b++) {
          const h = histogram[b]!
          if (h > 0) score += h * kernel[(b - j + PHASE_BINS) % PHASE_BINS]!
        }
        score /= total
        if (expectedPhase >= 0) {
          const candidate = (j + 0.5) / PHASE_BINS
          const off = Math.min(Math.abs(candidate - expectedPhase), 1 - Math.abs(candidate - expectedPhase))
          score *= 0.6 + 0.4 * Math.exp(-0.5 * (off / 0.12) ** 2)
        }
        score *= tempoPrior
        if (score <= best.score) continue // cannot win even with full coverage
        const phase = ((j + 0.5) / PHASE_BINS) * period
        const coverage = beatCoverage(onsets, period, now - phase)
        const full = score * (0.4 + 0.6 * coverage)
        if (full > best.score) best = { score: full, period, phase, coverage }
      }
    }
    return { period: best.period, lastBeat: now - best.phase, coverage: best.coverage }
  }

  /**
   * Keep a running tally of how accented each beat of the bar is and renumber
   * so the strongest is the downbeat. A phrase that starts after a silence
   * counts heavily: players usually come in on one.
   */
  private findDownbeat(grid: BeatGrid, onsets: Onset[], now: number, fresh: boolean): BeatGrid {
    const { beatsPerBar } = this.options
    const period = 60 / grid.bpm
    const decay = 0.5 ** (Math.max(0, now - (this.current?.at ?? now)) / 30)
    for (let i = 0; i < beatsPerBar; i++) {
      this.barAccent[i]! *= decay
      this.barCount[i]! *= decay
    }

    for (const onset of onsets) {
      if (onset.time <= this.accentSeenUntil) continue
      const beat = beatAt(grid, onset.time)
      const whole = Math.round(beat)
      if (Math.abs(beat - whole) * period > 0.06) continue
      const slot = ((whole % beatsPerBar) + beatsPerBar) % beatsPerBar
      this.barAccent[slot]! += onset.accent + (onset.gap > Math.max(2 * period, 1.2) ? 3 : 0)
      this.barCount[slot]! += 1
    }
    // Onsets in the last moments may still be revised or joined by chord tones; count them next time.
    this.accentSeenUntil = Math.max(this.accentSeenUntil, now - 0.25)

    // Typical accent on each beat of the bar; the extra one in the divisor keeps a
    // beat heard only once or twice from outranking one that is played every bar.
    const strength = this.barAccent.map((accent, i) => accent / (this.barCount[i]! + 1))
    let strongest = 0
    for (let i = 1; i < beatsPerBar; i++) if (strength[i]! > strength[strongest]!) strongest = i
    if (strongest === 0 || strength[strongest]! < strength[0]! * (fresh ? 1 : 1.3)) return grid
    this.barAccent = [...this.barAccent.slice(strongest), ...this.barAccent.slice(0, strongest)]
    this.barCount = [...this.barCount.slice(strongest), ...this.barCount.slice(0, strongest)]
    return { ...grid, anchorBeat: grid.anchorBeat - strongest }
  }
}

/** Share of beats, between the first and last onset, that have an onset on them. */
function beatCoverage(onsets: Onset[], period: number, beatTime: number): number {
  const first = onsets[0]!.time
  const lastOnset = onsets[onsets.length - 1]!.time
  const hit = new Set<number>()
  for (const onset of onsets) {
    const index = Math.round((onset.time - beatTime) / period)
    if (Math.abs(onset.time - (beatTime + index * period)) < 2 * TIMING_SIGMA) hit.add(index)
  }
  const beats = Math.max(1, Math.round((lastOnset - first) / period) + 1)
  return Math.min(1, hit.size / beats)
}

/**
 * Refine a rough period and phase by fitting a line through the onsets that
 * sit on the grid. Returns the period now, the time of a recent beat, and the
 * share of onset weight the grid explains.
 */
function lock(onsets: Onset[], roughPeriod: number, roughBeat: number, recency: (time: number) => number): { period: number; lastBeat: number; support: number } {
  let period = roughPeriod
  let origin = roughBeat
  const newest = onsets[onsets.length - 1]!.time
  for (let pass = 0; pass < 4; pass++) {
    const tolerance = pass === 0 ? Math.min(0.08, period / 6) : Math.min(0.05, period / 9)
    let sw = 0
    let sn = 0
    let st = 0
    let snn = 0
    let snt = 0
    let min = Infinity
    let max = -Infinity
    let used = 0
    for (const onset of onsets) {
      const position = Math.round(((onset.time - origin) / period) * 4) / 4
      const residual = onset.time - (origin + position * period)
      if (Math.abs(residual) > tolerance) continue
      const level = Number.isInteger(position) ? 1 : Number.isInteger(position * 2) ? 0.6 : 0.25
      const w = onset.weight * recency(onset.time) * level
      const t = onset.time - newest
      sw += w
      sn += w * position
      st += w * t
      snn += w * position * position
      snt += w * position * t
      min = Math.min(min, position)
      max = Math.max(max, position)
      used++
    }
    const spread = sw * snn - sn * sn
    if (used < 3 || max - min < 1.5 || spread <= 1e-9) break
    const slope = (sw * snt - sn * st) / spread
    const intercept = (st - slope * sn) / sw
    // One pass may not move the tempo far: the assignment was made with the old one.
    period = Math.max(period * 0.93, Math.min(period * 1.07, slope))
    origin = newest + intercept
  }

  // A straight line is an average over a few seconds, so when the tempo is
  // moving it trails the player: late in an accelerando, early in a
  // ritardando. Fit the curve as well (time = a + b n + c n^2, n counted back
  // from the newest onset) and read period and phase off its near end. The
  // curvature is held back and bounded, since it is the noisiest term.
  const sums = [0, 0, 0, 0, 0]
  const rhs = [0, 0, 0]
  let used = 0
  let far = 0
  const newestPosition = Math.round(((newest - origin) / period) * 4) / 4
  for (const onset of onsets) {
    const position = Math.round(((onset.time - origin) / period) * 4) / 4
    const residual = onset.time - (origin + position * period)
    if (Math.abs(residual) > Math.min(0.05, period / 9)) continue
    const level = Number.isInteger(position) ? 1 : Number.isInteger(position * 2) ? 0.6 : 0.25
    const w = onset.weight * recency(onset.time) * level
    const n = position - newestPosition
    let power = w
    for (let k = 0; k < 5; k++) {
      sums[k]! += power
      if (k < 3) rhs[k]! += power * residual
      power *= n
    }
    used++
    far = Math.min(far, n)
  }
  if (used >= 8 && far <= -6) {
    const curve = solve3([sums[0]!, sums[1]!, sums[2]!, sums[1]!, sums[2]!, sums[3]!, sums[2]!, sums[3]!, sums[4]!], rhs)
    if (curve) {
      const limit = 0.0025 * period
      const c = Math.max(-limit, Math.min(limit, CURVE_TRUST * curve[2]!))
      // Re-fit the line with the curve fixed, so the two stay consistent.
      const s0 = sums[0]!
      const s1 = sums[1]!
      const s2 = sums[2]!
      const r0 = rhs[0]! - c * s2
      const r1 = rhs[1]! - c * sums[3]!
      const spread = s0 * s2 - s1 * s1
      if (spread > 1e-9) {
        const slope = (s0 * r1 - s1 * r0) / spread
        const intercept = (r0 - slope * s1) / s0
        // Period and phase at the newest onset, where n = 0.
        origin = origin + newestPosition * period + intercept
        period = Math.max(period * 0.95, Math.min(period * 1.05, period + slope))
        origin -= newestPosition * period
      }
    }
  }

  let onGrid = 0
  let total = 0
  for (const onset of onsets) {
    const w = onset.weight * recency(onset.time)
    const position = Math.round(((onset.time - origin) / period) * 2) / 2
    total += w
    if (Math.abs(onset.time - (origin + position * period)) < 0.045) onGrid += w
  }
  // Report a beat at or just before the newest onset, to keep extrapolation short.
  const lastBeat = origin + Math.floor((newest - origin) / period + 1e-6) * period
  return { period, lastBeat, support: total > 0 ? onGrid / total : 0 }
}

/** Solve a 3x3 linear system (row-major), or null if it is close to singular. */
function solve3(m: number[], v: number[]): [number, number, number] | null {
  const det = (a: number[]) => a[0]! * (a[4]! * a[8]! - a[5]! * a[7]!) - a[1]! * (a[3]! * a[8]! - a[5]! * a[6]!) + a[2]! * (a[3]! * a[7]! - a[4]! * a[6]!)
  const d = det(m)
  const scale = Math.abs(m[0]! * m[4]! * m[8]!)
  if (!(Math.abs(d) > 1e-9 * Math.max(scale, 1e-12))) return null
  const column = (i: number) => m.map((value, index) => (index % 3 === i ? v[Math.floor(index / 3)]! : value))
  return [det(column(0)) / d, det(column(1)) / d, det(column(2)) / d]
}
