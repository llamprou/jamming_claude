import type { BeatGrid, StartQuantize } from '../music/transport/grid'
import type { Clip } from '../music/types'

/**
 * Bus traffic for the transport feature: the musical clock in the window that
 * plays clips and recorded audio as synced, looping layers.
 *
 * Main (agent/tools/transport.ts) runs the beat tracker and sends requests;
 * the window (features/transport/) owns the clock and the sound, and answers
 * every request with the resulting TransportState.
 */
export const TRANSPORT = 'transport'

/** The tracker's reading of the player, sent along so the window can line up with it. */
export interface PlayerBeat {
  grid: BeatGrid
  confidence: number
}

/** Mic samples are stamped on arrival, this long after the sound happened. A guess until measured on a real machine. */
export const INPUT_LATENCY_SECONDS = 0.03

/** Main -> window, with bus.request. */
export type TransportRequest =
  /**
   * Add a clip as a layer (or replace the layer with the same id at the start point).
   * To route any clip to the transport instead of the one-shot player, send this with loop false.
   */
  | {
      type: 'play'
      id: string
      clip: Clip
      loop: boolean
      start: StartQuantize
      /** Loop length; defaults to the clip rounded up to whole bars. */
      lengthBeats?: number
      /** Bars of click before the layer comes in. */
      countInBars?: number
      /** Tempo to use if the transport is stopped and the player's beat is not known. */
      bpm?: number
      player?: PlayerBeat | null
    }
  /** Loop the mic audio recorded between two session times (real times; the window allows for input latency). */
  | { type: 'loop-audio'; id: string; startTime: number; endTime: number; lengthBeats: number; start: StartQuantize; bpm?: number; player?: PlayerBeat | null }
  | { type: 'stop'; id?: string; at: 'now' | 'bar' }
  | { type: 'set'; bpm?: number; follow?: boolean; click?: boolean; beatsPerBar?: number; nudgeMs?: number; player?: PlayerBeat | null }
  | { type: 'state' }
  /** The most recent things handed to WebAudio, for checks. */
  | { type: 'log' }

/** Main -> window, with bus.send, about twice a second while anything is playing. */
export type TransportPush = { type: 'beat'; player: PlayerBeat | null }

export interface LayerState {
  id: string
  kind: 'notes' | 'audio'
  loop: boolean
  lengthBeats: number
  startBeat: number
  /** Set if the layer has been told to stop at a bar line. */
  stopBeat?: number
  /** Beats until it comes in; 0 if already playing. */
  startsIn: number
}

export interface TransportState {
  running: boolean
  /** Tempo being played (without momentary phase corrections). */
  bpm: number
  follow: boolean
  click: boolean
  beatsPerBar: number
  grid: BeatGrid
  /** Session time and position when this was read. */
  now: number
  beat: number
  bar: number
  beatInBar: number
  layers: LayerState[]
  /** The player's tempo as last used for following, and how far our beat is ahead of theirs (ms). */
  playerBpm: number | null
  phaseErrorMs: number | null
  nudgeMs: number
  outputLatencyMs: number
  /** Things that reached the scheduler after they were due (a stalled timer). */
  late: number
  /** Worst gap between scheduler ticks, ms. */
  worstTickMs: number
  /** What the last request did, for the tool result. */
  note?: string
  /** For 'play' and 'loop-audio': when the layer comes in. */
  startsAtBeat?: number
  startsInSeconds?: number
  /** For 'loop-audio': loudness of the take, 0-1. */
  level?: number
}

export interface LogEntry {
  kind: 'note' | 'audio' | 'click'
  layer: string
  pitch?: number
  beat: number
  /** Session time it will sound. */
  time: number
  /** How far ahead of its time it was handed to WebAudio, ms. Negative means late. */
  leadMs: number
}
