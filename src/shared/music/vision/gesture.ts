import { distance, handSize, landmark, LM, type HandFrame, type Side, type TrackedHand } from './landmarks'

/**
 * Cheap gestures: is a hand there, is it moving, is it held up. Enough to
 * tell "playing" from "stopped and waiting", and to notice a raised hand.
 */

export type HandMotion = 'absent' | 'still' | 'moving'

export interface HandActivity {
  motion: HandMotion
  /** Mean landmark speed in hand sizes per second (0 when absent). */
  speed: number
  /** Open hand held up, fingers above the wrist. */
  raised: boolean
}

const TRACKED: number[] = [LM.wrist, LM.indexTip, LM.middleTip, LM.ringTip, LM.pinkyTip, LM.thumbTip]

/** An open hand pointing up: every fingertip well above the wrist. */
export function isRaised(hand: TrackedHand, aspect: number): boolean {
  const size = handSize(hand, aspect)
  const wrist = landmark(hand, LM.wrist)
  return size > 0 && [LM.indexTip, LM.middleTip, LM.ringTip, LM.pinkyTip].every((i) => wrist.y - landmark(hand, i).y > size * 1.3)
}

/**
 * What one hand has been doing over a short run of frames (half a second to a
 * second is right). `stillBelow` is in hand sizes per second: tracker jitter
 * on a resting hand is about 0.1, playing is well above 0.5.
 */
export function handActivity(frames: HandFrame[], side: Side, stillBelow = 0.3): HandActivity {
  const seen = frames.flatMap((frame) => {
    const hand = frame.hands.find((h) => h.side === side)
    return hand ? [{ frame, hand }] : []
  })
  // Present means present in most of the window, not one stray detection.
  if (seen.length < 2 || seen.length < frames.length / 2) return { motion: 'absent', speed: 0, raised: false }
  let travelled = 0
  for (let i = 1; i < seen.length; i++) {
    const a = seen[i - 1]!
    const b = seen[i]!
    const size = handSize(b.hand, b.frame.aspect) || 1
    travelled += TRACKED.reduce((sum, lm) => sum + distance(landmark(a.hand, lm), landmark(b.hand, lm), b.frame.aspect), 0) / TRACKED.length / size
  }
  const seconds = seen[seen.length - 1]!.frame.time - seen[0]!.frame.time
  const speed = seconds > 0 ? travelled / seconds : 0
  const latest = seen[seen.length - 1]!
  return { motion: speed < stillBelow ? 'still' : 'moving', speed, raised: isRaised(latest.hand, latest.frame.aspect) }
}
