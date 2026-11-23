import type { NoteEvent } from '../types'
import { clamp01, fingertips, landmark, LM, project, type Point, type TrackedHand } from './landmarks'

/**
 * Piano: which hand is where along the keyboard, so notes can be split
 * between the staves by who played them rather than by a fixed middle C.
 *
 * The keyboard is a straight line between two marked keys, with pitch spread
 * evenly along it (true to within a key). Coarse on purpose: this says which
 * octave or so each hand is over, not which keys are down.
 */

export interface KeyboardCalibration {
  /** Where the key for `lowPitch` is in the picture (normalised, see landmarks.ts). */
  low: Point
  lowPitch: number
  high: Point
  highPitch: number
  /** Picture width / height when the points were marked. */
  aspect: number
}

/** The stretch of keys one hand is over, as MIDI pitches. */
export interface HandReach {
  low: number
  high: number
}

export interface KeyboardHandsHint {
  /** Seconds on the session clock. */
  time: number
  left: HandReach | null
  right: HandReach | null
  /**
   * Notes below this MIDI pitch are most likely the left hand's. Null when
   * only one hand (or none) is over the keys.
   */
  split: number | null
  /** 0-1. Below about 0.3, ignore the hint. */
  confidence: number
}

/**
 * The pitch under a point, continuous, and how far the point is from the
 * keyboard line, measured in semitone widths (a key is about 11 deep).
 */
export function pitchAtPoint(cal: KeyboardCalibration, p: Point): { pitch: number; off: number } {
  const { along, off } = project(p, cal.low, cal.high, cal.aspect)
  const range = cal.highPitch - cal.lowPitch
  return { pitch: cal.lowPitch + along * range, off: off * Math.abs(range) }
}

/** Fingertips this many semitone widths from the marked line are still on the keys; beyond FAR they are not. */
const NEAR = 8
const FAR = 14
const onKeys = (off: number): number => clamp01(1 - (off - NEAR) / (FAR - NEAR))

function reach(cal: KeyboardCalibration, hand: TrackedHand): (HandReach & { off: number; score: number }) | null {
  // Thumb included: on keys it is a playing finger.
  const spots = [landmark(hand, LM.thumbTip), ...fingertips(hand)].map((tip) => pitchAtPoint(cal, tip))
  const off = Math.min(...spots.map((s) => s.off))
  const pitches = spots.map((s) => s.pitch)
  const low = Math.min(...pitches)
  const high = Math.max(...pitches)
  const [from, to] = [Math.min(cal.lowPitch, cal.highPitch), Math.max(cal.lowPitch, cal.highPitch)]
  // Not over the keys at all (resting in a lap, turning a page).
  if (off > FAR || high < from - 6 || low > to + 6) return null
  return { low: Math.round(low), high: Math.round(high), off, score: hand.score }
}

/**
 * Which keys each hand is over. With two hands on the keys, left and right
 * are decided by position (hands rarely cross, and it is more reliable than
 * the tracker's left/right call from an overhead camera); with one, by the
 * tracker's call.
 */
export function keyboardHands(cal: KeyboardCalibration, hands: TrackedHand[], time: number): KeyboardHandsHint {
  const seen = hands.flatMap((hand) => {
    const r = reach(cal, hand)
    return r ? [{ ...r, side: hand.side }] : []
  })
  const strip = (r: HandReach): HandReach => ({ low: r.low, high: r.high })
  if (seen.length === 0) return { time, left: null, right: null, split: null, confidence: 0 }
  if (seen.length === 1) {
    const only = seen[0]!
    const confidence = 0.5 * clamp01(only.score) * onKeys(only.off)
    return { time, left: only.side === 'left' ? strip(only) : null, right: only.side === 'right' ? strip(only) : null, split: null, confidence }
  }
  const sorted = [...seen].sort((a, b) => a.low + a.high - (b.low + b.high))
  const left = sorted[0]!
  const right = sorted[1]!
  const split = Math.round((left.high + right.low) / 2)
  // Hands on top of each other: the split means little.
  const apart = clamp01((right.low - left.high + 6) / 6)
  const confidence = Math.min(clamp01(left.score), clamp01(right.score)) * onKeys(Math.max(left.off, right.off)) * (0.4 + 0.6 * apart)
  return { time, left: strip(left), right: strip(right), split, confidence }
}

/**
 * Split notes between the hands using the hint nearest each note's onset.
 * Notes with no trustworthy hint within `maxGap` seconds fall back to a fixed
 * split (middle C by default).
 */
export function splitByHands(
  notes: NoteEvent[],
  hints: KeyboardHandsHint[],
  opts: { fallbackSplit?: number; maxGap?: number; minConfidence?: number } = {},
): { left: NoteEvent[]; right: NoteEvent[] } {
  const { fallbackSplit = 60, maxGap = 1.5, minConfidence = 0.3 } = opts
  const usable = hints.filter((h) => h.split !== null && h.confidence >= minConfidence)
  const left: NoteEvent[] = []
  const right: NoteEvent[] = []
  for (const note of notes) {
    let best: KeyboardHandsHint | null = null
    for (const hint of usable) {
      const gap = Math.abs(hint.time - note.start)
      if (gap <= maxGap && (!best || gap < Math.abs(best.time - note.start))) best = hint
    }
    const split = best?.split ?? fallbackSplit
    ;(note.pitch < split ? left : right).push(note)
  }
  return { left, right }
}
