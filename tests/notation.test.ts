import { Playback } from '../src/main/playback'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { MainEvent } from '@shared/ipc'
import { Transcript } from '@shared/music/transcript'
import { notation } from '../src/main/agent/tools/notation'
import { FeatureBus } from '../src/main/bus'
import { TasteMemory } from '../src/main/memory/taste'
import {
  analyseMeter,
  arrangeTab,
  beatPosition,
  buildScore,
  chordsAsNotes,
  findKey,
  fixedMeter,
  keySegments,
  makeKey,
  meterFromBeats,
  parseKey,
  readNotationOptions,
  respellChord,
  rhythmGrid,
  rhythmGridToText,
  scoreToAbc,
  scoreToMusicXml,
  scoreToTab,
  spellNotes,
  spellPitch,
  splitMetric,
  tabToSvg,
  tabToText,
  toNumber,
  transcribe,
  transcribeTab,
  voiceLength,
  type Score,
} from '@shared/music/notation'
import type { NoteEvent } from '@shared/music/types'

const note = (pitch: number, start: number, duration = 0.5, velocity = 0.8): NoteEvent => ({ pitch, start, duration, velocity, source: 'midi', confidence: 1 })

/** Deterministic noise so the jitter tests are repeatable. */
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** Roughly normal timing error with the given standard deviation in seconds. */
function humanise(notes: NoteEvent[], sigma: number, seed = 1): NoteEvent[] {
  const r = random(seed)
  const gauss = () => (r() + r() + r() + r() - 2) * Math.sqrt(3)
  // Notes struck together share most of their error, as a hand does.
  const shared = new Map<number, number>()
  return notes.map((n) => {
    const key = Math.round(n.start * 1000)
    if (!shared.has(key)) shared.set(key, gauss() * sigma)
    return { ...n, start: n.start + shared.get(key)! + gauss() * sigma * 0.2, duration: Math.max(0.05, n.duration + gauss() * sigma) }
  })
}

/** [start, length, pitches, velocity] in quarter notes. */
type Hit = [number, number, number[], number?]
const play = (hits: Hit[], quarterSeconds: number, t0 = 0): NoteEvent[] =>
  hits.flatMap(([start, length, pitches, velocity]) => pitches.map((p) => note(p, t0 + start * quarterSeconds, length * quarterSeconds, velocity ?? 0.7)))

const MAJOR = [0, 2, 4, 5, 7, 9, 11, 12]
const HARMONIC_MINOR = [0, 2, 3, 5, 7, 8, 11, 12]
/** Up and down a scale, then the tonic triad. */
function scalePiece(tonic: number, steps: number[]): NoteEvent[] {
  const line = [...steps, ...steps.slice(0, -1).reverse()].map((s, i) => note(tonic + s, i * 0.4, 0.4))
  const third = steps[2]!
  return [...line, ...[0, third, 7].map((s) => note(tonic + s, line.length * 0.4, 1.6))]
}
const triad = (root: number, minor = false): number[] => [root, root + (minor ? 3 : 4), root + 7]
function progression(chords: number[][], seconds = 1.5): NoteEvent[] {
  return chords.flatMap((pitches, i) => pitches.map((p) => note(p, i * seconds, seconds)))
}

describe('key', () => {
  it.each([
    [60, MAJOR, 'C major'],
    [67, MAJOR, 'G major'],
    [62, MAJOR, 'D major'],
    [64, MAJOR, 'E major'],
    [59, MAJOR, 'B major'],
    [66, MAJOR, 'F# major'],
    [65, MAJOR, 'F major'],
    [58, MAJOR, 'Bb major'],
    [63, MAJOR, 'Eb major'],
    [56, MAJOR, 'Ab major'],
    [61, MAJOR, 'Db major'],
    [57, HARMONIC_MINOR, 'A minor'],
    [64, HARMONIC_MINOR, 'E minor'],
    [66, HARMONIC_MINOR, 'F# minor'],
    [61, HARMONIC_MINOR, 'C# minor'],
    [62, HARMONIC_MINOR, 'D minor'],
    [60, HARMONIC_MINOR, 'C minor'],
    [58, HARMONIC_MINOR, 'Bb minor'],
    [63, HARMONIC_MINOR, 'Eb minor'],
  ])('finds the key of a scale on %i: %s', (tonic, steps, name) => {
    expect(findKey(scalePiece(tonic, steps))?.name).toBe(name)
  })

  it('finds keys from chord progressions, spelled for the key', () => {
    // I IV V I in E and Ab; i iv V i in D minor and G# minor.
    expect(findKey(progression([triad(52), triad(57), triad(59), triad(52)]))?.name).toBe('E major')
    expect(findKey(progression([triad(56), triad(61), triad(63), triad(56)]))?.name).toBe('Ab major')
    expect(findKey(progression([triad(50, true), triad(55, true), triad(57), triad(50, true)]))?.name).toBe('D minor')
    const gSharpMinor = findKey(progression([triad(56, true), triad(61, true), triad(63), triad(56, true)]))
    expect(gSharpMinor).toMatchObject({ name: 'G# minor', fifths: 5 })
    // ii V I in C is C major, not D dorian or G.
    expect(findKey(progression([[62, 65, 69, 72], [55, 59, 62, 65], [60, 64, 67, 71]]))?.name).toBe('C major')
  })

  it('tells a minor key from its relative major by where the music rests', () => {
    // The same seven notes: one line circles A and E, the other C and G.
    const inA = [57, 59, 60, 62, 64, 60, 59, 57, 64, 62, 60, 59, 57, 52, 57].map((p, i) => note(p, i * 0.4, i === 14 ? 1.6 : 0.4))
    const inC = [60, 62, 64, 65, 67, 64, 62, 60, 67, 65, 64, 62, 60, 55, 60].map((p, i) => note(p, i * 0.4, i === 14 ? 1.6 : 0.4))
    const a = findKey(inA)!
    expect(a.name).toBe('A minor')
    expect(a.relative.name).toBe('C major')
    expect(findKey(inC)?.name).toBe('C major')
  })

  it('reports confidence and keeps the previous key unless another is clearly better', () => {
    const clear = findKey(scalePiece(60, MAJOR))!
    const vague = findKey([note(60, 0), note(67, 0.5), note(62, 1)])!
    expect(clear.confidence).toBeGreaterThan(0.6)
    expect(clear.confidence).toBeLessThanOrEqual(1)
    expect(vague.confidence).toBeLessThan(clear.confidence)
    // C, G and D alone fit several keys; whatever was showing stays.
    const g = makeKey(7, 'major')
    expect(findKey([note(60, 0), note(67, 0.5), note(62, 1), note(67, 1.5)], { previous: g })?.name).toBe('G major')
    // ...but not against clear evidence.
    expect(findKey(scalePiece(63, MAJOR), { previous: g })?.name).toBe('Eb major')
  })

  it('follows a modulation without flickering on borrowed notes', () => {
    const first = scalePiece(60, MAJOR)
    const tail = first[first.length - 1]!.start + 2
    const borrowed = [...first, note(66, 2.05, 0.2), note(70, 4.05, 0.2)]
    expect(keySegments(borrowed).map((s) => s.key.name)).toEqual(['C major'])
    const second = [...scalePiece(64, MAJOR), ...scalePiece(64, MAJOR).map((n) => ({ ...n, start: n.start + tail }))]
    const both = [...first, ...first.map((n) => ({ ...n, start: n.start + tail })), ...second.map((n) => ({ ...n, start: n.start + 2 * tail }))]
    const segments = keySegments(both)
    expect(segments.map((s) => s.key.name)).toEqual(['C major', 'E major'])
    expect(Math.abs(segments[1]!.start - 2 * tail)).toBeLessThanOrEqual(4)
  })

  it('parses key names', () => {
    expect(parseKey('F# minor')).toMatchObject({ tonicPc: 6, mode: 'minor', fifths: 3 })
    expect(parseKey('Bbm')?.name).toBe('Bb minor')
    expect(parseKey('E flat major')?.name).toBe('Eb major')
    expect(parseKey('nonsense')).toBeNull()
  })
})

