import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectChords } from '@shared/music/analysis'
import { createTranscriber, removeGhosts } from '@shared/music/polyphonic'
import { AudioRing, Resampler, SlowPass, type Correction } from '@shared/music/slowpass'
import { Transcript } from '@shared/music/transcript'
import { chord, synth } from './helpers/synth'

const modelDir = join(dirname(createRequire(import.meta.url).resolve('@spotify/basic-pitch/package.json')), 'model')
const loadTranscriber = () => {
  const weights = readFileSync(join(modelDir, 'group1-shard1of1.bin'))
  return createTranscriber(JSON.parse(readFileSync(join(modelDir, 'model.json'), 'utf8')), weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength) as ArrayBuffer)
}

describe('audio plumbing', () => {
  it('resamples a stream block by block without drifting', () => {
    const resampler = new Resampler(48000)
    const source = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000))
    let total = 0
    let crossings = 0
    let previous = 0
    for (let i = 0; i < source.length; i += 128) {
      const out = resampler.process(source.subarray(i, i + 128))
      total += out.length
      for (const s of out) {
        if (previous <= 0 && s > 0) crossings++
        previous = s
      }
    }
    expect(Math.abs(total - 22050)).toBeLessThanOrEqual(1)
    expect(Math.abs(crossings - 440)).toBeLessThanOrEqual(1) // still 440 Hz
  })

  it('addresses ring audio by session time, even after wrapping', () => {
    const ring = new AudioRing(2, 100)
    for (let second = 1; second <= 5; second++) ring.push(new Float32Array(100).fill(second), 10 + second)
    expect(ring.end).toBe(15)
    expect(ring.start).toBe(13)
    const { audio, from } = ring.slice(12, 14.5)
    expect(from).toBe(13)
    expect(audio).toHaveLength(150)
    expect([audio[0], audio[99], audio[100], audio[149]]).toEqual([4, 4, 5, 5])
  })

  it('drops faint notes and faint harmonics of louder notes', () => {
    const kept = removeGhosts([
      { pitch: 60, start: 0, duration: 1, amplitude: 0.8 },
      { pitch: 72, start: 0, duration: 0.5, amplitude: 0.5 }, // octave ghost of 60
      { pitch: 72, start: 2, duration: 0.5, amplitude: 0.5 }, // a real C5 later on
      { pitch: 43, start: 0, duration: 0.2, amplitude: 0.3 }, // too faint
    ])
    expect(kept.map((n) => [n.pitch, n.start])).toEqual([[60, 0], [72, 2]])
  })
})

describe('slow pass scheduling', () => {
  it('commits each moment exactly once, holding back the newest audio', async () => {
    const ring = new AudioRing(30, 100)
    const corrections: Correction[] = []
    const heard: number[] = []
    const pass = new SlowPass(
      ring,
      async (audio) => {
        heard.push(audio.length / 100)
        // One note per second of the window, at local times 0.5, 1.5, ...
        return Array.from({ length: Math.floor(audio.length / 100) }, (_, i) => ({ pitch: 60, start: i + 0.5, duration: 0.2, amplitude: 0.9 }))
      },
      (c) => corrections.push(c),
      { hopSeconds: 3, contextSeconds: 1, marginSeconds: 0.5 },
    )
    for (let t = 0.5; t <= 10; t += 0.5) {
      ring.push(new Float32Array(50).fill(0.1), t)
      pass.tick()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(corrections.map((c) => [c.from, c.to])).toEqual([[0, 3], [3, 6], [6, 9]])
    expect(heard).toEqual([3.5, 4.5, 4.5]) // later windows include a second of context
    expect(corrections.flatMap((c) => c.notes.map((n) => n.start))).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5])
  })

  it('skips old audio instead of falling ever further behind a slow model', async () => {
    const ring = new AudioRing(60, 100)
    const corrections: Correction[] = []
    let release = () => {}
    const pass = new SlowPass(ring, () => new Promise((resolve) => (release = () => resolve([]))), (c) => corrections.push(c), { hopSeconds: 3, marginSeconds: 0, maxStretchSeconds: 8 })
    ring.push(new Float32Array(300).fill(0.1), 3)
    expect(pass.tick()).toBe(true) // first run starts and hangs
    ring.push(new Float32Array(2000).fill(0.1), 23) // 20 s arrive meanwhile
    expect(pass.tick()).toBe(false)
    release()
    await new Promise((r) => setTimeout(r, 0))
    pass.tick()
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(corrections.map((c) => [c.from, c.to])).toEqual([[0, 3], [15, 23]])
  })

  it('skips the model on silence but still clears the stretch', async () => {
    const ring = new AudioRing(10, 100)
    const corrections: Correction[] = []
    let calls = 0
    const pass = new SlowPass(ring, async () => (calls++, []), (c) => corrections.push(c), { hopSeconds: 2, marginSeconds: 0 })
    ring.push(new Float32Array(300), 3)
    pass.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(0)
    expect(corrections).toEqual([{ from: 0, to: 3, notes: [] }])
  })
})

describe('polyphonic transcription (real model)', () => {
  it('hears chords the fast pass cannot, and corrects the transcript', async () => {
    const transcribe = loadTranscriber()
    const audio = synth(8, [...chord([62, 65, 69, 72], 0.5, 1.6), ...chord([55, 59, 62, 65], 2.5, 1.6), ...chord([60, 64, 67, 71], 4.5, 1.6)])

    const transcript = new Transcript()
    // What the fast monophonic pass might have guessed: one wrong-ish note per chord.
    transcript.add([62, 59, 67].map((pitch, i) => ({ pitch, start: 0.5 + i * 2, duration: 1.5, velocity: 0.7, source: 'audio' as const, confidence: 0.5 })))
    expect(transcript.snapshot(8).chords).toEqual([])

    const ring = new AudioRing(30)
    const pass = new SlowPass(ring, transcribe, (c) => transcript.revise(c.from, c.to, 'audio', c.notes), { hopSeconds: 3 })
    const block = 2205
    for (let i = 0; i < audio.length; i += block) {
      ring.push(audio.subarray(i, i + block), (i + block) / 22050)
      pass.tick()
      while (pass.running) await new Promise((r) => setTimeout(r, 20))
    }

    const snapshot = transcript.snapshot(8)
    expect(snapshot.chords.map((c) => c.symbol)).toEqual(['Dm7', 'G7', 'Cmaj7'])
    expect(snapshot.correctedUntil).toBeGreaterThanOrEqual(6)
    const firstChord = snapshot.notes.filter((n) => n.start < 2)
    expect(firstChord.map((n) => n.pitch).sort()).toEqual([62, 65, 69, 72])
    for (const n of firstChord) expect(Math.abs(n.start - 0.5)).toBeLessThan(0.06)
  }, 120_000)
})
