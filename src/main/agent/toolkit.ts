import type { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { MainEvent } from '@shared/ipc'
import type { Transcript } from '@shared/music/transcript'
import type { ScreenCapturer } from '@shared/screen'
import type { FeatureBus } from '../bus'
import type { Playback } from '../playback'
import type { TasteMemory } from '../memory/taste'

/**
 * What every tool module gets to work with. Add to this sparingly: a module
 * that needs its own state should own it, not hang it here.
 */
export interface ToolContext {
  transcript: Transcript
  memory: TasteMemory
  /** Seconds on the session clock. */
  now(): number
  /** Core UI events (views, playback, captions). Feature modules use `bus` instead. */
  emit(event: MainEvent): void
  /** How tools make sound: `playback.play(clip, { loop })` and `playback.stop()`. Do not emit 'play-clip' yourself. */
  playback: Playback
  /** Typed-by-convention channel to a feature's code in the window; see src/shared/features/. */
  bus: FeatureBus
  /** Save a generated MIDI file where the player can find it; returns its path. */
  saveMidi(name: string, midi: Uint8Array): Promise<string>
  /**
   * Give the agent a turn about something that happened without the player
   * speaking (they pressed Done on the whiteboard). Absent in tests.
   */
  notify?: (note: string) => void
  /** Screenshots of the app window or the screen, taken only when a tool asks. Absent in tests and where capture is unavailable. */
  screen?: ScreenCapturer
  /** Present only when self-extension is enabled (running from a source checkout). */
  extend?: (request: string) => Promise<string>
}

export type JamTool = ReturnType<typeof tool>

/**
 * A self-contained group of tools. Each module lives in its own file under
 * agent/tools/, is listed once in agent/tools/index.ts, and brings its own
 * paragraph of guidance for the system prompt. Nothing else needs editing to
 * add a capability.
 */
export interface ToolModule {
  name: string
  /** Lines for the system prompt's tool section: what these tools are for and when to reach for them. Spoken-voice rules apply. */
  guide: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Array<ReturnType<typeof tool<any>>>
}

/** Return null to leave the module out (e.g. a capability this build lacks). */
export type ToolModuleFactory = (ctx: ToolContext) => ToolModule | null

export const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })

export const noteSchema = z.object({
  pitch: z.number().int().min(0).max(127).describe('MIDI note number; 60 is middle C'),
  startBeat: z.number().min(0),
  durationBeats: z.number().positive(),
  velocity: z.number().min(0).max(1).default(0.8),
})

export const trackSchema = z.object({
  role: z.enum(['chords', 'melody', 'bass', 'drums', 'solo']),
  program: z.number().int().min(0).max(127).default(0).describe('General MIDI program; 0 piano, 24 nylon guitar, 32 acoustic bass'),
  notes: z.array(noteSchema),
})

