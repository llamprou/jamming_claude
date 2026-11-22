import { detectChords, estimateKey, estimateRhythm } from './analysis'
import type { InputSource, NoteEvent, Snapshot } from './types'

/**
 * The live transcript: a rolling buffer of NoteEvents fed by every input.
 *
 * Two-speed design, like live captions: the fast path appends lossy notes the
 * moment they are heard, and a slower, more accurate pass later calls
 * `revise()` to replace a time window with corrected notes. Views re-derive
 * from the buffer, so corrections simply appear.
 */
export class Transcript {
  private notes: NoteEvent[] = []
  private open = new Map<string, NoteEvent>()
  private correctedUntil = 0
  private listeners = new Set<() => void>()

  constructor(private readonly retainSeconds = 600) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  noteOn(pitch: number, time: number, velocity: number, source: InputSource, confidence = 1): void {
    const key = `${source}:${pitch}`
    if (this.open.has(key)) this.noteOff(pitch, time, source)
    const note: NoteEvent = { pitch, start: time, duration: 0, velocity, source, confidence }
    this.open.set(key, note)
    this.notes.push(note)
    this.emit()
  }

  noteOff(pitch: number, time: number, source: InputSource): void {
    const key = `${source}:${pitch}`
    const note = this.open.get(key)
    if (!note) return
    note.duration = Math.max(time - note.start, 0.01)
    this.open.delete(key)
    this.emit()
  }

  /** Append already-complete notes (e.g. a frame of audio transcription). */
  add(notes: NoteEvent[]): void {
    if (notes.length === 0) return
    this.notes.push(...notes)
    this.notes.sort((a, b) => a.start - b.start)
    this.trim()
    this.emit()
  }

  /**
   * Slow-pass correction: replace everything from `source` inside [from, to)
   * with the corrected notes.
   */
  revise(from: number, to: number, source: InputSource, corrected: NoteEvent[]): void {
    this.notes = this.notes.filter((n) => !(n.source === source && n.start >= from && n.start < to))
    this.notes.push(...corrected)
    this.notes.sort((a, b) => a.start - b.start)
    this.correctedUntil = Math.max(this.correctedUntil, to)
    this.emit()
  }

  /** Notes in the last `windowSeconds` before `now`, with open notes closed at `now`. */
  window(now: number, windowSeconds: number): NoteEvent[] {
    const from = now - windowSeconds
    return this.notes
      .filter((n) => n.start >= from && n.start <= now)
      .map((n) => (n.duration === 0 ? { ...n, duration: Math.max(now - n.start, 0.01) } : n))
  }

  snapshot(now: number, windowSeconds = 16): Snapshot {
    const notes = this.window(now, windowSeconds)
    return {
      windowSeconds,
      notes,
      chords: detectChords(notes),
      key: estimateKey(notes),
      rhythm: estimateRhythm(notes),
      corrected: this.correctedUntil > 0 && this.correctedUntil >= now - 1,
    }
  }

  clear(): void {
    this.notes = []
    this.open.clear()
    this.correctedUntil = 0
    this.emit()
  }

  private trim(): void {
    const last = this.notes[this.notes.length - 1]
    if (!last) return
    const cutoff = last.start - this.retainSeconds
    if (this.notes[0] && this.notes[0].start < cutoff) this.notes = this.notes.filter((n) => n.start >= cutoff)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }
}
