import { describe, expect, it } from 'vitest'
import MidiPkg from '@tonejs/midi'
import { detectChords, estimateKey, estimateRhythm, nameChord } from '@shared/music/analysis'
import { clipLengthBeats, clipToMidi, clipToNotes, progressionTrack } from '@shared/music/clip'
import { detectPitch, hzToMidi } from '@shared/music/pitch'
import { chordPitches, fretboardSvg, pianoSvg, tabToAscii, toAbc, toTab } from '@shared/music/render'
import { Transcript } from '@shared/music/transcript'
import type { NoteEvent } from '@shared/music/types'

const note = (pitch: number, start: number, duration = 0.5): NoteEvent => ({ pitch, start, duration, velocity: 0.8, source: 'midi', confidence: 1 })
const chord = (pitches: number[], start: number, duration = 1) => pitches.map((p) => note(p, start, duration))

describe('analysis', () => {
  it('names chords, including inversions', () => {
    expect(nameChord([60, 64, 67])).toBe('CM')
    expect(nameChord([62, 65, 69, 72])).toBe('Dm7')
    expect(nameChord([64, 67, 72])).toBe('CM/E')
    expect(nameChord([60, 64])).toBeNull()
  })

  it('segments a ii-V-I', () => {
    const notes = [...chord([62, 65, 69, 72], 0), ...chord([55, 59, 62, 65], 1), ...chord([60, 64, 67, 71], 2)]
    expect(detectChords(notes).map((c) => c.symbol)).toEqual(['Dm7', 'G7', 'Cmaj7'])
  })

  it('finds the key of a C major scale', () => {
    const scale = [60, 62, 64, 65, 67, 69, 71, 72].map((p, i) => note(p, i * 0.5))
    expect(estimateKey([...scale, note(60, 4, 2), note(67, 4, 2)])).toMatchObject({ tonic: 'C', mode: 'major' })
  })

  it('reads tempo and pattern from steady eighths at 100 bpm', () => {
    const eighth = 60 / 100 / 2
    const rhythm = estimateRhythm(Array.from({ length: 16 }, (_, i) => note(60, i * eighth, 0.1)))
    expect(rhythm?.bpm).toBe(100)
    expect(rhythm?.pattern).toBe('x.x.x.x.x.x.x.x.')
    expect(rhythm?.tightness).toBeGreaterThan(0.9)
  })
})

describe('transcript', () => {
  it('tracks live notes and lets the slow pass revise a window', () => {
    const t = new Transcript()
    t.noteOn(60, 0, 0.8, 'midi')
    t.noteOn(64, 0, 0.8, 'midi')
    t.noteOn(67, 0, 0.8, 'midi')
    expect(t.snapshot(1).chords[0]?.symbol).toBe('CM') // still held
    t.noteOff(60, 1, 'midi')
    t.add([{ ...note(61, 2), source: 'audio', confidence: 0.4 }])
    expect(t.snapshot(3).corrected).toBe(false)
    t.revise(1.5, 3, 'audio', [{ ...note(62, 2), source: 'audio' }])
    const snap = t.snapshot(3)
    expect(snap.corrected).toBe(true)
    expect(snap.notes.map((n) => n.pitch)).toEqual([60, 64, 67, 62])
  })
})

describe('rendering', () => {
  it('tabs an E minor shape on guitar without reusing strings', () => {
    const tab = toTab(chord([40, 47, 52, 55, 59, 64], 0), 'guitar')
    expect(tab).toHaveLength(6)
    expect(new Set(tab.map((t) => t.string)).size).toBe(6)
    expect(tab.map((t) => t.fret).sort()).toEqual([0, 0, 0, 0, 2, 2])
    expect(tabToAscii(tab, 'guitar').split('\n')).toHaveLength(6)
  })

  it('keeps a bass line on four strings', () => {
    const tab = toTab([note(28, 0), note(31, 0.5), note(33, 1), note(40, 1.5)], 'bass')
    expect(tab.map((t) => [t.string, t.fret])).toEqual([[0, 0], [0, 3], [1, 0], [2, 2]])
  })

  it('writes ABC whose bars each sum to sixteen sixteenths', () => {
    const quarter = 0.5
    const abc = toAbc([note(60, 0, quarter), note(64, quarter, quarter), note(67, 2 * quarter, 2 * quarter)], { bpm: 120, key: 'C' })
    const body = abc.split('\n').at(-1)!
    for (const bar of body.split('|').filter(Boolean)) {
      const total = [...bar.matchAll(/(?:\[[^\]]+\]|[\^_]?[A-Ga-gz][,']*)(\d*)-?/g)].reduce((sum, m) => sum + Number(m[1] || 1), 0)
      expect(total).toBe(16)
    }
    expect(body.startsWith('C4 E4 G8|')).toBe(true)
  })

  it('draws instrument diagrams', () => {
    expect(pianoSvg([60, 64, 67])).toContain('#f5a524')
    expect(fretboardSvg(chordPitches('Em'), 'guitar')).toContain('<circle')
  })
})

describe('clips', () => {
  it('voices a progression and round-trips through a MIDI file', () => {
    expect(chordPitches('Dm7')).toEqual([50, 53, 57, 60])
    const clip = { name: 'ii-V-I', bpm: 120, tracks: [progressionTrack(['Dm7', 'G7', 'Cmaj7'], 4)] }
    expect(clipLengthBeats(clip)).toBe(12)
    expect(detectChords(clipToNotes(clip)).map((c) => c.symbol)).toEqual(['Dm7', 'G7', 'Cmaj7'])
    const parsed = new MidiPkg.Midi(clipToMidi(clip))
    expect(parsed.header.tempos[0]?.bpm).toBeCloseTo(120)
    expect(parsed.tracks[0]?.notes).toHaveLength(12)
    expect(parsed.tracks[0]?.notes[4]?.time).toBeCloseTo(2)
  })
})

describe('pitch detection', () => {
  const sine = (hz: number, sampleRate = 48000, length = 2048) => Float32Array.from({ length }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / sampleRate))

  it('hears single notes across the guitar range', () => {
    for (const midi of [40, 52, 64, 76]) {
      const hz = 440 * 2 ** ((midi - 69) / 12)
      expect(Math.round(hzToMidi(detectPitch(sine(hz), 48000)!))).toBe(midi)
    }
  })

  it('stays quiet on silence and noise', () => {
    expect(detectPitch(new Float32Array(2048), 48000)).toBeNull()
    let seed = 1
    const noise = Float32Array.from({ length: 2048 }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.6)
    expect(detectPitch(noise, 48000)).toBeNull()
  })
})
