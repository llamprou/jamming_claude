/** Bus traffic for the whiteboard feature. The window owns the board; main reads it. */
export const WHITEBOARD = 'whiteboard'

/** main -> window, with bus.request(WHITEBOARD, ...). */
export type WhiteboardRequest =
  /** Replies WhiteboardContent. */
  | { type: 'read' }
  /** Wipe the board (the player can undo it). Replies WhiteboardContent. */
  | { type: 'clear' }

export interface WhiteboardContent {
  text: string
  /** Strokes that leave ink. */
  strokes: number
  /** PNG of the drawing on white, base64 without a data: prefix; absent when nothing is drawn. */
  image?: string
  mimeType?: string
}

/** window -> main, with sendFeature(WHITEBOARD, ...). */
export type WhiteboardEvent =
  /** The player pressed Done: they want you to look. */
  { type: 'done' }
