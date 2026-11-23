import type { Clip, Instrument, NoteEvent, Snapshot, ViewKind } from './music/types'

/** Everything the main process (agent, voice, memory) pushes to the window. */
export type MainEvent =
  | { type: 'status'; agent: 'idle' | 'thinking' | 'speaking' | 'error'; detail?: string }
  | { type: 'transcript'; role: 'user' | 'buddy'; text: string; final: boolean }
  | { type: 'show-view'; view: ViewKind; instrument?: Instrument; title?: string; notes?: NoteEvent[]; chords?: string[] }
  | { type: 'hide-view'; view: ViewKind | 'all' }
  | { type: 'play-clip'; clip: Clip; savedTo?: string }
  | { type: 'stop-playback' }
  | { type: 'tts-audio'; pcm16Base64: string; sampleRate: number }
  | { type: 'tts-flush' }
  | { type: 'config'; voice: boolean; missing: string[] }

/** Everything the window sends to main. */
export interface RendererApi {
  onEvent(handler: (event: MainEvent) => void): () => void
  /** Typed chat fallback and anything said by voice ends up here. */
  say(text: string): Promise<void>
  /** Live input from Web MIDI. */
  midi(kind: 'on' | 'off', pitch: number, velocity: number, time: number): void
  /** Fast-path notes from audio or video transcription. */
  notes(notes: NoteEvent[]): void
  /** Slow-pass correction: replace audio notes in [from, to) with these. */
  revise(from: number, to: number, notes: NoteEvent[]): void
  /** Seconds on the main process's session clock. */
  clock(): Promise<number>
  /** Mic audio for speech-to-text: 16 kHz mono PCM16. */
  micAudio(pcm16: ArrayBuffer): void
  snapshot(windowSeconds?: number): Promise<Snapshot>
  interrupt(): void
}

export const CHANNELS = {
  event: 'jam:event',
  say: 'jam:say',
  midi: 'jam:midi',
  notes: 'jam:notes',
  revise: 'jam:revise',
  clock: 'jam:clock',
  micAudio: 'jam:mic',
  snapshot: 'jam:snapshot',
  interrupt: 'jam:interrupt',
} as const
