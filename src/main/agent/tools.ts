import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { noteName } from '@shared/music/analysis'
import { clipLengthBeats, clipToMidi, clipToNotes, progressionTrack } from '@shared/music/clip'
import { chordPitches, chordsToText, rhythmToText } from '@shared/music/render'
import type { Transcript } from '@shared/music/transcript'
import type { Clip, NoteEvent } from '@shared/music/types'
import type { MainEvent } from '@shared/ipc'
import type { TasteMemory } from '../memory/taste'

export interface ToolContext {
  transcript: Transcript
  memory: TasteMemory
  /** Seconds on the session clock. */
  now(): number
  emit(event: MainEvent): void
  /** Present only when self-extension is enabled (running from a source checkout). */
  extend?: (request: string) => Promise<string>
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })

const noteSchema = z.object({
  pitch: z.number().int().min(0).max(127).describe('MIDI note number; 60 is middle C'),
  startBeat: z.number().min(0),
  durationBeats: z.number().positive(),
  velocity: z.number().min(0).max(1).default(0.8),
})

const trackSchema = z.object({
  role: z.enum(['chords', 'melody', 'bass', 'drums', 'solo']),
  program: z.number().int().min(0).max(127).default(0).describe('General MIDI program; 0 piano, 24 nylon guitar, 32 acoustic bass'),
  notes: z.array(noteSchema),
})

export const TOOL_NAMES = ['listen', 'show', 'play', 'stop', 'remember', 'recall', 'update_taste_profile', 'extend_self'] as const

export function createJamTools(ctx: ToolContext) {
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
      const lines = [
        `Window: last ${seconds}s, ${snap.notes.length} notes, sources: ${[...new Set(snap.notes.map((n) => n.source))].join(', ')}`,
        `Transcription: ${snap.corrected ? 'corrected by the slow pass' : 'fast pass only, may contain wrong or missing notes'}`,
        `Key: ${snap.key ? `${snap.key.tonic} ${snap.key.mode} (fit ${snap.key.score.toFixed(2)})` : 'unclear'}`,
        `Chords: ${chordsToText(snap.chords)}`,
        `Rhythm: ${rhythmToText(snap.rhythm)}`,
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
    "Show something on the player's screen. Without `chords` or `notes`, it shows what the player has been playing, live.",
    {
      view: z.enum(['chords', 'rhythm', 'sheet', 'tab', 'piano', 'guitar', 'bass']),
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
      loop: z.boolean().default(false),
    },
    async ({ name, bpm, chords, beats_per_chord, tracks }) => {
      const clip: Clip = { name, bpm, tracks: [...(tracks ?? [])] }
      if (chords?.length) {
        const unknown = chords.filter((c) => chordPitches(c).length === 0)
        if (unknown.length) return text(`I couldn't voice these chord symbols: ${unknown.join(', ')}. Use standard symbols like "Dm7", "G7b9", "Cmaj7/E".`)
        clip.tracks.unshift(progressionTrack(chords, beats_per_chord))
      }
      if (clip.tracks.every((t) => t.notes.length === 0)) return text('Nothing to play: give chords or tracks with notes.')
      const midi = clipToMidi(clip)
      ctx.emit({ type: 'play-clip', clip, midiBase64: Buffer.from(midi).toString('base64') })
      const seconds = (clipLengthBeats(clip) * 60) / bpm
      return text(`Playing "${name}" now: ${clipToNotes(clip).length} notes, ${seconds.toFixed(1)}s at ${bpm} bpm.`)
    },
  )

  const stop = tool('stop', 'Stop anything you are playing.', {}, async () => {
    ctx.emit({ type: 'stop-playback' })
    return text('Stopped.')
  })

  const remember = tool(
    'remember',
    "Record a reaction that reveals the player's taste, so future ideas fit them better.",
    {
      reaction: z.enum(['loved', 'liked', 'kept', 'neutral', 'disliked', 'skipped']),
      subject: z.string().describe('What they reacted to, in musical terms specific enough to act on later'),
      evidence: z.string().optional().describe('What they said or did'),
      tags: z.array(z.string()).optional().describe('e.g. genre, feel, harmony, tempo'),
    },
    async (event) => {
      await ctx.memory.record(event)
      const pending = await ctx.memory.undistilledCount()
      return text(pending >= 8 ? `Noted. ${pending} reactions since the profile was last updated: worth rewriting it soon.` : 'Noted.')
    },
  )

  const recall = tool(
    'recall',
    "Look up the player's recorded reactions.",
    { limit: z.number().int().min(1).max(200).default(30), tag: z.string().optional() },
    async ({ limit, tag }) => {
      const events = await ctx.memory.events(limit, tag)
      if (events.length === 0) return text('No reactions recorded yet.')
      return text(
        events
          .map((e) => `${e.at.slice(0, 10)} ${e.reaction}: ${e.subject}${e.evidence ? ` ("${e.evidence}")` : ''}${e.tags?.length ? ` [${e.tags.join(', ')}]` : ''}`)
          .join('\n'),
      )
    },
  )

  const updateProfile = tool(
    'update_taste_profile',
    "Rewrite the player's taste profile (markdown). It is loaded at the start of every session, so keep it concise, concrete and current: what they gravitate to, what they avoid, and how sure you are.",
    { markdown: z.string().min(20) },
    async ({ markdown }) => {
      await ctx.memory.writeProfile(markdown)
      return text('Taste profile updated.')
    },
  )

  const tools = [listen, show, play, stop, remember, recall, updateProfile]

  if (ctx.extend) {
    const extend = ctx.extend
    tools.push(
      tool(
        'extend_self',
        "Ask a Claude Code session to add a capability to this app's own source code. It works in the background on a separate git branch and reports back; the player reviews the change before it is used.",
        { request: z.string().describe('What to build and why, including what the player asked for in their own words') },
        async ({ request }) => text(await extend(request)),
      ) as never,
    )
  }

  return createSdkMcpServer({ name: 'jam', version: '0.1.0', tools })
}
