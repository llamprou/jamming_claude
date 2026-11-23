import { audioContext } from './context'

/** The buddy's voice: streamed PCM from text-to-speech, queued gaplessly. */

let voiceCursor = 0
let voiceNodes: AudioBufferSourceNode[] = []

export function playVoiceChunk(pcm16Base64: string, sampleRate: number): void {
  const audio = audioContext()
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