describe('pitch spelling', () => {
  const names = (pitches: number[], key: string) => pitches.map((p) => spellPitch(p, parseKey(key)!).name)

  it('spells scale notes by the key signature', () => {
    expect(names([66, 61, 65], 'G major')).toEqual(['F#4', 'C#4', 'F4'])
    expect(names([66, 61], 'D major')).toEqual(['F#4', 'C#4'])
    expect(names([66, 61, 70], 'Db major')).toEqual(['Gb4', 'Db4', 'Bb4'])
    expect(names([65, 60], 'C# major')).toEqual(['E#4', 'B#3'])
    expect(names([59, 64], 'Gb major')).toEqual(['Cb4', 'Fb4'])
    expect(names([63, 68, 70], 'Eb major')).toEqual(['Eb4', 'Ab4', 'Bb4'])
  })

  it('spells the raised notes of minor keys as sharps or naturals, never as flats of the wrong letter', () => {
    expect(names([68, 66], 'A minor')).toEqual(['G#4', 'F#4'])
    expect(names([61, 59], 'D minor')).toEqual(['C#4', 'B3'])
    expect(names([65], 'F# minor')).toEqual(['E#4'])
    expect(names([71, 69], 'C minor')).toEqual(['B4', 'A4'])
  })

  it('spells chromatic neighbours by where they resolve', () => {
    const c = parseKey('C major')!
    const up = spellNotes([60, 61, 62, 63, 64].map((p, i) => note(p, i * 0.5)), c).map((s) => s.name)
    expect(up).toEqual(['C4', 'C#4', 'D4', 'D#4', 'E4'])
    const down = spellNotes([64, 63, 62, 61, 60].map((p, i) => note(p, i * 0.5)), c).map((s) => s.name)
    expect(down).toEqual(['E4', 'Eb4', 'D4', 'Db4', 'C4'])
    expect(spellPitch(68, c, { next: 69 }).name).toBe('G#4')
    expect(spellPitch(68, c, { next: 67 }).name).toBe('Ab4')
    expect(spellPitch(68, c).name).toBe('Ab4')
    expect(spellPitch(66, c).name).toBe('F#4')
  })

  it('spells chord tones from the harmony', () => {
    const c = parseKey('C major')!
    // E7 in C major: the third is G sharp even with nothing to resolve to.
    const e7 = [52, 56, 59, 62].map((p) => note(p, 0, 2))
    const spelled = spellNotes(e7, c, [{ symbol: 'E7', start: 0, end: 2, pitchClasses: [2, 4, 8, 11] }])
    expect(spelled.map((s) => s.name)).toEqual(['E3', 'G#3', 'B3', 'D4'])
  })

  it('respells chord symbols for the key', () => {
    expect(respellChord('Gb7', parseKey('D major')!)).toBe('F#7')
    expect(respellChord('CM', parseKey('C major')!)).toBe('C')
    expect(respellChord('A#m', parseKey('F major')!)).toBe('Bbm')
    expect(respellChord('DbM/F', parseKey('A major')!)).toBe('C#/E#')
    expect(respellChord('CM/E', parseKey('C major')!)).toBe('C/E')
    expect(respellChord('Abdim', parseKey('C major')!)).toBe('G#dim')
    expect(respellChord('AbM', parseKey('C major')!)).toBe('Ab')
    expect(respellChord('Dm7', parseKey('C major')!)).toBe('Dm7')
    expect(respellChord('Ebm7', parseKey('F# major')!)).toBe('D#m7')
  })
})

/* ---------- pieces with a known meter ---------- */

const T0 = 3.2 // pieces do not start at zero on the session clock

/** 4/4 at 120: bass and chord on the bar, a melody of quarters and eighths. */
function commonTime(bars = 8, bpm = 120): NoteEvent[] {
  const q = 60 / bpm
  const roots = [48, 53, 55, 48]
  const hits: Hit[] = []
  for (let b = 0; b < bars; b++) {
    const root = roots[b % 4]!
    hits.push([b * 4, 4, [root - 12], 0.9], [b * 4, 2, triad(root), 0.6], [b * 4 + 2, 2, triad(root), 0.5])
    const tune = [0, 4, 7, 9, 7, 4]
    const at = [0, 1, 1.5, 2, 3, 3.5]
    tune.forEach((s, i) => hits.push([b * 4 + at[i]!, i === 0 || i === 3 ? 1 : 0.5, [root + 24 + s], i === 0 ? 0.9 : 0.65]))
  }
  return play(hits, q, T0)
}

