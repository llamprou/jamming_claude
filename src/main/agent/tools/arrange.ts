import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  BASS_STYLES,
  COMPING_STYLES,
  DRUM_STYLES,
  arrangementBeats,
  createArrangement,
  describeArrangement,
  describeLayer,
  guessKey,
  isChord,
  keyName,
  normalizeSymbol,
  parseKey,
  progressionFromSpans,
  progressionText,
  reharmonize,
  renderArrangement,
  strategyNames,
  toSlots,
  transposeArrangement,
  withLayer,
  withProgression,
  withoutLayer,
  type Arrangement,
  type BassStyle,
  type ChordSlot,
  type CompingStyle,
  type DrumStyle,
  type KeySpec,
  type Layer,
  type LayerRole,
} from '@shared/music/arrange'
import { clipLengthBeats, clipToMidi } from '@shared/music/clip'
import { noteSchema, text, type ToolModuleFactory } from '../toolkit'

/** A whole rhythm section in one word. */
const FEELS: Record<string, { drums: DrumStyle; bass: BassStyle; chords: CompingStyle; intensity: number }> = {
  rock: { drums: 'rock', bass: 'eighths', chords: 'block', intensity: 0.6 },
  funk: { drums: 'funk', bass: 'funk', chords: 'stabs', intensity: 0.6 },
  swing: { drums: 'swing', bass: 'walking', chords: 'stabs', intensity: 0.5 },
  bossa: { drums: 'bossa', bass: 'bossa', chords: 'block', intensity: 0.5 },
  ballad: { drums: 'half_time', bass: 'roots', chords: 'arpeggio', intensity: 0.3 },
  half_time: { drums: 'half_time', bass: 'roots', chords: 'block', intensity: 0.6 },
  dance: { drums: 'four_on_the_floor', bass: 'eighths', chords: 'stabs', intensity: 0.7 },
}
const FEEL_NAMES = Object.keys(FEELS) as [string, ...string[]]

const STYLES: Partial<Record<LayerRole, readonly string[]>> = { bass: BASS_STYLES, drums: DRUM_STYLES, chords: COMPING_STYLES }

/** The style that goes with what the rest of the band is already doing. */
function defaultStyle(role: LayerRole, a: Arrangement): string {
  const drums = a.layers.drums?.kind === 'drums' ? a.layers.drums.options.style : null
  const bass = a.layers.bass?.kind === 'bass' ? a.layers.bass.options.style : null
  const forDrums: Record<string, BassStyle> = { swing: 'walking', bossa: 'bossa', funk: 'funk', rock: 'eighths', half_time: 'roots', four_on_the_floor: 'eighths' }
  const forBass: Record<string, DrumStyle> = { walking: 'swing', bossa: 'bossa', funk: 'funk' }
  if (role === 'bass') return forDrums[drums ?? ''] ?? 'root_fifth'
  if (role === 'drums') return forBass[bass ?? ''] ?? 'rock'
  return 'block'
}

/**
 * The arrangement the player and the agent are building: chords that can be
 * reharmonized, with bass, drums and comping layered on. The module keeps the
 * one current arrangement; every change re-renders it and plays the result.
 */
