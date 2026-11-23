import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MainEvent } from '@shared/ipc'
import { SAMPLER, type CaptureReply, type SamplerRequest, type SavedInstrument } from '@shared/features/sampler'
import { captureTakes, detectNotes, findLoop, findOnset, isolatedNotes, loudness, measurePitch, normalise, peakEnvelope, peakLevel, tidyEdges, trimLeadingSilence } from '@shared/music/capture'
import { detectPitch, hzToMidi } from '@shared/music/pitch'
import { coverage, envelopeAt, gmDrumVoice, instrumentForTrack, midiToHz, noteEnvelope, pickZone, playbackRate, renderNote, type InstrumentDef, type Zone } from '@shared/music/sampler'
import { drumHit, electricPiano, generateStandIn, pluck } from '@shared/music/synthkit'
import { Transcript } from '@shared/music/transcript'
import { decodeWav, encodeWav } from '@shared/music/wav'
import type { ToolContext } from '../src/main/agent/toolkit'
import { instruments } from '../src/main/agent/tools/instruments'
import { FeatureBus } from '../src/main/bus'
import { InstrumentStore } from '../src/main/instruments/store'
import { TasteMemory } from '../src/main/memory/taste'
import { chord, synth } from './helpers/synth'

const RATE = 44100
const zone = (pitch: number, extra: Partial<Zone> = {}): Zone => ({ sample: `${pitch}`, pitch, ...extra })
const pitched = (zones: Zone[], extra: Partial<InstrumentDef> = {}): InstrumentDef => ({ name: 'test', label: 'test', kind: 'pitched', origin: 'captured', zones, ...extra })

/** A held, organ-like tone: steady level, a few harmonics. */
function held(pitch: number, seconds: number, sampleRate = RATE): Float32Array {
  const hz = midiToHz(pitch)
  const out = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate
    const envelope = Math.min(1, t / 0.03) * Math.min(1, (seconds - t) / 0.05)
    out[i] = 0.3 * envelope * (Math.sin(2 * Math.PI * hz * t) + 0.4 * Math.sin(2 * Math.PI * 2 * hz * t) + 0.2 * Math.sin(2 * Math.PI * 3 * hz * t))
  }
  return out
}

describe('wav', () => {
  it('round-trips mono 16-bit audio', () => {
    const samples = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.8)
    const wav = decodeWav(encodeWav(samples, 48000))
    expect(wav.sampleRate).toBe(48000)
    expect(wav.samples.length).toBe(1000)
    for (let i = 0; i < 1000; i += 37) expect(wav.samples[i]).toBeCloseTo(samples[i]!, 3)
  })

  it('clips rather than wraps, and reads stereo float and 24-bit files as mono', () => {
    expect(decodeWav(encodeWav(Float32Array.from([2, -2]), 8000)).samples[0]).toBeCloseTo(1, 3)

    const header = (format: number, channels: number, bits: number, dataBytes: number) => {
      const bytes = new Uint8Array(44 + dataBytes)
      const view = new DataView(bytes.buffer)
      bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
      bytes.set([...'WAVEfmt '].map((c) => c.charCodeAt(0)), 8)
      view.setUint32(16, 16, true)
      view.setUint16(20, format, true)
      view.setUint16(22, channels, true)
      view.setUint32(24, 22050, true)
      view.setUint16(34, bits, true)
      bytes.set([...'data'].map((c) => c.charCodeAt(0)), 36)
      view.setUint32(40, dataBytes, true)
      return { bytes, view }
    }
    const float = header(3, 2, 32, 16)
    ;[0.5, 0.1, -0.25, -0.75].forEach((v, i) => float.view.setFloat32(44 + i * 4, v, true))
    const mixed = decodeWav(float.bytes).samples
    expect(mixed[0]).toBeCloseTo(0.3)
    expect(mixed[1]).toBeCloseTo(-0.5)

    const pcm24 = header(1, 1, 24, 6)
    pcm24.bytes.set([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0], 44) // +0.5, -0.5
    expect([...decodeWav(pcm24.bytes).samples]).toEqual([0.5, -0.5])
    expect(() => decodeWav(new Uint8Array(20))).toThrow(/Not a WAV/)
  })
})