/** 3/4 at 150: bass on one, chords on two and three. */
function waltz(bars = 8, bpm = 150): NoteEvent[] {
  const q = 60 / bpm
  const roots = [48, 53, 55, 48]
  const hits: Hit[] = []
  for (let b = 0; b < bars; b++) {
    const root = roots[b % 4]!
    hits.push([b * 3, 1, [root - 12], 0.95], [b * 3 + 1, 1, triad(root + 12), 0.55], [b * 3 + 2, 1, triad(root + 12), 0.55])
    hits.push([b * 3, 2, [root + 28], 0.8], [b * 3 + 2, 1, [root + 26], 0.6])
  }
  return play(hits, q, T0)
}

/** 6/8 with the dotted quarter at 80: running eighths, bass on both beats. */
function sixEight(bars = 8, dottedBpm = 80): NoteEvent[] {
  const q = 60 / dottedBpm / 1.5
  const roots = [45, 50, 52, 45]
  const minor = [true, true, false, true]
  const hits: Hit[] = []
  for (let b = 0; b < bars; b++) {
    const chord = triad(roots[b % 4]! + 12, minor[b % 4])
    const figure = [chord[0]!, chord[1]!, chord[2]!, chord[1]!, chord[2]!, chord[1]!]
    figure.forEach((p, i) => hits.push([b * 3 + i * 0.5, 0.5, [p + 12], i === 0 ? 0.9 : i === 3 ? 0.75 : 0.55]))
    hits.push([b * 3, 1.5, [roots[b % 4]! - 12], 0.95], [b * 3 + 1.5, 1.5, [roots[b % 4]! - 5], 0.7])
  }
  return play(hits, q, T0)
}

/** Swung 4/4 at 120: walking bass in quarters, a melody of long-short eighths (2:1). */
function swing(bars = 8, bpm = 120): NoteEvent[] {
  const q = 60 / bpm
  const roots = [48, 53, 55, 48]
  const hits: Hit[] = []
  for (let b = 0; b < bars; b++) {
    const root = roots[b % 4]!
    ;[0, 4, 7, 9].forEach((s, i) => hits.push([b * 4 + i, 1, [root - 12 + s], i === 0 ? 0.95 : 0.7]))
    const tune = [12, 14, 16, 19, 21, 19, 16]
    const at = [0, 2 / 3, 1, 1 + 2 / 3, 2, 3, 3 + 2 / 3]
    tune.forEach((s, i) => hits.push([b * 4 + at[i]!, i === 4 ? 1 : at[i]! % 1 === 0 ? 2 / 3 : 1 / 3, [root + 12 + s], i === 0 ? 0.9 : 0.65]))
  }
  return play(hits, q, T0)
}

const barSeconds = (m: { beatSeconds: number; beatsPerBar: number }) => m.beatSeconds * m.beatsPerBar
/** How far a meter's bar lines are from the true ones, in seconds. */
function downbeatError(meter: { downbeat: number; beatSeconds: number; beatsPerBar: number }, truth: number): number {
  const bar = barSeconds(meter)
  const offset = (((meter.downbeat - truth) % bar) + bar) % bar
  return Math.min(offset, bar - offset)
}

describe('meter', () => {
  it.each([0, 0.012, 0.02])('reads 4/4 at 120 with the real downbeat (jitter %f s)', (sigma) => {
    const meter = analyseMeter(humanise(commonTime(), sigma, 3))!
    expect(meter.timeSignature).toBe('4/4')
    expect(meter.swing).toBe(false)
    expect(Math.abs(meter.bpm - 120)).toBeLessThan(3)
    expect(downbeatError(meter, T0)).toBeLessThan(0.06)
  })

  it.each([0, 0.012, 0.02])('reads a waltz as 3/4 at 150 (jitter %f s)', (sigma) => {
    const meter = analyseMeter(humanise(waltz(), sigma, 5))!
    expect(meter.timeSignature).toBe('3/4')
    expect(meter.beatsPerBar).toBe(3)
    expect(Math.abs(meter.bpm - 150)).toBeLessThan(4)
    expect(downbeatError(meter, T0)).toBeLessThan(0.06)
  })

  it.each([0, 0.012, 0.02])('reads 6/8 with a dotted-quarter beat at 80 (jitter %f s)', (sigma) => {
    const meter = analyseMeter(humanise(sixEight(), sigma, 7))!
    expect(meter.timeSignature).toBe('6/8')
    expect(meter.compound).toBe(true)
    expect(meter.beatsPerBar).toBe(2)
    expect(Math.abs(meter.bpm - 80)).toBeLessThan(3)
    expect(downbeatError(meter, T0)).toBeLessThan(0.06)
  })

  it.each([0, 0.012, 0.02])('reads swung eighths as 4/4 with a swing feel (jitter %f s)', (sigma) => {
    const meter = analyseMeter(humanise(swing(), sigma, 11))!
    expect(meter.timeSignature).toBe('4/4')
    expect(meter.swing).toBe(true)
    expect(meter.swingRatio).toBeGreaterThan(0.6)
    expect(meter.swingRatio).toBeLessThan(0.72)
    expect(Math.abs(meter.bpm - 120)).toBeLessThan(3)
    expect(downbeatError(meter, T0)).toBeLessThan(0.06)
  })

  it('reads 12/8 when the bar has four dotted beats', () => {
    // Slow blues figure: four groups of three eighths, bass on one, a lighter bass on three.
    const q = 60 / 66 / 1.5
    const hits: Hit[] = []
    for (let b = 0; b < 6; b++) {
      for (let i = 0; i < 12; i++) hits.push([b * 6 + i * 0.5, 0.5, [64 + [0, 3, 7][i % 3]!], i % 3 === 0 ? 0.75 : 0.5])
      hits.push([b * 6, 3, [40], 1], [b * 6 + 3, 3, [47], 0.7], [b * 6, 6, [52, 56, 59], 0.9])
    }
    const meter = analyseMeter(humanise(play(hits, q, T0), 0.01, 2))!
    expect(meter.timeSignature).toBe('12/8')
    expect(meter.beatsPerBar).toBe(4)
    expect(Math.abs(meter.bpm - 66)).toBeLessThan(3)
    expect(downbeatError(meter, T0)).toBeLessThan(0.06)
  })

  it('finds the downbeat after a pickup', () => {
    const q = 0.5
    const pickup = play([[-1, 0.5, [67], 0.6], [-0.5, 0.5, [69], 0.6]], q, T0)
    const meter = analyseMeter(humanise([...pickup, ...commonTime()], 0.01, 4))!
    expect(meter.timeSignature).toBe('4/4')
    expect(downbeatError(meter, T0)).toBeLessThan(0.06)
    // The first bar line is at or before the first note.
    expect(meter.downbeat).toBeLessThanOrEqual(T0 - 0.5 + 0.06)
  })

  it('follows a player who speeds up', () => {
    // 6% faster by the end: a fixed grid would be a beat out.
    const steady = commonTime(8)
    const span = 16
    const warped = steady.map((n) => {
      const x = (n.start - T0) / span
      return { ...n, start: T0 + span * (x - 0.03 * x * x), duration: n.duration * (1 - 0.06 * x) }
    })
    const meter = analyseMeter(humanise(warped, 0.008, 9))!
    expect(meter.timeSignature).toBe('4/4')
    const lastDownbeat = warped.filter((n) => n.pitch === 36).at(-1)!.start
    const position = beatPosition(meter, lastDownbeat)
    expect(Math.abs(position - Math.round(position))).toBeLessThan(0.12)
    expect(Math.round(position) % 4).toBe(0)
  })

  it('honours a forced time signature and a known grid', () => {
    expect(analyseMeter(commonTime(), { timeSignature: '3/4' })?.timeSignature).toBe('3/4')
    const onGrid = analyseMeter(play([[0, 1, [60]], [1.5, 0.5, [62]], [2, 1, [64]], [3, 1, [65]], [4, 2, [67]]], 0.5, 0), { quarterSeconds: 0.5, origin: 0, timeSignature: '6/8' })!
    expect(onGrid).toMatchObject({ timeSignature: '6/8', bpm: 80, downbeat: 0 })
    expect(analyseMeter([note(60, 0)])).toBeNull()
  })

  it('wraps beats from an outside tracker', () => {
    const beats = Array.from({ length: 9 }, (_, i) => 10 + i * 0.5)
    const meter = meterFromBeats(beats, 2, '4/4')!
    expect(meter.bpm).toBe(120)
    expect(meter.downbeat).toBeCloseTo(9)
    expect(beatPosition(meter, 11) % 4).toBeCloseTo(0)
  })

  it('lays the rhythm on the meter', () => {
    const three = rhythmGrid(waltz(), analyseMeter(waltz())!)
    expect(three.strengths).toEqual([3, 1, 2, 1, 2, 1])
    expect(rhythmGridToText(three)).toBe('3/4, quarter = 150, straight  |x. x. x.|')
    const six = rhythmGrid(sixEight(), analyseMeter(sixEight())!)
    expect(six.slotsPerBeat).toBe(3)
    expect(rhythmGridToText(six)).toBe('6/8, dotted quarter = 80, straight  |xxx xxx|')
    const swung = rhythmGrid(swing(), analyseMeter(swing())!, { bars: 2 })
    expect(swung.slotsPerBeat).toBe(3)
    expect(swung.bars).toHaveLength(2)
    expect(rhythmGridToText(swung)).toBe('4/4, quarter = 120, swing  |x.x x.x x.. x.x|')
  })
})

