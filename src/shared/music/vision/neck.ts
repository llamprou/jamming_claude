import { clamp01, fingertips, lerp, median, project, type Point, type TrackedHand } from './landmarks'

/**
 * Guitar and bass: from where the fretting hand is in the picture to which
 * frets it is over.
 *
 * This is deliberately coarse. One webcam cannot tell which finger is pressing
 * which string. What it can tell, once it knows where the neck is, is roughly
 * which stretch of frets the hand covers, and that is exactly what tablature
 * is missing when the same pitch can be played in several places.
 *
 * The neck is modelled as a straight line in the picture, seen roughly side
 * on. Perspective is ignored, so a neck pointing towards or away from the
 * camera reads a fret or two off at the far end. The calibration is two marked
 * points; it goes stale when the player or the camera moves.
 */

export interface NeckCalibration {
  instrument: 'guitar' | 'bass'
  /** Where the nut is in the picture (normalised, see landmarks.ts). */
  nut: Point
  /** Where the fret wire of `refFret` is. */
  ref: Point
  refFret: number
  /** Picture width / height when the points were marked. */
  aspect: number
}

/** A coarse statement of where the fretting hand is. This is what tablature consumes. */
export interface HandPositionHint {
  /** Seconds on the session clock. */
  time: number
  instrument: 'guitar' | 'bass'
  /** Lowest fret under the hand (the index finger's fret), 1-24. */
  lowFret: number
  /** Highest fret under the hand (usually the little finger's), >= lowFret. */
  highFret: number
  /** 0-1. Below about 0.3, ignore the hint. */
  confidence: number
}

export const MAX_FRET = 24

/** Distance from the nut to fret wire `n`, as a fraction of the scale length (equal temperament). */
export const fretFraction = (n: number): number => 1 - 2 ** (-n / 12)

/** Where the bridge would be, extrapolated from the two marked points. */
export const bridgePoint = (cal: NeckCalibration): Point => lerp(cal.nut, cal.ref, 1 / fretFraction(cal.refFret))

/** Where fret wire `n` is in the picture. For drawing the overlay. */
export const fretPoint = (cal: NeckCalibration, n: number): Point => lerp(cal.nut, bridgePoint(cal), fretFraction(n))

/**
 * The fret position of a point in the picture, as a continuous number: 0 at
 * the nut, 12.0 on the twelfth fret wire, negative behind the nut. `off` is
 * how far the point is from the neck line, in units of the nut-to-twelfth-fret
 * length (a neck is roughly 0.15 wide on that scale).
 */
export function fretAtPoint(cal: NeckCalibration, p: Point): { fret: number; off: number } {
  const { along, off } = project(p, cal.nut, bridgePoint(cal), cal.aspect)
  // Past the last fret the log blows up; hold it at the end of the board.
  const fret = along >= fretFraction(MAX_FRET + 1) ? MAX_FRET + 1 : -12 * Math.log2(1 - along)
  return { fret, off: off * 2 }
}

/** A finger between wire n-1 and wire n is playing fret n. */
const frettedFret = (continuous: number): number => Math.max(1, Math.min(MAX_FRET, Math.ceil(continuous - 1e-9)))

/**
 * Which frets the hand covers, or null if it is nowhere near the neck.
 * Confidence falls when the hand is poorly tracked, sits off the neck line, or
 * spans more frets than a hand can (a sign the calibration has gone stale).
 */
export function frettingHint(cal: NeckCalibration, hand: TrackedHand, time: number): HandPositionHint | null {
  const tips = fingertips(hand).map((tip) => fretAtPoint(cal, tip))
  const frets = tips.map((t) => t.fret)
  const low = Math.min(...frets)
  const high = Math.max(...frets)
  // Whole hand behind the nut or beyond the end of the board: not on the neck.
  if (high < -1 || low > MAX_FRET) return null
  const off = median(tips.map((t) => t.off))
  if (off > 0.6) return null

  const lowFret = frettedFret(low)
  const highFret = Math.max(lowFret, frettedFret(high))
  const onNeck = clamp01(1 - (off - 0.2) / 0.4)
  const span = highFret - lowFret
  const plausibleSpan = span <= 5 ? 1 : clamp01(1 - (span - 5) / 4)
  return { time, instrument: cal.instrument, lowFret, highFret, confidence: clamp01(hand.score) * onNeck * plausibleSpan }
}

/**
 * Steady a run of per-frame hints (about half a second's worth) into one:
 * median frets, mean confidence, stamped with the latest time. Null if the
 * run is empty.
 */
export function steadyHint(hints: HandPositionHint[]): HandPositionHint | null {
  const last = hints[hints.length - 1]
  if (!last) return null
  const lowFret = Math.round(median(hints.map((h) => h.lowFret)))
  const highFret = Math.max(lowFret, Math.round(median(hints.map((h) => h.highFret))))
  const confidence = hints.reduce((s, h) => s + h.confidence, 0) / hints.length
  return { time: last.time, instrument: last.instrument, lowFret, highFret, confidence }
}

/**
 * How well playing `fret` fits the hint: 0 when it is under the hand (open
 * strings always are), growing by one per fret of reach beyond it. A tab
 * chooser can add `confidence * fretReach(...)` to its cost for each candidate
 * string/fret.
 */
export function fretReach(hint: Pick<HandPositionHint, 'lowFret' | 'highFret'>, fret: number): number {
  if (fret <= 0) return 0
  if (fret < hint.lowFret) return hint.lowFret - fret
  if (fret > hint.highFret) return fret - hint.highFret
  return 0
}