describe('sampler arithmetic', () => {
  it('picks the nearest recording and the rate that lands on the requested pitch', () => {
    const def = pitched([zone(48), zone(54), zone(60)])
    expect(pickZone(def, 50)!.pitch).toBe(48)
    expect(pickZone(def, 52)!.pitch).toBe(54)
    expect(pickZone(def, 51)!.pitch).toBe(48) // tie: shift the lower one up
    expect(pickZone(def, 100)!.pitch).toBe(60)
    expect(pickZone(pitched([]), 60)).toBeNull()
    expect(playbackRate(zone(60), 72)).toBeCloseTo(2)
    expect(playbackRate(zone(60), 57)).toBeCloseTo(2 ** (-3 / 12))
    // A recording that is 50 cents sharp is slowed down to compensate.
    expect(playbackRate(zone(60, { tuneCents: 50 }), 60)).toBeCloseTo(2 ** (-0.5 / 12))
  })

  it('honours velocity layers, falling back to the closest layer', () => {
    const def = pitched([zone(60, { sample: 'soft', hiVel: 0.5 }), zone(60, { sample: 'hard', loVel: 0.5001 }), zone(72, { sample: 'hard-high', loVel: 0.8 })])
    expect(pickZone(def, 61, 0.3)!.sample).toBe('soft')
    expect(pickZone(def, 61, 0.7)!.sample).toBe('hard')
    expect(pickZone(def, 70, 0.9)!.sample).toBe('hard-high')
    expect(pickZone(def, 70, 0.3)!.sample).toBe('soft')
    expect(pickZone(pitched([zone(60, { loVel: 0.6 })]), 60, 0.1)!.pitch).toBe(60)
  })

  it('maps General MIDI drum notes to kit pieces, with fallbacks for a small kit', () => {
    expect([36, 38, 42, 46, 49, 51, 45].map(gmDrumVoice)).toEqual(['kick', 'snare', 'hatClosed', 'hatOpen', 'crash', 'ride', 'tomMid'])
    const kit: InstrumentDef = { name: 'kit', label: 'kit', kind: 'drums', origin: 'sampled', zones: (['kick', 'snare', 'hatClosed'] as const).map((drum) => ({ sample: drum, pitch: 0, drum })) }
    expect(pickZone(kit, 36)!.drum).toBe('kick')
    expect(pickZone(kit, 37)!.drum).toBe('snare') // rim shot -> snare
    expect(pickZone(kit, 46)!.drum).toBe('hatClosed') // open hat -> closed hat
    expect(pickZone(kit, 44)!.drum).toBe('hatClosed')
    expect(pickZone(kit, 51)).toBeNull() // no cymbal of any kind
  })

  it('shapes a note: attack, hold, release; drums play through regardless of length', () => {
    const def = pitched([zone(60)], { attack: 0.01, release: 0.2, gain: 0.5 })
    const env = noteEnvelope(def, def.zones[0]!, 1, 0.5, 4, 1)
    expect(env).toMatchObject({ peak: 0.5, attack: 0.01, releaseAt: 0.5, oneShot: false })
    expect(env.stopAt).toBeCloseTo(0.7)
    expect(envelopeAt(env, 0.005)).toBeCloseTo(0.25)
    expect(envelopeAt(env, 0.3)).toBe(0.5)
    expect(envelopeAt(env, 0.6)).toBeLessThan(0.05)
    expect(envelopeAt(env, 0.8)).toBe(0)
    // Quieter when played softer; never longer than the recording when it does not loop.
    expect(noteEnvelope(def, def.zones[0]!, 0.5, 0.5, 4, 1).peak).toBeLessThan(0.25)
    expect(noteEnvelope(def, def.zones[0]!, 1, 3, 2, 2).stopAt).toBeCloseTo(1)
    expect(noteEnvelope(def, zone(60, { loop: { start: 0.5, end: 1 } }), 1, 3, 2, 2).stopAt).toBeCloseTo(3.2)

    const kit: InstrumentDef = { name: 'kit', label: 'kit', kind: 'drums', origin: 'sampled', zones: [{ sample: 'kick', pitch: 0, drum: 'kick' }] }
    expect(noteEnvelope(kit, kit.zones[0]!, 1, 0.01, 0.4, 1)).toMatchObject({ oneShot: true, stopAt: 0.4, peak: 1 })
  })

  it('reports how well recorded pitches cover the keyboard', () => {
    const c = coverage([40, 45, 43, 60, 62, 45])!
    expect(c.pitches).toEqual([40, 43, 45, 60, 62])
    expect(c.gaps).toEqual([{ from: 45, to: 60, semitones: 15 }])
    expect(c.largestShift).toBe(7)
    expect([c.comfortableLow, c.comfortableHigh]).toEqual([37, 65])
    expect(coverage([])).toBeNull()
    expect(coverage([48, 54, 60])!.gaps).toEqual([]) // six apart: three up from one, three down from the next
  })

  it('chooses an instrument per track: explicit choice, then a telling MIDI program, then the role default', () => {
    expect(instrumentForTrack({ role: 'chords', program: 0 }, {})).toBe('piano')
    expect(instrumentForTrack({ role: 'bass', program: 0 }, {})).toBe('bass')
    expect(instrumentForTrack({ role: 'melody', program: 25 }, {})).toBe('guitar')
    expect(instrumentForTrack({ role: 'melody', program: 25 }, { melody: 'my-sax' })).toBe('my-sax')
    expect(instrumentForTrack({ role: 'drums', program: 30 }, {})).toBe('drums')
  })
})

