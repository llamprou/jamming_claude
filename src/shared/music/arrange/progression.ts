/** A chord and how long it lasts. A progression is a list of these. */
export interface ChordSlot {
  symbol: string
  beats: number
}

export function toSlots(symbols: string[], beats: number | number[] = 4): ChordSlot[] {
  return symbols.map((symbol, i) => ({ symbol, beats: Array.isArray(beats) ? (beats[i] ?? beats[beats.length - 1] ?? 4) : beats }))
}

export const totalBeats = (slots: ChordSlot[]): number => slots.reduce((sum, s) => sum + s.beats, 0)

/** Join neighbours that are the same chord. */
export function mergeSlots(slots: ChordSlot[]): ChordSlot[] {
  const out: ChordSlot[] = []
  for (const slot of slots) {
    if (slot.beats <= 0) continue
    const last = out[out.length - 1]
    if (last && last.symbol === slot.symbol) last.beats += slot.beats
    else out.push({ ...slot })
  }
  return out
}

export function repeatSlots(slots: ChordSlot[], times: number): ChordSlot[] {
  return Array.from({ length: Math.max(1, Math.round(times)) }, () => slots.map((s) => ({ ...s }))).flat()
}

/** "Dm7(4) G7(2) Db7(2) Cmaj7(8)": written for a model to read back. */
export const progressionText = (slots: ChordSlot[]): string => slots.map((s) => `${s.symbol}(${+s.beats.toFixed(2)})`).join(' ')

/**
 * One chord within one bar. Part generators work a segment at a time, so a
 * chord held for three bars gets three, and two chords in a bar get one each.
 */
export interface Segment {
  symbol: string
  /** Beats from the start of the progression. */
  start: number
  beats: number
  /** Index into the merged slots. */
  slot: number
  bar: number
  /** Beats into its bar that the segment starts. */
  offset: number
  /** First / last segment of its chord. */
  first: boolean
  last: boolean
  /** The chord that follows this one (wrapping to the top, since arrangements loop). */
  next: string
  nextSlot: number
}

export function segments(slots: ChordSlot[], beatsPerBar = 4): { segments: Segment[]; slots: ChordSlot[] } {
  const merged = mergeSlots(slots)
  const out: Segment[] = []
  const tidy = (n: number) => Math.round(n * 1e6) / 1e6
  let at = 0
  merged.forEach((slot, i) => {
    let remaining = slot.beats
    let first = true
    const nextSlot = (i + 1) % merged.length
    while (remaining > 1e-6) {
      const offset = tidy(at % beatsPerBar)
      const beats = Math.min(remaining, tidy(beatsPerBar - offset))
      remaining = tidy(remaining - beats)
      out.push({
        symbol: slot.symbol,
        start: at,
        beats,
        slot: i,
        bar: Math.floor(tidy(at / beatsPerBar)),
        offset,
        first,
        last: remaining <= 1e-6,
        next: merged[nextSlot]!.symbol,
        nextSlot,
      })
      at = tidy(at + beats)
      first = false
    }
  })
  return { segments: out, slots: merged }
}

/** Swing feel: an eighth on the "and" moves back to the last triplet of the beat. Everything else stays put. */
export function swingBeat(at: number): number {
  const beat = Math.floor(at + 1e-6)
  return Math.abs(at - beat - 0.5) < 1e-6 ? beat + 2 / 3 : at
}
