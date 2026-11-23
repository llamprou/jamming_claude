import { Chord } from 'tonal'
import type { ChordSpan, NoteEvent } from '../types'

/**
 * Key finding and pitch spelling.
 *
 * `findKey` correlates a weighted pitch-class histogram with three published
 * profile sets and adds a few tonal cues that separate a key from its relative.
 * `spellPitch` names a MIDI pitch for a key on the line of fifths, so F sharp
 * and G flat come out right, and uses harmony and melodic direction for
 * chromatic notes.
 */

export type Mode = 'major' | 'minor'

export interface Key {
  /** 0-11. */
  tonicPc: number
  mode: Mode
  /** Spelled tonic, e.g. "F#", "Bb". */
  tonic: string
  /** Key signature: sharps (positive) or flats (negative). */
  fifths: number
  /** e.g. "F# minor". */
  name: string
}

export interface KeyResult extends Key {
  /** Mean profile correlation plus cues; roughly -1..1. */
  score: number
  /** 0-1: how clearly this key beats the others. */
  confidence: number
  /** The relative major or minor, which shares the key signature. */
  relative: Key
  /** The next best candidates, best first. */
  alternatives: Array<Key & { score: number }>
}

export interface SpelledPitch {
  midi: number
  /** Letter A-G. */
  step: string
  /** -2..2 semitones from the letter. */
  alter: number
  /** Scientific octave of the spelled note (B#3 is MIDI 60). */
  octave: number
  /** e.g. "F#4". */
  name: string
}

const mod = (n: number, m: number): number => ((n % m) + m) % m

// Signature (in fifths) for each tonic pitch class.
const MAJOR_FIFTHS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5]
const MINOR_FIFTHS = [-3, 4, -1, -6, 1, -4, 3, -2, 5, 0, -5, 2]
const LETTERS = 'FCGDAEB'

/** Name of a position on the line of fifths (C = 0, G = 1, F = -1, Bb = -2, F# = 6). */
function lineName(position: number): { step: string; alter: number } {
  return { step: LETTERS[mod(position + 1, 7)]!, alter: Math.floor((position + 1) / 7) }
}
const linePc = (position: number): number => mod(position * 7, 12)
export const accidentalText = (alter: number): string => (alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter))
const lineText = (position: number): string => {
  const { step, alter } = lineName(position)
  return step + accidentalText(alter)
}

/** `signature` picks between enharmonic keys (C# major is 7, Db major is -5); the more usual one is the default. */
export function makeKey(tonicPc: number, mode: Mode, signature?: number): Key {
  const pc = mod(tonicPc, 12)
  const usual = (mode === 'major' ? MAJOR_FIFTHS : MINOR_FIFTHS)[pc]!
  const fifths = signature !== undefined && Math.abs(signature) <= 7 && mod(signature - usual, 12) === 0 ? signature : usual
  const tonic = lineText(mode === 'major' ? fifths : fifths + 3)
  return { tonicPc: pc, mode, tonic, fifths, name: `${tonic} ${mode}` }
}

export const relativeKey = (key: Key): Key => (key.mode === 'major' ? makeKey(key.tonicPc + 9, 'minor') : makeKey(key.tonicPc + 3, 'major'))

