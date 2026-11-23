import type { ClipTrack } from '../types'
import { segments, swingBeat, type ChordSlot, type Segment } from './progression'
import { makeRng, type Rng } from './rng'
import { mod12, parseChord, pcOf, type ChordInfo } from './theory'

export const BASS_STYLES = ['roots', 'root_fifth', 'eighths', 'walking', 'funk', 'bossa'] as const
export type BassStyle = (typeof BASS_STYLES)[number]

export interface BassOptions {
  style: BassStyle
  seed?: number
  beatsPerBar?: number
  /** Play offbeat eighths late, to sit with swing drums. */
  swing?: boolean
  /** General MIDI program; defaults to acoustic bass for walking and bossa, fingered electric otherwise. */
  program?: number
}

type Note = ClipTrack['notes'][number]

/** Low E on a four-string bass up to middle C. Roots stay in the bottom octave and a half. */
export const BASS_LOW = 28
export const BASS_HIGH = 60
const ROOT_HIGH = 47
const HOME = 38

const fold = (pitch: number): number => {
  let p = pitch
  while (p < BASS_LOW) p += 12
  while (p > BASS_HIGH) p -= 12
  return p
}

/** Put a pitch class in the root register, close to where the line already is. */
function place(pc: number, near: number): number {
  let best = BASS_LOW
  let bestCost = Infinity
  for (let p = BASS_LOW; p <= ROOT_HIGH; p++) {
    if (mod12(p) !== mod12(pc)) continue
    const cost = Math.abs(p - near) + 0.3 * Math.abs(p - HOME)
    if (cost < bestCost) {
      best = p
      bestCost = cost
    }
  }
  return best
}

/** Third, fifth and seventh (or the sixth, where a chord has no seventh) as semitones above the root. */
function tones(c: ChordInfo): { third: number; fifth: number; seventh: number } {
  const has = (n: number) => c.semitones.includes(n)
  const fifth = has(6) && !has(7) ? 6 : has(8) && !has(7) ? 8 : 7
  const third = has(4) ? 4 : has(3) ? 3 : has(5) ? 5 : has(2) ? 2 : fifth
  const seventh = has(10) ? 10 : has(11) ? 11 : has(9) ? 9 : c.kind === 'maj' || c.kind === 'dim' ? 9 : 10
  return { third, fifth, seventh }
}

/** A note that leads into `target`: a half step from the side the line is coming from, or now and then its fifth. */
function leadIn(target: number, from: number, rng: Rng): number {
  let note = from <= target ? target - 1 : target + 1
  if (rng.chance(0.2)) note = Math.abs(target + 7 - from) < Math.abs(target - 5 - from) ? target + 7 : target - 5
  if (note === from) note = note < target ? target + 1 : target - 1
  if (note < BASS_LOW) note = target + 1
  if (note > BASS_HIGH) note = target - 1
  return note
}

interface Spot {
  seg: Segment
  chord: ChordInfo
  /** The chord's root, placed in the bass register. */
  root: number
  /** What to play on the chord's first beat: the root, or the slash bass note. */
  down: number
  nextRoot: number
  third: number
  fifth: number
  seventh: number
  rng: Rng
  /** State a style carries from segment to segment. */
  memory: { last: number; start: number | null; template: number }
}

/** Times are beats from the start of the segment. */
type Style = (s: Spot) => Note[]

const note = (pitch: number, startBeat: number, durationBeats: number, velocity: number): Note => ({ pitch, startBeat, durationBeats, velocity })

const roots: Style = (s) => {
  const out: Note[] = []
  for (let at = 0; at < s.seg.beats - 1e-6; at += 2) out.push(note(at === 0 && s.seg.first ? s.down : s.root, at, Math.min(2, s.seg.beats - at) * 0.95, at === 0 ? 0.85 : 0.72))
  return out
}

