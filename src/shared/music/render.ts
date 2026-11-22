import { Chord, Note } from 'tonal'
import { pitchClass } from './analysis'
import type { ChordSpan, Instrument, NoteEvent, RhythmEstimate } from './types'

/* ---------- tablature ---------- */

/** Open-string MIDI pitches, lowest string first. */
export const TUNINGS = {
  guitar: [40, 45, 50, 55, 59, 64],
  bass: [28, 33, 38, 43],
} as const

export interface TabNote {
  /** 0 = lowest string. */
  string: number
  fret: number
  start: number
}

/**
 * Assign each note a string/fret, keeping the hand near where it already is.
 * Notes that start together are treated as one chord shape and never share a
 * string. Unplayable notes are dropped.
 */
export function toTab(notes: NoteEvent[], instrument: 'guitar' | 'bass', maxFret = 19): TabNote[] {
  const tuning = TUNINGS[instrument]
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  const out: TabNote[] = []
  let hand = 0
  let i = 0
  while (i < sorted.length) {
    const group = [sorted[i]!]
    while (i + group.length < sorted.length && sorted[i + group.length]!.start - group[0]!.start < 0.03) {
      group.push(sorted[i + group.length]!)
    }
    i += group.length
    const used = new Set<number>()
    const placed: TabNote[] = []
    for (const n of group) {
      let best: TabNote | null = null
      let bestCost = Infinity
      tuning.forEach((open, string) => {
        const fret = n.pitch - open
        if (fret < 0 || fret > maxFret || used.has(string)) return
        const cost = fret === 0 ? 0.5 : Math.abs(fret - hand)
        if (cost < bestCost) {
          bestCost = cost
          best = { string, fret, start: n.start }
        }
      })
      if (best) {
        used.add((best as TabNote).string)
        placed.push(best)
      }
    }
    const fretted = placed.filter((p) => p.fret > 0)
    if (fretted.length) hand = Math.min(...fretted.map((p) => p.fret))
    out.push(...placed)
  }
  return out
}

/** ASCII tab, one column per onset. Highest string on top, as players read it. */
export function tabToAscii(tab: TabNote[], instrument: 'guitar' | 'bass'): string {
  const names = instrument === 'guitar' ? ['E', 'A', 'D', 'G', 'B', 'e'] : ['E', 'A', 'D', 'G']
  const starts = [...new Set(tab.map((t) => Math.round(t.start * 100) / 100))].sort((a, b) => a - b)
  const lines = names.map((n) => `${n}|`)
  for (const s of starts) {
    const column = tab.filter((t) => Math.round(t.start * 100) / 100 === s)
    const width = Math.max(...column.map((t) => String(t.fret).length)) + 1
    names.forEach((_, string) => {
      const hit = column.find((t) => t.string === string)
      lines[string] += (hit ? String(hit.fret) : '').padEnd(width, '-').replace(/ /g, '-')
    })
  }
  return lines.map((l) => `${l}|`).reverse().join('\n')
}

/* ---------- sheet music (ABC notation, rendered by abcjs in the UI) ---------- */

