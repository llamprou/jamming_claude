import { detectChords } from '../analysis'
import type { ChordSpan, Instrument, NoteEvent } from '../types'
import { findKey, makeKey, respellChord, signatureAlter, spellNotes, type Key, type SpelledPitch } from './key'
import { analyseMeter, barLength, beatPosition, fixedMeter, type MeterEstimate, type TimeSignatureName } from './meter'
import { frac, toNumber, type Fraction } from './rational'

/**
 * The written form of a stretch of playing: bars of events with exact
 * durations, ties and rests. Sheet music (ABC, MusicXML) and tablature are all
 * drawn from this, so they always agree about rhythm.
 */

export interface ScorePitch extends SpelledPitch {
  /** Set when an accidental sign must be drawn: the alteration to show (0 is a natural). */
  accidental?: number
}

export interface ScoreEvent {
  /** Offset from the start of the bar, in whole notes. */
  start: Fraction
  /** Sounding length in whole notes (a triplet eighth is 1/12). */
  duration: Fraction
  /** Written note value including dots (a triplet eighth is written 1/8). */
  value: Fraction
  dots: number
  /** Sounding pitches, lowest first. Empty for a rest. */
  pitches: ScorePitch[]
  /** Tied to the next event of the voice. */
  tie: boolean
  /** Continues the previous event (the end of a tie). */
  tied: boolean
  /** Member of a tuplet: `size` events starting at the one with role "start". */
  tuplet?: { actual: number; normal: number; role: 'start' | 'inner' | 'stop'; size: number }
  beam?: 'begin' | 'continue' | 'end'
  /** A rest that fills the whole bar. */
  fullBar?: boolean
}

export interface ScoreStaff {
  clef: 'treble' | 'bass' | 'treble-8'
  /** Octaves the written notes sit above the sounding ones (guitar and bass guitar: 1). */
  octaveShift: number
}

export interface ScoreBar {
  /** 1-based bar number within the analysed stretch. */
  number: number
  /** One voice per staff, same order as `Score.staves`. */
  voices: ScoreEvent[][]
  chords: Array<{ at: Fraction; symbol: string }>
}

export interface Score {
  title?: string
  key: Key
  meter: MeterEstimate
  /** Length of a bar in whole notes. */
  barLength: Fraction
  staves: ScoreStaff[]
  bars: ScoreBar[]
}

export type StaffLayout = 'auto' | 'grand' | 'treble' | 'bass' | 'guitar' | 'bass-guitar'

export interface ScoreOptions {
  key?: Key
  /** A meter from elsewhere (given by the player, or a beat tracker). */
  meter?: MeterEstimate
  /** Hints passed to meter analysis when `meter` is absent. */
  timeSignature?: TimeSignatureName
  swing?: boolean
  quarterSeconds?: number
  origin?: number
  /** Chooses the staff layout unless `staff` says otherwise. */
  instrument?: Instrument
  staff?: StaffLayout
  /** Chord spans to write above the staff. Detected from the notes if absent; false for none. */
  chords?: ChordSpan[] | false
  /**
   * Write the chord symbols exactly as given, one on every span (repeats
   * included), and extend the score to the last span even where nothing sounds.
   * Otherwise they are respelled for the key and repeats are collapsed.
   */
  chordsAsWritten?: boolean
  /** Keep only the last so many bars. */
  maxBars?: number
  title?: string
}

/** Positions are whole-number ticks internally: 48 to a whole note, so sixteenths (3) and triplet eighths (4) are exact. */
const TICKS = 48
const ticksOf = (f: Fraction): number => Math.round((f.n * TICKS) / f.d)

interface Segment {
  start: number
  end: number
  /** Indices into the original notes; null for a rest. */
  notes: number[] | null
}

// Metric levels in sixteenths, strongest first.
const LEVELS: Record<TimeSignatureName, number[]> = {
  '4/4': [16, 8, 4, 2, 1],
  '3/4': [12, 4, 2, 1],
  '6/8': [12, 6, 2, 1],
  '12/8': [24, 12, 6, 2, 1],
}
const NOTATABLE = new Set([1, 2, 3, 4, 6, 8, 12, 16, 24])

