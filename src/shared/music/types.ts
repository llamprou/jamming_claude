/**
 * The common musical currency of the app. Every input (MIDI, audio, video) is
 * reduced to NoteEvents; every output (chords, rhythm, sheet, tab, diagrams,
 * playable MIDI) is derived from them. Times are seconds on the session clock.
 */

export type InputSource = 'midi' | 'audio' | 'video' | 'agent'

export interface NoteEvent {
  /** MIDI note number, 0-127. */
  pitch: number
  /** Onset, seconds since session start. */
  start: number
  /** Duration in seconds. 0 while the note is still sounding. */
  duration: number
  /** 0-1. */
  velocity: number
  source: InputSource
  /**
   * 0-1. Fast-path audio transcription is lossy; the slow correction pass
   * replaces low-confidence notes with a revised set (see Transcript.revise).
   */
  confidence: number
}

export interface ChordSpan {
  /** e.g. "Dm7", "G7/B". */
  symbol: string
  start: number
  end: number
  /** Pitch classes present, 0-11. */
  pitchClasses: number[]
}

export interface KeyEstimate {
  tonic: string
  mode: 'major' | 'minor'
  /** Correlation with the key profile, -1..1. */
  score: number
}

export interface RhythmEstimate {
  bpm: number
  /** Onsets per sixteenth step for one bar of 4/4, e.g. "x...x..x..x.x..." */
  pattern: string
  /** 0-1, how tightly onsets sit on the grid. */
  tightness: number
}

/** A clip the agent proposes or the user played: playable and exportable. */
export interface Clip {
  name: string
  bpm: number
  tracks: ClipTrack[]
}

export interface ClipTrack {
  role: 'chords' | 'melody' | 'bass' | 'drums' | 'solo'
  /** General MIDI program number, 0-127. Ignored for drums (channel 10). */
  program: number
  /** Note starts/durations are in beats, not seconds, so clips follow tempo. */
  notes: Array<{ pitch: number; startBeat: number; durationBeats: number; velocity: number }>
}

export type Instrument = 'piano' | 'guitar' | 'bass'

export type ViewKind = 'chords' | 'rhythm' | 'sheet' | 'tab' | 'piano' | 'guitar' | 'bass'

export interface Snapshot {
  windowSeconds: number
  notes: NoteEvent[]
  chords: ChordSpan[]
  key: KeyEstimate | null
  rhythm: RhythmEstimate | null
  /** True once the slow pass has corrected this window. */
  corrected: boolean
}
