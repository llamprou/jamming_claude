import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  chordsAsNotes,
  keySegments,
  parseKey,
  rhythmGrid,
  rhythmGridToText,
  scoreToAbc,
  scoreToMusicXml,
  tabToText,
  TAB_TUNINGS,
  transcribe,
  transcribeTab,
  type NotationOptions,
  type Transcription,
} from '@shared/music/notation'
import type { ChordSpan, NoteEvent } from '@shared/music/types'
import { noteSchema, text, type ToolModuleFactory } from '../toolkit'

const tunings = Object.keys(TAB_TUNINGS) as [string, ...string[]]

/** The choices a player can make about how music is written; shared by `notate` and `export_notation`. */
const optionSchema = {
  instrument: z.enum(['piano', 'guitar', 'bass']).optional().describe('Piano gives a grand staff when the range is wide; guitar and bass choose clef and tab strings'),
  key: z.string().optional().describe('Write it in this key, e.g. "F# minor", "Bb". Detected if absent'),
  time_signature: z.enum(['4/4', '3/4', '6/8', '12/8']).optional().describe('Detected if absent'),
  swing: z.boolean().optional().describe('True: write long-short eighths as plain eighths marked swing. Detected if absent'),
  capo: z.number().int().min(0).max(12).optional().describe('Tab: capo fret'),
  tuning: z.enum(tunings).optional().describe('Tab: string tuning. Standard for the instrument if absent'),
  hand_fret: z.number().int().min(0).max(19).optional().describe('Tab: fret the fretting hand is at, if known; positions near it are chosen'),
  bars: z.number().int().min(1).max(32).optional().describe('How many bars, counting back from the latest'),
  notes: z.array(noteSchema).optional().describe('Notes to write instead of the live playing (beats at 120 bpm, bar line at beat 0)'),
  chords: z.array(z.string()).optional().describe('Chord symbols to write instead, one bar each'),
}
type Asked = z.infer<z.ZodObject<typeof optionSchema>>

const fromBeats = (notes: z.infer<typeof noteSchema>[]): NoteEvent[] =>
  notes.map((n) => ({ pitch: n.pitch, start: n.startBeat * 0.5, duration: n.durationBeats * 0.5, velocity: n.velocity, source: 'agent', confidence: 1 }))

function optionsFrom(asked: Asked): NotationOptions {
  return {
    instrument: asked.instrument,
    key: asked.key,
    timeSignature: asked.time_signature,
    swing: asked.swing,
    capo: asked.capo,
    tuning: asked.tuning,
    handFret: asked.hand_fret,
    bars: asked.bars,
  }
}

const sureness = (confidence: number): string => (confidence >= 0.7 ? 'clear' : confidence >= 0.4 ? 'fairly sure' : 'unsure')