/**
 * Split a span inside one bar (in sixteenths) into values that can be written
 * as single notes or rests without hiding the beat. A note may cross one
 * boundary a single level stronger than where it starts and ends when that
 * level divides in two (quarter-half-quarter, eighth-quarter-eighth), but not
 * in compound time and never anything stronger. Rests never hide a boundary.
 */
export function splitMetric(start: number, end: number, rest: boolean, signature: TimeSignatureName): Array<[number, number]> {
  const units = LEVELS[signature]
  const compound = signature === '6/8' || signature === '12/8'
  const level = (x: number): number => {
    for (let i = 0; i < units.length; i++) if (x % units[i]! === 0) return i
    return units.length - 1
  }
  const go = (s: number, e: number): Array<[number, number]> => {
    const length = e - s
    let strongest = Infinity
    let inside: number[] = []
    for (let x = s + 1; x < e; x++) {
      const l = level(x)
      if (l < strongest) {
        strongest = l
        inside = [x]
      } else if (l === strongest) inside.push(x)
    }
    if (inside.length === 0) return [[s, e]]
    const own = Math.max(level(s), level(e))
    let single = NOTATABLE.has(length)
    if (single && rest) {
      const dotted = length === 3 || length === 6 || length === 12 || length === 24
      if (dotted && !(compound && length >= 6)) single = false
      if (strongest <= own) single = false
    } else if (single) {
      single = strongest >= own || (strongest === own - 1 && inside.length === 1 && units[own - 1]! / units[own]! === 2)
    }
    if (single) return [[s, e]]
    const cut = level(s) <= level(e) ? inside[inside.length - 1]! : inside[0]!
    return [...go(s, cut), ...go(cut, e)]
  }
  return go(start, end)
}

interface Onset {
  /** Position in felt beats. */
  beat: number
  endBeat: number
  notes: number[]
}