describe('reference renderer', () => {
  it('lands on the requested pitch when a recording is shifted up or down', () => {
    const recorded = pluck(midiToHz(57), 2, RATE, { decaySeconds: 3, brightness: 0.5, pickPosition: 0.2, softness: 0.3 })
    const def = pitched([zone(57)])
    for (const pitch of [54, 57, 60, 62]) {
      const out = renderNote(recorded, RATE, def, def.zones[0]!, { pitch, velocity: 1, duration: 0.6 })
      expect(out.length).toBe(Math.ceil(0.85 * RATE))
      expect(measurePitch(out, RATE)!).toBeCloseTo(pitch, 0.5)
      expect(Math.abs(measurePitch(out, RATE)! - pitch)).toBeLessThan(0.15)
    }
  })

  it('sustains a looped recording past its own length without a bump at the seam', () => {
    const recorded = held(64, 1)
    const loop = findLoop(recorded, RATE, midiToHz(64))!
    expect(loop).not.toBeNull()
    expect(loop.match).toBeGreaterThan(0.95)
    expect((loop.end - loop.start) / RATE).toBeGreaterThan(0.3)
    const looped = zone(64, { loop: { start: loop.start / RATE, end: loop.end / RATE } })
    const out = renderNote(recorded, RATE, pitched([looped]), looped, { pitch: 64, velocity: 1, duration: 3 })
    expect(out.length / RATE).toBeGreaterThan(3)
    // Still sounding, at pitch, two seconds after the recording would have ended.
    const late = out.subarray(Math.round(2.5 * RATE), Math.round(2.9 * RATE))
    expect(peakLevel(late)).toBeGreaterThan(0.2)
    expect(Math.abs(measurePitch(late, RATE)! - 64)).toBeLessThan(0.1)
    // No click: the biggest jump between neighbouring samples is no bigger than the waveform's own.
    const jump = (a: Float32Array) => a.reduce((max, s, i) => (i ? Math.max(max, Math.abs(s - a[i - 1]!)) : 0), 0)
    expect(jump(out.subarray(RATE / 2, 3 * RATE))).toBeLessThan(jump(recorded.subarray(RATE / 4, RATE / 2)) * 1.3)
  })

  it('finds no loop in a note that is dying away', () => {
    expect(findLoop(synth(1.5, [{ pitch: 60, start: 0, duration: 1.5 }], RATE), RATE, midiToHz(60))).toBeNull()
    expect(findLoop(held(60, 0.2), RATE, midiToHz(60))).toBeNull() // too short
  })
})

