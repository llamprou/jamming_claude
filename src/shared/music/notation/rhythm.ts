import type { NoteEvent } from '../types'
import { beatPosition, meterToText, type MeterEstimate } from './meter'

/** The rhythm of a stretch of playing laid on its meter: what a rhythm display or a text readout needs. */
export interface RhythmGrid {
  meter: MeterEstimate
  /** Slots drawn per felt beat: 2 or 4 in straight simple time, 3 for swing and compound time, 6 for compound sixteenths. */
  slotsPerBeat: number
  /** Metric strength of each slot of a bar: 3 downbeat, 2 beat, 1 in between. */
  strengths: number[]
  /** How often each slot is played across all bars heard, 0-1. */
  pattern: number[]
  /** The most recent bars, oldest first: loudness 0-1 in each slot (0 = nothing played). */
  bars: number[][]
  /** How many bars the notes span. */
  barCount: number
}

export function rhythmGrid(notes: NoteEvent[], meter: MeterEstimate, opts: { bars?: number } = {}): RhythmGrid {
  const onsets = notes.map((n) => ({ beat: beatPosition(meter, n.start), velocity: n.velocity })).filter((o) => o.beat > -0.2)
  // The coarsest grid that nearly every onset sits on.
  const candidates = meter.compound ? [3, 6] : meter.swing ? [3] : [2, 4, 3]
  let slotsPerBeat = candidates[0]!
  let bestMiss = Infinity
  for (const g of candidates) {
    const miss = onsets.filter((o) => Math.abs(o.beat * g - Math.round(o.beat * g)) > 0.07 * g).length / Math.max(1, onsets.length)
    if (miss <= 0.1) {
      slotsPerBeat = g
      bestMiss = miss
      break
    }
    if (miss < bestMiss) {
      bestMiss = miss
      slotsPerBeat = g
    }
  }
  const perBar = slotsPerBeat * meter.beatsPerBar
  const strengths = Array.from({ length: perBar }, (_, i) => (i === 0 ? 3 : i % slotsPerBeat === 0 ? 2 : 1))
  const loud = new Map<number, number>()
  for (const o of onsets) {
    const slot = Math.max(0, Math.round(o.beat * slotsPerBeat))
    loud.set(slot, Math.max(loud.get(slot) ?? 0, Math.max(0.15, o.velocity)))
  }
  const lastSlot = Math.max(0, ...loud.keys())
  const barCount = Math.floor(lastSlot / perBar) + 1
  const all = Array.from({ length: barCount }, (_, b) => Array.from({ length: perBar }, (_, i) => loud.get(b * perBar + i) ?? 0))
  const pattern = Array.from({ length: perBar }, (_, i) => all.filter((bar) => bar[i]! > 0).length / barCount)
  return { meter, slotsPerBeat, strengths, pattern, bars: all.slice(-(opts.bars ?? 2)), barCount }
}

/** e.g. "3/4, quarter = 140, straight |x.x.x.|" with a space between beats. */
export function rhythmGridToText(grid: RhythmGrid): string {
  const marks = grid.pattern.map((p) => (p >= 0.5 ? 'x' : '.'))
  const beats: string[] = []
  for (let i = 0; i < marks.length; i += grid.slotsPerBeat) beats.push(marks.slice(i, i + grid.slotsPerBeat).join(''))
  return `${meterToText(grid.meter)}  |${beats.join(' ')}|`
}