/** Parse "F# minor", "Bbm", "Eb", "a minor", "C major". */
export function parseKey(text: string): Key | null {
  const match = /^\s*([A-Ga-g])\s*(#|b|♯|♭|sharp|flat)?\s*(major|maj|minor|min|m|M)?\s*$/.exec(text.replace(/-/g, ' '))
  if (!match) return null
  const letter = match[1]!.toUpperCase()
  const accidental = match[2] ? (/#|♯|sharp/.test(match[2]) ? 1 : -1) : 0
  const mode: Mode = match[3] && /^(minor|min|m)$/.test(match[3]) ? 'minor' : 'major'
  const pc = mod([9, 11, 0, 2, 4, 5, 7]['ABCDEFG'.indexOf(letter)]! + accidental, 12)
  // Keep the spelling that was asked for when it is a real key signature.
  const position = LETTERS.indexOf(letter) - 1 + 7 * accidental
  return makeKey(pc, mode, mode === 'major' ? position : position - 3)
}

/** Alteration the key signature gives a letter: -1, 0 or 1. */
export function signatureAlter(step: string, fifths: number): number {
  if (fifths > 0 && 'FCGDAEB'.indexOf(step) < fifths) return 1
  if (fifths < 0 && 'BEADGCF'.indexOf(step) < -fifths) return -1
  return 0
}

/* ---------- key finding ---------- */

// [major, minor] profiles, tonic first: Krumhansl-Kessler, Temperley, Albrecht-Shanahan.
const PROFILES: Array<[number[], number[]]> = [
  [
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  ],
  [
    [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
    [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0],
  ],
  [
    [0.238, 0.006, 0.111, 0.006, 0.137, 0.094, 0.016, 0.214, 0.009, 0.08, 0.008, 0.081],
    [0.22, 0.006, 0.104, 0.123, 0.019, 0.103, 0.012, 0.214, 0.062, 0.022, 0.061, 0.052],
  ],
]

function correlate(a: number[], b: number[]): number {
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb)
    da += (a[i]! - ma) ** 2
    db += (b[i]! - mb) ** 2
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db)
}

export interface KeyOptions {
  /** The key shown until now. It is kept unless another key is clearly better. */
  previous?: Key | null
  /** How much better (in score) a new key must be to replace `previous`. */
  stickiness?: number
  /** Beat times with a downbeat first: notes on strong beats then count for more. */
  meter?: { beats: number[]; beatsPerBar: number }
}

type Weighted = Pick<NoteEvent, 'pitch' | 'start' | 'duration' | 'velocity'>

function metricWeight(time: number, meter: KeyOptions['meter']): number {
  if (!meter || meter.beats.length < 2) return 1
  const { beats, beatsPerBar } = meter
  const period = (beats[beats.length - 1]! - beats[0]!) / (beats.length - 1)
  let nearest = 0
  let distance = Infinity
  for (let i = 0; i < beats.length; i++) {
    const d = Math.abs(beats[i]! - time)
    if (d < distance) {
      distance = d
      nearest = i
    }
  }
  if (distance > period * 0.2) return 0.8
  return nearest % beatsPerBar === 0 ? 1.5 : 1.15
}

function histogram(notes: Weighted[], meter?: KeyOptions['meter']): number[] {
  const h = new Array<number>(12).fill(0)
  for (const n of notes) {
    // Long notes matter more, but a held note must not swamp everything else.
    const length = Math.sqrt(Math.min(Math.max(n.duration, 0.08), 2))
    h[mod(n.pitch, 12)]! += length * (0.5 + n.velocity / 2) * metricWeight(n.start, meter)
  }
  return h
}

/** Score all 24 keys: index tonic * 2 + (minor ? 1 : 0). */
function scoreKeys(notes: Weighted[], meter?: KeyOptions['meter']): number[] | null {
  const h = histogram(notes, meter)
  const total = h.reduce((s, x) => s + x, 0)
  if (total === 0) return null
  const scores = new Array<number>(24).fill(0)
  // Cue: where the music starts and comes to rest. The lowest note of the first
  // and last onsets lean towards the tonic.
  const sorted = [...notes].sort((a, b) => a.start - b.start)
  const lastStart = sorted[sorted.length - 1]!.start
  const final = sorted.filter((n) => n.start >= lastStart - 0.05).reduce((low, n) => (n.pitch < low.pitch ? n : low))
  const first = sorted.filter((n) => n.start <= sorted[0]!.start + 0.05).reduce((low, n) => (n.pitch < low.pitch ? n : low))
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = h.map((_, i) => h[(i + tonic) % 12]!)
    for (const minor of [0, 1]) {
      let score = 0
      for (const set of PROFILES) score += correlate(rotated, set[minor]!)
      score /= PROFILES.length
      if (mod(final.pitch, 12) === tonic) score += 0.06
      if (mod(first.pitch, 12) === tonic) score += 0.03
      if (minor) {
        // A raised seventh is the clearest sign of minor rather than its relative major.
        const leading = rotated[11]! / total
        const subtonic = rotated[10]! / total
        if (leading > 0.02 && leading >= subtonic * 0.5) score += 0.06
      }
      scores[tonic * 2 + minor] = score
    }
  }
  return scores
}

const keyAt = (index: number): Key => makeKey(index >> 1, index & 1 ? 'minor' : 'major')
const indexOfKey = (key: Key): number => key.tonicPc * 2 + (key.mode === 'minor' ? 1 : 0)
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

function resultFor(scores: number[], chosen: number): KeyResult {
  const order = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score)
  const score = scores[chosen]!
  const rival = order.find((o) => o.index !== chosen)!.score
  const key = keyAt(chosen)
  return {
    ...key,
    score,
    confidence: clamp01(0.5 * clamp01((score - 0.35) / 0.5) + 0.5 * clamp01((score - rival) / 0.15)),
    relative: relativeKey(key),
    alternatives: order
      .filter((o) => o.index !== chosen)
      .slice(0, 3)
      .map((o) => ({ ...keyAt(o.index), score: o.score })),
  }
}