/** Turn one voice's notes into non-overlapping segments on the written grid. */
function quantiseVoice(notes: NoteEvent[], indices: number[], meter: MeterEstimate): { segments: Segment[]; tuplets: Set<number> } {
  const beatTicks = ticksOf(meter.beatUnit)
  const sorted = [...indices].sort((a, b) => notes[a]!.start - notes[b]!.start)
  const onsets: Onset[] = []
  let groupStart = -Infinity
  for (const i of sorted) {
    const n = notes[i]!
    const endBeat = beatPosition(meter, n.start + n.duration)
    const last = onsets[onsets.length - 1]
    if (last && n.start - groupStart < 0.035) {
      last.notes.push(i)
      last.endBeat = Math.max(last.endBeat, endBeat)
    } else {
      groupStart = n.start
      onsets.push({ beat: beatPosition(meter, n.start), endBeat, notes: [i] })
    }
  }

  // Pick the simplest subdivision of each beat that fits the onsets in it.
  const byBeat = new Map<number, number[]>()
  const beatOf = (o: Onset): number => Math.max(0, Math.floor(o.beat + 0.125))
  onsets.forEach((o, i) => byBeat.set(beatOf(o), [...(byBeat.get(beatOf(o)) ?? []), i]))
  const options: Array<[number, number]> = meter.compound
    ? [[1, 0], [3, 0.25], [6, 0.9]]
    : meter.swing
      ? [[1, 0], [3, 0.25], [2, 1.2], [4, 1.6]]
      : [[1, 0], [2, 0.25], [4, 0.9], [3, 1.1]]
  const tolerance = meter.compound ? 0.03 : 0.045
  const choose = (bias: (g: number) => number): Map<number, number> => {
    const grids = new Map<number, number>()
    for (const [beat, members] of byBeat) {
      let best = 1
      let bestCost = Infinity
      for (const [g, penalty] of options) {
        let cost = penalty + bias(g)
        const taken = new Set<number>()
        for (const m of members) {
          const f = onsets[m]!.beat - beat
          const slot = Math.max(0, Math.min(g, Math.round(f * g)))
          cost += ((f - slot / g) / tolerance) ** 2 + (taken.has(slot) ? 2 : 0)
          taken.add(slot)
        }
        if (cost < bestCost) {
          bestCost = cost
          best = g
        }
      }
      grids.set(beat, best)
    }
    return grids
  }
  let grids = choose(() => 0)
  if (!meter.compound && !meter.swing) {
    // A piece is mostly in twos or mostly in threes; lean on the majority so jitter does not mix them.
    const threes = [...grids.values()].filter((g) => g === 3).length
    const twos = [...grids.values()].filter((g) => g === 2 || g === 4).length
    if (threes > 2 * twos) grids = choose((g) => (g === 3 ? -0.5 : g === 4 ? 0.5 : 0))
    else if (twos > 2 * threes) grids = choose((g) => (g === 3 ? 0.6 : 0))
  }

  const slotOf = (o: Onset, beat: number, g: number): number => Math.max(0, Math.min(g, Math.round((o.beat - beat) * g)))
  // In swing, a beat split long-short is written as two plain eighths.
  const swung = new Set<number>()
  const tuplets = new Set<number>()
  for (const [beat, g] of grids) {
    if (g !== 3 || meter.compound) continue
    const middle = byBeat.get(beat)!.some((m) => slotOf(onsets[m]!, beat, 3) === 1)
    if (meter.swing && !middle) swung.add(beat)
    else tuplets.add(beat)
  }
  const written = (beat: number, g: number, slot: number): number => {
    if (swung.has(beat)) return beat * beatTicks + [0, beatTicks / 4, beatTicks / 2, beatTicks][slot]!
    return beat * beatTicks + (slot * beatTicks) / g
  }
  const defaultGrid = meter.compound ? 3 : 2

  const placed = onsets.map((o) => {
    const beat = beatOf(o)
    const g = grids.get(beat)!
    const start = written(beat, g, slotOf(o, beat, g))
    // Where the note is let go, on the grid of the beat it ends in.
    const endBeat = Math.max(0, Math.floor(o.endBeat))
    let eg = grids.get(endBeat) ?? defaultGrid
    let end: number
    if (meter.swing && !grids.has(endBeat)) {
      const f = o.endBeat - endBeat
      end = endBeat * beatTicks + (f < 1 / 3 ? 0 : f < 5 / 6 ? beatTicks / 2 : beatTicks)
    } else {
      if (swung.has(endBeat)) eg = 3
      let slot = Math.max(0, Math.min(eg, Math.round((o.endBeat - endBeat) * eg)))
      if (swung.has(endBeat) && slot === 1) slot = 0
      end = written(endBeat, eg, slot)
    }
    const unit = swung.has(beat) ? beatTicks / 2 : beatTicks / g
    return { o, start, end, unit }
  })

  // Same written position: one chord.
  const merged: typeof placed = []
  for (const p of placed.sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1]
    if (last && last.start === p.start) {
      last.o = { beat: last.o.beat, endBeat: Math.max(last.o.endBeat, p.o.endBeat), notes: [...last.o.notes, ...p.o.notes] }
      last.end = Math.max(last.end, p.end)
    } else merged.push({ ...p })
  }

  const segments: Segment[] = []
  merged.forEach((p, i) => {
    const next = merged[i + 1]
    let end = Math.max(p.end, p.start + p.unit)
    if (next) {
      const ioi = next.o.beat - p.o.beat
      const gap = next.o.beat - p.o.endBeat
      // Notes that nearly reach the next one are written full length; so is anything shorter than a beat.
      if (ioi <= 1.05 || gap <= Math.max(0.3, 0.35 * ioi)) end = next.start
      end = Math.min(end, next.start)
    }
    if (end > p.start) segments.push({ start: p.start, end, notes: p.o.notes })
  })
  return { segments, tuplets }
}

