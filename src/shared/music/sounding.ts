/**
 * Which pitches are sounding at a moment: the arithmetic behind the animated
 * piano and fretboard views. Two sources:
 *
 * - `SoundingLog`: notes the transport has handed to WebAudio, stamped on the
 *   session clock, queried at "now" so the keys light as each note is heard.
 * - `stepPitches`: a fixed list of notes in beats, stepped through as a
 *   position in beats advances (looping), for `show` with timed notes.
 */

/** Notes shorter than this still light for this long, so fast notes are visible. */
export const MIN_LIT_SECONDS = 0.09

export interface SoundingNote {
  pitch: number
  /** Session seconds. */
  start: number
  end: number
  /** Transport layer id (a replaced layer keeps playing as "id~n"). */
  layer: string
  /** The clip track's role: chords, melody, bass, drums, solo. */
  role: string
}

/** The layer a (possibly retired, "id~n") layer id belongs to. */
export const baseLayer = (id: string): string => id.split('~')[0]!

/**
 * True if the note belongs to one of `parts`, matched against layer ids and
 * track roles. Empty or missing parts mean every pitched part.
 */
export function inParts(note: { layer: string; role: string }, parts?: string[]): boolean {
  if (!parts || parts.length === 0) return note.role !== 'drums'
  const wanted = new Set(parts.map((p) => p.toLowerCase()))
  return wanted.has(baseLayer(note.layer).toLowerCase()) || wanted.has(note.role.toLowerCase())
}

export class SoundingLog {
  private notes: SoundingNote[] = []

  add(note: SoundingNote): void {
    this.notes.push(note)
  }

  /** Pitches sounding at `time`, optionally only from some parts. Sorted, unique. */
  at(time: number, parts?: string[]): number[] {
    const pitches = new Set<number>()
    for (const n of this.notes) {
      if (n.start <= time && time < Math.max(n.end, n.start + MIN_LIT_SECONDS) && inParts(n, parts)) pitches.add(n.pitch)
    }
    return [...pitches].sort((a, b) => a - b)
  }

  /** True if any note (from these parts) sounds within `window` seconds either side of `time`: playback is under way, even in a rest. */
  activeAround(time: number, window: number, parts?: string[]): boolean {
    return this.notes.some((n) => n.start < time + window && Math.max(n.end, n.start + MIN_LIT_SECONDS) > time - window && inParts(n, parts))
  }

  /** Forget a layer's notes from `time` on (it was stopped). Without a layer, all of them. */
  cut(time: number, layer?: string): void {
    this.notes = this.notes.flatMap((n) => {
      if (layer !== undefined && n.layer !== layer) return [n]
      if (n.start >= time) return []
      return [{ ...n, end: Math.min(n.end, time) }]
    })
  }

  /** Drop notes that finished before `time`. */
  prune(time: number): void {
    this.notes = this.notes.filter((n) => Math.max(n.end, n.start + MIN_LIT_SECONDS) > time)
  }

  get size(): number {
    return this.notes.length
  }
}

export interface BeatNote {
  pitch: number
  startBeat: number
  durationBeats: number
}

/** Loop length for stepping: the notes' span rounded up to whole bars. */
export function stepLength(notes: BeatNote[], beatsPerBar = 4): number {
  const end = Math.max(0, ...notes.map((n) => n.startBeat + n.durationBeats))
  return Math.max(beatsPerBar, Math.ceil(end / beatsPerBar - 1e-9) * beatsPerBar)
}

/**
 * Pitches sounding at `beat` in a list of notes, wrapped into a loop of
 * `lengthBeats` (or not wrapped, if `loop` is false: past the end nothing sounds).
 */
export function stepPitches(notes: BeatNote[], beat: number, lengthBeats = stepLength(notes), loop = true): number[] {
  if (lengthBeats <= 0) return []
  if (!loop && (beat < 0 || beat >= lengthBeats)) return []
  const position = ((beat % lengthBeats) + lengthBeats) % lengthBeats
  const pitches = new Set<number>()
  for (const n of notes) {
    if (n.startBeat <= position + 1e-9 && position < n.startBeat + Math.max(n.durationBeats, 0.125)) pitches.add(n.pitch)
  }
  return [...pitches].sort((a, b) => a - b)
}

/**
 * What the player is sounding, from the live transcript: notes still held or
 * ended within `hold` seconds of `now`.
 */
export function heldPitches(notes: Array<{ pitch: number; start: number; duration: number }>, now: number, hold = 0.3): number[] {
  const pitches = new Set<number>()
  for (const n of notes) if (n.start <= now && (n.duration === 0 || n.start + n.duration >= now - hold)) pitches.add(n.pitch)
  return [...pitches].sort((a, b) => a - b)
}

/** A keyboard range (whole octaves from C) that covers the pitches, at least C2-C6. */
export function keyboardRange(pitches: number[], low = 36, high = 84): { low: number; high: number } {
  const lo = Math.min(low, ...pitches)
  const hi = Math.max(high, ...pitches)
  return { low: Math.max(0, lo - (lo % 12)), high: Math.min(127, hi + ((12 - (hi % 12)) % 12)) }
}

/** Chord symbols as timed notes, one chord per `beatsPerChord`, using a voicing function. */
export function chordsAsBeats(chords: string[], voice: (symbol: string) => number[], beatsPerChord = 4): BeatNote[] {
  return chords.flatMap((symbol, i) => voice(symbol).map((pitch) => ({ pitch, startBeat: i * beatsPerChord, durationBeats: beatsPerChord })))
}
