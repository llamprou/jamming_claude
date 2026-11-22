import MidiPkg from '@tonejs/midi'
import { chordPitches } from './render'
import type { Clip, ClipTrack, NoteEvent } from './types'

// @tonejs/midi is CommonJS; this works under both Node ESM and bundlers.
const { Midi } = MidiPkg

/** Serialise a clip to a Standard MIDI File. */
export function clipToMidi(clip: Clip): Uint8Array {
  const midi = new Midi()
  midi.header.setTempo(clip.bpm)
  midi.header.name = clip.name
  const beat = 60 / clip.bpm
  for (const track of clip.tracks) {
    const t = midi.addTrack()
    t.name = track.role
    if (track.role === 'drums') t.channel = 9
    else t.instrument.number = track.program
    for (const n of track.notes) {
      t.addNote({ midi: n.pitch, time: n.startBeat * beat, duration: n.durationBeats * beat, velocity: n.velocity })
    }
  }
  return midi.toArray()
}

/** Flatten a clip to timed NoteEvents (seconds), e.g. to render it as tab or sheet. */
export function clipToNotes(clip: Clip, offsetSeconds = 0): NoteEvent[] {
  const beat = 60 / clip.bpm
  return clip.tracks
    .filter((t) => t.role !== 'drums')
    .flatMap((t) =>
      t.notes.map((n) => ({
        pitch: n.pitch,
        start: offsetSeconds + n.startBeat * beat,
        duration: n.durationBeats * beat,
        velocity: n.velocity,
        source: 'agent' as const,
        confidence: 1,
      })),
    )
    .sort((a, b) => a.start - b.start)
}

/**
 * Turn a chord progression into a block-chord track. `beatsPerChord` may be a
 * single number or one entry per chord.
 */
export function progressionTrack(symbols: string[], beatsPerChord: number | number[] = 4, program = 0): ClipTrack {
  const notes: ClipTrack['notes'] = []
  let at = 0
  symbols.forEach((symbol, i) => {
    const beats = Array.isArray(beatsPerChord) ? (beatsPerChord[i] ?? 4) : beatsPerChord
    for (const pitch of chordPitches(symbol)) notes.push({ pitch, startBeat: at, durationBeats: beats, velocity: 0.7 })
    at += beats
  })
  return { role: 'chords', program, notes }
}

export function clipLengthBeats(clip: Clip): number {
  return Math.max(0, ...clip.tracks.flatMap((t) => t.notes.map((n) => n.startBeat + n.durationBeats)))
}
