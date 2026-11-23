import type { Clip, ClipTrack, NoteEvent } from '../types'
import { beatAt, ceilToStep, roundToStep, timeAt, type BeatGrid } from './grid'

/**
 * Cutting a loop out of what the player just played: pick the last N whole
 * bars on the beat grid and turn the notes in them into a clip that starts on
 * a bar line and is exactly N bars long.
 */

export interface LoopWindow {
  startBeat: number
  endBeat: number
  startTime: number
  endTime: number
}

/** Notes this far (in beats) ahead of a bar line are taken as an early downbeat of the next bar. */
const EARLY = 0.12

/**
 * Which bars "the last N bars" means. By the time someone asks for a loop
 * they have usually stopped playing, so the stretch ends at the bar line
 * after the last note rather than at `now`. If they are still playing (that
 * bar is not over yet), it ends at the last bar line already passed.
 */
export function lastBars(notes: NoteEvent[], grid: BeatGrid, now: number, bars: number): LoopWindow | null {
  const nowBeat = beatAt(grid, now)
  let lastOnset = -Infinity
  for (const note of notes) if (note.start <= now) lastOnset = Math.max(lastOnset, beatAt(grid, note.start))
  if (lastOnset === -Infinity) return null
  let endBeat = ceilToStep(lastOnset + EARLY + 1e-6, grid.beatsPerBar)
  if (endBeat > nowBeat + EARLY) endBeat = Math.floor((nowBeat + EARLY) / grid.beatsPerBar) * grid.beatsPerBar
  const startBeat = endBeat - bars * grid.beatsPerBar
  return { startBeat, endBeat, startTime: timeAt(grid, startBeat), endTime: timeAt(grid, endBeat) }
}

export interface ExtractOptions {
  /** Snap note starts to this many beats (0.25 = sixteenths). 0 keeps the player's own timing. */
  quantize?: number
  name?: string
  role?: ClipTrack['role']
  program?: number
  /** Notes begun before the window and still held this many beats into it are kept, starting on the first beat. */
  heldBeats?: number
}

/**
 * The notes of one window as a clip. Edges are handled the way a player
 * would mean them:
 *  - a note struck a hair before the first bar line is that bar's downbeat;
 *  - a note struck a hair before the last bar line belongs to the next bar and is left out;
 *  - a note ringing past the end is cut at the end, so the loop does not smear into itself;
 *  - a note held over from before the window is kept from beat 0 if it is held long enough to matter.
 */
export function extractLoop(notes: NoteEvent[], grid: BeatGrid, window: LoopWindow, options: ExtractOptions = {}): Clip {
  const { quantize = 0, name = 'loop', role = 'melody', program = 0, heldBeats = 0.5 } = options
  const length = window.endBeat - window.startBeat
  const picked = new Map<string, ClipTrack['notes'][number]>()

  for (const note of notes) {
    let start = beatAt(grid, note.start) - window.startBeat
    let end = beatAt(grid, note.start + note.duration) - window.startBeat
    if (start >= length - EARLY) continue
    if (start < -EARLY) {
      if (end < heldBeats) continue
      start = 0
    } else if (start < 0) {
      // An early downbeat keeps its length.
      end -= start
      start = 0
    }
    if (quantize > 0) {
      const snapped = Math.min(roundToStep(start, quantize), length - quantize)
      end += snapped - start
      start = Math.max(0, snapped)
    }
    end = Math.min(end, length)
    const durationBeats = Math.max(end - start, Math.min(0.1, length - start))
    const key = `${note.pitch}@${start.toFixed(4)}`
    const existing = picked.get(key)
    if (!existing || existing.durationBeats < durationBeats) picked.set(key, { pitch: note.pitch, startBeat: start, durationBeats, velocity: note.velocity })
  }

  const clipNotes = [...picked.values()].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
  return { name, bpm: Math.round(grid.bpm * 10) / 10, tracks: [{ role, program, notes: clipNotes }] }
}
