/**
 * The beat grid: the one mapping between musical time (beats, bars) and the
 * session clock. Everything the transport does is arithmetic on this.
 *
 * A grid is a tempo plus one anchor (beat `anchorBeat` falls at session time
 * `anchorTime`). Beat 0, and every multiple of `beatsPerBar`, is a downbeat.
 * Changing tempo means re-anchoring at the point of change, so the mapping
 * stays continuous and nothing jumps.
 */
export interface BeatGrid {
  bpm: number
  /** Session time, in seconds, of beat `anchorBeat`. */
  anchorTime: number
  anchorBeat: number
  beatsPerBar: number
}

export const makeGrid = (bpm: number, downbeatTime: number, beatsPerBar = 4): BeatGrid => ({ bpm, anchorTime: downbeatTime, anchorBeat: 0, beatsPerBar })

export const beatSeconds = (grid: BeatGrid): number => 60 / grid.bpm

/** Beat position (fractional) at a session time. */
export const beatAt = (grid: BeatGrid, time: number): number => grid.anchorBeat + ((time - grid.anchorTime) * grid.bpm) / 60

/** Session time of a beat position. */
export const timeAt = (grid: BeatGrid, beat: number): number => grid.anchorTime + ((beat - grid.anchorBeat) * 60) / grid.bpm

const EPSILON = 1e-9

/** The first multiple of `step` beats at or after `beat`. */
export const ceilToStep = (beat: number, step: number): number => Math.ceil(beat / step - EPSILON) * step

/** The nearest multiple of `step` beats. */
export const roundToStep = (beat: number, step: number): number => Math.round(beat / step) * step

/** Bar number (0-based) and beat within the bar (0-based, fractional) of a beat position. */
export function barPosition(grid: BeatGrid, beat: number): { bar: number; beatInBar: number } {
  const bar = Math.floor(beat / grid.beatsPerBar + EPSILON)
  return { bar, beatInBar: Math.max(0, beat - bar * grid.beatsPerBar) }
}

export type StartQuantize = 'bar' | 'beat' | 'now'

/**
 * Where something asked for at `fromBeat` should start: the next bar line,
 * the next beat, or right away. `fromBeat` is the earliest beat that can
 * still be scheduled, so the answer is never in the past.
 */
export function quantizeStart(grid: BeatGrid, fromBeat: number, quantize: StartQuantize): number {
  if (quantize === 'now') return fromBeat
  return ceilToStep(fromBeat, quantize === 'bar' ? grid.beatsPerBar : 1)
}

/** Beat number of the first downbeat at or after a session time. */
export const nextDownbeat = (grid: BeatGrid, time: number): number => ceilToStep(beatAt(grid, time), grid.beatsPerBar)

/** The same grid at a new tempo from `beat` onwards; positions before and at `beat` keep their times. */
export const retune = (grid: BeatGrid, beat: number, bpm: number): BeatGrid => ({ ...grid, bpm, anchorBeat: beat, anchorTime: timeAt(grid, beat) })

