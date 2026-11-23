import { WHITEBOARD, type WhiteboardRequest } from '@shared/features/whiteboard'
import { answerFeature } from '../bus'
import { board, changed, snapshot } from './board'

/** The board is always there to read; it only appears on screen when the agent shows the whiteboard view. */
export function start(): void {
  answerFeature(WHITEBOARD, (message) => {
    const request = message as WhiteboardRequest
    if (request.type === 'clear') {
      board.clear()
      changed()
    }
    return snapshot()
  })
}
