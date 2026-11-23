import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { INPUT_LATENCY_SECONDS, TRANSPORT, type PlayerBeat, type TransportPush, type TransportRequest, type TransportState } from '@shared/features/transport'
import { noteName } from '@shared/music/analysis'
import { clipLengthBeats, progressionTrack } from '@shared/music/clip'
import { chordPitches } from '@shared/music/render'
import { extractLoop, lastBars, type LoopWindow } from '@shared/music/transport/extract'
import { beatAt, timeAt, wholeBars, type BeatGrid } from '@shared/music/transport/grid'
import { BeatTracker } from '@shared/music/transport/tracker'
import type { Clip } from '@shared/music/types'
import { text, trackSchema, type ToolModuleFactory } from '../toolkit'

/** How far back the tracker is fed, and how often it runs while notes are arriving. */
const TRACK_WINDOW = 12
const TRACK_EVERY_MS = 400
/** Below this the player's beat is not used to start or cut anything. */
const USABLE = 0.5

/**
 * Playing in time with the player: a beat tracker over the transcript here,
 * and the transport (clock, scheduler, sound) in the window.
 */
export const transport: ToolModuleFactory = (ctx) => {
  // Audio notes are stamped when the mic samples arrive, a little after the sound; MIDI is on time.
  const tracker = new BeatTracker({ onsetOffset: (note) => (note.source === 'audio' ? -INPUT_LATENCY_SECONDS : 0) })
  let timer: ReturnType<typeof setTimeout> | undefined
  let layersPlaying = false

  /** Run the tracker now and return its reading of the player. */
  const hear = (): PlayerBeat | null => {
    const now = ctx.now()
    const estimate = tracker.update(ctx.transcript.window(now, TRACK_WINDOW), now)
    return estimate ? { grid: estimate.grid, confidence: estimate.confidence } : null
  }

  // Keep the tracker running while notes come in, so it carries its beat count
  // and downbeat guess along, and keep the window posted while it is playing.
  ctx.transcript.onChange(() => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      const player = hear()
      if (layersPlaying) ctx.bus.send(TRANSPORT, { type: 'beat', player } satisfies TransportPush)
    }, TRACK_EVERY_MS)
    timer.unref?.()
  })

  const ask = async (request: TransportRequest): Promise<TransportState> => {
    const state = await ctx.bus.request<TransportState>(TRANSPORT, request, 4000)
    if (!state) throw new Error('The transport is not running in the window.')
    layersPlaying = state.running
    return state
  }

  // Offer the transport to every other module that plays clips (core `play`, the
  // arrangement library): anything looping, or anything at all while layers are
  // running, comes in on the bar line in time. A lone one-shot is left to the simple player.
  ctx.playback.provide({
    play: async (clip, { loop, id }) => {
      if (!loop && !layersPlaying) return null
      const state = await ask({ type: 'play', id, clip, loop, start: 'bar', bpm: clip.bpm, player: hear() })
      const wait = state.startsInSeconds ?? 0
      return `${loop ? 'Looping' : 'Playing once'} in time at ${state.bpm.toFixed(0)} bpm, coming in ${wait < 0.25 ? 'now' : `on the bar line in ${wait.toFixed(1)}s`}. It keeps going until stopped.`
    },
    stop: () => void ask({ type: 'stop', at: 'now' }).catch(() => undefined),
  })

  const failed = (error: unknown) => text(`The transport did not respond: ${error instanceof Error ? error.message : String(error)}`)

  const describePlayer = (player: PlayerBeat | null): string => {
    if (!player) return "Player's beat: not found yet (too few notes)."
    const sure = player.confidence >= 0.75 ? 'steady' : player.confidence >= USABLE ? 'fairly steady' : 'unsure'
    return `Player's beat: about ${Math.round(player.grid.bpm)} bpm, ${sure} (confidence ${player.confidence.toFixed(2)}).`
  }

  const describe = (state: TransportState): string => {
    if (!state.running) return 'Transport: stopped, nothing is looping.'
    const layers = state.layers
      .filter((l) => !l.id.includes('~'))
      .map((l) => {
        const bars = l.lengthBeats / state.beatsPerBar
        const notes = [`${l.kind === 'audio' ? 'their recorded sound' : 'notes'}`, l.loop ? `${bars}-bar loop` : `${bars} bars, once`]
        if (l.startsIn > 0) notes.push(`comes in in ${l.startsIn.toFixed(1)} beats`)
        if (l.stopBeat !== undefined) notes.push('stopping at the bar line')
        return `"${l.id}" (${notes.join(', ')})`
      })
    const lines = [
      `Transport: ${state.bpm.toFixed(1)} bpm, ${state.beatsPerBar} beats to the bar, at bar ${state.bar + 1} beat ${(state.beatInBar + 1).toFixed(1)}. ${state.follow ? 'Following the player.' : 'Tempo is fixed.'}${state.click ? ' Click is on.' : ''}`,
      `Layers: ${layers.length ? layers.join('; ') : 'none'}.`,
    ]
    if (state.follow && state.phaseErrorMs !== null && state.playerBpm !== null) {
      const ms = Math.round(Math.abs(state.phaseErrorMs))
      lines.push(`Against the player: ${ms < 15 ? 'together' : `${ms} ms ${state.phaseErrorMs > 0 ? 'ahead of' : 'behind'} them, correcting`}; they read ${Math.round(state.playerBpm)} bpm.`)
    }
    if (state.late > 0) lines.push(`${state.late} notes were scheduled late (the window stalled; worst gap ${Math.round(state.worstTickMs)} ms).`)
    return lines.join('\n')
  }

  /** The grid to cut and place loops on: the transport's if it is running, else the player's own. */
  const workingGrid = async (): Promise<{ grid: BeatGrid; state: TransportState; player: PlayerBeat | null } | string> => {
    const player = hear()
    const state = await ask({ type: 'state' })
    if (state.running) return { grid: state.grid, state, player }
    if (!player || player.confidence < USABLE) {
      return `No loop made: there is no steady beat to cut it on. ${describePlayer(player)} Ask them to play it again with a steady pulse, or start a click with transport_set so they can play to it.`
    }
    return { grid: { ...player.grid, beatsPerBar: state.beatsPerBar }, state, player }
  }

  const jamAlong = tool(
    'jam_along',
    "Play a part in time with the player: it comes in on their next bar line at their tempo and loops until stopped. Several parts can run at once; using a name that is already playing swaps that part at the bar line. Give `chords`, `tracks`, or both.",
    {
      name: z.string().describe('Short name for this part, e.g. "bass" or "drums"; used to replace or stop it'),
      chords: z.array(z.string()).optional().describe('Chord symbols, played as block chords'),
      beats_per_chord: z.number().positive().default(4),
      tracks: z.array(trackSchema).optional().describe('Note positions are in beats from the start of the loop'),
      bpm: z.number().min(40).max(240).optional().describe("Only used when nothing is playing and the player's tempo is not known"),
      loop: z.boolean().default(true),
      start: z.enum(['bar', 'beat', 'now']).default('bar'),
      count_in_bars: z.number().int().min(0).max(4).default(0).describe('Bars of click before the part comes in'),
    },
    async ({ name, chords, beats_per_chord, tracks, bpm, loop, start, count_in_bars }) => {
      const clip: Clip = { name, bpm: bpm ?? 100, tracks: [...(tracks ?? [])] }
      if (chords?.length) {
        const unknown = chords.filter((c) => chordPitches(c).length === 0)
        if (unknown.length) return text(`I couldn't voice these chord symbols: ${unknown.join(', ')}. Use standard symbols like "Dm7", "G7b9", "Cmaj7/E".`)
        clip.tracks.unshift(progressionTrack(chords, beats_per_chord))
      }
      if (clip.tracks.every((t) => t.notes.length === 0)) return text('Nothing to play: give chords or tracks with notes.')
      try {
        const player = hear()
        const state = await ask({ type: 'play', id: name, clip, loop, start, countInBars: count_in_bars, bpm, player })
        const bars = wholeBars(clipLengthBeats(clip), state.beatsPerBar) / state.beatsPerBar
        const timing = (state.startsInSeconds ?? 0) < 0.25 ? 'now' : `in ${(state.startsInSeconds ?? 0).toFixed(1)}s on the bar line`
        const joined = state.layers.length <= 1 && (!player || player.confidence < USABLE) ? ` The player's beat was not clear, so this started its own count at ${state.bpm.toFixed(0)} bpm.` : ''
        return text(`"${name}" comes in ${timing}: ${bars} bar${bars === 1 ? '' : 's'}, ${loop ? 'looping' : 'once'}, at ${state.bpm.toFixed(1)} bpm.${joined}\n${describe(state)}`)
      } catch (error) {
        return failed(error)
      }
    },
  )

  const loopThat = tool(
    'loop_that',
    'Loop what the player just played: the last few whole bars, as transcribed notes on a synth or as their actual recorded sound. It comes in on the next bar line and repeats until stopped.',
    {
      bars: z.number().int().min(1).max(16).default(4),
      as: z.enum(['notes', 'audio']).default('notes').describe('"audio" loops the real sound from the mic; "notes" replays the transcription'),
      name: z.string().default('loop'),
      quantize: z.enum(['off', '8th', '16th']).default('16th').describe('For notes: tidy the timing to this grid'),
      role: z.enum(['chords', 'melody', 'bass', 'drums', 'solo']).default('melody').describe('For notes: which sound plays it'),
      program: z.number().int().min(0).max(127).default(0),
    },
    async ({ bars, as, name, quantize, role, program }) => {
      try {
        const found = await workingGrid()
        if (typeof found === 'string') return text(found)
        const { grid, player } = found
        const now = ctx.now()
        const notes = ctx.transcript.window(now, 180)
        const nowBeat = beatAt(grid, now)
        const endBeat = Math.floor(nowBeat / grid.beatsPerBar) * grid.beatsPerBar
        // With no transcribed notes (unpitched sound, say) fall back to the bars that just went by.
        const window: LoopWindow = lastBars(notes, grid, now, bars) ?? {
          startBeat: endBeat - bars * grid.beatsPerBar,
          endBeat,
          startTime: timeAt(grid, endBeat - bars * grid.beatsPerBar),
          endTime: timeAt(grid, endBeat),
        }
        const ago = Math.max(0, now - window.endTime)
        const where = `the ${bars} bar${bars === 1 ? '' : 's'} that ended ${ago.toFixed(1)}s ago`
        const lengthBeats = bars * grid.beatsPerBar

        if (as === 'audio') {
          const state = await ask({ type: 'loop-audio', id: name, startTime: window.startTime, endTime: window.endTime, lengthBeats, start: 'bar', bpm: grid.bpm, player })
          if (state.startsAtBeat === undefined) return text(state.note ?? 'No audio loop was made.')
          const quiet = (state.level ?? 0) < 0.003 ? ' The take is nearly silent; they may not have been playing then.' : ''
          return text(`Looping their recorded sound from ${where} as "${name}", coming in in ${(state.startsInSeconds ?? 0).toFixed(1)}s.${quiet}\n${describe(state)}`)
        }

        const clip = extractLoop(notes, grid, window, { quantize: quantize === 'off' ? 0 : quantize === '8th' ? 0.5 : 0.25, name, role, program })
        const picked = clip.tracks[0]!.notes
        if (picked.length === 0) return text(`No notes were transcribed in ${where}, so there is nothing to loop as notes. Try as "audio", or ask them to play it again.`)
        const state = await ask({ type: 'play', id: name, clip, loop: true, start: 'bar', lengthBeats, bpm: grid.bpm, player })
        const pitches = picked.map((n) => n.pitch)
        return text(
          `Looping ${picked.length} notes (${noteName(Math.min(...pitches))} to ${noteName(Math.max(...pitches))}) from ${where} as "${name}", coming in in ${(state.startsInSeconds ?? 0).toFixed(1)}s.\n${describe(state)}`,
        )
      } catch (error) {
        return failed(error)
      }
    },
  )

  const transportStop = tool(
    'transport_stop',
    'Stop one looping part by name, or everything that is looping. Stops at once, or cleanly at the next bar line.',
    { layer: z.string().optional().describe('Name of the part; leave out to stop everything'), at: z.enum(['now', 'bar']).default('now') },
    async ({ layer, at }) => {
      try {
        const state = await ask({ type: 'stop', id: layer, at })
        return text(`${state.note ?? 'Done.'}\n${describe(state)}`)
      } catch (error) {
        return failed(error)
      }
    },
  )

  const transportState = tool('transport_state', "Where the transport is: tempo, bar and beat, which parts are looping, and how sure the read of the player's beat is.", {}, async () => {
    try {
      const player = hear()
      return text(`${describe(await ask({ type: 'state' }))}\n${describePlayer(player)}`)
    } catch (error) {
      return failed(error)
    }
  })

  const transportSet = tool(
    'transport_set',
    "Change how the transport keeps time: fix the tempo, turn following the player on or off, turn the click on or off, change the meter, or shift your playing a little earlier or later.",
    {
      bpm: z.number().min(40).max(240).optional().describe('Set the tempo. Also turns following off unless `follow` is true'),
      follow: z.boolean().optional().describe("Keep adjusting tempo and beat to the player's"),
      click: z.boolean().optional().describe('Metronome click on every beat'),
      beats_per_bar: z.number().int().min(2).max(12).optional(),
      nudge_ms: z.number().min(-200).max(200).optional().describe('Positive plays everything that much earlier, negative later; use when they say you are dragging or rushing'),
    },
    async ({ bpm, follow, click, beats_per_bar, nudge_ms }) => {
      try {
        if (beats_per_bar !== undefined) tracker.setBeatsPerBar(beats_per_bar)
        const state = await ask({ type: 'set', bpm, follow: follow ?? (bpm !== undefined ? false : undefined), click, beatsPerBar: beats_per_bar, nudgeMs: nudge_ms, player: hear() })
        return text(`${describe(state)}${nudge_ms !== undefined ? `\nPlaying ${Math.abs(state.nudgeMs).toFixed(0)} ms ${state.nudgeMs >= 0 ? 'earlier' : 'later'} than written.` : ''}`)
      } catch (error) {
        return failed(error)
      }
    },
  )

  return {
    name: 'transport',
    guide: `- jam_along: play with them, in time. Unlike play, which starts at once at its own tempo and plays through one time, jam_along waits for their next bar line, takes their tempo, loops, and keeps adjusting to them. Use it whenever they are playing and want you to join in: a bass line, a drum groove, chords under their solo. Write the part in beats from the start of the loop and make it a whole number of bars. Give each part its own name; reuse a name to change that part without a gap. If they are not playing yet, give a bpm and a count in so they can come in with you.
- loop_that: when they say "loop that" or "keep that going", repeat the last few bars they played. Choose audio when they want their own sound back, notes when you want to change the sound or it will be shown or edited. Ask how many bars only if it is not obvious; four is a good guess. If the result says there is no steady beat, tell them so in a few words.
- transport_stop: stop one part by name or everything you have looping. The plain stop tool does not stop loops; when they say stop, use both.
- transport_state: check the tempo, where in the bar things are, what is looping, and how well you are locked to them. Check it before saying anything about the tempo of a running loop.
- transport_set: fix the tempo or go back to following them, start or stop a click, change the beats in a bar, or nudge your playing earlier or later if they say you are dragging or rushing.`,
    tools: [jamAlong, loopThat, transportStop, transportState, transportSet],
  }
}
