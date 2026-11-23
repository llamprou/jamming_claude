import type { Clip, Instrument, NoteEvent, Snapshot, ViewKind } from './music/types'

/** Everything the main process (agent, voice, memory) pushes to the window. */
export type MainEvent =
  | { type: 'status'; agent: 'idle' | 'thinking' | 'speaking' | 'error'; detail?: string }
  | { type: 'transcript'; role: 'user' | 'buddy'; text: string; final: boolean }
  | { type: 'show-view'; view: ViewKind; instrument?: Instrument; title?: string; notes?: NoteEvent[]; chords?: string[]; data?: unknown }
  | { type: 'hide-view'; view: ViewKind | 'all' }
  | { type: 'play-clip'; clip: Clip; savedTo?: string }
  | { type: 'stop-playback' }
  | { type: 'tts-audio'; pcm16Base64: string; sampleRate: number }
  | { type: 'tts-flush' }
  | { type: 'config'; voice: boolean; missing: string[] }
  /** A message for one feature's code in the window. Its shape is defined in src/shared/features/<feature>.ts. */
  | { type: 'feature'; feature: string; message: unknown }
  /** Like 'feature', but the window must answer with featureReply(id, ...). */
  | { type: 'feature-request'; id: number; feature: string; message: unknown }

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
  /** A message from one feature's window code to its main-process code. */
  feature(feature: string, message: unknown): void
  /** Answer a 'feature-request'. Pass `error` instead of `result` if it failed. */
  featureReply(id: number, result: unknown, error?: string): void
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
  feature: 'jam:feature',
  featureReply: 'jam:feature-reply',
} as const
