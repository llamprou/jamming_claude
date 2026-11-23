import type { ChordSpan } from '../types'
import { mergeSlots, totalBeats, type ChordSlot } from './progression'
import { normalizeSymbol } from './theory'

/**
 * If the player went round the same changes more than once, keep one pass.
 * Live timing is loose, so lengths may differ by a beat between passes.
 */
export function foldRepeats(slots: ChordSlot[]): ChordSlot[] {
  const n = slots.length
  for (let period = 1; period <= Math.floor(n / 2); period++) {
    const repeats = slots.every((slot, i) => {
      if (i < period) return true
      const first = slots[i - period]!
      return slot.symbol === first.symbol && (i === n - 1 || Math.abs(slot.beats - first.beats) <= 1)
    })
    if (repeats) return slots.slice(0, period).map((s) => ({ ...s }))
  }
  return slots.map((s) => ({ ...s }))
}

/**
 * Turn the chords heard in the player's recent playing (timed in seconds) into
 * a loopable progression in whole beats that ends on a bar line.
 */
export function progressionFromSpans(
  spans: ChordSpan[],
  bpm: number,
  options: { beatsPerBar?: number; maxChords?: number } = {},
): ChordSlot[] {
  const { beatsPerBar = 4, maxChords = 16 } = options
  const beat = 60 / bpm
  const heard = spans.flatMap((span) => {
    const symbol = normalizeSymbol(span.symbol)
    // Anything shorter than half a beat is a passing smear between two real chords.
    return symbol && span.end - span.start >= beat / 2 ? [{ symbol, start: span.start, end: span.end }] : []
  })
  if (heard.length === 0) return []
  const origin = heard[0]!.start
  const starts = heard.map((h) => Math.round((h.start - origin) / beat))
  const slots = heard.map((h, i) => ({
    symbol: h.symbol,
    beats: i < heard.length - 1 ? starts[i + 1]! - starts[i]! : Math.max(1, Math.round((h.end - h.start) / beat)),
  }))
  const folded = foldRepeats(mergeSlots(slots)).slice(0, maxChords)
  const last = folded[folded.length - 1]
  const over = totalBeats(folded) % beatsPerBar
  if (last && over > 0) last.beats += beatsPerBar - over
  return folded
}