interface Piece {
  start: number
  end: number
  written: number
  notes: number[] | null
  tie: boolean
  tied: boolean
  tuplet: boolean
  beat: number
  fullBar?: boolean
}

/** Cut a voice's segments into bars of writable notes and rests. */
function engrave(segments: Segment[], tuplets: Set<number>, meter: MeterEstimate, bars: number): Piece[][] {
  const beatTicks = ticksOf(meter.beatUnit)
  const barTicks = ticksOf(barLength(meter))
  // Fill the gaps with rests.
  const timeline: Segment[] = []
  let cursor = 0
  for (const s of segments) {
    if (s.start > cursor) timeline.push({ start: cursor, end: s.start, notes: null })
    timeline.push(s)
    cursor = s.end
  }
  if (cursor < bars * barTicks) timeline.push({ start: cursor, end: bars * barTicks, notes: null })

  const out: Piece[][] = Array.from({ length: bars }, () => [])
  for (const segment of timeline) {
    const pieces: Piece[] = []
    const push = (start: number, end: number, written: number, tuplet: boolean) =>
      pieces.push({ start, end, written, notes: segment.notes, tie: false, tied: false, tuplet, beat: Math.floor(start / beatTicks) })
    let at = segment.start
    while (at < segment.end) {
      const bar = Math.floor(at / barTicks)
      const barStart = bar * barTicks
      const beat = Math.floor(at / beatTicks)
      if (tuplets.has(beat)) {
        // Inside a triplet beat: thirds of the beat, written as eighths and quarters under a 3.
        const stop = Math.min(segment.end, (beat + 1) * beatTicks)
        if (stop - at === beatTicks) push(at, stop, beatTicks, false)
        else push(at, stop, ((stop - at) * 3) / 2, true)
        at = stop
        continue
      }
      // A plain run: up to the bar line or the next triplet beat.
      let stop = Math.min(segment.end, barStart + barTicks)
      for (let b = beat + 1; b * beatTicks < stop; b++) {
        if (tuplets.has(b)) {
          stop = b * beatTicks
          break
        }
      }
      if (segment.notes === null && at === barStart && stop === barStart + barTicks) {
        pieces.push({ start: at, end: stop, written: barTicks, notes: null, tie: false, tied: false, tuplet: false, beat, fullBar: true })
      } else {
        for (const [s, e] of splitMetric((at - barStart) / 3, (stop - barStart) / 3, segment.notes === null, meter.timeSignature)) {
          push(barStart + s * 3, barStart + e * 3, (e - s) * 3, false)
        }
      }
      at = stop
    }
    if (segment.notes) {
      pieces.forEach((p, i) => {
        p.tie = i < pieces.length - 1
        p.tied = i > 0
      })
    }
    for (const p of pieces) out[Math.floor(p.start / barTicks)]?.push(p)
  }
  return out
}

function chooseStaves(notes: NoteEvent[], opts: ScoreOptions): { staves: ScoreStaff[]; staffOf: number[] } {
  const pitches = notes.map((n) => n.pitch)
  const low = Math.min(...pitches)
  const high = Math.max(...pitches)
  let layout = opts.staff ?? 'auto'
  if (layout === 'auto') {
    if (opts.instrument === 'guitar') layout = 'guitar'
    else if (opts.instrument === 'bass') layout = 'bass-guitar'
    else if (notes.length && low < 55 && high > 65 && high - low >= 19) layout = 'grand'
    else {
      const median = [...pitches].sort((a, b) => a - b)[Math.floor(pitches.length / 2)] ?? 60
      layout = median >= 55 ? 'treble' : 'bass'
    }
  }
  if (layout !== 'grand') {
    const staff: ScoreStaff =
      layout === 'guitar' ? { clef: 'treble-8', octaveShift: 1 } : layout === 'bass-guitar' ? { clef: 'bass', octaveShift: 1 } : { clef: layout, octaveShift: 0 }
    return { staves: [staff], staffOf: notes.map(() => 0) }
  }
  // Two hands: split at middle C, but keep a close chord that straddles it together.
  const staffOf = notes.map((n) => (n.pitch >= 60 ? 0 : 1))
  const order = notes.map((_, i) => i).sort((a, b) => notes[a]!.start - notes[b]!.start)
  for (let i = 0; i < order.length; ) {
    let j = i
    while (j < order.length && notes[order[j]!]!.start - notes[order[i]!]!.start < 0.035) j++
    const group = order.slice(i, j)
    const groupPitches = group.map((g) => notes[g]!.pitch)
    if (group.length > 1 && Math.max(...groupPitches) - Math.min(...groupPitches) <= 12) {
      const upper = groupPitches.filter((p) => p >= 60).length
      if (upper > 0 && upper < group.length) {
        const mean = groupPitches.reduce((s, p) => s + p, 0) / group.length
        for (const g of group) staffOf[g] = mean >= 60 ? 0 : 1
      }
    }
    i = j
  }
  return {
    staves: [
      { clef: 'treble', octaveShift: 0 },
      { clef: 'bass', octaveShift: 0 },
    ],
    staffOf,
  }
}

