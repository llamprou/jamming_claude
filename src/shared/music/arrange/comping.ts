import type { ClipTrack } from '../types'
import { segments, swingBeat, type ChordSlot } from './progression'
import { makeRng } from './rng'
import { mod12, parseChord, type ChordInfo } from './theory'

export const COMPING_STYLES = ['block', 'shell', 'arpeggio', 'stabs'] as const
export type CompingStyle = (typeof COMPING_STYLES)[number]

export interface CompingOptions {
  style: CompingStyle
  seed?: number
  beatsPerBar?: number
  /** Play offbeat eighths late, to sit with swing drums. */
  swing?: boolean
  /** General MIDI program; piano by default. */
  program?: number
}

type Note = ClipTrack['notes'][number]

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)

/**
 * Voice a set of pitch classes in close position within `low..high`, choosing
 * the inversion that moves least from the previous voicing (or sits nearest
 * `centre` when there is none).
 */
export function voiceLead(pcs: number[], prev: number[] | null, low = 52, high = 74, centre = 62): number[] {
  const unique = [...new Set(pcs.map(mod12))]
  if (unique.length === 0) return []
  let best: number[] = []
  let bestCost = Infinity
  for (const bottomPc of unique) {
    for (let bottom = low; bottom < low + 12; bottom++) {
      if (mod12(bottom) !== bottomPc) continue
      const voicing = unique.map((pc) => bottom + mod12(pc - bottomPc)).sort((a, b) => a - b)
      const over = Math.max(0, voicing[voicing.length - 1]! - high)
      let cost = 0.4 * Math.abs(mean(voicing) - centre) + 4 * over
      if (prev?.length) {
        for (const v of voicing) cost += Math.min(...prev.map((p) => Math.abs(v - p)))
        cost += Math.abs(voicing[voicing.length - 1]! - prev[prev.length - 1]!)
      }
      if (cost < bestCost) {
        best = voicing
        bestCost = cost
      }
    }
  }
  return best
}

/** The notes worth playing: big chords lose their root (and then their fifth) so the colour tones fit in one hand. */
function chordPcs(c: ChordInfo): number[] {
  let tones = c.semitones
  if (tones.length >= 5) tones = tones.slice(1)
  if (tones.length >= 5) tones = tones.filter((s) => s !== 7)
  return tones.map((s) => mod12(c.rootPc + s))
}

/** Third and seventh: the two notes that say what the chord is. */
function guideTones(c: ChordInfo): number[] {
  const has = (n: number) => c.semitones.includes(n)
  const third = has(4) ? 4 : has(3) ? 3 : has(5) ? 5 : has(2) ? 2 : 7
  const seventh = has(10) ? 10 : has(11) ? 11 : has(9) ? 9 : has(6) ? 6 : has(8) ? 8 : 7
  return [mod12(c.rootPc + third), mod12(c.rootPc + seventh)]
}

const STABS: Array<Array<[at: number, length: number]>> = [
  // The Charleston, then two answers that stay off the downbeat.
  [[0, 0.9], [1.5, 0.4]],
  [[1, 0.4], [2.5, 0.7]],
  [[0, 0.4], [2.5, 0.4], [3.5, 0.4]],
]

/** A chordal accompaniment on the 'chords' track, voice-led from chord to chord. */
export function generateComping(slots: ChordSlot[], options: CompingOptions): ClipTrack {
  const { style, seed = 1, beatsPerBar = 4, program = 0 } = options
  const rng = makeRng(seed, `comping:${style}`)
  const { segments: segs, slots: merged } = segments(slots, beatsPerBar)
  const notes: Note[] = []

  // One voicing per chord, each chosen relative to the one before.
  const voicings: number[][] = []
  let prev: number[] | null = null
  for (const slot of merged) {
    const chord = parseChord(slot.symbol)
    if (!chord) {
      voicings.push([])
      continue
    }
    let voicing: number[]
    if (style === 'shell') {
      const upper = voiceLead(guideTones(chord), prev ? prev.slice(1) : null, 52, 68, 59)
      let root = 36 + chord.rootPc
      if (root < 41) root += 12
      voicing = [root, ...upper.filter((p) => p !== root)]
    } else voicing = voiceLead(chordPcs(chord), prev)
    voicings.push(voicing)
    prev = voicing
  }

  let stabPattern = 0
  let stabBar = -1
  for (const seg of segs) {
    const voicing = voicings[seg.slot]!
    if (voicing.length === 0) continue
    const strike = (at: number, length: number, velocity: number, pitches = voicing) => {
      if (at >= seg.beats - 1e-6) return
      for (const pitch of pitches) {
        notes.push({ pitch, startBeat: seg.start + (options.swing ? swingBeat(at) : at), durationBeats: Math.min(length, seg.beats - at), velocity: Math.min(1, velocity + rng.jitter(0.03)) })
      }
    }
    if (style === 'block' || style === 'shell') strike(0, seg.beats * 0.97, seg.first ? 0.68 : 0.6)
    else if (style === 'arpeggio') {
      const order = voicing.length > 2 ? [...voicing.keys(), ...[...voicing.keys()].slice(1, -1).reverse()] : [...voicing.keys()]
      const count = Math.max(1, Math.round(seg.beats * 2))
      for (let i = 0; i < count; i++) strike(i * 0.5, 0.75, i === 0 ? 0.74 : i % 2 === 0 ? 0.64 : 0.56, [voicing[order[i % order.length]!]!])
    } else {
      if (seg.bar !== stabBar) {
        stabBar = seg.bar
        const roll = rng.next()
        stabPattern = roll < 0.55 ? 0 : roll < 0.8 ? 1 : 2
      }
      const hits = STABS[stabPattern]!.map(([at, length]) => [at - seg.offset, length] as const).filter(([at]) => at >= -1e-6 && at < seg.beats - 1e-6)
      // Every chord gets heard, even if the pattern has no hit in its part of the bar.
      if (hits.length === 0) strike(0, Math.min(0.4, seg.beats), 0.7)
      for (const [at, length] of hits) strike(Math.max(0, at), length, at < 1e-6 ? 0.74 : 0.68)
    }
  }
  return { role: 'chords', program, notes }
}