describe('capturing an instrument from audio', () => {
  // What was really played: single notes, a repeated pitch (louder the second time), a chord, and two notes smeared together.
  const played = [
    { pitch: 52, start: 0.5, duration: 0.9 },
    { pitch: 57, start: 1.6, duration: 0.9 },
    { pitch: 62, start: 2.7, duration: 0.5 },
    { pitch: 67, start: 3.4, duration: 0.9 },
    ...chord([48, 52, 55], 4.6, 0.9),
    { pitch: 71, start: 5.8, duration: 0.9 },
    { pitch: 74, start: 6.2, duration: 0.5 }, // starts while 71 is still sounding
    { pitch: 57, start: 7.2, duration: 1.2 },
  ]
  const audio = synth(9, played, RATE)
  // The second A2 is played harder.
  for (let i = Math.round(7.2 * RATE); i < audio.length; i++) audio[i]! *= 2
  // The transcript's times run late and its lengths are approximate.
  const heard = played.map((n, i) => ({ pitch: n.pitch, start: n.start + 0.03 + (i % 3) * 0.02, duration: n.duration * 0.7 }))

  it('keeps only notes that sounded alone', () => {
    expect(isolatedNotes(heard).map((n) => n.pitch)).toEqual([52, 57, 62, 67, 57])
  })

  it('places each onset on the real start of the note, not the transcript time', () => {
    const envelope = peakEnvelope(audio, RATE)
    for (const [i, start] of [0.5, 1.6, 2.7, 3.4].entries()) {
      const onset = findOnset(envelope, (heard[i]!.start - 0.15) * RATE, (heard[i]!.start + 0.06) * RATE)!
      expect(Math.abs(onset.sample / RATE - start)).toBeLessThan(0.006)
      expect(onset.bleed).toBeLessThan(0.1)
    }
    expect(findOnset(envelope, 0, 0.3 * RATE)).toBeNull() // silence
  })

  const result = captureTakes(audio, RATE, heard)

  it('cuts out one in-tune take per pitch and reports what it set aside', () => {
    expect(result.takes.map((t) => t.pitch)).toEqual([52, 57, 62, 67])
    expect(result.heard).toBe(played.length)
    expect(result.rejected).toEqual({ overlapping: 5 })
    expect(result.duplicates).toBe(1)
    for (const take of result.takes) {
      // Check the pitch with the fast detector directly, well into the note.
      const hz = detectPitch(take.samples.subarray(4410, 4410 + 4096), RATE)!
      expect(Math.abs(hzToMidi(hz) - take.pitch)).toBeLessThan(0.1)
      expect(Math.abs(take.tuneCents)).toBeLessThan(10)
      expect(take.loop).toBeUndefined() // plucked: no sustain loop
      // Starts at the attack: loud within the first 10 ms, and no click at either end.
      expect(peakLevel(take.samples.subarray(0, 441))).toBeGreaterThan(0.2)
      expect(Math.abs(take.samples[0]!)).toBeLessThan(0.01)
      expect(Math.abs(take.samples[take.samples.length - 1]!)).toBeLessThan(0.01)
    }
    // The louder, longer second A was kept, and it rings past the transcript's idea of its length.
    const a = result.takes[1]!
    expect(a.start).toBeCloseTo(7.2, 1)
    expect(a.samples.length / RATE).toBeGreaterThan(1)
    // The short D stops before the next note starts.
    expect(result.takes[2]!.samples.length / RATE).toBeLessThan(0.72)
    expect(result.coverage).toMatchObject({ low: 52, high: 67, gaps: [], largestShift: 2 })
  })

  it('levels takes so a quiet note and a loud note come out equally loud', () => {
    const levels = result.takes.map((t) => loudness(t.samples, RATE))
    expect(Math.max(...levels) / Math.min(...levels)).toBeLessThan(1.15)
    for (const take of result.takes) expect(peakLevel(take.samples)).toBeLessThanOrEqual(0.9001)
    const quiet = Float32Array.from({ length: 4000 }, (_, i) => 0.01 * Math.sin(i / 5))
    expect(loudness(normalise(quiet, RATE), RATE)).toBeCloseTo(0.25, 2)
    expect(peakLevel(normalise(Float32Array.from([0, 0.001, 0]), RATE))).toBeLessThanOrEqual(0.9)
  })

  it('rejects a note whose audio is a different pitch from what the transcript claimed', () => {
    const wrong = captureTakes(audio, RATE, [{ pitch: 55, start: 0.53, duration: 0.6 }])
    expect(wrong.takes).toEqual([])
    expect(wrong.rejected).toEqual({ 'pitch mismatch': 1 })
    // An octave error is not let through either.
    expect(captureTakes(audio, RATE, [{ pitch: 40, start: 0.53, duration: 0.6 }]).takes).toEqual([])
    expect(captureTakes(audio, RATE, [{ pitch: 60, start: 0.2, duration: 0.2 }]).takes).toEqual([]) // nothing there
  })

  it('a captured take, shifted, plays at the pitch asked for', () => {
    const take = result.takes[0]!
    const z = zone(take.pitch, { tuneCents: take.tuneCents })
    const out = renderNote(take.samples, RATE, pitched([z]), z, { pitch: 55, velocity: 0.8, duration: 0.5 })
    expect(Math.abs(measurePitch(out, RATE)! - 55)).toBeLessThan(0.15)
  })

  it('finds a loop in held notes so they can sustain', () => {
    const sustained = new Float32Array(RATE * 3)
    sustained.set(held(60, 1.2), RATE * 0.3)
    sustained.set(held(65, 1.2), RATE * 1.7)
    const built = captureTakes(sustained, RATE, [
      { pitch: 60, start: 0.34, duration: 1 },
      { pitch: 65, start: 1.75, duration: 1 },
    ])
    expect(built.takes.map((t) => t.pitch)).toEqual([60, 65])
    for (const take of built.takes) expect(take.loop!.end - take.loop!.start).toBeGreaterThan(0.2)
  })

  it('finds single notes in a recording that has no transcript', () => {
    const notes = detectNotes(audio.subarray(0, Math.round(4.4 * RATE)), RATE)
    expect(notes.map((n) => n.pitch)).toEqual([52, 57, 62, 67])
    notes.forEach((n, i) => expect(Math.abs(n.start - [0.5, 1.6, 2.7, 3.4][i]!)).toBeLessThan(0.02))
    expect(captureTakes(audio, RATE, notes).takes.map((t) => t.pitch)).toEqual([52, 57, 62, 67])
    expect(detectNotes(new Float32Array(RATE), RATE)).toEqual([])
  })

  it('trims silence before a sound and tidies cut edges', () => {
    const padded = new Float32Array(3000)
    for (let i = 1000; i < 3000; i++) padded[i] = 0.5 * Math.sin(i / 3) + 0.1
    const trimmed = trimLeadingSilence(padded, 10000)
    expect(padded.length - trimmed.length).toBeGreaterThan(970)
    expect(padded.length - trimmed.length).toBeLessThanOrEqual(1000)
    const tidy = tidyEdges(padded.subarray(1000), 10000)
    expect(tidy[0]).toBe(0)
    expect(tidy[tidy.length - 1]).toBe(0)
    expect(Math.abs(tidy.reduce((a, b) => a + b, 0) / tidy.length)).toBeLessThan(0.01) // offset removed
  })
})

