/**
 * Hand landmarks as the tracker reports them, and the small geometry helpers
 * everything else in this folder builds on. Pure: no DOM, no model.
 *
 * Coordinates are normalised to the camera picture as the camera took it (not
 * mirrored): x runs 0-1 left to right, y runs 0-1 top to bottom. Because x and
 * y are scaled differently, distances are always measured after `square()`,
 * which stretches x by the picture's aspect ratio.
 */

export interface Point {
  x: number
  y: number
}

export interface Landmark extends Point {
  /** Depth relative to the wrist, roughly in x units; negative is nearer the camera. Noisy. */
  z: number
}

/** The player's own left or right hand. */
export type Side = 'left' | 'right'

export interface TrackedHand {
  side: Side
  /** 0-1, the tracker's confidence in the left/right call (a fair proxy for how well the hand is seen). */
  score: number
  /** 21 points in MediaPipe order; see LM. */
  landmarks: Landmark[]
}

/** Everything the tracker saw in one camera frame. */
export interface HandFrame {
  /** Seconds on the session clock. */
  time: number
  /** Picture width / height. */
  aspect: number
  hands: TrackedHand[]
}

/** MediaPipe hand landmark indices. */
export const LM = {
  wrist: 0,
  thumbTip: 4,
  indexMcp: 5,
  indexTip: 8,
  middleMcp: 9,
  middleTip: 12,
  ringMcp: 13,
  ringTip: 16,
  pinkyMcp: 17,
  pinkyTip: 20,
} as const

/** Index to little finger. The thumb is left out: on a neck it sits behind, on keys it wanders. */
export const FINGERTIPS = [LM.indexTip, LM.middleTip, LM.ringTip, LM.pinkyTip] as const

/** Bones to draw between landmarks. */
export const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** Into a space where one unit is the picture's height in both directions. */
export const square = (p: Point, aspect: number): Point => ({ x: p.x * aspect, y: p.y })

export const distance = (a: Point, b: Point, aspect: number): number => Math.hypot((a.x - b.x) * aspect, a.y - b.y)

export function mean(points: Point[]): Point {
  const n = Math.max(1, points.length)
  return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n }
}

export const landmark = (hand: TrackedHand, index: number): Landmark => hand.landmarks[index] ?? { x: 0, y: 0, z: 0 }

/** Wrist to middle knuckle: a length that does not change as fingers curl. */
export const handSize = (hand: TrackedHand, aspect: number): number => distance(landmark(hand, LM.wrist), landmark(hand, LM.middleMcp), aspect)

export const fingertips = (hand: TrackedHand): Point[] => FINGERTIPS.map((i) => landmark(hand, i))

/**
 * Where a point falls along the line from `a` to `b`: `along` is 0 at a and 1
 * at b; `off` is its distance from the line in the same units (|ab| = 1).
 */
export function project(p: Point, a: Point, b: Point, aspect: number): { along: number; off: number } {
  const A = square(a, aspect)
  const B = square(b, aspect)
  const P = square(p, aspect)
  const dx = B.x - A.x
  const dy = B.y - A.y
  const length2 = dx * dx + dy * dy
  if (length2 === 0) return { along: 0, off: Infinity }
  const along = ((P.x - A.x) * dx + (P.y - A.y) * dy) / length2
  const off = Math.abs((P.x - A.x) * dy - (P.y - A.y) * dx) / length2
  return { along, off }
}

/** The point at `along` on the line a-b (the inverse of `project` for points on the line). */
export const lerp = (a: Point, b: Point, along: number): Point => ({ x: a.x + (b.x - a.x) * along, y: a.y + (b.y - a.y) * along })

export function median(values: number[]): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((x, y) => x - y)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
