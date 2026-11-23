import { tool } from '@anthropic-ai/claude-agent-sdk'
import { WHITEBOARD, type WhiteboardContent, type WhiteboardEvent, type WhiteboardRequest } from '@shared/features/whiteboard'
import { describeBoard } from '@shared/whiteboard'
import { text, type ToolModuleFactory } from '../toolkit'

/** The whiteboard: an on-demand surface the player draws or types on, read back as text plus a picture. */
export const whiteboard: ToolModuleFactory = (ctx) => {
  const ask = (request: WhiteboardRequest) => ctx.bus.request<WhiteboardContent>(WHITEBOARD, request)
  const failed = (error: unknown) => text(error instanceof Error ? error.message : String(error))

  ctx.bus.on(WHITEBOARD, (message) => {
    if ((message as WhiteboardEvent).type === 'done') ctx.notify?.('The player pressed Done on the whiteboard. Read it with read_whiteboard and respond to what they wrote or drew.')
  })

  const read = tool('read_whiteboard', "Read the whiteboard: the player's typed text and a picture of what they drew.", {}, async () => {
    try {
      const board = await ask({ type: 'read' })
      const words = text(describeBoard(board))
      if (!board.image) return words
      return { content: [{ type: 'image' as const, data: board.image, mimeType: board.mimeType ?? 'image/png' }, ...words.content] }
    } catch (error) {
      return failed(error)
    }
  })

  const clear = tool('clear_whiteboard', 'Wipe the whiteboard, drawing and text. The player can undo it.', {}, async () => {
    try {
      await ask({ type: 'clear' })
      return text('Whiteboard cleared.')
    } catch (error) {
      return failed(error)
    }
  })

  return {
    name: 'whiteboard',
    guide: `- whiteboard / read_whiteboard / clear_whiteboard: a pop-up whiteboard the player can scribble on with a finger, pen or mouse, or type into. It is not on screen unless they ask: when they say "pull up the whiteboard", "let me write it down", "I'll sketch it" or similar, show the whiteboard view with the title "Whiteboard"; hide it when they are finished with it. Read it with read_whiteboard whenever they say they have written or drawn something, or when you get a note that they pressed Done. It gives you their typed text and a picture of the drawing: chord names, rhythms, sketched notation, arrows. Say what you read back briefly, ask if you cannot make something out, then act on it. What they wrote stays there when the view is hidden, until cleared.`,
    tools: [read, clear],
  }
}