/** Key, meter, and writing music out: the careful reading behind the sheet, tab and rhythm views. */
export const notation: ToolModuleFactory = (ctx) => {
  /** Notes and options for a request: given notes, given chords, or the last `seconds` of playing. */
  const gather = (asked: Asked, seconds: number, guitar = false): { notes: NoteEvent[]; chords?: ChordSpan[]; options: NotationOptions } => {
    const options = optionsFrom(asked)
    if (asked.notes?.length) return { notes: fromBeats(asked.notes), options: { ...options, quarterSeconds: 0.5, origin: 0 } }
    if (asked.chords?.length) {
      const written = chordsAsNotes(asked.chords, guitar || asked.instrument === 'guitar' ? 'guitar' : 'keyboard')
      return { notes: written.notes, chords: written.chords, options: { ...written.options, ...options } }
    }
    return { notes: ctx.transcript.window(ctx.now(), seconds), options }
  }

  const readMusic = tool(
    'read_music',
    'Read what the player has been playing as written music: key (with how sure, and the relative key), key changes, time signature, tempo, swing, where the downbeat falls, and chords bar by bar.',
    {
      seconds: z.number().min(4).max(180).default(30).describe('How far back to look'),
      include_bars: z.boolean().default(false).describe('Also give the bars as ABC notation (to quote or rework the music exactly)'),
    },
    async ({ seconds, include_bars }) => {
      const now = ctx.now()
      const notes = ctx.transcript.window(now, seconds)
      if (notes.length === 0) return text(`Nothing heard in the last ${seconds} seconds.`)
      const result: Transcription = transcribe(notes)
      const { key, meter, score } = result
      const lines = [`Window: last ${seconds}s, ${notes.length} notes, ${score.bars.length} bars`]
      if (key) {
        const others = key.alternatives.filter((a) => a.score > key.score - 0.12).map((a) => a.name)
        lines.push(`Key: ${key.name} (${sureness(key.confidence)}); relative ${key.relative.name}${others.length ? `; could also be ${others.join(' or ')}` : ''}`)
      }
      const segments = keySegments(notes)
      if (segments.length > 1) lines.push(`Key changes: ${segments.map((s) => `${s.key.name} from ${Math.max(0, now - s.start).toFixed(0)}s ago`).join(', then ')}`)
      if (meter) {
        const beat = meter.compound ? 'dotted quarter' : 'quarter'
        lines.push(
          `Meter: ${meter.timeSignature} (${sureness(meter.confidence)}), ${beat} = ${Math.round(meter.bpm)}, ${meter.swing ? `swing (offbeat at ${Math.round(meter.swingRatio * 100)}% of the beat)` : 'straight'}`,
          `Bar lines: one ${Math.max(0, notes[0]!.start - meter.downbeat).toFixed(2)}s before the first note, then every ${(meter.beatSeconds * meter.beatsPerBar).toFixed(2)}s`,
          `Rhythm of a typical bar: ${rhythmGridToText(rhythmGrid(notes, meter)).split('  ')[1]}`,
        )
      } else {
        lines.push('Meter: too little played to tell')
      }
      const chords = score.bars.filter((b) => b.chords.length).map((b) => `${b.number}: ${b.chords.map((c) => c.symbol).join(' ')}`)
      if (chords.length) lines.push(`Chords by bar: ${chords.join(' | ')}`)
      if (include_bars) lines.push('ABC:', scoreToAbc(score))
      return text(lines.join('\n'))
    },
  )

  const notate = tool(
    'notate',
    'Show sheet music, tablature or the rhythm grid written the way the player asks: instrument, key, time signature, swing, capo, tuning, hand position, how many bars. Without `notes` or `chords` it follows the live playing.',
    { view: z.enum(['sheet', 'tab', 'rhythm']), title: z.string().optional(), ...optionSchema },
    async ({ view, title, ...asked }) => {
      if (asked.key && !parseKey(asked.key)) return text(`I can't read "${asked.key}" as a key. Use a form like "F# minor" or "Bb major".`)
      const options = optionsFrom(asked)
      const instrument = view === 'tab' && options.instrument !== 'bass' ? 'guitar' : options.instrument
      ctx.emit({
        type: 'show-view',
        view,
        title,
        instrument,
        notes: asked.notes?.length ? fromBeats(asked.notes) : undefined,
        chords: asked.notes?.length ? undefined : asked.chords,
        data: { notation: { ...options, instrument } },
      })
      const chosen = Object.entries({ ...options, instrument })
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => `${name} ${value}`)
      return text(`Showing ${view}${asked.notes?.length || asked.chords?.length ? '' : ' (live)'}${chosen.length ? ` with ${chosen.join(', ')}` : ''}.`)
    },
  )

  const exportNotation = tool(
    'export_notation',
    'Save music as a file to open elsewhere: MusicXML sheet music (MuseScore, Sibelius, Dorico, Finale), ABC text, or tablature as plain text. Saves the recent playing unless `notes` or `chords` are given.',
    {
      format: z.enum(['musicxml', 'abc', 'tab']),
      name: z.string().describe('Short title for the file'),
      seconds: z.number().min(4).max(600).default(60).describe('How far back to take the playing from'),
      ...optionSchema,
    },
    async ({ format, name, seconds, ...asked }) => {
      if (asked.key && !parseKey(asked.key)) return text(`I can't read "${asked.key}" as a key. Use a form like "F# minor" or "Bb major".`)
      const { notes, chords, options } = gather(asked, seconds, format === 'tab' && asked.instrument !== 'bass')
      if (notes.length === 0) return text(`Nothing to save: nothing heard in the last ${seconds} seconds.`)
      let body: string
      let extension: string
      let summary: string
      if (format === 'tab') {
        const { tab, score } = transcribeTab(notes, { ...options, chords })
        body = `${name}\n${tabToText(tab)}\n`
        extension = 'tab.txt'
        summary = `${tab.instrument} tab, ${score.bars.length} bars`
      } else {
        const { score } = transcribe(notes, { ...options, chords, title: name })
        body = format === 'abc' ? `${scoreToAbc(score, { title: name })}\n` : scoreToMusicXml(score, { title: name })
        extension = format === 'abc' ? 'abc' : 'musicxml'
        summary = `${score.key.name}, ${score.meter.timeSignature}, ${score.bars.length} bars`
      }
      // Next to the MIDI ideas (see saveMidi in src/main/index.ts).
      const dir = process.env.JAM_DATA_DIR ? join(process.env.JAM_DATA_DIR, 'ideas') : join(homedir(), 'Music', 'Jamming Claude')
      const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
      const path = join(dir, `${stamp} ${name.replace(/[^\w .-]+/g, '').trim() || 'music'}.${extension}`)
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(path, body, 'utf8')
      } catch (error) {
        return text(`Could not save the file: ${error instanceof Error ? error.message : String(error)}`)
      }
      return text(`Saved ${summary} as ${path}.`)
    },
  )

  return {
    name: 'notation',
    guide: `- read_music: the careful reading of what they played: key (how sure, and its relative), key changes, time signature, the downbeat, tempo, swing, and chords bar by bar. Its key and meter are better than listen's rough ones; call it before you name a key or a time signature, count bars, or write anything out.
- notate: open sheet music, tab or the rhythm grid written the way they ask: "as bass tab", "capo on two", "drop D", "write that in six eight", "it's swung", "put it in F sharp minor", "just the last four bars". Plain show opens the same views with everything detected for them; use notate when they have made a choice, and call it again with the new choice to change it. Sheet music uses a grand staff for wide piano playing, and the guitar's and bass's own clefs. Never read notation aloud.
- export_notation: save the music as a MusicXML file for notation software, as ABC text, or the tab as a text file, when they ask to keep, export, print or send it. Say that it is saved; give the location only if they ask.`,
    tools: [readMusic, notate, exportNotation],
  }
}