/* ---------- the written score ---------- */

function expectWellFormed(score: Score): void {
  for (const bar of score.bars) {
    expect(bar.voices).toHaveLength(score.staves.length)
    for (const voice of bar.voices) {
      expect(toNumber(voiceLength(voice))).toBeCloseTo(toNumber(score.barLength), 9)
      let at = 0
      for (const event of voice) {
        expect(toNumber(event.start)).toBeCloseTo(at, 9)
        at += toNumber(event.duration)
      }
    }
  }
}
/** Length of every bar of an ABC body in sixteenths, tuplets included. */
function abcBarLengths(abc: string): number[] {
  const body = abc.split('\n').filter((l) => !/^([A-Za-z]:|%%)/.test(l))
  return body.flatMap((line) =>
    line
      .replace(/^\[V:\d+\]/, '')
      .replace(/"[^"]*"/g, '')
      .split('|')
      .map((bar) => bar.trim())
      .filter((bar) => bar && bar !== ']')
      .map((bar) => {
        let total = 0
        let scale = 1
        let left = 0
        for (const m of bar.matchAll(/\((\d):(\d):(\d)|(\[[^\]]+\]|[\^_=]*[A-Ga-gz][,']*)(\d*)/g)) {
          if (m[1]) {
            scale = Number(m[2]) / Number(m[1])
            left = Number(m[3])
            continue
          }
          total += Number(m[5] || 1) * (left > 0 ? scale : 1)
          if (left > 0) left--
        }
        return total
      }),
  )
}

describe('score', () => {
  it('splits and ties values so the beat stays visible', () => {
    // 4/4 in sixteenths.
    expect(splitMetric(4, 12, false, '4/4')).toEqual([[4, 12]]) // quarter-half-quarter is fine
    expect(splitMetric(2, 6, false, '4/4')).toEqual([[2, 6]]) // eighth-quarter-eighth too
    expect(splitMetric(6, 10, false, '4/4')).toEqual([[6, 8], [8, 10]]) // but beat three must show
    expect(splitMetric(2, 10, false, '4/4')).toEqual([[2, 8], [8, 10]])
    expect(splitMetric(0, 10, false, '4/4')).toEqual([[0, 8], [8, 10]])
    expect(splitMetric(3, 5, false, '4/4')).toEqual([[3, 4], [4, 5]])
    expect(splitMetric(0, 16, false, '4/4')).toEqual([[0, 16]])
    expect(splitMetric(1, 16, false, '4/4')).toEqual([[1, 4], [4, 8], [8, 16]])
    // Compound time never hides a dotted beat.
    expect(splitMetric(4, 8, false, '6/8')).toEqual([[4, 6], [6, 8]])
    expect(splitMetric(0, 8, false, '6/8')).toEqual([[0, 6], [6, 8]])
    expect(splitMetric(0, 12, false, '6/8')).toEqual([[0, 12]])
    expect(splitMetric(2, 10, false, '3/4')).toEqual([[2, 8], [8, 10]])
    // Rests are grouped by beat and never dotted in simple time.
    expect(splitMetric(0, 12, true, '4/4')).toEqual([[0, 8], [8, 12]])
    expect(splitMetric(4, 12, true, '4/4')).toEqual([[4, 8], [8, 12]])
    expect(splitMetric(2, 8, true, '4/4')).toEqual([[2, 4], [4, 8]])
    expect(splitMetric(0, 8, true, '3/4')).toEqual([[0, 4], [4, 8]])
    expect(splitMetric(0, 6, true, '6/8')).toEqual([[0, 6]])
  })

  it('writes a scale in quarters exactly', () => {
    const scale = play(MAJOR.map((s, i): Hit => [i, 1, [62 + s]]), 0.5, 0)
    const score = buildScore(scale, { quarterSeconds: 0.5, origin: 0, chords: false })
    expect(score.key.name).toBe('D major')
    expect(score.staves).toEqual([{ clef: 'treble', octaveShift: 0 }])
    // F sharp and C sharp are in the signature, so no accidentals are written.
    expect(scoreToAbc(score)).toBe(['X:1', 'M:4/4', 'L:1/16', 'Q:1/4=120', 'K:D clef=treble', 'D4 E4 F4 G4 | A4 B4 c4 d4 |]'].join('\n'))
  })

  it('writes syncopation with ties at the beat, rests grouped, and beams by beat', () => {
    const hits: Hit[] = [
      [0, 0.5, [60]], [0.5, 0.5, [62]], [1, 0.5, [64]], [1.5, 1.5, [65]], // the F is held over beat three
      [4, 1, [67]], [5, 0.25, [69]], [5.25, 0.25, [71]], [5.5, 0.5, [72]], // then a rest to the end of the bar
    ]
    const score = buildScore(play(hits, 0.5, 0), { quarterSeconds: 0.5, origin: 0, chords: false, key: parseKey('C major')! })
    expectWellFormed(score)
    expect(scoreToAbc(score).split('\n').at(-1)).toBe('C2D2 E2F2- F4 z4 | G4 ABc2 z8 |]')
    const first = score.bars[0]!.voices[0]!
    expect(first.map((e) => e.beam)).toEqual(['begin', 'end', 'begin', 'end', undefined, undefined])
    expect(first[3]).toMatchObject({ tie: true, tied: false })
    expect(first[4]).toMatchObject({ tie: false, tied: true, dots: 0 })
  })

  it('writes accidentals once per bar and cancels them', () => {
    // G major: F natural needs a sign, the F sharp after it needs one back, and the next bar starts clean.
    const hits: Hit[] = [[0, 1, [67]], [1, 1, [65]], [2, 1, [64]], [3, 1, [66]], [4, 1, [66]], [5, 1, [70]], [6, 1, [70]], [7, 1, [69]]]
    const score = buildScore(play(hits, 0.5, 0), { quarterSeconds: 0.5, origin: 0, chords: false, key: parseKey('G major')! })
    expect(scoreToAbc(score).split('\n').at(-1)).toBe('G4 =F4 E4 ^F4 | F4 _B4 B4 A4 |]')
  })

  it.each([
    ['4/4', commonTime, 8],
    ['3/4', waltz, 8],
    ['6/8', sixEight, 8],
    ['4/4 swing', swing, 8],
  ] as const)('fills every bar of jittered %s exactly', (label, make, bars) => {
    const { score, meter } = transcribe(humanise(make(), 0.012, 21))
    expect(`${meter!.timeSignature}${meter!.swing ? ' swing' : ''}`).toBe(label)
    expect(score.bars).toHaveLength(bars)
    expectWellFormed(score)
    const abc = scoreToAbc(score)
    const expected = toNumber(score.barLength) * 16
    for (const length of abcBarLengths(abc)) expect(length).toBeCloseTo(expected, 6)
    expect(abc).toContain(`M:${meter!.timeSignature}`)
  })

  it('writes the waltz as a grand staff in C with chord symbols', () => {
    const { score, key } = transcribe(humanise(waltz(), 0.01, 8), { instrument: 'piano' })
    expect(key?.name).toBe('C major')
    expect(score.staves.map((s) => s.clef)).toEqual(['treble', 'bass'])
    const abc = scoreToAbc(score)
    expect(abc).toContain('%%score {1 | 2}')
    expect(abc).toContain('V:2 clef=bass')
    expect(abc).toContain('M:3/4')
    expect(abc).toContain('[V:2] C,,4')
    // Left hand: the bass note on one, then rests. Right hand: tune, then the chords on two and three.
    expect(score.bars[0]!.voices[1]!.map((e) => e.pitches.length)).toEqual([1, 0, 0])
    expect(score.bars[0]!.voices[0]!.map((e) => e.pitches.length)).toEqual([1, 3, 4])
    expect(score.bars.flatMap((b) => b.chords.map((c) => c.symbol)).slice(0, 3)).toEqual(['C', 'F', 'G'])
    expect(abc.split('\n').filter((l) => l.startsWith('[V:1]'))).toHaveLength(2) // eight bars on two lines
  })

  it('writes 6/8 with dotted beats, beamed in threes, in A minor', () => {
    const { score, key } = transcribe(humanise(sixEight(), 0.01, 8), { staff: 'treble', chords: [] })
    expect(key?.name).toBe('A minor')
    const abc = scoreToAbc(score)
    expect(abc).toContain('M:6/8')
    expect(abc).toContain('Q:3/8=80')
    expect(abc).toContain('K:Am clef=treble')
    // Beams start on the dotted beats.
    for (const bar of score.bars) {
      for (const event of bar.voices[0]!) if (event.beam === 'begin') expect([0, 3 / 8]).toContain(toNumber(event.start))
    }
    // G sharp in the E major bar, written as a sharp.
    expect(abc).toMatch(/\^g/)
    expect(abc).not.toMatch(/_A/)
  })

  it('writes swing as plain eighths with a swing marking, and real triplets as triplets', () => {
    const swung = transcribe(humanise(swing(), 0.01, 8), { staff: 'treble', chords: [] })
    const abc = scoreToAbc(swung.score)
    expect(abc).toContain('Q:"Swing" 1/4=120')
    expect(abc).not.toContain('(3')
    expect(swung.score.bars.flatMap((b) => b.voices[0]!).every((e) => !e.tuplet)).toBe(true)

    // Straight 4/4 with one beat of triplets and one long-short triplet.
    const hits: Hit[] = [[0, 1, [60]], [1, 1 / 3, [62]], [1 + 1 / 3, 1 / 3, [64]], [1 + 2 / 3, 1 / 3, [65]], [2, 0.5, [67]], [2.5, 0.5, [65]], [3, 2 / 3, [64]], [3 + 2 / 3, 1 / 3, [62]], [4, 4, [60]]]
    const straight = transcribe(humanise(play(hits, 0.5, 0), 0.006, 2), { quarterSeconds: 0.5, origin: 0, key: 'C major', chords: [] })
    expectWellFormed(straight.score)
    expect(scoreToAbc(straight.score).split('\n').at(-1)).toBe('C4 (3:2:3D2E2F2 G2F2 (3:2:2E4 D2 | C16 |]')
    expect(straight.score.bars[0]!.voices[0]![1]).toMatchObject({ duration: { n: 1, d: 12 }, value: { n: 1, d: 8 }, tuplet: { role: 'start', size: 3 } })
  })

  it('chooses the staff for the instrument', () => {
    const low = play([[0, 1, [40]], [1, 1, [43]], [2, 1, [45]], [3, 1, [47]]], 0.5, 0)
    const guitar = buildScore(low, { instrument: 'guitar', quarterSeconds: 0.5, origin: 0, chords: false, key: parseKey('E minor')! })
    expect(guitar.staves).toEqual([{ clef: 'treble-8', octaveShift: 1 }])
    // Guitar music is written an octave above where it sounds.
    expect(scoreToAbc(guitar)).toContain('K:Em clef=treble-8\nE,4 G,4 A,4 B,4 |]')
    const bass = buildScore(low.map((n) => ({ ...n, pitch: n.pitch - 12 })), { instrument: 'bass', quarterSeconds: 0.5, origin: 0, chords: false, key: parseKey('E minor')! })
    expect(bass.staves).toEqual([{ clef: 'bass', octaveShift: 1 }])
    expect(scoreToAbc(bass)).toContain('K:Em clef=bass\nE,,4 G,,4 A,,4 B,,4 |]')
    expect(buildScore(low, { chords: false }).staves[0]!.clef).toBe('bass')
  })

  it('keeps only the last bars when asked and survives empty input', () => {
    const { score } = transcribe(commonTime(), { bars: 3 })
    expect(score.bars.map((b) => b.number)).toEqual([6, 7, 8])
    expectWellFormed(score)
    const empty = buildScore([])
    expect(scoreToAbc(empty)).toBe(['X:1', 'M:4/4', 'L:1/16', 'Q:1/4=120', 'K:C clef=treble', 'z16 |]'].join('\n'))
  })

  it('writes a bare chord list as one bar each', () => {
    const { notes, chords, options } = chordsAsNotes(['Dm7', 'G7', 'Cmaj7'])
    const { score } = transcribe(notes, { ...options, chords })
    expect(score.bars).toHaveLength(3)
    expect(score.bars.map((b) => b.chords[0]?.symbol)).toEqual(['Dm7', 'G7', 'Cmaj7'])
    expect(scoreToAbc(score)).toContain('"Dm7"')
    expect(score.staves).toEqual([{ clef: 'treble', octaveShift: 0 }])
    // For the guitar the same list comes out as the shapes a player would use.
    const guitar = chordsAsNotes(['G', 'CM', 'D7'], 'guitar')
    const { tab } = transcribeTab(guitar.notes, { ...guitar.options, chords: guitar.chords })
    expect(tab.bars.map((b) => frets({ positions: b.events[0]!.positions }))).toEqual(['320003', 'x32010', 'xx0212'])
  })

  it('reads view options defensively', () => {
    expect(readNotationOptions({ notation: { instrument: 'bass', capo: 2, timeSignature: '6/8', key: 'F# minor', tuning: 'drop-d', junk: 1 } })).toEqual({
      instrument: 'bass',
      capo: 2,
      timeSignature: '6/8',
      key: 'F# minor',
      tuning: 'drop-d',
    })
    expect(readNotationOptions({ notation: { timeSignature: '5/4', key: 'H', instrument: 'kazoo' } })).toEqual({})
    expect(readNotationOptions(undefined)).toEqual({})
  })
})

/** Minimal XML well-formedness check: tags balance and nest, attributes are quoted, text is escaped. */
function parseXml(xml: string): { tags: string[]; root: string } {
  const body = xml.replace(/<\?xml[^?]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '')
  const stack: string[] = []
  const tags: string[] = []
  let root = ''
  let last = 0
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w-]*)((?:\s+[\w-]+="[^"<&]*")*)\s*(\/?)>/g)) {
    const between = body.slice(last, m.index)
    if (/[<>]/.test(between) || /&(?!amp;|lt;|gt;|quot;)/.test(between)) throw new Error(`stray markup before <${m[2]}>: ${between.slice(0, 40)}`)
    last = m.index + m[0].length
    if (m[1]) {
      if (stack.pop() !== m[2]) throw new Error(`mismatched </${m[2]}>`)
    } else {
      if (stack.length === 0) {
        if (root) throw new Error('two roots')
        root = m[2]!
      }
      tags.push(m[2]!)
      if (!m[4]) stack.push(m[2]!)
    }
  }
  if (stack.length) throw new Error(`unclosed <${stack.at(-1)}>`)
  if (/[<>]/.test(body.slice(last))) throw new Error('trailing markup')
  return { tags, root }
}

describe('MusicXML', () => {
  it('is well formed and carries key, time, staves, ties, tuplets and harmony', () => {
    const { score } = transcribe(humanise(waltz(), 0.01, 8), { instrument: 'piano', title: 'Waltz & <friends>' })
    const xml = scoreToMusicXml(score)
    const { tags, root } = parseXml(xml)
    expect(root).toBe('score-partwise')
    expect(tags.filter((t) => t === 'measure')).toHaveLength(8)
    expect(xml).toContain('<work-title>Waltz &amp; &lt;friends&gt;</work-title>')
    expect(xml).toContain('<key><fifths>0</fifths><mode>major</mode></key>')
    expect(xml).toContain('<time><beats>3</beats><beat-type>4</beat-type></time>')
    expect(xml).toContain('<staves>2</staves>')
    expect(xml).toContain('<clef number="2"><sign>F</sign><line>4</line></clef>')
    expect(xml).toContain('<harmony><root><root-step>F</root-step></root><kind text="">major</kind></harmony>')
    expect(tags.filter((t) => t === 'backup')).toHaveLength(8)
    // Every measure's first voice lasts exactly one bar (12 divisions to the quarter).
    for (const measure of xml.split('<measure').slice(1)) {
      const voice1 = measure.split('<backup>')[0]!
      const total = [...voice1.matchAll(/<note>(?!<chord\/>).*?<duration>(\d+)<\/duration>/g)].reduce((s, m) => s + Number(m[1]), 0)
      expect(total).toBe(36)
    }
  })

  it('marks tuplets, ties, accidentals and transposing clefs', () => {
    const hits: Hit[] = [[0, 1, [61]], [1, 1 / 3, [62]], [1 + 1 / 3, 1 / 3, [64]], [1 + 2 / 3, 1 / 3, [65]], [2, 3, [67]], [5, 3, [60]]]
    const { score } = transcribe(play(hits, 0.5, 0), { quarterSeconds: 0.5, origin: 0, key: 'C major', instrument: 'guitar', chords: [] })
    const xml = scoreToMusicXml(score)
    parseXml(xml)
    expect(xml).toContain('<clef-octave-change>-1</clef-octave-change>')
    expect(xml).toContain('<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>')
    expect(xml).toContain('<tuplet type="start"/>')
    expect(xml).toContain('<tuplet type="stop"/>')
    expect(xml).toContain('<tied type="start"/>')
    expect(xml).toContain('<tie type="stop"/>')
    expect(xml).toContain('<accidental>sharp</accidental>')
    expect(xml).toContain('<beam number="1">begin</beam>')
  })
})

/* ---------- tablature ---------- */

const frets = (shape: { positions: Array<{ string: number; fret: number }> }, strings = 6): string =>
  Array.from({ length: strings }, (_, s) => shape.positions.find((p) => p.string === s)?.fret ?? 'x').join('')

describe('tablature', () => {
  it.each([
    ['C', [48, 52, 55, 60, 64], 'x32010'],
    ['G', [43, 47, 50, 55, 59, 67], '320003'],
    ['Am', [45, 52, 57, 60, 64], 'x02210'],
    ['E', [40, 47, 52, 56, 59, 64], '022100'],
    ['D', [50, 57, 62, 66], 'xx0232'],
    ['F', [41, 48, 53, 57, 60, 65], '133211'],
    ['B7', [47, 51, 57, 59, 66], 'x21202'],
  ])('plays %s as the usual shape', (name, pitches, expected) => {
    const [shape] = arrangeTab([pitches], { instrument: 'guitar' })
    expect(frets(shape!)).toBe(expected)
    expect(shape!.shape).toBe(name)
  })

  it('keeps chords playable: one note per string, within a hand span', () => {
    const groups = [[52, 59, 64, 68], [57, 61, 64, 69], [50, 54, 57, 62, 66], [45, 52, 55, 60, 64], [43, 50, 55, 59, 62, 67]]
    for (const shape of arrangeTab(groups, { instrument: 'guitar' })) {
      const strings = shape.positions.map((p) => p.string)
      expect(new Set(strings).size).toBe(strings.length)
      const fretted = shape.positions.filter((p) => p.fret > 0).map((p) => p.fret)
      expect(Math.max(...fretted) - Math.min(...fretted)).toBeLessThanOrEqual(4)
      for (const p of shape.positions) expect([40, 45, 50, 55, 59, 64][p.string]! + p.fret).toBe(p.pitch)
    }
  })

  it('plays a scale in one position', () => {
    // C major from C3: the open-position fingering every guitarist learns.
    const scale = arrangeTab(MAJOR.map((s) => [48 + s]), { instrument: 'guitar' })
    expect(scale.map((s) => `${s.positions[0]!.string}:${s.positions[0]!.fret}`)).toEqual(['1:3', '2:0', '2:2', '2:3', '3:0', '3:2', '4:0', '4:1'])
    expect(new Set(scale.map((s) => s.hand)).size).toBe(1)
    // Two octaves of G major: the greedy way jumps about; the planned way moves the hand at most twice.
    const twoOctaves = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24].map((s) => [43 + s])
    const run = arrangeTab(twoOctaves, { instrument: 'guitar' })
    const shifts = run.filter((s, i) => i > 0 && s.hand !== run[i - 1]!.hand).length
    expect(shifts).toBeLessThanOrEqual(2)
    for (const s of run) {
      const f = s.positions[0]!.fret
      expect(f === 0 || (f >= s.hand && f <= s.hand + 3)).toBe(true)
    }
  })

  it('takes a hand-position hint, a capo and other tunings', () => {
    // E4 is the open first string, but with the hand at the ninth fret it is on the G string.
    expect(arrangeTab([[64]], { instrument: 'guitar' })[0]!.positions[0]).toMatchObject({ string: 5, fret: 0 })
    expect(arrangeTab([[64]], { instrument: 'guitar', hand: { fret: 9 } })[0]!.positions[0]).toMatchObject({ string: 3, fret: 9 })
    const high = arrangeTab(MAJOR.map((s) => [60 + s]), { instrument: 'guitar', hand: { fret: 7 } })
    expect(high.every((s) => s.hand >= 5 && s.hand <= 8)).toBe(true)
    // Capo on 2: an E major chord is the D shape, counted from the capo.
    const [capoed] = arrangeTab([[52, 59, 64, 68]], { instrument: 'guitar', capo: 2 })
    expect(frets(capoed!)).toBe('xx0232')
    expect(capoed!.shape).toBe('D')
    // Drop D: the low D is the open sixth string.
    expect(arrangeTab([[38]], { instrument: 'guitar', tuning: [38, 45, 50, 55, 59, 64] })[0]!.positions[0]).toMatchObject({ string: 0, fret: 0 })
    // Bass: a walking line stays in first position.
    const line = arrangeTab([[28], [32], [35], [37], [40], [37], [35], [32]], { instrument: 'bass' })
    expect(line.map((s) => `${s.positions[0]!.string}:${s.positions[0]!.fret}`)).toEqual(['0:0', '0:4', '1:2', '1:4', '2:2', '1:4', '1:2', '0:4'])
    // A note below the instrument is moved up an octave rather than dropped.
    expect(arrangeTab([[36]], { instrument: 'guitar' })[0]!.positions[0]!.pitch).toBe(48)
  })

  it('draws tab as a staff with rhythm and exports text with bar lines', () => {
    const hits: Hit[] = [[0, 2, [48, 52, 55, 60, 64]], [2, 0.5, [60]], [2.5, 0.5, [62]], [3, 1, [64]], [4, 1.5, [55]], [5.5, 0.5, [57]], [6, 2, [43, 47, 50, 55, 59, 67]]]
    const { tab, score } = transcribeTab(play(hits, 0.5, 0), { quarterSeconds: 0.5, origin: 0, key: 'C major', chords: [{ symbol: 'CM', start: 0, end: 1, pitchClasses: [0, 4, 7] }] })
    expect(score.staves[0]!.clef).toBe('treble-8')
    expect(tab.stringNames).toEqual(['E', 'A', 'D', 'G', 'B', 'e'])
    expect(tab.bars).toHaveLength(2)
    expect(frets({ positions: tab.bars[0]!.events[0]!.positions })).toBe('x32010')
    const svg = tabToSvg(tab)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    parseXml(svg)
    expect(svg.match(/<line [^>]*stroke="#8a8a8a"/g)).toHaveLength(6) // six strings, one system
    expect(svg).toContain('>C</text>') // chord symbol
    expect(svg).toContain('>3</text>')
    expect(tabToText(tab)).toBe(
      [
        '4/4, 120 bpm',
        '',
        '    C',
        'e |-0-----------0---|---------3-------|',
        'B |-1-------1-3-----|---------0-------|',
        'G |-0---------------|-0-----2-0-------|',
        'D |-2---------------|---------0-------|',
        'A |-3---------------|---------2-------|',
        'E |-----------------|---------3-------|',
      ].join('\n'),
    )
    const bass = transcribeTab(play([[0, 1, [28]], [1, 1, [31]], [2, 1, [33]], [3, 1, [35]]], 0.5, 0), { instrument: 'bass', quarterSeconds: 0.5, origin: 0, capo: 0 })
    expect(bass.tab.stringNames).toEqual(['E', 'A', 'D', 'G'])
    expect(tabToText(bass.tab).split('\n').at(-1)).toBe('E |-0---3-----------|')
  })

  it('keeps tab and sheet on the same rhythm', () => {
    const { tab, score } = transcribeTab(humanise(sixEight(), 0.01, 3), { instrument: 'guitar' })
    expect(tab.meter.timeSignature).toBe('6/8')
    tab.bars.forEach((bar, i) => {
      expect(bar.events.map((e) => toNumber(e.start))).toEqual(score.bars[i]!.voices[0]!.map((e) => toNumber(e.start)))
      // Every sounding event gets fret numbers; a stretch no hand can make loses its inner notes, never all of them.
      for (const e of bar.events) {
        expect(e.positions.length).toBeLessThanOrEqual(e.pitches.length)
        expect(e.positions.length > 0).toBe(e.pitches.length > 0)
      }
    })
  })
})

