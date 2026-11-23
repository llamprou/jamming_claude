import { join } from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { SAMPLER, type CaptureReply, type InstrumentInfo, type SamplerNotice, type SamplerRequest, type SamplerState } from '@shared/features/sampler'
import { noteName } from '@shared/music/analysis'
import type { RejectReason } from '@shared/music/capture'
import { TRACK_ROLES, type Coverage, type TrackRole } from '@shared/music/sampler'
import { InstrumentStore } from '../../instruments/store'
import { text, type ToolModuleFactory } from '../toolkit'

/** Where captured instruments are kept: beside the taste memory in the app's data folder. */
async function instrumentsDir(): Promise<string> {
  if (process.env.JAM_DATA_DIR) return join(process.env.JAM_DATA_DIR, 'instruments')
  const { app } = await import('electron')
  return join(app.getPath('userData'), 'instruments')
}

const ORIGIN: Record<InstrumentInfo['origin'], string> = {
  sampled: 'real recorded samples',
  synthesized: 'synthesized stand-in, not real samples (the sample set is not installed)',
  captured: "built from the player's own sound",
}

const span = (pitches: number[]) => (pitches.length ? `${noteName(pitches[0]!)} to ${noteName(pitches[pitches.length - 1]!)}` : 'no notes')

function describeInstrument(i: InstrumentInfo): string {
  const size = i.kind === 'drums' ? `${i.hits} drum hits` : `${i.pitches.length} recorded notes, ${span(i.pitches)}`
  return `- ${i.name}: ${i.label}. ${ORIGIN[i.origin]}; ${size}.`
}

function describeCoverage(c: Coverage | null): string {
  if (!c) return 'No notes captured.'
  const lines = [
    `Captured notes (${c.pitches.length}): ${c.pitches.map(noteName).join(' ')}.`,
    `Other notes are made by shifting the nearest captured one. Within ${c.maxShift} semitones of a captured note: ${noteName(c.comfortableLow)} to ${noteName(c.comfortableHigh)}${c.gaps.length ? ', except inside the gaps below' : ''}. Largest shift between the lowest and highest captured note: ${c.largestShift} semitones.`,
  ]
  if (c.gaps.length) lines.push(`Gaps: ${c.gaps.map((g) => `${noteName(g.from)} to ${noteName(g.to)} (${g.semitones} semitones apart)`).join('; ')}. Notes in a gap, or far outside the captured range, will sound less like the instrument.`)
  return lines.join('\n')
}

const describeRejected = (rejected: Partial<Record<RejectReason, number>>) =>
  Object.entries(rejected)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Sampled instruments for playback, including ones captured from the player's own sound. */
