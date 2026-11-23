import { detectChords } from '../analysis'
import { chordPitches } from '../render'
import type { ChordSpan, Instrument, NoteEvent } from '../types'
import { findKey, parseKey, respellChord, type Key, type KeyResult } from './key'
import { analyseMeter, isTimeSignature, type MeterEstimate, type TimeSignatureName } from './meter'
import { buildScore, type Score, type StaffLayout } from './score'
import { openShapePitches, scoreToTab, TAB_TUNINGS, type Tablature } from './tab'

/**
 * What the player (through the agent) can ask of a written view. It travels to
 * the window in the `data.notation` field of a show-view event, and the same
 * options drive export, so the screen and the file agree.
 */
export interface NotationOptions {
  instrument?: Instrument
  /** e.g. "F# minor". Detected if absent. */
  key?: string
  /** Detected if absent. */
  timeSignature?: TimeSignatureName
  swing?: boolean
  /** Tab: capo fret. */
  capo?: number
  /** Tab: a preset name from TAB_TUNINGS or open-string MIDI pitches, lowest first. */
  tuning?: string | number[]
  /** Tab: fret the player's index finger is at, e.g. from video. */
  handFret?: number
  staff?: StaffLayout
  /** How many bars to show (the most recent). */
  bars?: number
  /** The notes sit on a known grid: seconds per quarter note, with a bar line at `origin`. */
  quarterSeconds?: number
  origin?: number
}

/** Read NotationOptions out of an untyped payload, dropping anything malformed. */
export function readNotationOptions(data: unknown): NotationOptions {
  const raw = (data as { notation?: Record<string, unknown> } | null | undefined)?.notation
  if (!raw || typeof raw !== 'object') return {}
  const out: NotationOptions = {}
  if (raw.instrument === 'piano' || raw.instrument === 'guitar' || raw.instrument === 'bass') out.instrument = raw.instrument
  if (typeof raw.key === 'string' && parseKey(raw.key)) out.key = raw.key
  if (typeof raw.timeSignature === 'string' && isTimeSignature(raw.timeSignature)) out.timeSignature = raw.timeSignature
  if (typeof raw.swing === 'boolean') out.swing = raw.swing
  if (typeof raw.capo === 'number') out.capo = raw.capo
  if (typeof raw.tuning === 'string' && raw.tuning in TAB_TUNINGS) out.tuning = raw.tuning
  if (Array.isArray(raw.tuning) && raw.tuning.every((p) => typeof p === 'number')) out.tuning = raw.tuning as number[]
  if (typeof raw.handFret === 'number') out.handFret = raw.handFret
  if (typeof raw.staff === 'string' && ['auto', 'grand', 'treble', 'bass', 'guitar', 'bass-guitar'].includes(raw.staff)) out.staff = raw.staff as StaffLayout
  if (typeof raw.bars === 'number' && raw.bars >= 1) out.bars = Math.round(raw.bars)
  if (typeof raw.quarterSeconds === 'number' && raw.quarterSeconds > 0) out.quarterSeconds = raw.quarterSeconds
  if (typeof raw.origin === 'number') out.origin = raw.origin
  return out
}

export interface Transcription {
  key: KeyResult | null
  /** Null when there were too few notes to tell and no signature was given; the score then assumes 4/4. */
  meter: MeterEstimate | null
  chords: ChordSpan[]
  score: Score
}

/**
 * Key, meter, chords and the written score for some notes, in one go.
 * `previousKey` keeps the key steady between successive calls on live input.
 */
export function transcribe(
  notes: NoteEvent[],
  opts: NotationOptions & { previousKey?: Key | null; chords?: ChordSpan[]; title?: string; meter?: MeterEstimate | null } = {},
): Transcription {
  const sounding = notes.filter((n) => n.duration > 0)
  // `meter` may be handed in (already analysed, or from a beat tracker); undefined means work it out here.
  const meter =
    opts.meter !== undefined ? opts.meter : analyseMeter(sounding, { timeSignature: opts.timeSignature, swing: opts.swing, quarterSeconds: opts.quarterSeconds, origin: opts.origin })
  const forced = opts.key ? parseKey(opts.key) : null
  const found = findKey(sounding, { previous: forced ?? opts.previousKey, stickiness: forced ? Infinity : undefined, meter: meter ?? undefined })
  const chords = opts.chords ?? detectChords(sounding)
  const score = buildScore(sounding, {
    key: found ?? forced ?? undefined,
    meter: meter ?? undefined,
    timeSignature: opts.timeSignature,
    swing: opts.swing,
    quarterSeconds: opts.quarterSeconds,
    origin: opts.origin,
    instrument: opts.instrument,
    staff: opts.staff,
    chords,
    // Chords someone named are written as named, every bar; detected ones are tidied for the key.
    chordsAsWritten: opts.chords !== undefined,
    maxBars: opts.bars,
    title: opts.title,
  })
  return { key: found, meter, chords, score }
}

