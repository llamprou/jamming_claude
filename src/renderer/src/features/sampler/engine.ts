import { measurePitch, peakLevel } from '@shared/music/capture'
import { DEFAULT_INSTRUMENTS, TRACK_ROLES, instrumentForTrack, midiToHz, noteEnvelope, pickZone, playbackRate, type InstrumentDef, type TrackRole } from '@shared/music/sampler'
import type { ClipTrack } from '@shared/music/types'
import type { InstrumentInfo, ProbeReply, SamplerState } from '@shared/features/sampler'
import { audioContext } from '../../audio/context'
import { registerVoice, voiceFor, type Voice } from '../../audio/voices'

/**
 * The sampler as a voice: the thin WebAudio shell around the arithmetic in
 * shared/music/sampler.ts. Instruments are sets of AudioBuffers; each note is
 * one buffer source, sped up or slowed to pitch, through one gain envelope.
 */

export interface LoadedInstrument {
  def: InstrumentDef
  /** Audio for each zone, keyed by `zone.sample`. */
  buffers: Map<string, AudioBuffer>
}

type SamplerVoice = Voice & { instrument: LoadedInstrument }

const instruments = new Map<string, LoadedInstrument>()
const voices = new WeakMap<LoadedInstrument, SamplerVoice>()
const chosen: Partial<Record<TrackRole, string>> = {}

export function monoBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
  const buffer = new AudioBuffer({ length: Math.max(1, samples.length), sampleRate, numberOfChannels: 1 })
  buffer.copyToChannel(Float32Array.from(samples), 0)
  return buffer
}

/** Schedule one note on any context (the live one, or an offline one for checks). */
export function schedule(
  context: BaseAudioContext,
  instrument: LoadedInstrument,
  note: { pitch: number; velocity: number },
  when: number,
  duration: number,
  output: AudioNode,
): AudioScheduledSourceNode[] {
  const { def, buffers } = instrument
  const zone = pickZone(def, note.pitch, note.velocity)
  const buffer = zone && buffers.get(zone.sample)
  if (!zone || !buffer) return []
  const rate = def.kind === 'drums' ? 1 : playbackRate(zone, note.pitch)
  const envelope = noteEnvelope(def, zone, note.velocity, duration, buffer.duration, rate)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.playbackRate.value = rate
  if (zone.loop) {
    source.loop = true
    source.loopStart = zone.loop.start
    source.loopEnd = zone.loop.end
  }
  const gain = context.createGain()
  source.connect(gain).connect(output)
  const start = Math.max(when, context.currentTime)
  if (envelope.oneShot) {
    gain.gain.setValueAtTime(envelope.peak, start)
  } else {
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(envelope.peak, start + envelope.attack)
    gain.gain.setTargetAtTime(0, start + envelope.releaseAt, envelope.releaseTau)
  }
  source.start(start)
  source.stop(start + envelope.stopAt)
  return [source]
}

function voiceOf(instrument: LoadedInstrument): SamplerVoice {
  let voice = voices.get(instrument)
  if (!voice) {
    voice = { instrument, play: (note, when, duration, output) => schedule(audioContext(), instrument, note, when, duration, output) }
    voices.set(instrument, voice)
  }
  return voice
}

/** Take over every track an instrument is loaded for; the built-in synth plays the rest. */
export function registerSampler(): void {
  registerVoice((track: ClipTrack) => {
    const instrument = instruments.get(instrumentForTrack(track, chosen))
    return instrument ? voiceOf(instrument) : null
  })
}

export const getInstrument = (name: string): LoadedInstrument | undefined => instruments.get(name)

export function addInstrument(instrument: LoadedInstrument): void {
  instruments.set(instrument.def.name, instrument)
}

export function removeInstrument(name: string): boolean {
  for (const role of TRACK_ROLES) if (chosen[role] === name) delete chosen[role]
  return instruments.delete(name)
}

/** Returns the roles that changed, or null if there is no such instrument. */
export function assign(role: TrackRole | 'all', name: string | null): TrackRole[] | null {
  if (name !== null && !instruments.has(name)) return null
  const roles = role === 'all' ? TRACK_ROLES.filter((r) => name === null || (instruments.get(name)!.def.kind === 'drums') === (r === 'drums')) : [role]
  for (const r of roles) {
    if (name === null) delete chosen[r]
    else chosen[r] = name
  }
  return roles
}

const info = ({ def }: LoadedInstrument): InstrumentInfo => ({
  name: def.name,
  label: def.label,
  kind: def.kind,
  origin: def.origin,
  pitches: def.kind === 'drums' ? [] : [...new Set(def.zones.map((z) => z.pitch))].sort((a, b) => a - b),
  hits: def.zones.length,
  credit: def.credit,
})

export function samplerState(micSeconds: number): SamplerState {
  const playing = {} as Record<TrackRole, string>
  for (const role of TRACK_ROLES) {
    const name = chosen[role] ?? DEFAULT_INSTRUMENTS[role]
    playing[role] = instruments.has(name) ? name : 'built-in synth'
  }
  return { instruments: [...instruments.values()].map(info), playing, chosen: { ...chosen }, micSeconds }
}

/**
 * Render one note offline through whatever the voice registry would pick for
 * a part, and measure what came out. A check that needs no speakers.
 */
export async function probe(role: TrackRole, pitch: number): Promise<ProbeReply> {
  const voice = voiceFor({ role, program: 0, notes: [] }) as Partial<SamplerVoice>
  const instrument = voice.instrument
  if (!instrument) return { instrument: null, origin: null, hz: null, peak: 0 }
  const sampleRate = 44100
  const offline = new OfflineAudioContext(1, sampleRate, sampleRate)
  schedule(offline, instrument, { pitch, velocity: 0.8 }, 0, 0.7, offline.destination)
  const rendered = (await offline.startRendering()).getChannelData(0)
  const measured = instrument.def.kind === 'drums' ? null : measurePitch(rendered, sampleRate)
  return { instrument: instrument.def.name, origin: instrument.def.origin, hz: measured === null ? null : midiToHz(measured), peak: peakLevel(rendered) }
}
