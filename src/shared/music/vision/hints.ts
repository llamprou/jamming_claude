import type { KeyboardHandsHint } from './keyboard'
import type { HandPositionHint } from './neck'

/**
 * Where vision's hints live so the rest of the music code can use them
 * without knowing about cameras. The camera feature fills these in the
 * window; the same hints are forwarded over the feature bus and filled in
 * again in the main process (see agent/tools/vision.ts), so a renderer of tab
 * or sheet can read them wherever it runs:
 *
 *   import { fretHints } from '@shared/music/vision/hints'
 *   const hint = fretHints.at(note.start)   // HandPositionHint | null
 *
 * Both stores are empty unless the camera is on and the instrument's
 * position in the picture has been marked.
 */
export class HintStore<T extends { time: number; confidence: number }> {
  private items: T[] = []

  constructor(private readonly capacity = 2400) {}

  /** Hints must arrive in time order (they do: one clock, one producer). */
  add(hint: T): void {
    this.items.push(hint)
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity)
  }

  /** The hint nearest `time`, if one lies within `tolerance` seconds and is at least `minConfidence`. */
  at(time: number, tolerance = 1.5, minConfidence = 0.3): T | null {
    let best: T | null = null
    for (const hint of this.items) {
      const gap = Math.abs(hint.time - time)
      if (gap <= tolerance && hint.confidence >= minConfidence && (!best || gap < Math.abs(best.time - time))) best = hint
    }
    return best
  }

  /** Every hint with from <= time < to. */
  between(from: number, to: number): T[] {
    return this.items.filter((h) => h.time >= from && h.time < to)
  }

  latest(): T | null {
    return this.items[this.items.length - 1] ?? null
  }

  clear(): void {
    this.items = []
  }
}

/** Fretting-hand position for guitar and bass. */
export const fretHints = new HintStore<HandPositionHint>()

/** Left/right hand reach and split point for piano. */
export const keyboardHints = new HintStore<KeyboardHandsHint>()

export type { HandPositionHint } from './neck'
export type { KeyboardHandsHint } from './keyboard'