const VALUES: Record<number, [number, number]> = {
  // ticks -> [undotted value in ticks, dots]
  3: [3, 0], 6: [6, 0], 9: [6, 1], 12: [12, 0], 18: [12, 1], 24: [24, 0], 36: [24, 1], 48: [48, 0], 72: [48, 1],
}

/** Build the written score for some notes. Never fails: with too little to go on it assumes 4/4 at 120 in C. */
export function buildScore(notes: NoteEvent[], opts: ScoreOptions = {}): Score {
  const sounding = notes.filter((n) => n.duration > 0)
  const first = sounding.length ? Math.min(...sounding.map((n) => n.start)) : 0
  const last = sounding.length ? Math.max(...sounding.map((n) => n.start + n.duration)) : 0
  const meter =
    opts.meter ??
    analyseMeter(sounding, { timeSignature: opts.timeSignature, swing: opts.swing, quarterSeconds: opts.quarterSeconds, origin: opts.origin }) ??
    fixedMeter(
      opts.timeSignature ?? '4/4',
      opts.quarterSeconds ? (opts.timeSignature === '6/8' || opts.timeSignature === '12/8' ? 40 : 60) / opts.quarterSeconds : 120,
      opts.origin ?? first,
      last,
      opts.swing ?? false,
    )
  const key = opts.key ?? findKey(sounding, { meter }) ?? makeKey(0, 'major')
  const barTicks = ticksOf(barLength(meter))
  const beatTicks = ticksOf(meter.beatUnit)
  const { staves, staffOf } = chooseStaves(sounding, opts)
  const spans = opts.chords === false ? [] : (opts.chords ?? detectChords(sounding))
  const spelling = spellNotes(sounding, key, spans)

  const voices = staves.map((_, staff) => quantiseVoice(sounding, sounding.map((_, i) => i).filter((i) => staffOf[i] === staff), meter))
  const written = opts.chordsAsWritten === true
  const chordEnd = written ? Math.max(0, ...spans.map((s) => Math.round(beatPosition(meter, s.end) * beatTicks))) : 0
  const end = Math.max(0, chordEnd, ...voices.flatMap((v) => v.segments.map((s) => s.end)))
  const barCount = Math.max(1, Math.ceil(end / barTicks))
  const engraved = voices.map((v) => engrave(v.segments, v.tuplets, meter, barCount))

  const bars: ScoreBar[] = []
  for (let b = 0; b < barCount; b++) {
    const barVoices = engraved.map((voice) => {
      const pieces = voice[b]!
      const signs = new Map<string, number>()
      const events = pieces.map((p): ScoreEvent => {
        const [base, dots] = VALUES[p.written] ?? [p.written, 0]
        const pitches = (p.notes ?? [])
          .map((i) => spelling[i]!)
          .sort((x, y) => x.midi - y.midi)
          .filter((pitch, i, all) => i === 0 || all[i - 1]!.midi !== pitch.midi)
          .map((pitch): ScorePitch => {
            // An accidental is drawn when the note differs from what the bar so far implies.
            // The end of a tie over a bar line repeats nothing.
            const id = `${pitch.step}${pitch.octave}`
            const implied = signs.get(id) ?? signatureAlter(pitch.step, key.fifths)
            const carried = p.tied && p.start === b * barTicks
            if (!carried) signs.set(id, pitch.alter)
            return !carried && implied !== pitch.alter ? { ...pitch, accidental: pitch.alter } : { ...pitch }
          })
        return {
          start: frac(p.start - b * barTicks, TICKS),
          duration: frac(p.end - p.start, TICKS),
          value: frac(dots ? (base * 3) / 2 : base, TICKS),
          dots,
          pitches,
          tie: p.tie,
          tied: p.tied,
          ...(p.fullBar ? { fullBar: true } : {}),
        }
      })
      // Tuplet brackets: the run of triplet pieces inside one beat.
      for (let i = 0; i < pieces.length; ) {
        if (!pieces[i]!.tuplet) {
          i++
          continue
        }
        let j = i
        while (j < pieces.length && pieces[j]!.tuplet && pieces[j]!.beat === pieces[i]!.beat) j++
        for (let k = i; k < j; k++) events[k]!.tuplet = { actual: 3, normal: 2, role: k === i ? 'start' : k === j - 1 ? 'stop' : 'inner', size: j - i }
        i = j
      }
      // Beams: runs of eighths or shorter inside one felt beat.
      for (let i = 0; i < pieces.length; ) {
        const beamable = (k: number): boolean => k < pieces.length && pieces[k]!.notes !== null && pieces[k]!.written < TICKS / 4
        if (!beamable(i)) {
          i++
          continue
        }
        let j = i
        while (beamable(j) && Math.floor(pieces[j]!.start / beatTicks) === Math.floor(pieces[i]!.start / beatTicks)) j++
        if (j - i >= 2) for (let k = i; k < j; k++) events[k]!.beam = k === i ? 'begin' : k === j - 1 ? 'end' : 'continue'
        i = j
      }
      return events
    })
    bars.push({ number: b + 1, voices: barVoices, chords: [] })
  }

  // Chord symbols, respelled for the key, on the nearest beat (half beat in simple time).
  const step = meter.compound ? beatTicks : beatTicks / 2
  let previous = ''
  let previousBar = -1
  const rootOf = (symbol: string): string => /^[A-G][#b]?/.exec(symbol)?.[0] ?? symbol
  for (const span of spans) {
    if (beatPosition(meter, span.end) - beatPosition(meter, span.start) < 0.5) continue
    const at = Math.max(0, Math.round((beatPosition(meter, span.start) * beatTicks) / step) * step)
    const symbol = written ? span.symbol : respellChord(span.symbol, key)
    const barIndex = Math.floor(at / barTicks)
    const bar = bars[barIndex]
    if (!bar) continue
    // A melody note over a held chord renames it (C, then Cadd9); within a bar the first name of a root stands.
    if (!written && (symbol === previous || (barIndex === previousBar && rootOf(symbol) === rootOf(previous)))) continue
    previous = symbol
    previousBar = barIndex
    const offset = frac(at % barTicks, TICKS)
    const same = bar.chords.find((c) => toNumber(c.at) === toNumber(offset))
    if (same) same.symbol = symbol
    else bar.chords.push({ at: offset, symbol })
  }

  let kept = bars
  if (opts.maxBars && bars.length > opts.maxBars) {
    kept = bars.slice(-opts.maxBars)
    for (const voice of kept[0]!.voices) if (voice[0]) voice[0].tied = false
  }
  return { title: opts.title, key, meter, barLength: barLength(meter), staves, bars: kept }
}

/** Sum of the sounding lengths in one voice of a bar; equals `barLength` for a well-formed score. */
export function voiceLength(events: ScoreEvent[]): Fraction {
  return frac(
    events.reduce((sum, e) => sum + ticksOf(e.duration), 0),
    TICKS,
  )
}