describe('fixed meter', () => {
  it('builds a steady grid', () => {
    const meter = fixedMeter('6/8', 80, 1, 5)
    expect(meter.beats[0]).toBe(1)
    expect(meter.beatSeconds).toBeCloseTo(0.75)
    expect(meter.beats.at(-1)!).toBeGreaterThan(5)
  })
})

/* ---------- the agent's tools ---------- */

describe('notation tools', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'jam-notation-'))
    const events: MainEvent[] = []
    const transcript = new Transcript()
    const module = notation({
      playback: new Playback(() => undefined),
      transcript,
      memory: new TasteMemory(dir),
      now: () => 22,
      emit: (e) => events.push(e),
      bus: new FeatureBus(() => {}),
      saveMidi: async () => '',
    })!
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const found = module.tools.find((t) => t.name === name)!
      const result = await found.handler(z.object(found.inputSchema).parse(args), {})
      return (result.content[0] as { text: string }).text
    }
    return { transcript, events, call, dir, module }
  }

  it('reads key and meter of the playing', async () => {
    const { transcript, call, module } = setup()
    expect(await call('read_music', {})).toMatch(/^Nothing heard/)
    transcript.add(humanise(sixEight(), 0.01, 5))
    const reading = await call('read_music', { include_bars: true })
    expect(reading).toContain('Key: A minor')
    expect(reading).toContain('relative C major')
    expect(reading).toMatch(/Meter: 6\/8 \((clear|fairly sure)\), dotted quarter = 80, straight/)
    expect(reading).toContain('Rhythm of a typical bar: |xxx xxx|')
    expect(reading).toContain('Bar lines: one 0.00s before the first note, then every 1.50s')
    expect(reading).toContain('M:6/8')
    expect(module.guide).toContain('- notate:')
  })

  it('opens views with the choices asked for', async () => {
    const { events, call } = setup()
    expect(await call('notate', { view: 'tab', instrument: 'bass', capo: 2, time_signature: '6/8' })).toBe('Showing tab (live) with instrument bass, timeSignature 6/8, capo 2.')
    expect(events[0]).toMatchObject({ type: 'show-view', view: 'tab', instrument: 'bass' })
    // The options survive the trip to the window as plain data.
    const data = events[0]!.type === 'show-view' ? events[0]!.data : null
    expect(readNotationOptions(JSON.parse(JSON.stringify(data)))).toEqual({ instrument: 'bass', timeSignature: '6/8', capo: 2 })
    expect(await call('notate', { view: 'sheet', key: 'H minor' })).toMatch(/can't read "H minor"/)
    await call('notate', { view: 'sheet', chords: ['Dm7', 'G7'] })
    expect(events[1]).toMatchObject({ view: 'sheet', chords: ['Dm7', 'G7'] })
  })

  it('exports MusicXML, ABC and tab files', async () => {
    const { transcript, call, dir } = setup()
    process.env.JAM_DATA_DIR = dir
    try {
      transcript.add(humanise(waltz(), 0.01, 5))
      expect(await call('export_notation', { format: 'musicxml', name: 'My Waltz', instrument: 'piano' })).toMatch(/^Saved C major, 3\/4, 8 bars as .*My Waltz\.musicxml\.$/)
      expect(await call('export_notation', { format: 'abc', name: 'My Waltz' })).toContain('.abc')
      const riff = [{ pitch: 55, startBeat: 0, durationBeats: 1 }, { pitch: 58, startBeat: 1, durationBeats: 1 }]
      expect(await call('export_notation', { format: 'tab', name: 'Riff', capo: 3, notes: riff })).toMatch(/guitar tab, 1 bars/)
      const files = readdirSync(join(dir, 'ideas')).sort()
      expect(files.map((f) => f.replace(/^[\d-]+ /, ''))).toEqual(['My Waltz.abc', 'My Waltz.musicxml', 'Riff.tab.txt'])
      const xml = readFileSync(join(dir, 'ideas', files.find((f) => f.endsWith('.musicxml'))!), 'utf8')
      expect(parseXml(xml).root).toBe('score-partwise')
      expect(xml).toContain('<work-title>My Waltz</work-title>')
      expect(readFileSync(join(dir, 'ideas', files.find((f) => f.endsWith('.txt'))!), 'utf8')).toContain('capo 3')
    } finally {
      delete process.env.JAM_DATA_DIR
    }
  })
})