describe('synthesized stand-ins', () => {
  it('plucked strings and the electric piano are in tune across their range', () => {
    for (const pitch of [28, 40, 52, 64, 76]) {
      const string = pluck(midiToHz(pitch), 1.5, 32000, { decaySeconds: 3, brightness: 0.5, pickPosition: 0.2, softness: 0.4 })
      expect(Math.abs(measurePitch(string, 32000, pitch)! - pitch)).toBeLessThan(0.12)
      expect(peakLevel(string)).toBeCloseTo(0.9, 3)
      // It decays: the last third is much quieter than the first.
      expect(peakLevel(string.subarray(32000))).toBeLessThan(peakLevel(string.subarray(0, 16000)) * 0.7)
    }
    for (const pitch of [36, 60, 84]) expect(Math.abs(measurePitch(electricPiano(midiToHz(pitch), 1.5, 32000), 32000, pitch)! - pitch)).toBeLessThan(0.1)
  })

  it('drum hits are short, finite and the same every time', () => {
    for (const voice of ['kick', 'snare', 'hatClosed', 'hatOpen', 'tomMid', 'crash', 'ride', 'clap', 'rim', 'perc'] as const) {
      const hit = drumHit(voice, 32000)
      expect(hit.every(Number.isFinite)).toBe(true)
      expect(peakLevel(hit)).toBeCloseTo(0.9, 3)
      expect(hit.length / 32000).toBeLessThan(2)
      expect(drumHit(voice, 32000)).toEqual(hit)
    }
    // A kick is mostly low, a hi-hat mostly high: compare how often each crosses zero.
    const crossings = (a: Float32Array) => a.reduce((n, s, i) => n + (i && s > 0 !== a[i - 1]! > 0 ? 1 : 0), 0) / a.length
    expect(crossings(drumHit('kick', 32000))).toBeLessThan(0.02)
    expect(crossings(drumHit('hatClosed', 32000))).toBeGreaterThan(0.3)
  })

  it('builds each stand-in as a multi-sample set labelled as synthesized', () => {
    for (const which of ['guitar', 'bass', 'piano', 'drums'] as const) {
      const { def, samples } = generateStandIn(which, 16000)
      expect(def.name).toBe(which)
      expect(def.origin).toBe('synthesized')
      expect(def.label).toMatch(/not sampled/)
      expect(def.zones.length).toBeGreaterThanOrEqual(10)
      for (const z of def.zones) expect(samples.get(z.sample)!.length).toBeGreaterThan(100)
      if (which !== 'drums') expect(coverage(def.zones.map((z) => z.pitch))!.largestShift).toBe(1)
    }
    const { def, samples, sampleRate } = generateStandIn('guitar', 32000)
    const z = pickZone(def, 62)!
    const out = renderNote(samples.get(z.sample)!, sampleRate, def, z, { pitch: 62, velocity: 0.9, duration: 0.5 })
    expect(Math.abs(measurePitch(out, sampleRate)! - 62)).toBeLessThan(0.15)
    expect(pickZone(generateStandIn('drums', 8000).def, 38)!.drum).toBe('snare')
  })
})