const rootFifth: Style = (s) => {
  const out: Note[] = []
  const below = s.root + s.fifth - 12
  const fifth = below >= BASS_LOW && s.root >= 36 ? below : s.root + s.fifth
  let i = 0
  for (let at = 0; at < s.seg.beats - 1e-6; at += 2, i++) {
    const room = Math.min(2, s.seg.beats - at)
    const isLastUnit = at + 2 >= s.seg.beats - 1e-6
    const pitch = i % 2 === 0 ? (at === 0 && s.seg.first ? s.down : s.root) : fifth
    if (isLastUnit && s.seg.last && room >= 2 && s.rng.chance(0.5)) {
      out.push(note(pitch, at, 0.95, i % 2 === 0 ? 0.85 : 0.75))
      out.push(note(leadIn(s.nextRoot, pitch, s.rng), at + 1, 0.9, 0.7))
    } else out.push(note(pitch, at, Math.min(1.5, room * 0.95), i % 2 === 0 ? 0.85 : 0.75))
  }
  return out
}

const eighths: Style = (s) => {
  const out: Note[] = []
  const count = Math.max(1, Math.round(s.seg.beats * 2))
  const pickup = s.seg.last && count >= 4 && s.rng.chance(0.6)
  for (let i = 0; i < count; i++) {
    const lead = pickup && i === count - 1
    const pitch = lead ? leadIn(s.nextRoot, s.root, s.rng) : i === 0 && s.seg.first ? s.down : s.root
    out.push(note(pitch, i * 0.5, 0.42, (i % 2 === 0 ? 0.85 : 0.68) + s.rng.jitter(0.04)))
  }
  return out
}

const walking: Style = (s) => {
  const count = Math.max(1, Math.floor(s.seg.beats + 1e-6))
  const { root, third, fifth, seventh } = s
  const start = s.seg.first ? s.down : (s.memory.start ?? root)
  const pitches = [start]
  const middle = count - 1 - (count >= 2 ? 1 : 0)
  if (middle > 0) {
    // Head towards the next root, unless that would run off the instrument.
    const up = root < 34 ? true : root > 43 ? false : s.nextRoot === root ? s.rng.chance(0.5) : s.nextRoot > root
    const stepwise = s.chord.kind === 'dim' || s.chord.kind === 'hdim' ? [third, fifth] : [2, third]
    const shapes = up
      ? [[third, fifth, seventh], stepwise.concat(fifth), [fifth, third, fifth]]
      : [[seventh - 12, fifth - 12, third - 12], [fifth - 12, seventh - 12, fifth - 12], [third, fifth - 12, seventh - 12]]
    const shape = s.rng.pick(shapes)
    const base = mod12(start - root) === 0 ? start : root
    for (let i = 0; i < middle; i++) {
      let p = fold(base + shape[i % shape.length]!)
      if (p === pitches[pitches.length - 1]) p = fold(root + fifth)
      pitches.push(p)
    }
  }
  if (count >= 2) {
    const from = pitches[pitches.length - 1]!
    if (s.seg.last) {
      pitches.push(leadIn(s.nextRoot, from, s.rng))
      s.memory.start = null
    } else {
      // Same chord next bar: come back to its root, sometimes an octave up for variety.
      const target = root + 12 <= 50 && s.rng.chance(0.35) ? root + 12 : root
      pitches.push(leadIn(target, from, s.rng))
      s.memory.start = target
    }
  }
  return pitches.map((p, i) => {
    const length = i === count - 1 ? s.seg.beats - i : 1
    return note(fold(p), i, length * 0.92, (i === 0 ? 0.86 : 0.74) + s.rng.jitter(0.04))
  })
}

type Degree = 'R' | '8' | '5' | '7' | 'lead'
type Hit = [at: number, degree: Degree, length: number, velocity: number]

const FUNK: Hit[][] = [
  [[0, 'R', 0.5, 1], [0.75, 'R', 0.25, 0.6], [1.5, '8', 0.25, 0.9], [2.5, 'R', 0.25, 0.7], [2.75, '7', 0.25, 0.7], [3, 'R', 0.5, 0.9], [3.5, 'lead', 0.4, 0.8]],
  [[0, 'R', 0.75, 1], [1.5, 'R', 0.25, 0.7], [1.75, '8', 0.25, 0.9], [2.5, '5', 0.5, 0.8], [3.25, '7', 0.25, 0.7], [3.5, 'lead', 0.4, 0.8]],
  [[0, 'R', 0.5, 1], [1, '8', 0.25, 0.9], [1.5, 'R', 0.5, 0.8], [2.25, 'R', 0.25, 0.6], [3, '5', 0.25, 0.8], [3.5, 'lead', 0.25, 0.8], [3.75, 'R', 0.2, 0.6]],
]