export const arrange: ToolModuleFactory = (ctx) => {
  let current: Arrangement | null = null
  let original: ChordSlot[] = []
  let history: Arrangement[] = []
  const uses = new Map<string, number>()

  const commit = (next: Arrangement) => {
    if (current) history = [...history.slice(-19), current]
    current = next
  }

  const none = () => text('There is no arrangement yet. Start one with arrange_start (give chords, or leave them out to use what the player just played).')

  /** Render, save and hand the clip to the player's speakers; returns a sentence for the tool result. */
  async function play(a: Arrangement): Promise<string> {
    const bars = arrangementBeats(a) / a.beatsPerBar
    const repeats = bars <= 4 ? 2 : 1
    const clip = renderArrangement(a, { repeats })
    if (clip.tracks.length === 0) return 'Nothing to play: the arrangement has no layers.'
    const savedTo = await ctx.saveMidi(a.name, clipToMidi(clip)).catch(() => undefined)
    ctx.emit({ type: 'play-clip', clip, savedTo })
    const seconds = (clipLengthBeats(clip) * 60) / a.bpm
    return `Playing it now${repeats > 1 ? `, ${repeats} times through` : ''} (${seconds.toFixed(0)}s).${savedTo ? ` MIDI saved as ${savedTo}.` : ''}`
  }

  const finish = async (a: Arrangement, lead: string, shouldPlay: boolean) =>
    text([lead, describeArrangement(a), shouldPlay ? await play(a) : 'Not played yet.'].join('\n'))

  const start = tool(
    'arrange_start',
    'Start a new arrangement (replacing the current one) from a chord progression, or from what the player just played when `chords` is left out. Plays it.',
    {
      name: z.string().default('arrangement').describe('Short name for it'),
      chords: z.array(z.string()).optional().describe('Chord symbols in order, e.g. ["Dm7","G7","Cmaj7"]. Omit to take the chords from the player\'s recent playing'),
      beats_per_chord: z
        .union([z.number().positive(), z.array(z.number().positive())])
        .default(4)
        .describe('One number for all chords, or one per chord'),
      bpm: z.number().min(40).max(240).optional().describe("Defaults to the player's tempo, or 100"),
      key: z.string().optional().describe('e.g. "C major", "F# minor". Worked out from the chords when omitted'),
      feel: z.enum(FEEL_NAMES).optional().describe('Add a matching rhythm section (bass, drums, comping) straight away'),
      seconds: z.number().min(4).max(120).default(20).describe('When taking chords from the player: how far back to listen'),
    },
    async ({ name, chords, beats_per_chord, bpm, key, feel, seconds }) => {
      let progression: ChordSlot[]
      let keySpec: KeySpec | undefined
      let tempo = bpm
      let source = 'the chords you gave'
      if (key) {
        keySpec = parseKey(key) ?? undefined
        if (!keySpec) return text(`I couldn't read the key "${key}". Say it like "C major" or "F# minor".`)
      }
      if (chords?.length) {
        const unknown = chords.filter((c) => !isChord(c))
        if (unknown.length) return text(`I couldn't voice these chord symbols: ${unknown.join(', ')}. Use standard symbols like "Dm7", "G7b9", "Cmaj7/E".`)
        progression = toSlots(chords.map((c) => normalizeSymbol(c) ?? c), beats_per_chord)
      } else {
        const snap = ctx.transcript.snapshot(ctx.now(), seconds)
        tempo ??= snap.rhythm ? Math.round(snap.rhythm.bpm) : undefined
        progression = progressionFromSpans(snap.chords, tempo ?? 100)
        if (progression.length === 0) {
          return text(`I heard no chords in the last ${seconds} seconds to build on. Ask the player to play the changes, or pass chords.`)
        }
        if (!keySpec && snap.key && snap.key.score > 0.6) keySpec = parseKey(`${snap.key.tonic} ${snap.key.mode}`) ?? undefined
        source = `the player's last ${seconds}s${snap.notes.some((n) => n.source === 'audio') ? ' (heard through the mic, so check the chords with them)' : ''}`
      }
      tempo = Math.min(240, Math.max(40, tempo ?? 100))
      let next = createArrangement({ name, bpm: tempo, key: keySpec ?? guessKey(progression.map((s) => s.symbol)), progression })
      if (feel) {
        const f = FEELS[feel]!
        next = withLayer(next, 'chords', { kind: 'comping', options: { style: f.chords } })
        next = withLayer(next, 'bass', { kind: 'bass', options: { style: f.bass } })
        next = withLayer(next, 'drums', { kind: 'drums', options: { style: f.drums, intensity: f.intensity } })
      }
      history = []
      current = next
      original = next.progression
      uses.clear()
      return finish(next, `New arrangement from ${source}.`, true)
    },
  )

  const reharm = tool(
    'arrange_reharmonize',
    `Reharmonize the current arrangement's chords with one strategy; every layer follows the new chords. Strategies stack, so call it again to go further: ${strategyNames().join(', ')} (colour adds ninths and thirteenths; simplify strips back to triads). Also undo (take back the last change of any kind) and original (the chords it started with).`,
    {
      strategy: z.enum(['undo', 'original', ...strategyNames()] as [string, ...string[]]),
      amount: z.number().min(0).max(1).optional().describe('How much of the progression to change: 0.2 a touch, 1 everywhere it applies'),
      variation: z.number().int().optional().describe('Change this number to get a different choice of places'),
      play: z.boolean().default(true),
    },
    async ({ strategy, amount, variation, play: shouldPlay }) => {
      if (!current) return none()
      const before = progressionText(current.progression)
      if (strategy === 'undo') {
        const previous = history.pop()
        if (!previous) return text('Nothing to undo.')
        current = previous
        return finish(current, 'Took back the last change.', shouldPlay)
      }
      if (strategy === 'original') {
        commit(withProgression(current, original))
        return finish(current, `Back to the original chords (was: ${before}).`, shouldPlay)
      }
      const turn = (uses.get(strategy) ?? 0) + 1
      uses.set(strategy, turn)
      const result = reharmonize(current.progression, strategy, { key: current.key, amount, seed: variation ?? turn })
      if (!result.changed) {
        const others = strategyNames().filter((s) => s !== strategy && reharmonize(current!.progression, s, { key: current!.key }).changed)
        return text(`${strategy} found nothing to change in ${before}.${others.length ? ` These would change something: ${others.join(', ')}.` : ''}`)
      }
      commit(withProgression(current, result.slots))
      return finish(current, `${strategy}: ${before}  ->  ${progressionText(result.slots)}`, shouldPlay)
    },
  )

  const layer = tool(
    'arrange_layer',
    `Add, replace or remove one layer of the current arrangement. Bass styles: ${BASS_STYLES.join(', ')}. Drum styles: ${DRUM_STYLES.join(', ')}. Chord (comping) styles: ${COMPING_STYLES.join(', ')}. Asking again for the same style gives a new variation. For a part you wrote yourself (a melody, a solo, a special bass line), pass \`notes\`.`,
    {
      role: z.enum(['bass', 'drums', 'chords', 'melody', 'solo']),
      style: z.string().optional().describe('One of the styles for that role; omit to match the rest of the band'),
      remove: z.boolean().default(false),
      intensity: z.number().min(0).max(1).optional().describe('Drums: 0 sparse and quiet, 1 busy and loud'),
      fills: z.boolean().optional().describe('Drums: play a fill every four bars'),
      variation: z.number().int().optional().describe('Change this number for a different take on the same style'),
      program: z.number().int().min(0).max(127).optional().describe('General MIDI program, e.g. 4 electric piano, 24 nylon guitar, 33 electric bass'),
      notes: z.array(noteSchema).optional().describe('A written part covering one pass of the progression, instead of a generated one'),
      play: z.boolean().default(true),
    },
    async ({ role, style, remove, intensity, fills, variation, program, notes, play: shouldPlay }) => {
      if (!current) return none()
      if (remove) {
        if (!current.layers[role]) return text(`There is no ${role} layer to remove.\n${describeArrangement(current)}`)
        commit(withoutLayer(current, role))
        return finish(current, `Removed the ${role} layer.`, shouldPlay)
      }
      const existing = current.layers[role]
      let next: Layer
      if (notes?.length) {
        next = { kind: 'fixed', program: program ?? (role === 'bass' ? 33 : 0), notes, label: 'written part' }
      } else {
        const allowed = STYLES[role]
        if (!allowed) return text(`A ${role} layer needs \`notes\`: there is no generator for it.`)
        const previousStyle = existing && existing.kind !== 'fixed' ? existing.options.style : undefined
        const chosen = style ?? previousStyle ?? defaultStyle(role, current)
        if (!allowed.includes(chosen)) return text(`No ${role} style called "${chosen}". Choose from: ${allowed.join(', ')}.`)
        const previousSeed = existing && existing.kind !== 'fixed' ? (existing.options.seed ?? 1) : 0
        // Asking for the same thing again means "another one", unless only a setting changed.
        const again = previousStyle === chosen && intensity === undefined && fills === undefined && program === undefined
        const seed = variation ?? (again ? previousSeed + 1 : Math.max(1, previousSeed))
        if (role === 'bass') next = { kind: 'bass', options: { style: chosen as BassStyle, seed, program } }
        else if (role === 'chords') next = { kind: 'comping', options: { style: chosen as CompingStyle, seed, program } }
        else {
          const old = existing?.kind === 'drums' ? existing.options : undefined
          next = {
            kind: 'drums',
            options: {
              style: chosen as DrumStyle,
              seed,
              intensity: intensity ?? old?.intensity ?? 0.6,
              fillEvery: fills === undefined ? (old?.fillEvery ?? 4) : fills ? 4 : 0,
            },
          }
        }
      }
      commit(withLayer(current, role, next))
      return finish(current, `${existing ? 'Replaced' : 'Added'} ${role}: ${describeLayer(next)}.`, shouldPlay)
    },
  )

  const describe = tool(
    'arrangement',
    'Read back the current arrangement (key, tempo, chords, layers). Can also change its tempo or key, and play it again.',
    {
      bpm: z.number().min(40).max(240).optional().describe('New tempo'),
      transpose: z.number().int().min(-11).max(11).optional().describe('Semitones up or down'),
      play: z.boolean().default(false).describe('Play it (always plays after a tempo or key change)'),
    },
    async ({ bpm, transpose, play: shouldPlay }) => {
      if (!current) return none()
      if (bpm === undefined && !transpose) return finish(current, 'Current arrangement.', shouldPlay)
      let next = current
      if (bpm !== undefined) next = { ...next, bpm }
      if (transpose) {
        next = transposeArrangement(next, transpose)
        original = transposeArrangement({ ...next, progression: original, key: current.key, layers: {} }, transpose).progression
      }
      commit(next)
      return finish(next, `Now ${keyName(next.key)} at ${next.bpm} bpm.`, true)
    },
  )

  return {
    name: 'arrange',
    guide: `- arrange_start, arrange_reharmonize, arrange_layer, arrangement: a band you can build up piece by piece. There is one current arrangement: a chord progression with layers (chords, bass, drums, and parts you write). Use these instead of composing note by note with play whenever they ask for a backing, a bass line, a drum beat, a groove to play over, or a different take on some chords. arrange_start begins one from chords you name, or from what they just played if you give no chords; add a feel (${FEEL_NAMES.join(', ')}) to bring in the whole rhythm section at once. arrange_reharmonize changes the chords with a named strategy and the layers follow; strategies stack, and undo or original takes you back. arrange_layer adds, swaps or removes one layer in a style, or sets how busy the drums are. arrangement reads it back, changes tempo or key, or plays it again. Every change plays the result, so say a few words about what you changed and let them hear it. When you speak about chords, say their names the way a musician would, and name only the ones that changed. If they like a version, remember it; if they don't, undo.`,
    tools: [start, reharm, layer, describe],
  }
}
