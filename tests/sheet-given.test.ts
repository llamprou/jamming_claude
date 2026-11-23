import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { MainEvent } from '@shared/ipc'
import { NOTATION } from '@shared/features/notation'
import {
  barsToShow,
  chordSpansByBar,
  describeWritten,
  givenMusic,
  scoreToAbc,
  summariseScore,
  transcribe,
  transcribeTab,
} from '@shared/music/notation'
import type { NoteEvent } from '@shared/music/types'
import { Transcript } from '@shared/music/transcript'
import { notation } from '../src/main/agent/tools/notation'
import { FeatureBus } from '../src/main/bus'
import { TasteMemory } from '../src/main/memory/taste'
import { Playback } from '../src/main/playback'

/** The progression the live agent asked to see, which came out as 8 bars with the wrong names. */
const SIXTEEN = ['C', 'Bb', 'Ab', 'C/G', 'F', 'C/E', 'Dm7b5', 'Gsus4', 'Ab', 'Eb', 'F', 'C/E', 'Dm7', 'Bb', 'Fsus2/A', 'G']

/** How a written view builds its score from given music (views/notation.tsx does the same). */
function written(given: { notes?: NoteEvent[]; chords?: string[] }, options = {}) {
  const music = givenMusic(given, options)!
  return transcribe(music.notes, { ...music.options, bars: barsToShow(false, music.options.bars), chords: music.chords }).score
}

/** A grand-staff piano part, 64 beats (16 bars of 4/4) in seconds at 120: bass on each beat, melody on the offbeats. */
function pianoPart(): NoteEvent[] {
  const notes: NoteEvent[] = []
  for (let beat = 0; beat < 64; beat++) {
    notes.push({ pitch: 36 + (beat % 5), start: beat * 0.5, duration: 0.5, velocity: 0.8, source: 'agent', confidence: 1 })
    notes.push({ pitch: 72 + (beat % 7), start: beat * 0.5 + 0.25, duration: 0.25, velocity: 0.8, source: 'agent', confidence: 1 })
  }
  return notes
}

const symbolsByBar = (chordsByBar: string[][]) => chordsByBar.map((c) => c.join(' '))

describe('given music on the sheet', () => {
  it('writes every bar of a 16-chord progression with the symbols exactly as given', () => {
    const score = written({ chords: SIXTEEN }, { key: 'C major', timeSignature: '4/4', instrument: 'piano' })
    expect(score.bars).toHaveLength(16)
    const summary = summariseScore(score, { view: 'sheet', live: false })
    expect(symbolsByBar(summary.chordsByBar)).toEqual(SIXTEEN)
    expect(summary.lines).toBeGreaterThanOrEqual(4)
    // Every bar reaches the ABC, wrapped onto several lines.
    const abc = scoreToAbc(score)
    for (const symbol of SIXTEEN) expect(abc).toContain(`"${symbol}"`)
    expect(abc.split('\n').filter((l) => l.includes('|')).length).toBe(summary.lines)
  })

  it('keeps repeated chords and does not respell them for the key', () => {
    const score = written({ chords: ['G#', 'G#', 'C'] }, { key: 'Eb major' })
    expect(symbolsByBar(summariseScore(score, { view: 'sheet', live: false }).chordsByBar)).toEqual(['G#', 'G#', 'C'])
  })

  it('gives an unvoiceable symbol its own bar', () => {
    const score = written({ chords: ['C', 'Xyz', 'G'] })
    expect(score.bars).toHaveLength(3)
    expect(symbolsByBar(summariseScore(score, { view: 'sheet', live: false }).chordsByBar)).toEqual(['C', 'Xyz', 'G'])
  })

  it('labels given notes with given chords, every bar, on a grand staff', () => {
    const score = written({ notes: pianoPart(), chords: SIXTEEN }, { key: 'C major', instrument: 'piano' })
    expect(score.staves).toHaveLength(2)
    expect(score.bars).toHaveLength(16)
    expect(symbolsByBar(summariseScore(score, { view: 'sheet', live: false }).chordsByBar)).toEqual(SIXTEEN)
  })

  it('extends given notes to cover chords past their end', () => {
    const notes = pianoPart().filter((n) => n.start < 4)
    expect(written({ notes, chords: SIXTEEN.slice(0, 4) }).bars).toHaveLength(4)
  })

  it('places chords a bar apart in other time signatures', () => {
    expect(chordSpansByBar(['C', 'G'], '3/4').map((c) => [c.start, c.end])).toEqual([[0, 1.5], [1.5, 3]])
    const score = written({ chords: ['C', 'F', 'G', 'C'] }, { timeSignature: '3/4' })
    expect(score.bars).toHaveLength(4)
    expect(symbolsByBar(summariseScore(score, { view: 'sheet', live: false }).chordsByBar)).toEqual(['C', 'F', 'G', 'C'])
  })

  it('caps live playing at 8 bars unless asked, but not given music', () => {
    expect(barsToShow(true)).toBe(8)
    expect(barsToShow(true, 12)).toBe(12)
    expect(barsToShow(false)).toBeUndefined()
    expect(barsToShow(false, 4)).toBe(4)
  })

  it('says when the oldest bars were cut', () => {
    const score = written({ chords: SIXTEEN }, { bars: 4 })
    const text = describeWritten(summariseScore(score, { view: 'sheet', live: false }))
    expect(text).toMatch(/^sheet: 4 bars \(the last 4 of 16\) on 1 line/)
    expect(text).toContain('Chords by bar: 13 Dm7 | 14 Bb | 15 Fsus2/A | 16 G')
  })

  it('writes given chords on tab too', () => {
    const music = givenMusic({ chords: SIXTEEN }, { instrument: 'guitar' }, 'guitar')!
    const { score } = transcribeTab(music.notes, { ...music.options, chords: music.chords })
    expect(symbolsByBar(summariseScore(score, { view: 'tab', live: false }).chordsByBar)).toEqual(SIXTEEN)
  })
})

