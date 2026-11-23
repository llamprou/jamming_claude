import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { noteName } from '@shared/music/analysis'
import { clipLengthBeats, clipToMidi, clipToNotes, progressionTrack } from '@shared/music/clip'
import { findKey } from '@shared/music/notation/key'
import { analyseMeter, meterToText } from '@shared/music/notation/meter'
import { chordPitches, chordsToText } from '@shared/music/render'
import type { Clip, NoteEvent, Snapshot } from '@shared/music/types'
import { VIEWS, viewKinds } from '@shared/views'
import { noteSchema, text, trackSchema, type ToolModuleFactory } from '../toolkit'

/** Tell the model how far to trust what it is about to read. */
function describeAccuracy(snap: Snapshot): string {
  if (!snap.notes.some((n) => n.source === 'audio')) return 'exact (MIDI input)'
  if (snap.correctedUntil === null) return 'audio, fast pass only: single notes that may be wrong; chords are not heard yet'
  const lag = Math.max(0, snap.now - snap.correctedUntil)
  return `audio, corrected by the polyphonic pass except the most recent ${lag.toFixed(0)}s, which are single-note guesses`
}

/** Hearing, the screen, and playback: the tools every session has. */
export const core: ToolModuleFactory = (ctx) => {
  const listen = tool(
    'listen',
    'Get what the player has been playing recently: chords, key, tempo and groove, and the notes themselves.',
    {
      seconds: z.number().min(2).max(120).default(16).describe('How far back to look'),
      include_notes: z.boolean().default(false).describe('Also list individual notes (needed to quote or continue a melody)'),
    },
    async ({ seconds, include_notes }) => {
      const snap = ctx.transcript.snapshot(ctx.now(), seconds)
      if (snap.notes.length === 0) return text(`Nothing heard in the last ${seconds} seconds.`)
      const key = findKey(snap.notes)
      const meter = analyseMeter(snap.notes)
      const lines = [
        `Window: last ${seconds}s, ${snap.notes.length} notes, sources: ${[...new Set(snap.notes.map((n) => n.source))].join(', ')}`,
        `Transcription: ${describeAccuracy(snap)}`,
        `Key: ${key ? `${key.name} (${key.confidence >= 0.6 ? 'clear' : key.confidence >= 0.3 ? 'fairly clear' : `unsure; could be ${key.relative.name}`})` : 'unclear'}`,
        `Chords: ${chordsToText(snap.chords)}`,
        `Rhythm: ${meter ? meterToText(meter) : 'not enough to tell yet'}`,
      ]
      if (include_notes) {
        const start = snap.notes[0]!.start
        lines.push(
          'Notes (name, seconds from first note, length):',
          ...snap.notes.slice(-200).map((n) => `${noteName(n.pitch)} @${(n.start - start).toFixed(2)} ${n.duration.toFixed(2)}s`),
        )
      }
      return text(lines.join('\n'))
    },
  )

  const show = tool(
    'show',
    "Open a view on the player's screen (several can be open at once; showing a view that is already open updates it). Without `chords` or `notes`, it follows what the player is playing, live.",
    {
      view: z.enum(viewKinds()),
      title: z.string().optional(),
      chords: z.array(z.string()).optional().describe('Chord symbols to show instead of the live input, e.g. ["Dm7","G7","Cmaj7"]'),
      notes: z.array(noteSchema).optional().describe('Notes to show instead of the live input (beats at 120 bpm)'),
      instrument: z.enum(['piano', 'guitar', 'bass']).optional().describe('For tab: guitar or bass'),
    },
    async ({ view, title, chords, notes, instrument }) => {
      const asEvents: NoteEvent[] | undefined = notes?.map((n) => ({
        pitch: n.pitch,
        start: n.startBeat * 0.5,
        duration: n.durationBeats * 0.5,
        velocity: n.velocity,
        source: 'agent',
        confidence: 1,
      }))
      ctx.emit({ type: 'show-view', view, title, chords, notes: asEvents, instrument })
      return text(`Showing ${view}${chords || notes ? '' : ' (live)'}.`)
    },
  )

  const play = tool(
    'play',
    'Play a musical idea through the speakers and make it available as a MIDI file. Give either `chords` (a quick progression) or full `tracks`, or both.',
    {
      name: z.string().describe('Short name for the idea'),
      bpm: z.number().min(40).max(240),
      chords: z.array(z.string()).optional().describe('Chord symbols, played as block chords'),
      beats_per_chord: z.number().positive().default(4),
      tracks: z.array(trackSchema).optional(),
      loop: z.boolean().default(false).describe('Keep repeating in time until stopped'),
    },
    async ({ name, bpm, chords, beats_per_chord, tracks, loop }) => {
      const clip: Clip = { name, bpm, tracks: [...(tracks ?? [])] }
      if (chords?.length) {
        const unknown = chords.filter((c) => chordPitches(c).length === 0)
        if (unknown.length) return text(`I couldn't voice these chord symbols: ${unknown.join(', ')}. Use standard symbols like "Dm7", "G7b9", "Cmaj7/E".`)
        clip.tracks.unshift(progressionTrack(chords, beats_per_chord))
      }
      if (clip.tracks.every((t) => t.notes.length === 0)) return text('Nothing to play: give chords or tracks with notes.')
      const midi = clipToMidi(clip)
      const savedTo = await ctx.saveMidi(name, midi).catch(() => undefined)
      const how = await ctx.playback.play(clip, { loop, savedTo })
      const seconds = (clipLengthBeats(clip) * 60) / bpm
      return text(`"${name}": ${clipToNotes(clip).length} notes, ${seconds.toFixed(1)}s at ${bpm} bpm. ${how}${savedTo ? ` MIDI file saved as ${savedTo}.` : ''}`)
    },
  )

  const hide = tool(
    'hide',
    "Close a view on the player's screen, or all of them.",
    { view: z.enum([...viewKinds(), 'all']) },
    async ({ view }) => {
      ctx.emit({ type: 'hide-view', view })
      return text(view === 'all' ? 'Screen cleared.' : `Closed ${view}.`)
    },
  )

  const stop = tool('stop', 'Stop anything you are playing.', {}, async () => {
    ctx.playback.stop()
    return text('Stopped everything that was playing.')
  })

  return {
    name: 'core',
    guide: `- listen: what they've been playing just now (chords, key, tempo and groove, notes). Call it before you comment on or build from their playing; don't guess what you heard. For audio input the result says how recent the corrected transcription is.
- show / hide: you run the screen. The player has no buttons or menus and is not typing; their hands are on an instrument. When they ask to see something, open it with show; when they ask you to close something or clear the screen, use hide. Open a view on your own whenever seeing would help, and close ones that are no longer relevant so the screen stays uncluttered. Showing is much faster than describing. Views: ${VIEWS.map((v) => `${v.kind} (${v.description})`).join('; ')}.
- play: play a musical idea through the speakers: a progression, a melody, a bass line, a groove, a solo. This is how you jam. When they ask for an idea, play it rather than describing it, and say a few words while it starts. Each idea is also saved as a MIDI file; mention where only if they ask.
- stop: silence everything you are playing, loops included.`,
    tools: [listen, show, hide, play, stop],
  }
}
