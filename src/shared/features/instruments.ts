import { chordPitches } from '../music/render'
import { chordsAsBeats, type BeatNote } from '../music/sounding'

/**
 * `Panel.data` for the piano, guitar and bass views
 * (src/renderer/src/views/instruments.tsx), set by the `show` tool.
 */
export interface InstrumentViewData {
  /**
   * With no notes or chords to show: light what the player is playing, what the
   * app is playing (transport loops and one-shots), or both. Default both:
   * playback while something is playing, otherwise the player.
   */
  follow?: 'both' | 'playback' | 'player'
  /** Only these parts of the playback: transport layer ids or track roles (chords, melody, bass, solo). Default all but drums. */
  parts?: string[]
  /** Timed notes to step through, in beats. Absent: show `Panel.notes` / `Panel.chords` as one still frame. */
  steps?: BeatNote[]
  /** Tempo for stepping when the transport is not running. With it running, steps follow its beat. */
  bpm?: number
  /** Repeat the steps (default true), or step through once and hold the final notes. */
  loop?: boolean
}

export const isInstrumentView = (view: string): boolean => view === 'piano' || view === 'guitar' || view === 'bass'

/**
 * What `show` sends for an instrument view. Several chords, or notes that
 * don't all start together, become steps; a single chord or a single block of
 * notes stays a still frame.
 */
export function instrumentViewData(args: {
  chords?: string[]
  notes?: BeatNote[]
  follow?: InstrumentViewData['follow']
  parts?: string[]
  bpm?: number
  beats_per_chord?: number
  loop?: boolean
}): InstrumentViewData {
  const data: InstrumentViewData = { follow: args.follow ?? 'both', parts: args.parts, bpm: args.bpm, loop: args.loop }
  if (args.notes?.length) {
    const onsets = new Set(args.notes.map((n) => n.startBeat))
    if (onsets.size > 1) data.steps = args.notes.map((n) => ({ pitch: n.pitch, startBeat: n.startBeat, durationBeats: n.durationBeats }))
  } else if (args.chords && args.chords.length > 1) {
    data.steps = chordsAsBeats(args.chords, (c) => chordPitches(c), args.beats_per_chord ?? 4)
  }
  return data
}
