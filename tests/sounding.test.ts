import { describe, expect, it } from 'vitest'
import { instrumentViewData, isInstrumentView } from '@shared/features/instruments'
import { chordPitches } from '@shared/music/render'
import { baseLayer, chordsAsBeats, heldPitches, inParts, keyboardRange, MIN_LIT_SECONDS, SoundingLog, stepLength, stepPitches } from '@shared/music/sounding'

describe('SoundingLog', () => {
  const log = () => {
    const l = new SoundingLog()
    l.add({ pitch: 60, start: 10, end: 11, layer: 'comp', role: 'chords' })
    l.add({ pitch: 64, start: 10, end: 11, layer: 'comp~2', role: 'chords' })
    l.add({ pitch: 36, start: 10.5, end: 12, layer: 'bassline', role: 'bass' })
    l.add({ pitch: 42, start: 10, end: 10.1, layer: 'kit', role: 'drums' })
    return l
  }

  it('lights only what sounds at the moment, never drums by default', () => {
    expect(log().at(9.9)).toEqual([])
    expect(log().at(10.2)).toEqual([60, 64])
    expect(log().at(10.6)).toEqual([36, 60, 64])
    expect(log().at(11.5)).toEqual([36])
    expect(log().at(12)).toEqual([])
  })

  it('filters by layer id (including replaced layers) or track role', () => {
    expect(log().at(10.6, ['bass'])).toEqual([36])
    expect(log().at(10.6, ['comp'])).toEqual([60, 64])
    expect(log().at(10.6, ['Chords', 'bassline'])).toEqual([36, 60, 64])
    expect(log().at(10.05, ['drums'])).toEqual([42])
    expect(baseLayer('comp~3')).toBe('comp')
    expect(inParts({ layer: 'x', role: 'drums' })).toBe(false)
  })

  it('keeps very short notes lit long enough to see', () => {
    const l = new SoundingLog()
    l.add({ pitch: 70, start: 5, end: 5.01, layer: 'a', role: 'melody' })
    expect(l.at(5 + MIN_LIT_SECONDS / 2)).toEqual([70])
  })

  it('cuts a stopped layer and prunes finished notes', () => {
    const l = log()
    l.cut(10.6, 'bassline')
    expect(l.at(10.7)).toEqual([60, 64])
    l.add({ pitch: 48, start: 11, end: 12, layer: 'bassline', role: 'bass' })
    l.cut(10.6)
    expect(l.at(11.5)).toEqual([])
    l.prune(11)
    expect(l.size).toBe(0)
  })

  it('knows when playback is under way, rests included', () => {
    expect(log().activeAround(12.5, 1)).toBe(true)
    expect(log().activeAround(14, 1)).toBe(false)
  })
})

describe('stepping through timed notes', () => {
  const notes = [
    { pitch: 60, startBeat: 0, durationBeats: 1 },
    { pitch: 62, startBeat: 1, durationBeats: 1 },
    { pitch: 64, startBeat: 2, durationBeats: 2 },
  ]

  it('moves through the notes as the beat advances, looping on whole bars', () => {
    expect(stepLength(notes)).toBe(4)
    expect(stepPitches(notes, 0.5)).toEqual([60])
    expect(stepPitches(notes, 1.5)).toEqual([62])
    expect(stepPitches(notes, 3.9)).toEqual([64])
    expect(stepPitches(notes, 4.5)).toEqual([60])
    expect(stepPitches(notes, 9.5)).toEqual([62])
    expect(stepPitches(notes, 4.5, 4, false)).toEqual([])
  })

  it('turns a progression into one chord per step', () => {
    const steps = chordsAsBeats(['C', 'G'], (c) => chordPitches(c), 2)
    expect(stepLength(steps)).toBe(4)
    expect(stepPitches(steps, 1)).toEqual(chordPitches('C'))
    expect(stepPitches(steps, 3)).toEqual(chordPitches('G'))
  })
})

describe('instrument view helpers', () => {
  it('lights only notes the player still holds', () => {
    const played = [
      { pitch: 60, start: 1, duration: 0.5 },
      { pitch: 64, start: 2.8, duration: 0 },
      { pitch: 67, start: 2.5, duration: 0.4 },
    ]
    expect(heldPitches(played, 3)).toEqual([64, 67])
  })

  it('widens the keyboard to whole octaves that fit', () => {
    expect(keyboardRange([60])).toEqual({ low: 36, high: 84 })
    expect(keyboardRange([28, 90])).toEqual({ low: 24, high: 96 })
  })

  it('show sends steps for progressions and timed notes, a still frame otherwise', () => {
    expect(isInstrumentView('piano')).toBe(true)
    expect(isInstrumentView('sheet')).toBe(false)
    expect(instrumentViewData({ chords: ['Dm7'] }).steps).toBeUndefined()
    expect(instrumentViewData({ chords: ['Dm7', 'G7', 'Cmaj7'], beats_per_chord: 2 }).steps?.at(-1)?.startBeat).toBe(4)
    expect(instrumentViewData({ notes: [{ pitch: 60, startBeat: 0, durationBeats: 4 }, { pitch: 64, startBeat: 0, durationBeats: 4 }] }).steps).toBeUndefined()
    const melody = instrumentViewData({ notes: [{ pitch: 60, startBeat: 0, durationBeats: 1 }, { pitch: 62, startBeat: 1, durationBeats: 1 }], bpm: 90, loop: false })
    expect(melody).toMatchObject({ follow: 'both', bpm: 90, loop: false })
    expect(melody.steps).toHaveLength(2)
    expect(instrumentViewData({ follow: 'playback', parts: ['chords'] })).toMatchObject({ follow: 'playback', parts: ['chords'] })
  })
})
