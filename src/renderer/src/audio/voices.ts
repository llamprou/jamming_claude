import type { ClipTrack } from '@shared/music/types'
import { audioContext } from './context'

/**
 * A voice turns one note into sound. Playback asks the registry which voice
 * to use for each track, so a new instrument (a sampler, a physical model)
 * is added by registering it; nothing in the player changes.
 */
export interface Voice {
  /** Schedule one note. Return every node that should be stopped if playback is cancelled. */
  play(note: { pitch: number; velocity: number }, when: number, duration: number, output: AudioNode, track: ClipTrack): AudioScheduledSourceNode[]
}

type Chooser = (track: ClipTrack) => Voice | null
const choosers: Chooser[] = []

/**
 * Register a way of choosing a voice. Later registrations win, so a feature
 * can take over some tracks (say, every 'bass' track) and return null for the
 * rest to fall through to earlier choosers and finally the built-in synth.
 */
export function registerVoice(chooser: Chooser): () => void {
  choosers.push(chooser)
  return () => void choosers.splice(choosers.indexOf(chooser), 1)
}

export function voiceFor(track: ClipTrack): Voice {
  for (let i = choosers.length - 1; i >= 0; i--) {
    const voice = choosers[i]!(track)
    if (voice) return voice
  }
  return builtinSynth
}

const midiHz = (pitch: number) => 440 * 2 ** ((pitch - 69) / 12)

/** The fallback: oscillators for pitched tracks, filtered noise for drums. */
export const builtinSynth: Voice = {
  play(note, when, duration, output, track) {
    const audio = audioContext()
    const gain = audio.createGain()
    gain.connect(output)
    const level = 0.16 * note.velocity
    if (track.role === 'drums') {
      // Noise burst, pitched roughly by drum: low = kick, high = hats.
      const buffer = audio.createBuffer(1, audio.sampleRate * 0.12, audio.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
      const source = audio.createBufferSource()
      source.buffer = buffer
      const filter = audio.createBiquadFilter()
      filter.type = note.pitch < 40 ? 'lowpass' : 'highpass'
      filter.frequency.value = note.pitch < 40 ? 150 : note.pitch < 45 ? 1800 : 7000
      source.connect(filter).connect(gain)
      gain.gain.setValueAtTime(level * 2.5, when)
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.12)
      source.start(when)
      return [source]
    }
    const osc = audio.createOscillator()
    osc.type = track.role === 'bass' ? 'sine' : track.role === 'chords' ? 'triangle' : 'sawtooth'
    osc.frequency.value = midiHz(note.pitch)
    const filter = audio.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = track.role === 'chords' ? 1800 : 3200
    osc.connect(filter).connect(gain)
    gain.gain.setValueAtTime(0, when)
    gain.gain.linearRampToValueAtTime(level, when + 0.012)
    gain.gain.setTargetAtTime(level * 0.6, when + 0.05, 0.2)
    gain.gain.setTargetAtTime(0, when + duration, 0.04)
    osc.start(when)
    osc.stop(when + duration + 0.3)
    return [osc]
  },
}
