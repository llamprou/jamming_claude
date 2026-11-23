import { BOARD_HEIGHT, BOARD_WIDTH, Board, strokeWidth } from '@shared/whiteboard'
import type { WhiteboardContent } from '@shared/features/whiteboard'

/**
 * The one whiteboard. It lives here, not in the view, so what the player
 * wrote survives the agent hiding and showing the panel.
 */
export const board = new Board()

const listeners = new Set<() => void>()
export const subscribe = (listener: () => void): (() => void) => (listeners.add(listener), () => listeners.delete(listener))
export const boardVersion = (): number => board.version
export function changed(): void {
  for (const listener of listeners) listener()
}

/** Draw every stroke onto `g`, scaled from board units by `scale`. Eraser strokes cut through to transparent. */
export function drawStrokes(g: CanvasRenderingContext2D, scale: number, ink: string): void {
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const stroke of board.strokes) {
    g.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
    g.strokeStyle = g.fillStyle = ink
    const pts = stroke.points
    if (pts.length === 1) {
      g.beginPath()
      g.arc(pts[0]!.x * scale, pts[0]!.y * scale, (strokeWidth(stroke.width, pts[0]!.pressure) * scale) / 2, 0, Math.PI * 2)
      g.fill()
      continue
    }
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1]!, pts[i]!]
      g.lineWidth = strokeWidth(stroke.width, (a.pressure + b.pressure) / 2) * scale
      g.beginPath()
      g.moveTo(a.x * scale, a.y * scale)
      g.lineTo(b.x * scale, b.y * scale)
      g.stroke()
    }
  }
  g.globalCompositeOperation = 'source-over'
}

/** The drawing, cropped to what is drawn, dark ink on white, as a PNG for the model. */
export function snapshot(maxSide = 1024): WhiteboardContent {
  const content: WhiteboardContent = { text: board.text, strokes: board.inkStrokes() }
  const box = board.bounds()
  if (!box) return content
  const full = document.createElement('canvas')
  const scale = Math.min(1, maxSide / BOARD_WIDTH)
  full.width = Math.round(BOARD_WIDTH * scale)
  full.height = Math.round(BOARD_HEIGHT * scale)
  drawStrokes(full.getContext('2d')!, scale, '#111')

  const fit = Math.min(1, maxSide / Math.max(box.width, box.height))
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(box.width * fit))
  out.height = Math.max(1, Math.round(box.height * fit))
  const g = out.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, out.width, out.height)
  g.drawImage(full, box.x * scale, box.y * scale, box.width * scale, box.height * scale, 0, 0, out.width, out.height)
  content.image = out.toDataURL('image/png').split(',')[1]
  content.mimeType = 'image/png'
  return content
}