/** The key of a stretch of notes, or null if there are none. */
export function findKey(notes: Weighted[], opts: KeyOptions = {}): KeyResult | null {
  const scores = scoreKeys(notes, opts.meter)
  if (!scores) return null
  let best = 0
  for (let i = 1; i < 24; i++) if (scores[i]! > scores[best]!) best = i
  if (opts.previous) {
    const held = indexOfKey(opts.previous)
    if (scores[held]! >= scores[best]! - (opts.stickiness ?? 0.07)) best = held
  }
  return resultFor(scores, best)
}

export interface KeySegment {
  start: number
  end: number
  key: KeyResult
}

/**
 * Follow the key through a longer passage: score short frames, then pick the
 * path through them that pays a penalty for every change of key, so a few
 * borrowed notes do not count as a modulation.
 */
export function keySegments(notes: Weighted[], opts: { frameSeconds?: number; changePenalty?: number } = {}): KeySegment[] {
  if (notes.length === 0) return []
  const frame = opts.frameSeconds ?? 4
  const penalty = opts.changePenalty ?? 0.45
  const from = Math.min(...notes.map((n) => n.start))
  const to = Math.max(...notes.map((n) => n.start + n.duration))
  const count = Math.max(1, Math.ceil((to - from) / frame))
  const flat = new Array<number>(24).fill(0)
  const frames: number[][] = []
  for (let f = 0; f < count; f++) {
    // Each frame also hears half of its neighbours, which steadies short frames.
    const lo = from + (f - 0.5) * frame
    const hi = from + (f + 1.5) * frame
    frames.push(scoreKeys(notes.filter((n) => n.start >= lo && n.start < hi)) ?? flat)
  }
  let cost = frames[0]!.slice()
  const back: number[][] = []
  for (let f = 1; f < count; f++) {
    let bestPrev = 0
    for (let k = 1; k < 24; k++) if (cost[k]! > cost[bestPrev]!) bestPrev = k
    const next = new Array<number>(24).fill(0)
    const cameFrom = new Array<number>(24).fill(0)
    for (let k = 0; k < 24; k++) {
      const stay = cost[k]!
      const move = cost[bestPrev]! - penalty
      cameFrom[k] = stay >= move ? k : bestPrev
      next[k] = Math.max(stay, move) + frames[f]![k]!
    }
    back.push(cameFrom)
    cost = next
  }
  let k = 0
  for (let i = 1; i < 24; i++) if (cost[i]! > cost[k]!) k = i
  const path = new Array<number>(count).fill(0)
  for (let f = count - 1; f >= 0; f--) {
    path[f] = k
    if (f > 0) k = back[f - 1]![k]!
  }
  const segments: KeySegment[] = []
  let begin = 0
  for (let f = 1; f <= count; f++) {
    if (f < count && path[f] === path[begin]) continue
    const start = from + begin * frame
    const end = Math.min(to, from + f * frame)
    const scores = scoreKeys(notes.filter((n) => n.start >= start && n.start < end)) ?? flat
    segments.push({ start, end, key: resultFor(scores, path[begin]!) })
    begin = f
  }
  return segments
}

/* ---------- spelling ---------- */

/** Line-of-fifths position of a pitch class in a key: diatonic notes first, then the usual chromatic spellings. */
function defaultPosition(pc: number, key: Key): number {
  // Major: b2 b6 b3 b7 | 4 1 5 2 6 3 7 | #4. Minor (same signature): from the tonic's b2 up to its raised 4th.
  const low = key.mode === 'major' ? key.fifths - 5 : key.fifths - 2
  for (let p = low; p < low + 12; p++) if (linePc(p) === mod(pc, 12)) return p
  return 0
}

const isDiatonic = (position: number, key: Key): boolean => position >= key.fifths - 1 && position <= key.fifths + 5

function spelled(midi: number, position: number): SpelledPitch {
  const { step, alter } = lineName(position)
  const octave = Math.floor((midi - alter) / 12) - 1
  return { midi, step, alter, octave, name: `${step}${accidentalText(alter)}${octave}` }
}

/** How a pitch class is written in a key when nothing else is known, e.g. pc 6 is "F#" in D major. */
export const pcSpelling = (pc: number, key: Key): string => lineText(defaultPosition(pc, key))

export interface SpellingContext {
  /** The pitch this note moves to next in its line, if any. */
  next?: number
  /** Spelled notes of the chord sounding with it, e.g. ["E", "G#", "B", "D"]. */
  chordTones?: string[]
}

