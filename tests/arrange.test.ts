import { Playback } from '../src/main/playback'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { MainEvent } from '@shared/ipc'
import {
  BASS_HIGH,
  BASS_LOW,
  BASS_STYLES,
  COMPING_STYLES,
  DRUM_STYLES,
  GM,
  STRATEGIES,
  createArrangement,
  describeArrangement,
  foldRepeats,
  generateBass,
  generateComping,
  generateDrums,
  guessKey,
  parseChord,
  parseKey,
  pcOf,
  progressionFromSpans,
  progressionText,
  reharmonize,
  renderArrangement,
  segments,
  spell,
  strategyNames,
  toSlots,
  totalBeats,
  transposeArrangement,
  voiceLead,
  withLayer,
  withProgression,
  type ChordSlot,
  type KeySpec,
} from '@shared/music/arrange'
import { clipLengthBeats, clipToMidi } from '@shared/music/clip'
import { chordPitches } from '@shared/music/render'
import { Transcript } from '@shared/music/transcript'
import type { Clip, ClipTrack } from '@shared/music/types'
import type { ToolContext } from '../src/main/agent/toolkit'
import { arrange } from '../src/main/agent/tools/arrange'
import { FeatureBus } from '../src/main/bus'
import { TasteMemory } from '../src/main/memory/taste'

const C: KeySpec = { tonic: 'C', mode: 'major' }
const symbols = (slots: ChordSlot[]) => slots.map((s) => s.symbol)
const pc = (pitch: number) => ((pitch % 12) + 12) % 12

const PROGRESSIONS: Array<[chords: string[], beats: number | number[]]> = [
  [['C', 'Am', 'F', 'G'], 4],
  [['Dm7', 'G7', 'Cmaj7'], [4, 4, 8]],
  [['Am', 'F', 'C', 'G'], 4],
  [['Am', 'Dm', 'E7', 'Am'], 4],
  [['Cm7', 'Fm7', 'Dm7b5', 'G7'], 4],
  [['E', 'A', 'B7', 'E'], 2],
  [['F#m', 'D', 'A', 'E'], 4],
  [['Bbmaj7', 'Gm7', 'Cm7', 'F7', 'Dm7', 'G7', 'Cm7', 'F7'], 2],
  [['Ebm', 'Abm7', 'Bb7', 'Cb'], [3, 3, 3, 3]],
  [['C7', 'F7', 'C7', 'G7', 'F7', 'C7'], [8, 8, 8, 4, 4, 8]],
  [['Gsus4', 'G', 'Em/G', 'Caug', 'D5'], 4],
  [['A'], 8],
]

describe('theory', () => {
  it('reads chord symbols', () => {
    expect(parseChord('Dm7')).toMatchObject({ root: 'D', suffix: 'm7', kind: 'min', hasSeventh: true, bass: null })
    expect(parseChord('G7/B')).toMatchObject({ root: 'G', kind: 'dom', bass: 'B' })
    expect(parseChord('CM')).toMatchObject({ suffix: '', kind: 'maj', hasSeventh: false })
    expect(parseChord('Bm7b5')?.kind).toBe('hdim')
    expect(parseChord('Bdim7')?.kind).toBe('dim')
    expect(parseChord('Csus4')?.kind).toBe('sus')
    expect(parseChord('H7')).toBeNull()
  })

  it('reads and guesses keys', () => {
    expect(parseKey('C major')).toEqual({ tonic: 'C', mode: 'major' })
    expect(parseKey('F# minor')).toEqual({ tonic: 'F#', mode: 'minor' })
    expect(parseKey('Bbm')).toEqual({ tonic: 'Bb', mode: 'minor' })
    expect(parseKey('b flat')).toEqual({ tonic: 'Bb', mode: 'major' })
    expect(parseKey('whatever')).toBeNull()
    expect(guessKey(['C', 'Am', 'F', 'G'])).toEqual({ tonic: 'C', mode: 'major' })
    expect(guessKey(['Dm7', 'G7', 'Cmaj7'])).toEqual({ tonic: 'C', mode: 'major' })
    expect(guessKey(['Am', 'Dm', 'E7', 'Am'])).toEqual({ tonic: 'A', mode: 'minor' })
    expect(guessKey(['F#m', 'D', 'A', 'E'])).toEqual({ tonic: 'F#', mode: 'minor' })
  })

  it('spells chromatic roots the usual way', () => {
    expect(spell(pcOf('F#'), C)).toBe('F#')
    expect(spell(pcOf('Bb'), C)).toBe('Bb')
    expect(spell(pcOf('G#'), { tonic: 'A', mode: 'minor' })).toBe('G#')
    expect(spell(pcOf('C#'), C, 'sharp')).toBe('C#')
    expect(spell(pcOf('F'), { tonic: 'F#', mode: 'major' })).toBe('F') // not E#
  })
})