const BOSSA: Hit[] = [[0, 'R', 1.4, 0.85], [1.5, '5', 0.45, 0.7], [2, '5', 1.4, 0.8], [3.5, 'lead', 0.45, 0.72]]

/** Play a one-bar pattern, clipped to however much of the bar this chord has. */
function fromHits(s: Spot, hits: Hit[], anticipate: boolean): Note[] {
  const below = s.root + s.fifth - 12
  const fifth = below >= BASS_LOW && s.root >= 36 ? below : s.root + s.fifth
  const out: Note[] = []
  // A chord that enters mid-bar still needs its root first.
  const shifted = s.seg.offset > 0 && !hits.some(([at]) => Math.abs(at - s.seg.offset) < 1e-6)
  if (shifted) out.push(note(s.down, 0, Math.min(0.5, s.seg.beats), 0.9))
  for (const [barAt, degree, length, velocity] of hits) {
    const at = barAt - s.seg.offset
    if (at < (shifted ? 0.5 : 0) - 1e-6 || at >= s.seg.beats - 1e-6) continue
    let pitch = s.root
    if (at < 1e-6 && s.seg.first) pitch = s.down
    else if (degree === '8') pitch = s.root + 12
    else if (degree === '5') pitch = fifth
    else if (degree === '7') pitch = fold(s.root + s.seventh > 55 ? s.root + s.seventh - 12 : s.root + s.seventh)
    else if (degree === 'lead') pitch = !s.seg.last ? s.root : anticipate ? s.nextRoot : leadIn(s.nextRoot, s.root, s.rng)
    out.push(note(pitch, at, Math.min(length, s.seg.beats - at), Math.min(1, velocity * 0.85 + s.rng.jitter(0.03))))
  }
  return out
}

const funk: Style = (s) => {
  // One pattern is the groove; every fourth bar answers it with another.
  const template = s.seg.bar % 4 === 3 ? (s.memory.template + 1) % FUNK.length : s.memory.template
  return fromHits(s, FUNK[template]!, false)
}

const bossa: Style = (s) => fromHits(s, BOSSA, true)

const STYLES: Record<BassStyle, Style> = { roots, root_fifth: rootFifth, eighths, walking, funk, bossa }

/** A bass line under a chord progression. Same options and seed give the same line. */
export function generateBass(slots: ChordSlot[], options: BassOptions): ClipTrack {
  const { style, seed = 1, beatsPerBar = 4 } = options
  const program = options.program ?? (style === 'walking' || style === 'bossa' ? 32 : 33)
  const rng = makeRng(seed, `bass:${style}`)
  const { segments: segs, slots: merged } = segments(slots, beatsPerBar)
  const chords = merged.map((s) => parseChord(s.symbol))
  const rootOf: number[] = []
  chords.forEach((c, i) => rootOf.push(place(c?.rootPc ?? 0, rootOf[i - 1] ?? HOME)))
  const memory: Spot['memory'] = { last: HOME, start: null, template: rng.int(FUNK.length) }
  const play = STYLES[style]
  const notes: Note[] = []
  for (const seg of segs) {
    const chord = chords[seg.slot]
    if (!chord) continue
    const root = rootOf[seg.slot]!
    const down = chord.bass ? place(pcOf(chord.bass), root) : root
    const spot: Spot = { seg, chord, root, down, nextRoot: rootOf[seg.nextSlot]!, ...tones(chord), rng, memory }
    for (const n of play(spot)) {
      if (n.startBeat >= seg.beats - 1e-6 || n.durationBeats <= 0) continue
      notes.push({
        pitch: fold(n.pitch),
        startBeat: seg.start + (options.swing ? swingBeat(n.startBeat) : n.startBeat),
        durationBeats: Math.min(n.durationBeats, seg.beats - n.startBeat),
        velocity: Math.min(1, Math.max(0.1, n.velocity)),
      })
    }
  }
  return { role: 'bass', program, notes }
}