/** Move the bar lines so that `beat` becomes a downbeat (beat numbers shift; times do not). */
export function rebar(grid: BeatGrid, beat: number): BeatGrid {
  const whole = Math.round(beat)
  const shift = ((whole % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar
  return { ...grid, anchorBeat: grid.anchorBeat - shift }
}

/** Wrap a beat difference into [-span/2, span/2). */
export const wrapBeats = (difference: number, span = 1): number => difference - span * Math.floor(difference / span + 0.5)

/* ---------- loop regions ---------- */

export interface LoopRegion {
  /** Transport beat where the first pass starts. */
  startBeat: number
  lengthBeats: number
}

/** Which pass of the loop a beat is in, and how far into it. Beats before the start are in pass -1, -2... */
export function loopPosition(region: LoopRegion, beat: number): { pass: number; offset: number } {
  const pass = Math.floor((beat - region.startBeat) / region.lengthBeats + EPSILON)
  return { pass, offset: Math.max(0, beat - region.startBeat - pass * region.lengthBeats) }
}

/** A clip's length rounded up to whole bars (at least one), so loops stay bar-aligned. */
export const wholeBars = (lengthBeats: number, beatsPerBar: number): number => Math.max(1, Math.ceil(lengthBeats / beatsPerBar - 1e-6)) * beatsPerBar

/* ---------- following the player ---------- */

export interface FollowOptions {
  /** Ignore the tracker below this confidence. */
  minConfidence?: number
  /** How fast tempo moves toward the player's, 0-1 per update. */
  tempoGain?: number
  /** Close a phase error over this many beats. */
  phaseBeats?: number
  /** Largest tempo offset used to pull phase in, as a fraction. Keeps corrections inaudible as jumps. */
  maxPhaseRate?: number
  /** Do not follow a tempo further than this fraction from the current one; it is more likely a misreading. */
  maxTempoStep?: number
  /** Phase errors smaller than this (beats) are left alone. */
  deadband?: number
}

export interface FollowResult {
  grid: BeatGrid
  /** Our tempo without the temporary phase correction. Feed it back in as `baseBpm` next time. */
  baseBpm: number
  /** How far the player's beat is from ours, in our beats; positive means we are ahead of the player. */
  phaseError: number
  /** The player's tempo folded to the nearest octave of ours, or null if the tracker was not confident. */
  targetBpm: number | null
  followed: boolean
}

/**
 * One step of tempo following. `own` is the grid being played, `baseBpm` its
 * tempo without any phase correction, `player` the tracker's grid. Returns a
 * grid that is continuous at `atBeat` (normally the scheduler's cursor, so
 * nothing already scheduled moves) whose tempo leans toward the player's and
 * runs a touch fast or slow until the beats line up again.
 *
 * Only beat phase is followed, never bar phase: the player's downbeat is a
 * guess, and jumping a loop by a beat is worse than trusting the loop.
 */
export function followStep(own: BeatGrid, baseBpm: number, player: BeatGrid, confidence: number, atBeat: number, options: FollowOptions = {}): FollowResult {
  const { minConfidence = 0.5, tempoGain = 0.3, phaseBeats = 4, maxPhaseRate = 0.06, maxTempoStep = 0.15, deadband = 0.02 } = options
  const hold: FollowResult = { grid: own.bpm === baseBpm ? own : retune(own, atBeat, baseBpm), baseBpm, phaseError: 0, targetBpm: null, followed: false }
  if (confidence < minConfidence) return hold

  // The tracker may read half or double time; fold to whichever is nearest ours.
  let fold = 1
  for (const candidate of [0.5, 2]) {
    if (Math.abs(Math.log((player.bpm * candidate) / baseBpm)) < Math.abs(Math.log((player.bpm * fold) / baseBpm))) fold = candidate
  }
  const targetBpm = player.bpm * fold
  if (Math.abs(targetBpm / baseBpm - 1) > maxTempoStep) return { ...hold, targetBpm }

  // Where does the player's beat nearest `atBeat` fall on our grid?
  const time = timeAt(own, atBeat)
  const playerBeatTime = timeAt(player, Math.round(beatAt(player, time)))
  // If the player's beats are read at half our tempo they still land on our beats;
  // read at double, they also land on our half beats.
  const phaseError = wrapBeats(beatAt(own, playerBeatTime), fold === 0.5 ? 0.5 : 1)

  const nextBase = baseBpm + tempoGain * (targetBpm - baseBpm)
  const rate = Math.abs(phaseError) < deadband ? 0 : Math.max(-maxPhaseRate, Math.min(maxPhaseRate, -phaseError / phaseBeats))
  return { grid: retune(own, atBeat, nextBase * (1 + rate)), baseBpm: nextBase, phaseError, targetBpm, followed: true }
}