describe('reharmonization', () => {
  it('every strategy keeps the length and returns chords that can be voiced', () => {
    for (const strategy of strategyNames()) {
      for (const [chords, beats] of PROGRESSIONS) {
        for (const seed of [1, 2, 3]) {
          for (const amount of [0.2, 1]) {
            const input = toSlots(chords, beats)
            const { slots } = reharmonize(input, strategy, { seed, amount })
            const label = `${strategy} on ${chords.join(' ')}`
            expect(totalBeats(slots), label).toBe(totalBeats(input))
            for (const slot of slots) {
              expect(chordPitches(slot.symbol).length, `${label}: ${slot.symbol}`).toBeGreaterThanOrEqual(2)
              expect(Number.isInteger(slot.beats) && slot.beats >= 1, `${label}: ${slot.symbol} lasts ${slot.beats}`).toBe(true)
            }
          }
        }
      }
    }
  })

  it('is repeatable for a seed and changes something on ordinary progressions', () => {
    const input = toSlots(['C', 'Am', 'F', 'G'], 4)
    for (const strategy of strategyNames()) {
      expect(reharmonize(input, strategy, { seed: 7 })).toEqual(reharmonize(input, strategy, { seed: 7 }))
    }
    const jazz = toSlots(['Dm7', 'G7', 'Cmaj7', 'A7'], 4)
    for (const strategy of strategyNames()) {
      expect(reharmonize(input, strategy).changed || reharmonize(jazz, strategy).changed, strategy).toBe(true)
    }
    expect(() => reharmonize(input, 'nope')).toThrow(/Unknown/)
    expect(new Set(STRATEGIES.map((s) => s.name)).size).toBe(STRATEGIES.length)
  })

  const run = (chords: string[], strategy: string, beats: number | number[] = 4, key: KeySpec = C, amount = 1) =>
    progressionText(reharmonize(toSlots(chords, beats), strategy, { key, amount }).slots)

  it('does what each strategy says', () => {
    expect(run(['Dm7', 'G7', 'Cmaj7'], 'tritone_sub')).toBe('Dm7(4) Db7(4) Cmaj7(4)')
    expect(run(['Dm7', 'G7', 'Cmaj7'], 'backdoor')).toBe('Dm7(4) Bb7(4) Cmaj7(4)')
    expect(run(['C', 'Am', 'F', 'G'], 'sevenths')).toBe('Cmaj7(4) Am7(4) Fmaj7(4) G7(4)')
    expect(run(['Cmaj7', 'Am7', 'Dm7', 'G7'], 'simplify')).toBe('C(4) Am(4) Dm(4) G(4)')
    expect(run(['C', 'Am'], 'secondary_dominants', [4, 4])).toBe('C(2) E7(2) Am(2) G7(2)')
    expect(run(['C', 'Dm'], 'passing_diminished', [4, 4])).toContain('C(2) C#dim7(2) Dm')
    // Into a major chord: a major two-five. Into a minor chord: the minor one.
    expect(run(['Cmaj7', 'Fmaj7'], 'two_five', [8, 8])).toContain('Cmaj7(4) Gm7(2) C7(2) Fmaj7')
    expect(run(['Cmaj7', 'Dm7'], 'two_five', [8, 8])).toContain('Cmaj7(4) Em7b5(2) A7b9(2) Dm7')
    // Only room for one chord: just the dominant.
    expect(run(['Cmaj7', 'Fmaj7'], 'two_five', [2, 6])).toContain('Cmaj7(1) C7(1) Fmaj7')
    const borrowed = run(['C', 'F', 'Am', 'G'], 'modal_interchange')
    expect(borrowed).toContain('Fm(4)')
    expect(borrowed).toContain('Ab(4)')
    expect(run(['Am', 'Dm', 'E7', 'Am'], 'colour', 4, { tonic: 'A', mode: 'minor' })).toContain('E7b9')
    expect(run(['C', 'Am', 'F', 'G'], 'diatonic_sub').startsWith('C(4)')).toBe(true)
  })

  it('amount controls how much changes', () => {
    const input = toSlots(['C', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'], 4)
    const changed = (amount: number) => reharmonize(input, 'sevenths', { key: C, amount }).slots.filter((s, i) => s.symbol !== input[i]!.symbol).length
    expect(changed(0)).toBe(1)
    expect(changed(0.5)).toBe(4)
    expect(changed(1)).toBe(8)
  })

  it('strategies stack', () => {
    let slots = toSlots(['C', 'Am', 'F', 'G'], 4)
    for (const strategy of ['sevenths', 'secondary_dominants', 'tritone_sub', 'colour', 'passing_diminished']) {
      slots = reharmonize(slots, strategy, { key: C }).slots
    }
    expect(totalBeats(slots)).toBe(16)
    expect(slots.length).toBeGreaterThan(4)
    for (const s of slots) expect(chordPitches(s.symbol).length).toBeGreaterThan(2)
  })
})

const JAZZ = toSlots(['Dm7', 'G7', 'Cmaj7', 'A7'], [4, 4, 6, 2])

/** Start beat of each chord in a progression. */
const chordStarts = (slots: ChordSlot[]) => {
  let at = 0
  return slots.map((s) => {
    const start = at
    at += s.beats
    return { start, symbol: s.symbol }
  })
}

describe('bass lines', () => {
  it('every style stays in the bass register, in time, on the root at each change', () => {
    for (const style of BASS_STYLES) {
      for (const [chords, beats] of PROGRESSIONS) {
        const slots = toSlots(chords, beats)
        const track = generateBass(slots, { style, seed: 3 })
        const label = `${style} on ${chords.join(' ')}`
        expect(track.role).toBe('bass')
        expect(track.notes.length, label).toBeGreaterThanOrEqual(segments(slots).slots.length)
        let end = 0
        for (const n of track.notes) {
          expect(n.pitch >= BASS_LOW && n.pitch <= BASS_HIGH, `${label}: pitch ${n.pitch}`).toBe(true)
          expect(n.startBeat, `${label}: one note at a time`).toBeGreaterThanOrEqual(end - 1e-6)
          expect(n.velocity > 0 && n.velocity <= 1).toBe(true)
          end = n.startBeat + n.durationBeats
        }
        expect(end).toBeLessThanOrEqual(totalBeats(slots) + 1e-6)
        for (const { start, symbol } of chordStarts(segments(slots).slots)) {
          const first = track.notes.find((n) => Math.abs(n.startBeat - start) < 1e-6)
          const chord = parseChord(symbol)!
          expect(first && pc(first.pitch), `${label}: downbeat of ${symbol}`).toBe(pcOf(chord.bass ?? chord.root))
        }
      }
    }
  })

  it('walks in quarter notes and approaches each new chord by step or from its fifth', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const notes = generateBass(JAZZ, { style: 'walking', seed }).notes
      expect(notes.map((n) => n.startBeat)).toEqual(Array.from({ length: 16 }, (_, i) => i))
      for (const change of [4, 8, 14]) {
        const interval = Math.abs(notes[change]!.pitch - notes[change - 1]!.pitch)
        expect([1, 5, 7], `seed ${seed}, into beat ${change}: ${interval}`).toContain(interval)
      }
      // A walking line moves: no note repeated straight away.
      notes.forEach((n, i) => i > 0 && expect(n.pitch).not.toBe(notes[i - 1]!.pitch))
    }
  })

  it('is repeatable for a seed and varies between seeds', () => {
    for (const style of BASS_STYLES) expect(generateBass(JAZZ, { style, seed: 5 })).toEqual(generateBass(JAZZ, { style, seed: 5 }))
    const lines = new Set([1, 2, 3, 4, 5, 6].map((seed) => generateBass(JAZZ, { style: 'walking', seed }).notes.map((n) => n.pitch).join(',')))
    expect(lines.size).toBeGreaterThan(2)
  })

  it('has the rhythm of its style', () => {
    const starts = (style: (typeof BASS_STYLES)[number]) => generateBass(toSlots(['C', 'F'], 4), { style }).notes.map((n) => n.startBeat)
    expect(starts('roots')).toEqual([0, 2, 4, 6])
    expect(starts('eighths')).toEqual(Array.from({ length: 16 }, (_, i) => i / 2))
    expect(starts('bossa')).toEqual([0, 1.5, 2, 3.5, 4, 5.5, 6, 7.5])
    const fifth = generateBass(toSlots(['C'], 4), { style: 'root_fifth' }).notes
    expect(fifth.slice(0, 2).map((n) => pc(n.pitch))).toEqual([0, 7])
    // Funk is syncopated: something lands off the eighth-note grid.
    expect(starts('funk').some((s) => (s * 2) % 1 !== 0)).toBe(true)
  })
})