/** Tablature for some notes with the same options. */
export function transcribeTab(
  notes: NoteEvent[],
  opts: NotationOptions & { previousKey?: Key | null; chords?: ChordSpan[]; meter?: MeterEstimate | null } = {},
): Transcription & { tab: Tablature } {
  const instrument = opts.instrument === 'bass' ? 'bass' : 'guitar'
  const result = transcribe(notes, { ...opts, instrument, staff: instrument === 'bass' ? 'bass-guitar' : 'guitar' })
  const tuning = typeof opts.tuning === 'string' ? TAB_TUNINGS[opts.tuning] : opts.tuning
  const tab = scoreToTab(result.score, { instrument, tuning, capo: opts.capo, hand: opts.handFret !== undefined ? { fret: opts.handFret } : undefined })
  return { ...result, tab }
}

/** Seconds in one bar of each signature with the quarter note at 120 (the grid agent-given music is written on). */
const BAR_SECONDS: Record<TimeSignatureName, number> = { '4/4': 2, '3/4': 1.5, '6/8': 1.5, '12/8': 3 }

/**
 * Chord spans for a list of symbols, one bar each from a bar line at zero, at
 * 120 to the quarter. Every symbol gets its bar, even one that cannot be voiced.
 */
export function chordSpansByBar(symbols: string[], timeSignature: TimeSignatureName = '4/4'): ChordSpan[] {
  const bar = BAR_SECONDS[timeSignature]
  return symbols.map((symbol, i) => ({ symbol, start: i * bar, end: (i + 1) * bar, pitchClasses: [...new Set(chordPitches(symbol, 4).map((p) => p % 12))] }))
}

/**
 * Notes and chord spans for a bare list of chord symbols: one bar each at 120
 * (4/4 unless another signature is given), so they can be written out. For
 * the guitar they are voiced as the usual open shapes where there is one;
 * otherwise close, around middle C.
 */
export function chordsAsNotes(
  symbols: string[],
  voicing: 'keyboard' | 'guitar' = 'keyboard',
  timeSignature: TimeSignatureName = '4/4',
): { notes: NoteEvent[]; chords: ChordSpan[]; options: NotationOptions } {
  const notes: NoteEvent[] = []
  const chords = chordSpansByBar(symbols, timeSignature)
  chords.forEach((span) => {
    const pitches = (voicing === 'guitar' ? openShapePitches(span.symbol) : null) ?? chordPitches(span.symbol, voicing === 'guitar' ? 3 : 4)
    for (const pitch of pitches) notes.push({ pitch, start: span.start, duration: span.end - span.start, velocity: 0.8, source: 'agent', confidence: 1 })
    if (pitches.length) span.pitchClasses = [...new Set(pitches.map((p) => p % 12))]
  })
  return { notes, chords, options: { quarterSeconds: 0.5, origin: 0, timeSignature, ...(voicing === 'keyboard' ? { staff: 'treble' as const } : {}) } }
}

/** What a written view or export works from when the agent supplied the music. */
export interface GivenMusic {
  notes: NoteEvent[]
  /** The given chord symbols as spans; written exactly as given. */
  chords?: ChordSpan[]
  options: NotationOptions
}

/**
 * Given notes (seconds at 120, bar line at zero), given chord symbols (one a
 * bar), or both: the notes then carry the symbols above them. Null when
 * neither is given, meaning the live playing is wanted.
 */
export function givenMusic(given: { notes?: NoteEvent[]; chords?: string[] }, options: NotationOptions, voicing: 'keyboard' | 'guitar' = 'keyboard'): GivenMusic | null {
  const timeSignature = options.timeSignature ?? '4/4'
  if (given.notes?.length) {
    return { notes: given.notes, chords: given.chords?.length ? chordSpansByBar(given.chords, timeSignature) : undefined, options: { quarterSeconds: 0.5, origin: 0, ...options } }
  }
  if (given.chords?.length) {
    const written = chordsAsNotes(given.chords, voicing, timeSignature)
    return { notes: written.notes, chords: written.chords, options: { ...written.options, ...options } }
  }
  return null
}

/** Bars a written view shows: live playing keeps the latest 8 unless asked; given music shows every bar unless asked. */
export const barsToShow = (live: boolean, asked?: number): number | undefined => asked ?? (live ? 8 : undefined)

/** Chord symbols respelled for a key, with repeats collapsed. */
export function chordNames(chords: Array<ChordSpan | string>, key: Key | null): string[] {
  const out: string[] = []
  for (const chord of chords) {
    const symbol = typeof chord === 'string' ? chord : chord.symbol
    const name = key ? respellChord(symbol, key) : symbol
    if (out[out.length - 1] !== name) out.push(name)
  }
  return out
}