describe('notate and read_notation', () => {
  const setup = () => {
    const events: MainEvent[] = []
    const bus = new FeatureBus((e) => events.push(e))
    const module = notation({
      playback: new Playback(() => undefined),
      transcript: new Transcript(),
      memory: new TasteMemory(mkdtempSync(join(tmpdir(), 'jam-sheet-'))),
      now: () => 0,
      emit: (e) => events.push(e),
      bus,
      saveMidi: async () => '',
    })!
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const found = module.tools.find((t) => t.name === name)!
      const result = await found.handler(z.object(found.inputSchema).parse(args), {})
      return (result.content[0] as { text: string }).text
    }
    return { events, bus, call }
  }

  it('sends chords with notes, and reports the bars and chords written', async () => {
    const { events, call } = setup()
    const notes = pianoPart().map((n) => ({ pitch: n.pitch, startBeat: n.start * 2, durationBeats: n.duration * 2 }))
    const reply = await call('notate', { view: 'sheet', instrument: 'piano', key: 'C major', time_signature: '4/4', notes, chords: SIXTEEN })
    expect(events[0]).toMatchObject({ type: 'show-view', view: 'sheet', chords: SIXTEEN })
    expect(events[0]!.type === 'show-view' && events[0]!.notes?.length).toBe(128)
    expect(reply).toContain('sheet: 16 bars on')
    expect(reply).toContain(`Chords by bar: ${SIXTEEN.map((s, i) => `${i + 1} ${s}`).join(' | ')}`)
  })

  it('reads back what the window drew', async () => {
    const { events, bus, call } = setup()
    const pending = call('read_notation', {})
    const request = events.find((e) => e.type === 'feature-request')
    expect(request).toMatchObject({ feature: NOTATION, message: { type: 'read' } })
    const score = written({ chords: SIXTEEN })
    bus.settle(request!.type === 'feature-request' ? request!.id : -1, { views: [{ ...summariseScore(score, { view: 'sheet', live: false }), lines: 4 }] })
    expect(await pending).toMatch(/^sheet: 16 bars on 4 lines, C major, 4\/4\. Chords by bar: 1 C \| 2 Bb/)
  })

  it('says when nothing is on screen', async () => {
    const { events, bus, call } = setup()
    const pending = call('read_notation', {})
    const request = events.find((e) => e.type === 'feature-request')
    bus.settle(request!.type === 'feature-request' ? request!.id : -1, { views: [] })
    expect(await pending).toBe('No sheet music or tab is on screen.')
  })
})