describe('drum patterns', () => {
  const at = (track: ClipTrack, pitch: number) => track.notes.filter((n) => n.pitch === pitch).map((n) => +n.startBeat.toFixed(3))
  const kit: number[] = Object.values(GM)

  it('every style is General MIDI percussion on the drums track, with a kick on every downbeat', () => {
    for (const style of DRUM_STYLES) {
      for (const intensity of [0.1, 0.5, 0.9]) {
        const track = generateDrums(32, { style, intensity })
        expect(track.role).toBe('drums')
        for (const n of track.notes) {
          expect(kit, `${style}: ${n.pitch}`).toContain(n.pitch)
          expect(n.startBeat >= 0 && n.startBeat < 32).toBe(true)
          expect(n.velocity > 0 && n.velocity <= 1).toBe(true)
        }
        const kicks = at(track, GM.kick)
        for (let bar = 0; bar < 8; bar++) expect(kicks, `${style} bar ${bar}`).toContain(bar * 4)
        expect(generateDrums(32, { style, intensity })).toEqual(track)
      }
    }
  })

  it('puts the backbeat where the style wants it', () => {
    const plain = { fillEvery: 0, intensity: 0.5 }
    expect(at(generateDrums(8, { style: 'rock', ...plain }), GM.snare)).toEqual([1, 3, 5, 7])
    expect(at(generateDrums(8, { style: 'half_time', ...plain }), GM.snare)).toEqual([2, 6])
    expect(at(generateDrums(8, { style: 'four_on_the_floor', ...plain }), GM.kick)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    // Swing: the ride's skip note sits on the last triplet, and the hi-hat foot is on two and four.
    const swing = generateDrums(4, { style: 'swing', ...plain })
    expect(at(swing, GM.ride)).toEqual([0, 1, 1.667, 2, 3, 3.667])
    expect(at(swing, GM.pedalHat)).toEqual([1, 3])
    // Bossa: the clave on the rim takes two bars.
    expect(at(generateDrums(8, { style: 'bossa', ...plain }), GM.rim)).toEqual([0, 1.5, 3, 5, 6.5])
  })

  it('plays fills at the end of phrases, and only when asked', () => {
    const toms: number[] = [GM.highTom, GM.midTom, GM.lowTom, GM.floorTom]
    for (const style of DRUM_STYLES) {
      const none = generateDrums(32, { style, fillEvery: 0, intensity: 0.8 })
      expect(none.notes.some((n) => toms.includes(n.pitch)), style).toBe(false)
      const filled = generateDrums(32, { style, fillEvery: 4, intensity: 0.8 })
      const fillNotes = filled.notes.filter((n) => toms.includes(n.pitch))
      expect(fillNotes.length, style).toBeGreaterThan(0)
      // Only in the back half of bars four and eight.
      for (const n of fillNotes) expect((n.startBeat >= 14 && n.startBeat < 16) || (n.startBeat >= 30 && n.startBeat < 32), `${style} @${n.startBeat}`).toBe(true)
    }
    // After a fill, a crash on the next downbeat.
    expect(at(generateDrums(32, { style: 'rock', fillEvery: 4, intensity: 0.8 }), GM.crash)).toContain(16)
  })

  it('intensity makes it busier and louder', () => {
    for (const style of DRUM_STYLES) {
      const quiet = generateDrums(16, { style, intensity: 0.1, fillEvery: 0 }).notes
      const loud = generateDrums(16, { style, intensity: 1, fillEvery: 0 }).notes
      const mean = (notes: typeof quiet) => notes.reduce((s, n) => s + n.velocity, 0) / notes.length
      expect(loud.length, style).toBeGreaterThanOrEqual(quiet.length)
      expect(Math.max(...loud.map((n) => n.velocity)), style).toBeGreaterThan(Math.max(...quiet.map((n) => n.velocity)))
      expect(mean(quiet)).toBeLessThan(0.75)
    }
  })

  it('handles lengths that are not whole phrases, and three-four', () => {
    expect(Math.max(...generateDrums(6, { style: 'rock' }).notes.map((n) => n.startBeat))).toBeLessThan(6)
    const waltz = generateDrums(12, { style: 'swing', beatsPerBar: 3, fillEvery: 0 })
    expect(at(waltz, GM.kick).filter((b) => b % 3 === 0)).toEqual([0, 3, 6, 9])
  })
})

describe('comping', () => {
  const groups = (track: ClipTrack) => {
    const byStart = new Map<number, number[]>()
    for (const n of track.notes) byStart.set(n.startBeat, [...(byStart.get(n.startBeat) ?? []), n.pitch])
    return [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([, pitches]) => pitches.sort((a, b) => a - b))
  }

  it('every style plays only chord tones, for the whole progression', () => {
    for (const style of COMPING_STYLES) {
      for (const [chords, beats] of PROGRESSIONS) {
        const slots = toSlots(chords, beats)
        const track = generateComping(slots, { style })
        expect(track.role).toBe('chords')
        const starts = chordStarts(segments(slots).slots)
        for (const n of track.notes) {
          const chord = [...starts].reverse().find((c) => c.start <= n.startBeat + 1e-6)!
          const allowed = chordPitches(chord.symbol).map(pc)
          expect(allowed, `${style}: ${n.pitch} over ${chord.symbol}`).toContain(pc(n.pitch))
          expect(n.startBeat + n.durationBeats).toBeLessThanOrEqual(totalBeats(slots) + 1e-6)
          expect(n.pitch >= 36 && n.pitch <= 84).toBe(true)
        }
        // Every chord is heard.
        starts.forEach((c, i) => {
          const until = starts[i + 1]?.start ?? totalBeats(slots)
          expect(track.notes.some((n) => n.startBeat >= c.start - 1e-6 && n.startBeat < until), `${style}: ${c.symbol}`).toBe(true)
        })
        expect(generateComping(slots, { style })).toEqual(track)
      }
    }
  })

  it('leads voices smoothly from chord to chord', () => {
    const voicings = groups(generateComping(toSlots(['Dm7', 'G7', 'Cmaj7', 'A7', 'Dm7'], 4), { style: 'block' }))
    expect(voicings).toHaveLength(5)
    for (let i = 1; i < voicings.length; i++) {
      const [a, b] = [voicings[i - 1]!, voicings[i]!]
      expect(Math.abs(b[b.length - 1]! - a[a.length - 1]!), 'top voice').toBeLessThanOrEqual(3)
      // Far less motion than jumping root position to root position (a fourth or fifth in every voice).
      expect(b.reduce((s, p, v) => s + Math.abs(p - (a[v] ?? p)), 0) / b.length).toBeLessThanOrEqual(2.5)
    }
    // Close position: inside an octave.
    for (const v of voicings) expect(v[v.length - 1]! - v[0]!).toBeLessThan(12)
    expect(voiceLead([0, 4, 7], [60, 65, 69])).toEqual([60, 64, 67])
  })

  it('shell voicings are the root with the third and seventh', () => {
    const [dm7, g7] = groups(generateComping(toSlots(['Dm7', 'G7'], 4), { style: 'shell' }))
    expect(dm7!.map(pc)).toEqual([2, 5, 0]) // D, F, C
    expect(new Set(g7!.map(pc))).toEqual(new Set([7, 11, 5])) // G, B, F
    // The guide tones move by step: C falls to B, F stays.
    expect(g7!.slice(1)).toEqual([dm7![1]!, dm7![2]! - 1])
  })

  it('arpeggios run in eighths, one note at a time', () => {
    const track = generateComping(toSlots(['C', 'F'], 4), { style: 'arpeggio' })
    expect(track.notes.map((n) => n.startBeat)).toEqual(Array.from({ length: 16 }, (_, i) => i / 2))
  })
})

describe('capturing a progression from playing', () => {
  const span = (symbol: string, start: number, end: number) => ({ symbol, start, end, pitchClasses: [] })

  it('quantizes heard chords to beats and ends on a bar line', () => {
    // 120 bpm: a beat is half a second. Loose timing, a blip, and detector spellings.
    const spans = [span('CM', 10.02, 11.9), span('Dsus4', 11.9, 12.0), span('Am', 12.05, 14.01), span('FM', 14.0, 15.4)]
    expect(progressionFromSpans(spans, 120)).toEqual([
      { symbol: 'C', beats: 4 },
      { symbol: 'Am', beats: 4 },
      { symbol: 'F', beats: 4 },
    ])
    expect(progressionFromSpans([], 120)).toEqual([])
  })

  it('keeps one pass when the player went round the changes more than once', () => {
    const twice = toSlots(['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G', 'C'], [4, 4, 4, 4, 4, 3, 4, 4, 2])
    expect(symbols(foldRepeats(twice))).toEqual(['C', 'Am', 'F', 'G'])
    expect(symbols(foldRepeats(toSlots(['C', 'Am', 'F', 'G'], 4)))).toEqual(['C', 'Am', 'F', 'G'])
  })
})

describe('arrangement', () => {
  const base = createArrangement({ name: 'test', bpm: 120, progression: toSlots(['Dm7', 'G7', 'Cmaj7'], [4, 4, 8]) })
  const track = (clip: Clip, role: ClipTrack['role']) => clip.tracks.find((t) => t.role === role)!

  it('starts as plain chords and renders one track per layer', () => {
    expect(base.key).toEqual(C)
    expect(renderArrangement(base).tracks.map((t) => t.role)).toEqual(['chords'])
    let a = withLayer(base, 'drums', { kind: 'drums', options: { style: 'swing' } })
    a = withLayer(a, 'bass', { kind: 'bass', options: { style: 'walking' } })
    a = withLayer(a, 'melody', { kind: 'fixed', program: 73, notes: [{ pitch: 72, startBeat: 0, durationBeats: 2, velocity: 0.8 }] })
    const clip = renderArrangement(a)
    expect(clip.tracks.map((t) => t.role)).toEqual(['chords', 'bass', 'drums', 'melody'])
    expect(clip.bpm).toBe(120)
    expect(clipLengthBeats(clip)).toBeLessThanOrEqual(16)
    expect(clipLengthBeats(clip)).toBeGreaterThan(15)
    expect(clipToMidi(clip).length).toBeGreaterThan(100)
    const text = describeArrangement(a)
    expect(text).toContain('C major, 120 bpm, 4 bars')
    expect(text).toContain('Dm7(4) G7(4) Cmaj7(8)')
    expect(text).toContain('bass: walking bass')
  })

  it('layers follow the chords when they are reharmonized', () => {
    const a = withLayer(base, 'bass', { kind: 'bass', options: { style: 'roots' } })
    const before = track(renderArrangement(a), 'bass').notes
    const after = track(renderArrangement(withProgression(a, reharmonize(a.progression, 'tritone_sub', { key: a.key }).slots)), 'bass').notes
    const atBeat4 = (notes: typeof before) => pc(notes.find((n) => n.startBeat === 4)!.pitch)
    expect(atBeat4(before)).toBe(pcOf('G'))
    expect(atBeat4(after)).toBe(pcOf('Db'))
  })

  it('repeats are generated through, and written parts are tiled', () => {
    let a = withLayer(base, 'drums', { kind: 'drums', options: { style: 'rock', fillEvery: 4 } })
    a = withLayer(a, 'solo', { kind: 'fixed', program: 0, notes: [{ pitch: 72, startBeat: 1, durationBeats: 1, velocity: 0.8 }] })
    const clip = renderArrangement(a, { repeats: 2 })
    expect(clipLengthBeats(clip)).toBeGreaterThan(31)
    expect(track(clip, 'solo').notes.map((n) => n.startBeat)).toEqual([1, 17])
    expect(track(clip, 'chords').notes.some((n) => n.startBeat === 16)).toBe(true)
  })

  it('pitched parts lean back when the drums swing', () => {
    const straight = withLayer(base, 'chords', { kind: 'comping', options: { style: 'arpeggio' } })
    const swung = withLayer(straight, 'drums', { kind: 'drums', options: { style: 'swing' } })
    const offbeat = (a: typeof base) => track(renderArrangement(a), 'chords').notes[1]!.startBeat
    expect(offbeat(straight)).toBe(0.5)
    expect(offbeat(swung)).toBeCloseTo(2 / 3)
  })

  it('transposes chords, key and written notes together', () => {
    const a = withLayer(base, 'melody', { kind: 'fixed', program: 0, notes: [{ pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }] })
    const up = transposeArrangement(a, 3)
    expect(up.key).toEqual({ tonic: 'Eb', mode: 'major' })
    expect(symbols(up.progression)).toEqual(['Fm7', 'Bb7', 'Ebmaj7'])
    expect(up.layers.melody).toMatchObject({ notes: [{ pitch: 63 }] })
  })
})

describe('arrange tools', () => {
  const setup = () => {
    const events: MainEvent[] = []
    const transcript = new Transcript()
    const ctx: ToolContext = {
      transcript,
      memory: new TasteMemory('/tmp/jam-arrange-test'),
      now: () => 20,
      emit: (e) => events.push(e),
      bus: new FeatureBus((e) => events.push(e)), playback: new Playback((e) => events.push(e)),
      saveMidi: async (name) => `/tmp/${name}.mid`,
    }
    const module = arrange(ctx)!
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const t = module.tools.find((x) => x.name === name)!
      const result = await t.handler(z.object(t.inputSchema).parse(args), {})
      return (result.content[0] as { text: string }).text
    }
    const clips = () => events.flatMap((e) => (e.type === 'play-clip' ? [e.clip] : []))
    return { module, call, clips, transcript, events }
  }

  it('builds an arrangement by steps, playing each change', async () => {
    const { module, call, clips, events } = setup()
    expect(module.tools.map((t) => t.name)).toEqual(['arrange_start', 'arrange_reharmonize', 'arrange_layer', 'arrangement'])
    expect(await call('arrangement')).toContain('no arrangement yet')
    expect(await call('arrange_reharmonize', { strategy: 'sevenths' })).toContain('no arrangement yet')

    const started = await call('arrange_start', { chords: ['C', 'Am', 'F', 'G'], bpm: 110 })
    expect(started).toContain('C major, 110 bpm')
    expect(started).toContain('C(4) Am(4) F(4) G(4)')
    expect(started).toContain('Playing once, now')
    expect(clips()).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'play-clip', savedTo: '/tmp/arrangement.mid' })
    // One pass of the four bars: the transport loops it in the app.
    expect(clipLengthBeats(clips()[0]!)).toBeGreaterThan(15)
    expect(clipLengthBeats(clips()[0]!)).toBeLessThanOrEqual(16)

    const reharmonized = await call('arrange_reharmonize', { strategy: 'sevenths' })
    expect(reharmonized).toContain('C(4) Am(4) F(4) G(4)  ->  Cmaj7(4) Am7(4) Fmaj7(4) G7(4)')
    expect(await call('arrange_reharmonize', { strategy: 'sevenths' })).toContain('found nothing to change')
    expect(clips()).toHaveLength(2)

    expect(await call('arrange_layer', { role: 'bass', style: 'walking' })).toContain('Added bass: walking bass')
    expect(await call('arrange_layer', { role: 'drums' })).toContain('swing drums') // matches the walking bass
    expect(clips().at(-1)!.tracks.map((t) => t.role)).toEqual(['chords', 'bass', 'drums'])

    // The same request again is a new take; a setting change is not.
    const first = clips().at(-1)!.tracks[1]!.notes
    await call('arrange_layer', { role: 'bass', style: 'walking' })
    expect(clips().at(-1)!.tracks[1]!.notes).not.toEqual(first)
    const drums = clips().at(-1)!.tracks[2]!.notes.length
    expect(await call('arrange_layer', { role: 'drums', intensity: 1, play: false })).toContain('Not played yet')
    expect(await call('arrangement')).toContain('swing drums, intensity 1')
    expect(drums).toBeGreaterThan(0)

    expect(await call('arrange_layer', { role: 'bass', style: 'slap' })).toContain('Choose from: roots')
    expect(await call('arrange_layer', { role: 'melody' })).toContain('needs `notes`')
    expect(await call('arrange_layer', { role: 'bass', remove: true })).toContain('Removed the bass layer')
    expect(await call('arrange_reharmonize', { strategy: 'undo' })).toContain('bass: walking bass')
    expect(await call('arrange_reharmonize', { strategy: 'original' })).toContain('Chords (beats each): C(4) Am(4) F(4) G(4)')

    const moved = await call('arrangement', { transpose: 2, bpm: 90 })
    expect(moved).toContain('Now D major at 90 bpm')
    expect(moved).toContain('D(4) Bm(4) G(4) A(4)')
    expect(clips().at(-1)!.bpm).toBe(90)
  })

  it('a feel brings the whole rhythm section', async () => {
    const { call, clips } = setup()
    const out = await call('arrange_start', { name: 'bossa idea', chords: ['Dm7', 'G7', 'Cmaj7', 'A7'], feel: 'bossa', key: 'C major' })
    expect(out).toContain('bossa bass')
    expect(out).toContain('bossa drums')
    expect(clips()[0]!.tracks.map((t) => t.role)).toEqual(['chords', 'bass', 'drums'])
    expect(await call('arrange_start', { chords: ['Dm7', 'Xyz'] })).toContain("couldn't voice")
  })

  it("starts from the player's own chords", async () => {
    const { call, transcript } = setup()
    expect(await call('arrange_start', {})).toContain('heard no chords')
    // C, Am, F, G as held triads, two seconds each (four beats at 120), ending at the 20s mark.
    const triads = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]]
    transcript.add(
      triads.flatMap((pitches, i) =>
        pitches.map((pitch) => ({ pitch, start: 12 + i * 2, duration: 1.95, velocity: 0.8, source: 'midi' as const, confidence: 1 })),
      ),
    )
    const out = await call('arrange_start', { bpm: 120 })
    expect(out).toContain("the player's last 20s")
    expect(out).toContain('C(4) Am(4) F(4) G(4)')
  })
})
