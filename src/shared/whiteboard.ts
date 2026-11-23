/**
 * The whiteboard's content, independent of any canvas: freehand strokes on a
 * fixed logical surface plus typed text, with undo. Pure, so the window can
 * draw it and the tests can check it without a DOM.
 */

/** Logical size of the board. Pointer positions are scaled into this; drawings scale out of it. */
export const BOARD_WIDTH = 1600
export const BOARD_HEIGHT = 1000

export interface StrokePoint {
  x: number
  y: number
  /** Pen pressure 0-1; mice and fingers that report none are treated as 0.5. */
  pressure: number
}

export interface Stroke {
  points: StrokePoint[]
  /** Base line width in board units, at pressure 0.5. */
  width: number
  /** An eraser stroke rubs out what is under it. */
  erase: boolean
}

type Undoable = { kind: 'stroke' } | { kind: 'clear'; strokes: Stroke[]; text: string }

/** Line width for a segment drawn at `pressure`: thin for a light touch, up to about twice as thick pressed hard. */
export function strokeWidth(base: number, pressure: number): number {
  const p = Number.isFinite(pressure) && pressure > 0 ? Math.min(1, pressure) : 0.5
  return base * (0.4 + p * 1.2)
}

export class Board {
  strokes: Stroke[] = []
  text = ''
  /** Bumped on every change, for views that redraw. */
  version = 0
  private undoStack: Undoable[] = []
  private drawing: Stroke | null = null

  begin(point: StrokePoint, opts: { width?: number; erase?: boolean } = {}): void {
    this.drawing = { points: [clampPoint(point)], width: opts.width ?? (opts.erase ? 36 : 5), erase: Boolean(opts.erase) }
    this.strokes.push(this.drawing)
    this.undoStack.push({ kind: 'stroke' })
    this.version++
  }

  extend(point: StrokePoint): void {
    if (!this.drawing) return
    this.drawing.points.push(clampPoint(point))
    this.version++
  }

  end(): void {
    this.drawing = null
  }

  get isDrawing(): boolean {
    return this.drawing !== null
  }

  setText(text: string): void {
    if (text === this.text) return
    this.text = text
    this.version++
  }

  /** Wipe drawing and text. Undo brings both back. */
  clear(): void {
    if (this.isEmpty()) return
    this.end()
    this.undoStack.push({ kind: 'clear', strokes: this.strokes, text: this.text })
    this.strokes = []
    this.text = ''
    this.version++
  }

  /** Take back the last stroke or clear. Returns false when there is nothing to undo. */
  undo(): boolean {
    this.end()
    const last = this.undoStack.pop()
    if (!last) return false
    if (last.kind === 'stroke') this.strokes.pop()
    else {
      this.strokes = last.strokes
      this.text = last.text
    }
    this.version++
    return true
  }

  /** Strokes that leave ink (an eraser on its own leaves nothing). */
  inkStrokes(): number {
    return this.strokes.filter((s) => !s.erase).length
  }

  isEmpty(): boolean {
    return this.inkStrokes() === 0 && this.text.trim() === ''
  }

  /** The box around everything drawn, padded, or null if nothing is. */
  bounds(pad = 40): { x: number; y: number; width: number; height: number } | null {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const stroke of this.strokes) {
      if (stroke.erase) continue
      for (const p of stroke.points) {
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x)
        maxY = Math.max(maxY, p.y)
      }
    }
    if (minX === Infinity) return null
    const x = Math.max(0, minX - pad)
    const y = Math.max(0, minY - pad)
    return { x, y, width: Math.min(BOARD_WIDTH, maxX + pad) - x, height: Math.min(BOARD_HEIGHT, maxY + pad) - y }
  }
}

function clampPoint(p: StrokePoint): StrokePoint {
  return {
    x: Math.min(BOARD_WIDTH, Math.max(0, p.x)),
    y: Math.min(BOARD_HEIGHT, Math.max(0, p.y)),
    pressure: Number.isFinite(p.pressure) && p.pressure > 0 ? Math.min(1, p.pressure) : 0.5,
  }
}

/** What the board holds, in words for the model. The picture comes separately. */
export function describeBoard(content: { text: string; strokes: number }): string {
  const lines: string[] = []
  const typed = content.text.trim()
  if (!typed && content.strokes === 0) return 'The whiteboard is empty.'
  lines.push(typed ? `Typed text:\n${typed}` : 'No typed text.')
  lines.push(content.strokes ? `Drawing: ${content.strokes} stroke${content.strokes === 1 ? '' : 's'}; the picture shows it.` : 'Nothing drawn.')
  return lines.join('\n')
}