function namePosition(name: string): number | null {
  const match = /^([A-G])(#{1,2}|b{1,2})?$/.exec(name)
  if (!match) return null
  const alter = match[2] ? (match[2][0] === '#' ? match[2].length : -match[2].length) : 0
  return LETTERS.indexOf(match[1]!) - 1 + 7 * alter
}

/**
 * Name one MIDI pitch in a key. Notes of the scale take the scale's spelling.
 * A chromatic note is spelled as a tone of the sounding chord if it is one,
 * else as a raised note when it resolves up a semitone and a lowered note when
 * it resolves down, else by the key's usual chromatic spelling.
 */
export function spellPitch(midi: number, key: Key, context: SpellingContext = {}): SpelledPitch {
  const pc = mod(midi, 12)
  const usual = defaultPosition(pc, key)
  if (isDiatonic(usual, key)) return spelled(midi, usual)
  for (const tone of context.chordTones ?? []) {
    const position = namePosition(tone)
    if (position !== null && linePc(position) === pc && Math.abs(lineName(position).alter) <= 1) return spelled(midi, position)
  }
  if (context.next !== undefined && Math.abs(context.next - midi) === 1) {
    const sharpSide = usual > key.fifths + 5 ? usual : usual + 12
    const wanted = context.next > midi ? sharpSide : sharpSide - 12
    if (Math.abs(lineName(wanted).alter) <= 1) return spelled(midi, wanted)
  }
  return spelled(midi, usual)
}

/** Spelled notes of a chord symbol, or [] if it is not understood. */
export function chordTones(symbol: string): string[] {
  const chord = Chord.get(symbol.split('/')[0]!)
  return chord.empty ? [] : chord.notes
}

/**
 * Spell a passage. Each note's context is the chord sounding at its onset and
 * the next note a semitone away that follows it closely (its resolution).
 */
export function spellNotes(notes: Array<Pick<NoteEvent, 'pitch' | 'start' | 'duration'>>, key: Key, chords: ChordSpan[] = []): SpelledPitch[] {
  const order = notes.map((n, i) => ({ n, i })).sort((a, b) => a.n.start - b.n.start)
  const out = new Array<SpelledPitch>(notes.length)
  const tones = chords.map((c) => ({ start: c.start, end: c.end, tones: chordTones(respellChord(c.symbol, key)) }))
  order.forEach(({ n, i }, at) => {
    const end = n.start + n.duration
    let next: number | undefined
    for (let j = at + 1; j < order.length; j++) {
      const later = order[j]!.n
      if (later.start <= n.start + 0.03) continue
      if (later.start > end + 0.75) break
      if (Math.abs(later.pitch - n.pitch) === 1) {
        next = later.pitch
        break
      }
    }
    // A note belongs to the harmony if it is struck as part of a chord or joins one already sounding.
    // A passing note on its own makes a "chord" of its own for a moment; that says nothing about its spelling.
    const together = order.filter((o) => Math.abs(o.n.start - n.start) <= 0.03).length
    const sounding = tones.find((c) => n.start >= c.start - 0.03 && n.start < c.end && (together >= 3 || n.start > c.start + 0.03))
    out[i] = spellPitch(n.pitch, key, { next, chordTones: sounding?.tones })
  })
  return out
}

/**
 * Rewrite a chord symbol so its root and bass are spelled for the key
 * ("Gb7" in D major becomes "F#7") and plain major triads lose tonal's "M".
 * Diminished chords on chromatic roots are leading-tone chords, so they take
 * the sharp spelling ("G#dim" in C, not "Abdim").
 */
export function respellChord(symbol: string, key: Key): string {
  const match = /^([A-G](?:#|b)?)([^/]*)(?:\/([A-G](?:#|b)?))?$/.exec(symbol)
  if (!match) return symbol
  const [, root, rawQuality, bass] = match
  // tonal writes major as "M" ("CM", "CMadd9"); chord charts leave it out.
  const quality = rawQuality!.replace(/^M(?=$|add|b|#)/, '')
  const respell = (name: string, leading: boolean): string => {
    const position = namePosition(name)
    if (position === null) return name
    const usual = defaultPosition(linePc(position), key)
    if (leading && !isDiatonic(usual, key) && lineName(usual).alter < 0 && Math.abs(lineName(usual + 12).alter) <= 1) return lineText(usual + 12)
    return lineText(usual)
  }
  const leading = /^(dim|o|m7b5|ø)/.test(quality)
  const head = `${respell(root!, leading)}${quality}`
  if (!bass) return head
  // The bass is usually a chord tone: spell it as the chord does (C#/E#, not C#/F).
  const bassPc = linePc(namePosition(bass) ?? 0)
  const tone = chordTones(head).find((t) => {
    const position = namePosition(t)
    return position !== null && linePc(position) === bassPc && Math.abs(lineName(position).alter) <= 1
  })
  return `${head}/${tone ?? respell(bass, false)}`
}
