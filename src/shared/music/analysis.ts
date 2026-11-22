import { Chord, Note } from 'tonal'
import type { ChordSpan, KeyEstimate, NoteEvent, RhythmEstimate } from './types'

const PC_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const

export const pitchClass = (pitch: number): number => ((pitch % 12) + 12) % 12
export const pcName = (pc: number): string => PC_NAMES[pitchClass(pc)]!
export const noteName = (pitch: number): string => Note.fromMidi(pitch)

/**
 * Name the chord formed by a set of sounding pitches. The lowest pitch is
 * treated as the bass, so inversions come back as slash chords.
 */
export function nameChord(pitches: number[]): string | null {
  const sorted = [...new Set(pitches)].sort((a, b) => a - b)
  const pcs: number[] = []
  for (const p of sorted) if (!pcs.includes(pitchClass(p))) pcs.push(pitchClass(p))
  if (pcs.length < 3) return null
  const candidates = Chord.detect(pcs.map(pcName))
  return candidates[0] ?? null
}

/**
 * Segment notes into chord spans: slice time at every onset/offset, name the
 * sounding set in each slice, and merge neighbours with the same name.
 */
export function detectChords(notes: NoteEvent[], minSpan = 0.15): ChordSpan[] {
  const sounding = notes.filter((n) => n.duration > 0)
  if (sounding.length === 0) return []
  const cuts = [...new Set(sounding.flatMap((n) => [n.start, n.start + n.duration]))].sort((a, b) => a - b)
  const spans: ChordSpan[] = []
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i]!
    const end = cuts[i + 1]!
    const mid = (start + end) / 2
    const active = sounding.filter((n) => n.start <= mid && n.start + n.duration > mid).map((n) => n.pitch)
    const symbol = nameChord(active)
    if (!symbol) continue
    const last = spans[spans.length - 1]
    if (last && last.symbol === symbol && start - last.end < minSpan) {
      last.end = end
    } else {
      spans.push({ symbol, start, end, pitchClasses: [...new Set(active.map(pitchClass))].sort((a, b) => a - b) })
    }
  }
  return spans.filter((s) => s.end - s.start >= minSpan)
}

// Krumhansl-Kessler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function correlate(a: number[], b: number[]): number {
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb)
    da += (a[i]! - ma) ** 2
    db += (b[i]! - mb) ** 2
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db)
}

/** Estimate the key from duration-weighted pitch-class content. */
export function estimateKey(notes: NoteEvent[]): KeyEstimate | null {
  const histogram = new Array<number>(12).fill(0)
  for (const n of notes) histogram[pitchClass(n.pitch)]! += Math.max(n.duration, 0.05) * (0.5 + n.velocity / 2)
  if (histogram.every((v) => v === 0)) return null
  let best: KeyEstimate | null = null
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = histogram.map((_, i) => histogram[(i + tonic) % 12]!)
    for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]] as const) {
      const score = correlate(rotated, profile)
      if (!best || score > best.score) best = { tonic: pcName(tonic), mode, score }
    }
  }
  return best
}

/**
 * Estimate tempo from inter-onset intervals, then render one bar of 4/4 as a
 * sixteenth-note grid. Good enough for a live readout; the slow pass refines it.
 */
export function estimateRhythm(notes: NoteEvent[]): RhythmEstimate | null {
  const onsets = [...new Set(notes.map((n) => Math.round(n.start * 1000) / 1000))].sort((a, b) => a - b)
  if (onsets.length < 4) return null

  // Score candidate tempi by how well onsets land on that tempo's sixteenth grid.
  let best = { bpm: 120, error: Infinity }
  for (let bpm = 60; bpm <= 180; bpm += 1) {
    const step = 60 / bpm / 4
    let error = 0
    for (const t of onsets) {
      const phase = (t - onsets[0]!) / step
      error += Math.abs(phase - Math.round(phase))
    }
    error /= onsets.length
    // Prefer tempi where onsets are also reasonably dense on the grid (avoids
    // always picking the fastest tempo, whose fine grid fits anything).
    const span = onsets[onsets.length - 1]! - onsets[0]!
    const density = onsets.length / Math.max(span / step, 1)
    const cost = error - 0.15 * Math.min(density, 1)
    if (cost < best.error) best = { bpm, error: cost }
  }

  const step = 60 / best.bpm / 4
  const grid = new Array<number>(16).fill(0)
  let offGrid = 0
  for (const t of onsets) {
    const phase = (t - onsets[0]!) / step
    offGrid += Math.abs(phase - Math.round(phase))
    grid[((Math.round(phase) % 16) + 16) % 16]! += 1
  }
  const peak = Math.max(...grid)
  const pattern = grid.map((c) => (c >= Math.max(1, peak * 0.4) ? 'x' : '.')).join('')
  const tightness = Math.max(0, 1 - (offGrid / onsets.length) * 4)
  return { bpm: best.bpm, pattern, tightness }
}
