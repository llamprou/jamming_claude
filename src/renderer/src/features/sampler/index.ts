import { captureTakes, detectNotes, type HeardNote } from '@shared/music/capture'
import { AudioRing } from '@shared/music/slowpass'
import { coverage, type InstrumentDef } from '@shared/music/sampler'
import { decodeWav, encodeWav } from '@shared/music/wav'
import { SAMPLER, type CaptureReply, type SamplerNotice, type SamplerRequest, type SavedInstrument } from '@shared/features/sampler'
import { onMicBlock } from '../../audio/context'
import { answerFeature, sendFeature } from '../bus'
import { addInstrument, assign, getInstrument, monoBuffer, probe, registerSampler, removeInstrument, samplerState } from './engine'
import { loadStock } from './stock'

/**
 * Sampled instruments for the buddy's playback, including ones built from the
 * player's own sound. This file is the wiring: it keeps the last stretch of
 * mic audio, answers the main process's requests, and hands the signal
 * processing to shared/music/capture.ts.
 */

/** How much mic audio is kept for capturing, seconds. */
const MIC_SECONDS = 60
const NOTE_NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B']
const fileName = (pitch: number) => `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}.wav`

let ring: AudioRing | null = null
let ringRate = 0

function build(name: string, label: string, audio: Float32Array, sampleRate: number, heard: HeardNote[], extend = false): CaptureReply {
  const existing = getInstrument(name)
  if (existing && existing.def.origin !== 'captured') return { ok: false, reason: `"${name}" is a built-in instrument; choose another name.`, heard: 0, rejected: {} }
  // With no transcript to go by (a recording saved without notes), find the notes in the audio itself.
  const notesFrom = heard.length ? 'transcript' : 'audio'
  const notes = heard.length ? heard : detectNotes(audio, sampleRate)
  const result = captureTakes(audio, sampleRate, notes)
  if (result.takes.length === 0) return { ok: false, reason: notes.length ? 'None of the notes heard could be used.' : 'No notes were heard in that audio.', heard: result.heard, rejected: result.rejected }

  const def: InstrumentDef = {
    name,
    label,
    kind: 'pitched',
    origin: 'captured',
    release: 0.2,
    gain: 0.45,
    zones: result.takes.map((take) => ({ sample: fileName(take.pitch), pitch: take.pitch, tuneCents: take.tuneCents, loop: take.loop })),
  }
  const buffers = new Map<string, AudioBuffer>()
  const files: Record<string, Uint8Array> = {}
  for (const take of result.takes) {
    buffers.set(fileName(take.pitch), monoBuffer(take.samples, sampleRate))
    files[fileName(take.pitch)] = encodeWav(take.samples, sampleRate)
  }
  if (extend && existing) {
    // Keep the earlier takes of pitches this capture did not replace.
    for (const zone of existing.def.zones) {
      const buffer = existing.buffers.get(zone.sample)
      if (!buffer || buffers.has(zone.sample)) continue
      def.zones.push(zone)
      buffers.set(zone.sample, buffer)
      files[zone.sample] = encodeWav(buffer.getChannelData(0), buffer.sampleRate)
    }
    def.zones.sort((a, b) => a.pitch - b.pitch)
  }
  addInstrument({ def, buffers })
  return {
    ok: true,
    instrument: { def, createdAt: new Date().toISOString(), coverage: coverage(def.zones.map((z) => z.pitch)), files },
    recording: { wav: encodeWav(audio, sampleRate), notes },
    heard: result.heard,
    rejected: result.rejected,
    duplicates: result.duplicates,
    notesFrom,
  }
}

function load(saved: SavedInstrument[]): number {
  let loaded = 0
  for (const instrument of saved) {
    try {
      const buffers = new Map<string, AudioBuffer>()
      for (const zone of instrument.def.zones) {
        const bytes = instrument.files[zone.sample]
        if (!bytes) throw new Error(`missing ${zone.sample}`)
        const wav = decodeWav(bytes)
        buffers.set(zone.sample, monoBuffer(wav.samples, wav.sampleRate))
      }
      addInstrument({ def: { ...instrument.def, origin: 'captured' }, buffers })
      loaded++
    } catch (error) {
      console.warn(`sampler: could not load saved instrument ${instrument.def.name}`, error)
    }
  }
  return loaded
}

async function handle(request: SamplerRequest): Promise<unknown> {
  switch (request.type) {
    case 'state':
      return samplerState(ring ? ring.end - ring.start : 0)
    case 'assign':
      return { roles: assign(request.role, request.instrument), state: samplerState(ring ? ring.end - ring.start : 0) }
    case 'capture': {
      if (!ring) return { ok: false, reason: 'The microphone has not delivered any audio yet.', heard: 0, rejected: {} } satisfies CaptureReply
      const { audio, from } = ring.slice(request.from, request.to)
      if (audio.length < ringRate * 0.5) return { ok: false, reason: 'No microphone audio is held for that stretch.', heard: 0, rejected: {} } satisfies CaptureReply
      const notes = request.notes.map((n) => ({ pitch: n.pitch, start: n.start - from, duration: n.duration })).filter((n) => n.start > -0.05 && n.start < audio.length / ringRate)
      // An empty list here means the transcript heard nothing, not that it is unknown: do not guess from the audio.
      if (notes.length === 0) return { ok: false, reason: 'The transcript has no notes from the microphone in that stretch.', heard: 0, rejected: {} } satisfies CaptureReply
      return build(request.name, request.label, audio, ringRate, notes, request.extend)
    }
    case 'build': {
      const wav = decodeWav(request.recording.wav)
      return build(request.name, request.label, wav.samples, wav.sampleRate, request.recording.notes, request.extend)
    }
    case 'load':
      return load(request.instruments)
    case 'remove':
      return getInstrument(request.name)?.def.origin === 'captured' && removeInstrument(request.name)
    case 'probe':
      return probe(request.role, request.pitch)
  }
}

export function start(): void {
  registerSampler()
  void loadStock()
  onMicBlock((block, sampleRate, sessionTime) => {
    if (!ring || sampleRate !== ringRate) {
      ring = new AudioRing(MIC_SECONDS, sampleRate)
      ringRate = sampleRate
    }
    ring.push(block, sessionTime)
  })
  answerFeature(SAMPLER, (message) => handle(message as SamplerRequest))
  // Main answers this by sending the instruments saved in earlier sessions ('load').
  sendFeature(SAMPLER, { type: 'ready' } satisfies SamplerNotice)
}