function abcPitch(pitch: number): string {
  const name = Note.fromMidiSharps(pitch) // e.g. "C#4"
  const match = /^([A-G])(#?)(-?\d+)$/.exec(name)
  if (!match) return 'z'
  const [, letter, sharp, octaveText] = match
  const octave = Number(octaveText)
  const accidental = sharp ? '^' : ''
  if (octave >= 5) return `${accidental}${letter!.toLowerCase()}${"'".repeat(octave - 5)}`
  return `${accidental}${letter}${','.repeat(4 - octave)}`
}

/**
 * Quantise notes to sixteenths and emit single-voice ABC (simultaneous notes
 * become ABC chords). Lossy by design: this is the live readout.
 */
export function toAbc(notes: NoteEvent[], opts: { bpm: number; key?: string; title?: string }): string {
  const step = 60 / opts.bpm / 4
  const header = [`X:1`, `T:${opts.title ?? 'Live'}`, `M:4/4`, `L:1/16`, `Q:1/4=${Math.round(opts.bpm)}`, `K:${opts.key ?? 'C'}`]
  if (notes.length === 0) return [...header, 'z16|'].join('\n')
  const origin = Math.min(...notes.map((n) => n.start))
  const slots = new Map<number, { pitches: number[]; length: number }>()
  for (const n of notes) {
    const at = Math.round((n.start - origin) / step)
    const length = Math.max(1, Math.round(n.duration / step))
    const slot = slots.get(at) ?? { pitches: [], length }
    if (!slot.pitches.includes(n.pitch)) slot.pitches.push(n.pitch)
    slot.length = Math.min(slot.length, length)
    slots.set(at, slot)
  }
  const positions = [...slots.keys()].sort((a, b) => a - b)
  let body = ''
  let cursor = 0
  const emit = (token: string, length: number) => {
    // Split anything that crosses a barline so every bar sums to 16.
    let remaining = length
    let first = true
    while (remaining > 0) {
      const room = 16 - (cursor % 16)
      const take = Math.min(room, remaining)
      const tie = token !== 'z' && remaining > take ? '-' : ''
      body += `${first || token === 'z' ? token : token}${take > 1 ? take : ''}${tie}`
      cursor += take
      remaining -= take
      first = false
      if (cursor % 16 === 0) body += '|'
      else body += ' '
    }
  }
  positions.forEach((at, index) => {
    if (at > cursor) emit('z', at - cursor)
    const slot = slots.get(at)!
    const next = positions[index + 1]
    const length = next !== undefined ? Math.min(slot.length, next - at) : slot.length
    const sortedPitches = slot.pitches.sort((a, b) => a - b).map(abcPitch)
    emit(sortedPitches.length > 1 ? `[${sortedPitches.join('')}]` : sortedPitches[0]!, length)
  })
  if (cursor % 16 !== 0) emit('z', 16 - (cursor % 16))
  return [...header, body.trim()].join('\n')
}

/* ---------- text readouts ---------- */

export function chordsToText(chords: ChordSpan[]): string {
  return chords.map((c) => c.symbol).join(' | ') || '(no chords heard yet)'
}

export function rhythmToText(r: RhythmEstimate | null): string {
  if (!r) return '(not enough onsets yet)'
  const bar = r.pattern.replace(/(.{4})/g, '$1 ').trim()
  return `${r.bpm} bpm  |${bar}|`
}

/* ---------- instrument diagrams (SVG strings) ---------- */

const WHITE = [0, 2, 4, 5, 7, 9, 11]

/** Piano keyboard with the given pitches lit. */
export function pianoSvg(pitches: number[], low = 36, high = 84): string {
  const lit = new Set(pitches)
  const whites: number[] = []
  for (let p = low; p <= high; p++) if (WHITE.includes(pitchClass(p))) whites.push(p)
  const w = 14
  const h = 70
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${whites.length * w} ${h}" role="img" aria-label="Piano">`
  whites.forEach((p, i) => {
    svg += `<rect x="${i * w}" y="0" width="${w}" height="${h}" fill="${lit.has(p) ? '#f5a524' : '#fff'}" stroke="#333"/>`
  })
  whites.forEach((p, i) => {
    const black = p + 1
    if (black > high || WHITE.includes(pitchClass(black))) return
    svg += `<rect x="${(i + 1) * w - 4.5}" y="0" width="9" height="${h * 0.62}" fill="${lit.has(black) ? '#d97706' : '#222'}"/>`
  })
  return `${svg}</svg>`
}

/** Fretboard with dots where the given pitches can be played nearest the nut. */
export function fretboardSvg(pitches: number[], instrument: 'guitar' | 'bass', frets = 12): string {
  const tuning = TUNINGS[instrument]
  const fw = 34
  const sh = 16
  const width = (frets + 1) * fw + 10
  const height = tuning.length * sh + 10
  const notes: NoteEvent[] = pitches.map((pitch) => ({ pitch, start: 0, duration: 1, velocity: 1, source: 'agent', confidence: 1 }))
  const tab = toTab(notes, instrument, frets)
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${instrument} fretboard">`
  tuning.forEach((_, s) => {
    const y = height - 5 - s * sh - sh / 2
    svg += `<line x1="${fw}" y1="${y}" x2="${width - 5}" y2="${y}" stroke="#888"/>`
  })
  for (let f = 0; f <= frets; f++) {
    const x = fw + f * fw
    svg += `<line x1="${x}" y1="5" x2="${x}" y2="${height - 5}" stroke="${f === 0 ? '#111' : '#bbb'}" stroke-width="${f === 0 ? 3 : 1}"/>`
  }
  for (const t of tab) {
    const y = height - 5 - t.string * sh - sh / 2
    const x = t.fret === 0 ? fw / 2 : fw + t.fret * fw - fw / 2
    svg += `<circle cx="${x}" cy="${y}" r="6" fill="${t.fret === 0 ? '#fff' : '#f5a524'}" stroke="#d97706"/>`
    svg += `<text x="${x}" y="${y + 3}" font-size="7" text-anchor="middle" fill="#111">${t.fret}</text>`
  }
  return `${svg}</svg>`
}

export function diagramSvg(pitches: number[], instrument: Instrument): string {
  return instrument === 'piano' ? pianoSvg(pitches) : fretboardSvg(pitches, instrument)
}

/** Voice a chord symbol as MIDI pitches around a root octave. */
export function chordPitches(symbol: string, octave = 3): number[] {
  const chord = Chord.get(symbol)
  if (chord.empty || !chord.tonic) return []
  const root = Note.midi(`${chord.tonic}${octave}`)
  if (root === null) return []
  const pitches: number[] = []
  let previous = root - 1
  for (const name of chord.notes) {
    let midi = Note.midi(`${name}${octave}`)
    if (midi === null) continue
    while (midi <= previous) midi += 12
    pitches.push(midi)
    previous = midi
  }
  return pitches
}