export const instruments: ToolModuleFactory = (ctx) => {
  let storePromise: Promise<InstrumentStore> | null = null
  const store = () => (storePromise ??= instrumentsDir().then((dir) => new InstrumentStore(dir)))
  const ask = <T>(request: SamplerRequest, timeoutMs?: number) => ctx.bus.request<T>(SAMPLER, request, timeoutMs)

  // Instruments captured in earlier sessions become playable again as soon as
  // the window is up. Whichever side starts second triggers the hand-over.
  const sendSaved = async () => {
    const saved = await (await store()).loadAll()
    if (saved.length) await ask({ type: 'load', instruments: saved })
  }
  ctx.bus.on(SAMPLER, (message) => {
    if ((message as SamplerNotice | null)?.type === 'ready') void sendSaved().catch(() => undefined)
  })
  void sendSaved().catch(() => undefined)

  const list = tool('list_instruments', 'List the instruments playback can use (built-in and captured from the player), what each part is playing on, and saved recordings.', {}, async () => {
    const saved = await store()
    const recordings = [...(await saved.names()), ...(await saved.looseRecordings())]
    const state = await ask<SamplerState>({ type: 'state' }).catch(() => null)
    if (!state) return text(`The window is not answering, so I can't see what is loaded. Saved captured instruments: ${(await saved.names()).join(', ') || 'none'}.`)
    return text(
      [
        'Instruments:',
        ...state.instruments.map(describeInstrument),
        `Playing now: ${TRACK_ROLES.map((role) => `${role} on ${state.playing[role]}${state.chosen[role] ? ' (chosen)' : ''}`).join(', ')}.`,
        `Saved recordings that capture_instrument can rebuild from: ${recordings.join(', ') || 'none'}.`,
      ].join('\n'),
    )
  })

  const set = tool(
    'set_instrument',
    'Choose which instrument plays a part (or all parts) in everything you play from now on.',
    {
      role: z.enum(['chords', 'melody', 'bass', 'drums', 'solo', 'all']).describe('"all" means every pitched part (or just drums, for a drum kit)'),
      instrument: z.string().describe('Name from list_instruments, or "default" to go back to the usual one'),
    },
    async ({ role, instrument }) => {
      const name = instrument === 'default' ? null : instrument
      const reply = await ask<{ roles: TrackRole[] | null; state: SamplerState }>({ type: 'assign', role, instrument: name })
      if (!reply.roles) return text(`There is no instrument called "${instrument}". Available: ${reply.state.instruments.map((i) => i.name).join(', ')}.`)
      const chosen = reply.state.instruments.find((i) => i.name === name)
      return text(
        `${reply.roles.join(', ')} ${name ? `now on ${name}` : 'back on the default'}. Playing now: ${TRACK_ROLES.map((r) => `${r} on ${reply.state.playing[r]}`).join(', ')}.${
          chosen && chosen.kind === 'pitched' && chosen.origin === 'captured' ? ` ${name} has recorded notes from ${span(chosen.pitches)}; parts far outside that will sound less like it.` : ''
        }`,
      )
    },
  )

  const capture = tool(
    'capture_instrument',
    "Build a playable instrument from the player's own sound: cut the single notes out of what the microphone heard and spread them across the keyboard. Saved for later sessions.",
    {
      name: z.string().min(1).describe('Short name for it, e.g. "my strat"'),
      seconds: z.number().min(3).max(55).default(20).describe('Use what was played in this many seconds up to now'),
      wait_seconds: z.number().min(0).max(30).default(0).describe('Instead: listen for this long from now while the player plays single notes, then build from that'),
      from_recording: z.string().optional().describe('Instead: rebuild from a saved recording (see list_instruments)'),
      extend: z.boolean().default(false).describe('Add the new notes to the captured instrument of this name instead of replacing it'),
      use_for: z.enum(['chords', 'melody', 'bass', 'solo', 'all']).optional().describe('Also start using it for this part'),
    },
    async ({ name, seconds, wait_seconds, from_recording, extend, use_for }) => {
      const slug = InstrumentStore.slug(name)
      if (!slug) return text('Give it a name with letters or numbers.')
      const saved = await store()
      let reply: CaptureReply
      let caution = ''
      if (from_recording) {
        const recording = await saved.recording(from_recording)
        if (!recording) return text(`No saved recording called "${from_recording}". Available: ${[...(await saved.names()), ...(await saved.looseRecordings())].join(', ') || 'none'}.`)
        reply = await ask<CaptureReply>({ type: 'build', name: slug, label: name, recording, extend }, 30_000)
      } else {
        if (wait_seconds > 0) await sleep(wait_seconds * 1000 + 300)
        const to = ctx.now()
        const stretch = wait_seconds > 0 ? wait_seconds + 0.6 : seconds
        const notes = ctx.transcript.window(to, stretch).filter((n) => n.source === 'audio')
        // Notes newer than the polyphonic pass has reached are single-note guesses: fine for single notes, wrong for chords.
        const corrected = ctx.transcript.snapshot(to, 1).correctedUntil ?? -Infinity
        const guessed = notes.filter((n) => n.start >= corrected).length
        if (guessed) caution = ` ${guessed} of the ${notes.length} notes heard were not yet checked by the slower, more accurate pass; if chords were being played then, some captured notes may be wrong.`
        reply = await ask<CaptureReply>({ type: 'capture', name: slug, label: name, from: to - stretch, to, notes: notes.map(({ pitch, start, duration }) => ({ pitch, start, duration })), extend }, 30_000)
      }
      const rejected = describeRejected(reply.rejected)
      if (!reply.ok) return text(`Could not build an instrument. ${reply.reason}${reply.heard ? ` ${reply.heard} notes heard${rejected ? `; set aside: ${rejected}` : ''}.` : ''} It needs single notes played one at a time and left to ring, not chords.`)
      await saved.save(reply.instrument, reply.recording)
      let using = ''
      if (use_for) {
        const assigned = await ask<{ roles: TrackRole[] | null }>({ type: 'assign', role: use_for, instrument: slug })
        using = assigned.roles ? ` Now used for: ${assigned.roles.join(', ')}.` : ''
      }
      const looped = reply.instrument.def.zones.filter((zone) => zone.loop).length
      return text(
        [
          `Built "${slug}" ${reply.notesFrom === 'audio' ? 'from notes found in the recording itself' : 'from the notes heard'}: ${reply.heard} notes heard${rejected ? `, set aside: ${rejected}` : ''}${reply.duplicates ? `, ${reply.duplicates} repeats of a pitch dropped in favour of a better take` : ''}.${caution}`,
          describeCoverage(reply.instrument.coverage),
          `${looped ? `${looped} of the notes hold steady and can sustain; the rest` : 'The notes'} ring and die away as played.`,
          `Saved; it will be available in later sessions.${using || ' Not used for any part yet: call set_instrument.'}`,
        ].join('\n'),
      )
    },
  )

  const remove = tool('delete_instrument', "Delete an instrument that was captured from the player's sound, including its saved recording.", { name: z.string() }, async ({ name }) => {
    const slug = InstrumentStore.slug(name)
    const onDisk = await (await store()).remove(slug)
    const inWindow = await ask<boolean>({ type: 'remove', name: slug }).catch(() => false)
    return text(onDisk || inWindow ? `Deleted "${slug}". Parts that used it are back on their defaults.` : `There is no captured instrument called "${name}". Built-in instruments cannot be deleted.`)
  })

  return {
    name: 'instruments',
    guide: `- list_instruments / set_instrument: what you play comes out on sampled instruments: a piano, a guitar, a bass and a drum kit, plus any built from the player's own sound. Unless told otherwise, chords and melody are on piano, bass lines on bass, solos on guitar. When they ask for a different sound on a part ("play that on guitar", "use my sound for the melody"), call set_instrument and then play. Use list_instruments when you need to know what exists or what each part is on. If an instrument is listed as a synthesized stand-in, never call it a real piano or guitar.
- capture_instrument: turn the player's own instrument into one you can play, from what the microphone hears. It needs single notes that ring on their own; chords are no use. Either build from what they just played (seconds), or ask them to play a handful of single notes slowly from low to high, letting each one ring, and then call it with wait_seconds so it listens while they play; say nothing until it returns. The result lists the notes captured and any gaps. Tell them in a sentence how it came out, and if there are gaps or few notes, ask for the missing ones and call it again with the same name and extend. It is saved and comes back in later sessions.
- delete_instrument: remove a captured instrument when they ask.`,
    tools: [list, set, capture, remove],
  }
}