describe('captured instruments on disk and the agent tools', () => {
  const audio = synth(6, [52, 55, 59, 64].map((pitch, i) => ({ pitch, start: 0.5 + i * 1.2, duration: 1 })), RATE)
  const dir = mkdtempSync(join(tmpdir(), 'jam-instruments-'))

  /** Stands in for the window: holds "mic" audio from session time 100, and does what features/sampler does with it. */
  function fakeWindow() {
    const requests: SamplerRequest[] = []
    const loaded = new Map<string, SavedInstrument>()
    const chosen: Record<string, string> = {}
    const state = () => ({
      instruments: [
        { name: 'piano', label: 'Grand piano', kind: 'pitched', origin: 'sampled', pitches: [48, 60], hits: 2 },
        ...[...loaded.values()].map((i) => ({ name: i.def.name, label: i.def.label, kind: 'pitched', origin: 'captured', pitches: i.def.zones.map((z) => z.pitch), hits: i.def.zones.length })),
      ],
      playing: { chords: 'piano', melody: 'piano', bass: 'bass', drums: 'drums', solo: 'guitar', ...chosen },
      chosen,
      micSeconds: 6,
    })
    const build = (name: string, label: string, samples: Float32Array, notes: Array<{ pitch: number; start: number; duration: number }>): CaptureReply => {
      const result = captureTakes(samples, RATE, notes.length ? notes : detectNotes(samples, RATE))
      if (!result.takes.length) return { ok: false, reason: 'None of the notes heard could be used.', heard: result.heard, rejected: result.rejected }
      const instrument: SavedInstrument = {
        def: { name, label, kind: 'pitched', origin: 'captured', zones: result.takes.map((t) => ({ sample: `${t.pitch}.wav`, pitch: t.pitch, tuneCents: t.tuneCents })) },
        createdAt: '2026-01-01T00:00:00Z',
        coverage: result.coverage,
        files: Object.fromEntries(result.takes.map((t) => [`${t.pitch}.wav`, encodeWav(t.samples, RATE)])),
      }
      loaded.set(name, instrument)
      return { ok: true, instrument, recording: { wav: encodeWav(samples, RATE), notes }, heard: result.heard, rejected: result.rejected, duplicates: result.duplicates, notesFrom: notes.length ? 'transcript' : 'audio' }
    }
    const answer = (request: SamplerRequest): unknown => {
      requests.push(request)
      switch (request.type) {
        case 'state':
          return state()
        case 'assign': {
          if (request.instrument && request.instrument !== 'piano' && !loaded.has(request.instrument)) return { roles: null, state: state() }
          const roles = request.role === 'all' ? ['chords', 'melody', 'bass', 'solo'] : [request.role]
          for (const role of roles) request.instrument ? (chosen[role] = request.instrument) : delete chosen[role]
          return { roles, state: state() }
        }
        case 'capture':
          if (!request.notes.length) return { ok: false, reason: 'The transcript has no notes from the microphone in that stretch.', heard: 0, rejected: {} } satisfies CaptureReply
          return build(request.name, request.label, audio.subarray(Math.round((request.from - 100) * RATE)), request.notes.map((n) => ({ ...n, start: n.start - request.from })))
        case 'build':
          return build(request.name, request.label, decodeWav(request.recording.wav).samples, request.recording.notes)
        case 'load':
          for (const instrument of request.instruments) loaded.set(instrument.def.name, instrument)
          return request.instruments.length
        case 'remove':
          return loaded.delete(request.name)
        case 'probe':
          return null
      }
    }
    const bus: FeatureBus = new FeatureBus((event: MainEvent) => {
      if (event.type === 'feature-request' && event.feature === SAMPLER) queueMicrotask(() => bus.settle(event.id, answer(event.message as SamplerRequest)))
    })
    return { bus, requests, loaded }
  }

  function session(window = fakeWindow()) {
    const transcript = new Transcript()
    const ctx: ToolContext = { transcript, memory: new TasteMemory(join(dir, 'taste')), now: () => 106, emit: () => undefined, bus: window.bus, saveMidi: async () => '' }
    process.env.JAM_DATA_DIR = dir
    const module = instruments(ctx)!
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await module.tools.find((t) => t.name === name)!.handler(args, {})
      return (result.content[0] as { text: string }).text
    }
    return { transcript, call, window, module }
  }

  it('captures from the transcript and mic audio, saves, and reports coverage for the model to read', async () => {
    const { transcript, call, window } = session()
    // What the transcript heard on the session clock (mic audio starts at 100 s), plus a MIDI note that must be ignored.
    transcript.add([52, 55, 59, 64].map((pitch, i) => ({ pitch, start: 100.54 + i * 1.2, duration: 0.7, velocity: 0.7, source: 'audio' as const, confidence: 0.5 })))
    transcript.add([{ pitch: 30, start: 101, duration: 1, velocity: 1, source: 'midi', confidence: 1 }])

    const said = await call('capture_instrument', { name: 'My Strat!', seconds: 6, wait_seconds: 0, extend: false, use_for: 'melody' })
    expect(said).toContain('Built "my-strat" from the notes heard: 4 notes heard')
    expect(said).toContain('Captured notes (4): E3 G3 B3 E4')
    expect(said).toContain('Within 3 semitones of a captured note: Db3 to G4')
    expect(said).toContain('not yet checked by the slower, more accurate pass')
    expect(said).toContain('Now used for: melody')
    const sent = window.requests.find((r) => r.type === 'capture')!
    expect(sent).toMatchObject({ type: 'capture', name: 'my-strat', from: 100, to: 106 })
    expect(sent.type === 'capture' && sent.notes.map((n) => n.pitch)).toEqual([52, 55, 59, 64])

    expect(readdirSync(join(dir, 'instruments', 'my-strat')).sort()).toEqual(['52.wav', '55.wav', '59.wav', '64.wav', 'instrument.json', 'recording.json', 'recording.wav'])
    const store = new InstrumentStore(join(dir, 'instruments'))
    const saved = (await store.load('my-strat'))!
    expect(saved.def).toMatchObject({ name: 'my-strat', label: 'My Strat!', origin: 'captured' })
    expect(Math.abs(measurePitch(decodeWav(saved.files['59.wav']!).samples, RATE, 59)! - 59)).toBeLessThan(0.1)
    expect((await store.recording('my-strat'))!.notes.length).toBe(4)

    expect(await call('list_instruments', {})).toMatch(/- my-strat: My Strat!\. built from the player's own sound; 4 recorded notes, E3 to E4\.[\s\S]*melody on my-strat \(chosen\)[\s\S]*rebuild from: my-strat/)
  })

  it('hands saved instruments back to the window in a later session, whichever side starts first', async () => {
    const later = fakeWindow()
    session(later)
    await expect.poll(() => later.loaded.has('my-strat')).toBe(true)
    later.loaded.clear()
    later.bus.deliver(SAMPLER, { type: 'ready' }) // the window (re)starts after main
    await expect.poll(() => later.loaded.has('my-strat')).toBe(true)
  })

  it('rebuilds from a saved recording, including a loose WAV with no notes', async () => {
    const { call, window } = session()
    expect(await call('capture_instrument', { name: 'again', seconds: 20, wait_seconds: 0, from_recording: 'my-strat', extend: false })).toContain('Captured notes (4): E3 G3 B3 E4')
    mkdirSync(join(dir, 'instruments', 'recordings'), { recursive: true })
    writeFileSync(join(dir, 'instruments', 'recordings', 'Old Take.wav'), encodeWav(audio, RATE))
    const said = await call('capture_instrument', { name: 'old', seconds: 20, wait_seconds: 0, from_recording: 'old take', extend: false })
    expect(said).toContain('from notes found in the recording itself')
    expect(said).toContain('Captured notes (4): E3 G3 B3 E4')
    expect(window.loaded.has('old')).toBe(true)
    expect(await call('capture_instrument', { name: 'x', seconds: 20, wait_seconds: 0, from_recording: 'nope', extend: false })).toMatch(/No saved recording called "nope"\. Available: again, my-strat, old, Old Take/)
  })

  it('says plainly when nothing usable was heard, sets and resets parts, and deletes', async () => {
    const { call, transcript, window } = session()
    await expect.poll(() => window.loaded.has('my-strat')).toBe(true) // saved instruments arrive shortly after start
    expect(await call('capture_instrument', { name: 'empty', seconds: 6, wait_seconds: 0, extend: false })).toMatch(/Could not build an instrument\..*single notes/)
    transcript.add(chord([52, 55, 59], 100.5, 1).map((n) => ({ ...n, velocity: 0.7, source: 'audio' as const, confidence: 0.9 })))
    expect(await call('capture_instrument', { name: 'chordy', seconds: 6, wait_seconds: 0, extend: false })).toMatch(/3 notes heard; set aside: 3 overlapping/)

    expect(await call('set_instrument', { role: 'all', instrument: 'my-strat' })).toMatch(/chords, melody, bass, solo now on my-strat.*recorded notes from E3 to E4/)
    expect(await call('set_instrument', { role: 'bass', instrument: 'default' })).toContain('bass back on the default')
    expect(await call('set_instrument', { role: 'bass', instrument: 'tuba' })).toMatch(/no instrument called "tuba"\. Available: piano, again, my-strat, old/)

    expect(await call('delete_instrument', { name: 'My Strat' })).toContain('Deleted "my-strat"')
    expect(await new InstrumentStore(join(dir, 'instruments')).names()).toEqual(['again', 'old'])
    expect(await call('delete_instrument', { name: 'piano' })).toContain('Built-in instruments cannot be deleted')
  })
})
