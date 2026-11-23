import type { Clip } from '../types'

/**
 * The lookahead scheduler's core, in beats and with no clock or audio in it.
 *
 * The window code calls `advance(toBeat)` every few milliseconds with the
 * beat position a little ahead of now; it gets back everything that starts in
 * the stretch since the last call, each thing exactly once, and hands those
 * to WebAudio with sample-accurate times. Because the cursor is kept in beats,
 * tempo can change between calls without anything being played twice or
 * skipped.
 */

interface LayerBase {
  /** Unique name; adding a layer with a name already in use replaces it. */
  id: string
  /** Transport beat where the first pass starts. */
  startBeat: number
  /** Length of one pass. */
  lengthBeats: number
  loop: boolean
  /** Nothing starts at or after this beat; the layer is dropped once it is reached. */
  stopBeat?: number
}

/** A clip played as notes. Note positions are in beats and follow the transport's tempo; the clip's own bpm is ignored. */
export interface NoteLayer extends LayerBase {
  kind: 'notes'
  clip: Clip
}

/** A stretch of recorded sound, retriggered once per pass by the window code. */
export interface AudioLayer extends LayerBase {
  kind: 'audio'
}

export type Layer = NoteLayer | AudioLayer

export type Scheduled =
  | { kind: 'note'; layerId: string; track: number; pitch: number; velocity: number; beat: number; durationBeats: number }
  | { kind: 'audio'; layerId: string; beat: number; pass: number }
  | { kind: 'click'; beat: number; accent: boolean }
  /** The layer has played its last note; it has been removed from the scheduler. */
  | { kind: 'end'; layerId: string; beat: number }

/** The beat at which a layer stops producing events (Infinity for an open loop). */
export const layerEnd = (layer: Layer): number => Math.min(layer.stopBeat ?? Infinity, layer.loop ? Infinity : layer.startBeat + layer.lengthBeats)

/** Everything `layer` starts in [fromBeat, toBeat). */
export function layerEvents(layer: Layer, fromBeat: number, toBeat: number): Scheduled[] {
  const out: Scheduled[] = []
  const end = layerEnd(layer)
  const until = Math.min(toBeat, end)
  if (layer.lengthBeats <= 0) return out
  let pass = Math.max(0, Math.floor((fromBeat - layer.startBeat) / layer.lengthBeats) - 1)
  for (; ; pass++) {
    if (pass > 0 && !layer.loop) break
    const passStart = layer.startBeat + pass * layer.lengthBeats
    if (passStart >= until) break
    if (layer.kind === 'audio') {
      if (passStart >= fromBeat) out.push({ kind: 'audio', layerId: layer.id, beat: passStart, pass })
      continue
    }
    layer.clip.tracks.forEach((track, index) => {
      for (const note of track.notes) {
        if (note.startBeat >= layer.lengthBeats) continue
        const beat = passStart + note.startBeat
        if (beat < fromBeat || beat >= until) continue
        const durationBeats = Math.min(note.durationBeats, layer.lengthBeats, end - beat)
        out.push({ kind: 'note', layerId: layer.id, track: index, pitch: note.pitch, velocity: note.velocity, beat, durationBeats })
      }
    })
  }
  return out
}

export class Scheduler {
  private layers = new Map<string, Layer>()
  private position: number
  /** Metronome: on for good, or only until a beat (a count-in). */
  click: { on: boolean; untilBeat: number } = { on: false, untilBeat: -Infinity }

  constructor(
    startBeat = 0,
    public beatsPerBar = 4,
  ) {
    this.position = startBeat
  }

  /** Everything before this beat has been handed out. New material can start here at the earliest. */
  get cursor(): number {
    return this.position
  }

  get all(): Layer[] {
    return [...this.layers.values()]
  }

  get(id: string): Layer | undefined {
    return this.layers.get(id)
  }

  add(layer: Layer): void {
    this.layers.set(layer.id, layer)
  }

  remove(id: string): boolean {
    return this.layers.delete(id)
  }

  /** Let a layer play up to `beat`, then drop it. */
  stopAt(id: string, beat: number): boolean {
    const layer = this.layers.get(id)
    if (!layer) return false
    this.layers.set(id, { ...layer, stopBeat: Math.min(beat, layer.stopBeat ?? Infinity) })
    return true
  }

  clear(): void {
    this.layers.clear()
    this.click = { on: false, untilBeat: -Infinity }
  }

  /** Move the cursor without playing what is skipped (used when the transport starts or jumps). */
  seek(beat: number): void {
    this.position = beat
  }

  /** Hand out everything that starts in [cursor, toBeat), in time order, and move the cursor there. */
  advance(toBeat: number): Scheduled[] {
    if (!(toBeat > this.position)) return []
    const from = this.position
    const out: Scheduled[] = []
    for (const layer of [...this.layers.values()]) {
      out.push(...layerEvents(layer, from, toBeat))
      const end = layerEnd(layer)
      if (end < toBeat) {
        this.layers.delete(layer.id)
        out.push({ kind: 'end', layerId: layer.id, beat: Math.max(end, from) })
      }
    }
    for (let beat = Math.ceil(from - 1e-9); beat < toBeat; beat++) {
      if (beat < from) continue
      if (this.click.on || beat < this.click.untilBeat) out.push({ kind: 'click', beat, accent: ((beat % this.beatsPerBar) + this.beatsPerBar) % this.beatsPerBar === 0 })
    }
    this.position = toBeat
    return out.sort((a, b) => a.beat - b.beat)
  }
}
