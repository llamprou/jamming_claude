import type { Clip, NoteEvent } from '@shared/music/types'
import { detectPitch, hzToMidi } from '@shared/music/pitch'

/**
 * All sound in and out of the app goes through one AudioContext in the
 * renderer. That is deliberate: Chromium's echo canceller can only remove the
 * buddy's voice and playback from the mic if it plays them itself.
 */

let context: AudioContext | null = null
const ctx = (): AudioContext => (context ??= new AudioContext({ latencyHint: 'interactive' }))

/* ---------- clip playback (simple built-in synth) ---------- */

let playing: AudioScheduledSourceNode[] = []

const midiHz = (pitch: number) => 440 * 2 ** ((pitch - 69) / 12)

export function playClip(clip: Clip): void {
  stopClip()
  const audio = ctx()
  const beat = 60 / clip.bpm
  const t0 = audio.currentTime + 0.08
  for (const track of clip.tracks) {
    for (const n of track.notes) {
      const start = t0 + n.startBeat * beat
      const length = n.durationBeats * beat
      const gain = audio.createGain()
      gain.connect(audio.destination)
      const level = 0.16 * n.velocity
      if (track.role === 'drums') {
        // Noise burst, pitched roughly by drum: low = kick, high = hats.
        const buffer = audio.createBuffer(1, audio.sampleRate * 0.12, audio.sampleRate)
        const data = buffer.getChannelData(0)
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
        const source = audio.createBufferSource()
        source.buffer = buffer
        const filter = audio.createBiquadFilter()
        filter.type = n.pitch < 40 ? 'lowpass' : 'highpass'
        filter.frequency.value = n.pitch < 40 ? 150 : n.pitch < 45 ? 1800 : 7000
        source.connect(filter).connect(gain)
        gain.gain.setValueAtTime(level * 2.5, start)
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.12)
        source.start(start)
        playing.push(source)
        continue
      }
      const osc = audio.createOscillator()
      osc.type = track.role === 'bass' ? 'sine' : track.role === 'chords' ? 'triangle' : 'sawtooth'
      osc.frequency.value = midiHz(n.pitch)
      const filter = audio.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = track.role === 'chords' ? 1800 : 3200
      osc.connect(filter).connect(gain)
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(level, start + 0.012)
      gain.gain.setTargetAtTime(level * 0.6, start + 0.05, 0.2)
      gain.gain.setTargetAtTime(0, start + length, 0.04)
      osc.start(start)
      osc.stop(start + length + 0.3)
      playing.push(osc)
    }
  }
}

export function stopClip(): void {
  for (const node of playing) {
    try {
      node.stop()
    } catch {
      // already stopped
    }
  }
  playing = []
}

/* ---------- buddy voice (streamed PCM from text-to-speech) ---------- */

let voiceCursor = 0
let voiceNodes: AudioBufferSourceNode[] = []

export function playVoiceChunk(pcm16Base64: string, sampleRate: number): void {
  const audio = ctx()
  const bytes = Uint8Array.from(atob(pcm16Base64), (c) => c.charCodeAt(0))
  const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2))
  const buffer = audio.createBuffer(1, samples.length, sampleRate)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 32768
  const source = audio.createBufferSource()
  source.buffer = buffer
  source.connect(audio.destination)
  voiceCursor = Math.max(voiceCursor, audio.currentTime + 0.03)
  source.start(voiceCursor)
  voiceCursor += buffer.duration
  voiceNodes.push(source)
  source.onended = () => (voiceNodes = voiceNodes.filter((n) => n !== source))
}

export function flushVoice(): void {
  for (const node of voiceNodes) node.stop()
  voiceNodes = []
  voiceCursor = 0
}

/* ---------- microphone: speech to main, pitch to the transcript ---------- */

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('tap', Tap)
`

export interface MicHandle {
  stop(): void
}

/**
 * Open the mic once and split it two ways:
 *  - speech path: echo-cancelled, downsampled to 16 kHz PCM16 for speech-to-text
 *  - music path:  the same signal through a fast monophonic pitch tracker.
 *    This is the lossy fast pass; the slow polyphonic pass corrects it later.
 */
export async function startMic(opts: {
  onSpeechPcm(pcm16: ArrayBuffer): void
  onNotes(notes: NoteEvent[]): void
  now(): number
}): Promise<MicHandle> {
  const audio = ctx()
  await audio.resume()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  })
  await audio.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })))
  const source = audio.createMediaStreamSource(stream)
  const tap = new AudioWorkletNode(audio, 'tap')
  source.connect(tap)

  const ratio = audio.sampleRate / 16000
  let resamplePhase = 0
  let speech: number[] = []

  const frameSize = 2048
  let frame = new Float32Array(frameSize)
  let filled = 0
  let current: { pitch: number; start: number; frames: number } | null = null

  const closeNote = (end: number) => {
    if (current && current.frames >= 2) {
      opts.onNotes([{ pitch: current.pitch, start: current.start, duration: Math.max(end - current.start, 0.05), velocity: 0.7, source: 'audio', confidence: 0.5 }])
    }
    current = null
  }

  tap.port.onmessage = (message: MessageEvent<Float32Array>) => {
    const block = message.data

    for (; resamplePhase < block.length; resamplePhase += ratio) {
      speech.push(Math.max(-1, Math.min(1, block[Math.floor(resamplePhase)]!)) * 32767)
    }
    resamplePhase -= block.length
    if (speech.length >= 1280) {
      opts.onSpeechPcm(Int16Array.from(speech).buffer) // 80 ms chunks
      speech = []
    }

    let offset = 0
    while (offset < block.length) {
      const take = Math.min(frameSize - filled, block.length - offset)
      frame.set(block.subarray(offset, offset + take), filled)
      filled += take
      offset += take
      if (filled < frameSize) break
      const hz = detectPitch(frame, audio.sampleRate)
      const time = opts.now()
      const pitch = hz ? Math.round(hzToMidi(hz)) : null
      if (pitch === null || (current && pitch !== current.pitch)) closeNote(time)
      if (pitch !== null) {
        if (!current) current = { pitch, start: time, frames: 1 }
        else current.frames += 1
      }
      // 50% overlap between analysis frames
      frame.copyWithin(0, frameSize / 2)
      filled = frameSize / 2
    }
  }

  return {
    stop() {
      tap.port.onmessage = null
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      frame = new Float32Array(0)
    },
  }
}

/* ---------- Web MIDI ---------- */

export async function startMidi(onNote: (kind: 'on' | 'off', pitch: number, velocity: number) => void): Promise<string[]> {
  const access = await navigator.requestMIDIAccess()
  const names: string[] = []
  const bind = () => {
    names.length = 0
    for (const input of access.inputs.values()) {
      names.push(input.name ?? 'MIDI input')
      input.onmidimessage = (event) => {
        const [status = 0, pitch = 0, velocity = 0] = event.data ?? []
        const command = status & 0xf0
        if (command === 0x90 && velocity > 0) onNote('on', pitch, velocity / 127)
        else if (command === 0x80 || command === 0x90) onNote('off', pitch, 0)
      }
    }
  }
  bind()
  access.onstatechange = bind
  return names
}
