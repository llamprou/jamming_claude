import type { Clip, ClipTrack } from '../types'
import { generateBass, type BassOptions } from './bass'
import { generateComping, type CompingOptions } from './comping'
import { generateDrums, type DrumOptions } from './drums'
import { mergeSlots, progressionText, repeatSlots, totalBeats, type ChordSlot } from './progression'
import { guessKey, keyName, transposeKey, transposeSymbol, type KeySpec } from './theory'

export type LayerRole = ClipTrack['role']

/**
 * A layer is either a recipe (regenerated from the chords each time, so a bass
 * line follows a reharmonization) or fixed notes (a melody someone wrote).
 * Fixed notes cover one pass of the progression.
 */
export type Layer =
  | { kind: 'comping'; options: CompingOptions }
  | { kind: 'bass'; options: BassOptions }
  | { kind: 'drums'; options: DrumOptions }
  | { kind: 'fixed'; program: number; notes: ClipTrack['notes']; label?: string }

/** The thing the player and the agent build up together: changes, tempo, key, and one layer per role. */
export interface Arrangement {
  name: string
  bpm: number
  key: KeySpec
  beatsPerBar: number
  progression: ChordSlot[]
  layers: Partial<Record<LayerRole, Layer>>
}

const ORDER: LayerRole[] = ['chords', 'bass', 'drums', 'melody', 'solo']

export function createArrangement(input: {
  name?: string
  bpm?: number
  key?: KeySpec
  beatsPerBar?: number
  progression: ChordSlot[]
  layers?: Arrangement['layers']
}): Arrangement {
  const progression = mergeSlots(input.progression)
  return {
    name: input.name ?? 'arrangement',
    bpm: input.bpm ?? 100,
    key: input.key ?? guessKey(progression.map((s) => s.symbol)),
    beatsPerBar: input.beatsPerBar ?? 4,
    progression,
    // Something to hear from the start: plain chords.
    layers: input.layers ?? { chords: { kind: 'comping', options: { style: 'block' } } },
  }
}

export const withProgression = (a: Arrangement, progression: ChordSlot[]): Arrangement => ({ ...a, progression: mergeSlots(progression) })

export const withLayer = (a: Arrangement, role: LayerRole, layer: Layer): Arrangement => ({ ...a, layers: { ...a.layers, [role]: layer } })

export function withoutLayer(a: Arrangement, role: LayerRole): Arrangement {
  const layers = { ...a.layers }
  delete layers[role]
  return { ...a, layers }
}

/** Move the whole arrangement up or down; generated layers follow, fixed notes are shifted. */
export function transposeArrangement(a: Arrangement, semitones: number): Arrangement {
  const key = transposeKey(a.key, semitones)
  const layers: Arrangement['layers'] = {}
  for (const role of ORDER) {
    const layer = a.layers[role]
    if (!layer) continue
    layers[role] =
      layer.kind === 'fixed' && role !== 'drums'
        ? { ...layer, notes: layer.notes.map((n) => ({ ...n, pitch: Math.min(127, Math.max(0, n.pitch + semitones)) })) }
        : layer
  }
  return { ...a, key, layers, progression: a.progression.map((s) => ({ ...s, symbol: transposeSymbol(s.symbol, semitones, key) })) }
}

export const arrangementBeats = (a: Arrangement): number => totalBeats(a.progression)

function renderLayer(a: Arrangement, role: LayerRole, layer: Layer, slots: ChordSlot[], repeats: number): ClipTrack {
  const beatsPerBar = a.beatsPerBar
  // Pitched parts lean their offbeats back when the drummer is swinging.
  const swing = a.layers.drums?.kind === 'drums' && a.layers.drums.options.style === 'swing'
  switch (layer.kind) {
    case 'comping':
      return { ...generateComping(slots, { beatsPerBar, swing, ...layer.options }), role }
    case 'bass':
      return { ...generateBass(slots, { beatsPerBar, swing, ...layer.options }), role }
    case 'drums':
      return { ...generateDrums(totalBeats(slots), { beatsPerBar, ...layer.options }), role }
    case 'fixed': {
      const length = arrangementBeats(a)
      const notes = Array.from({ length: repeats }, (_, pass) =>
        layer.notes.filter((n) => n.startBeat < length).map((n) => ({ ...n, startBeat: n.startBeat + pass * length })),
      ).flat()
      return { role, program: layer.program, notes }
    }
  }
}

/**
 * Render to a playable clip. With `repeats`, the parts are generated across
 * the whole length, so a walking line keeps developing and the drum fill
 * lands at the end rather than the same bar being pasted twice.
 */
export function renderArrangement(a: Arrangement, options: { repeats?: number } = {}): Clip {
  const repeats = Math.max(1, Math.round(options.repeats ?? 1))
  const slots = repeatSlots(a.progression, repeats)
  const tracks = ORDER.flatMap((role) => {
    const layer = a.layers[role]
    return layer ? [renderLayer(a, role, layer, slots, repeats)] : []
  }).filter((t) => t.notes.length > 0)
  return { name: a.name, bpm: a.bpm, tracks }
}

export function describeLayer(layer: Layer): string {
  switch (layer.kind) {
    case 'comping':
      return `${layer.options.style} comping`
    case 'bass':
      return `${layer.options.style} bass`
    case 'drums': {
      const fills = layer.options.fillEvery ?? 4
      return `${layer.options.style} drums, intensity ${layer.options.intensity ?? 0.6}, ${fills > 0 ? `fill every ${fills} bars` : 'no fills'}`
    }
    case 'fixed':
      return `${layer.label ?? 'written part'}, ${layer.notes.length} notes`
  }
}

/** A few lines for the model: enough to talk about the arrangement or decide what to change. */
export function describeArrangement(a: Arrangement): string {
  const beats = arrangementBeats(a)
  const bars = beats / a.beatsPerBar
  const layers = ORDER.flatMap((role) => (a.layers[role] ? [`${role}: ${describeLayer(a.layers[role])}`] : []))
  return [
    `Arrangement "${a.name}": ${keyName(a.key)}, ${a.bpm} bpm, ${+bars.toFixed(2)} bars of ${a.beatsPerBar} (${+beats.toFixed(2)} beats).`,
    `Chords (beats each): ${progressionText(a.progression)}`,
    `Layers: ${layers.length ? layers.join('; ') : 'none'}`,
  ].join('\n')
}
