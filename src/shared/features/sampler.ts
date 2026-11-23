import type { HeardNote, RejectReason } from '../music/capture'
import type { Coverage, InstrumentDef, TrackRole } from '../music/sampler'

/**
 * Bus traffic for the sampler: main (agent/tools/instruments.ts) asks, the
 * window (features/sampler) answers. The window holds the audio and plays it;
 * main holds the transcript and the files on disk.
 */
export const SAMPLER = 'sampler'

/** What the agent is told about one instrument. */
export interface InstrumentInfo {
  name: string
  label: string
  kind: InstrumentDef['kind']
  origin: InstrumentDef['origin']
  /** Recorded pitches (pitched instruments) or number of hits (drums). */
  pitches: number[]
  hits: number
  credit?: string
}

export interface SamplerState {
  instruments: InstrumentInfo[]
  /** What each part plays on right now. */
  playing: Record<TrackRole, string>
  /** Parts the player has chosen an instrument for; the rest follow the defaults. */
  chosen: Partial<Record<TrackRole, string>>
  /** Seconds of mic audio currently held for capturing. */
  micSeconds: number
}

/** A captured instrument as stored on disk: a manifest plus one WAV per zone. */
export interface SavedInstrument {
  def: InstrumentDef
  createdAt: string
  coverage: Coverage | null
  /** WAV bytes keyed by `zone.sample` (a file name). */
  files: Record<string, Uint8Array>
}

/** The audio an instrument was built from, kept so it can be rebuilt later. */
export interface SavedRecording {
  wav: Uint8Array
  /** Notes the transcript heard, timed from the start of the recording. Empty if unknown. */
  notes: HeardNote[]
}

export type CaptureReply =
  | { ok: false; reason: string; heard: number; rejected: Partial<Record<RejectReason, number>> }
  | {
      ok: true
      instrument: SavedInstrument
      recording: SavedRecording
      heard: number
      rejected: Partial<Record<RejectReason, number>>
      duplicates: number
      /** Whether the notes came from the transcript or had to be found in the audio alone. */
      notesFrom: 'transcript' | 'audio'
    }

/** Result of rendering one test note offline through whatever voice a part would use. */
export interface ProbeReply {
  /** Instrument the voice registry chose, or null if the built-in synth would play. */
  instrument: string | null
  origin: InstrumentDef['origin'] | null
  /** Pitch of the rendered audio in Hz, or null if none was found (drums, silence). */
  hz: number | null
  peak: number
}

/** main -> window, with bus.request. */
export type SamplerRequest =
  | { type: 'state' }
  /** Choose what a part plays on; null goes back to the default. */
  | { type: 'assign'; role: TrackRole | 'all'; instrument: string | null }
  /** Build an instrument from mic audio between two session times, using the notes the transcript heard there. `extend` adds to an existing captured instrument of that name instead of replacing it. */
  | { type: 'capture'; name: string; label: string; from: number; to: number; notes: Array<{ pitch: number; start: number; duration: number }>; extend?: boolean }
  /** Build an instrument from a saved recording. */
  | { type: 'build'; name: string; label: string; recording: SavedRecording; extend?: boolean }
  /** Make saved instruments playable (sent at startup). */
  | { type: 'load'; instruments: SavedInstrument[] }
  | { type: 'remove'; name: string }
  | { type: 'probe'; role: TrackRole; pitch: number }

/** window -> main, with sendFeature. */
export type SamplerNotice = { type: 'ready' }
