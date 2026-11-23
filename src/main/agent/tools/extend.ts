import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { text, type ToolModuleFactory } from '../toolkit'

/** Self-extension: hand a coding task to a Claude Code session on this app's own source. */
export const extend: ToolModuleFactory = (ctx) => {
  const run = ctx.extend
  if (!run) return null
  return {
    name: 'extend',
    guide: `- extend_self: hand a coding task to a Claude Code session that works on this app's own source. Use it when the player wants something you have no tool for (a new view, a new input, a new kind of generation). Tell them plainly that you can't do it yet and that you're building it, then carry on jamming; you'll be told when the work is ready for them to review.`,
    tools: [
      tool(
        'extend_self',
        "Ask a Claude Code session to add a capability to this app's own source code. It works in the background on a separate git branch and reports back; the player reviews the change before it is used.",
        { request: z.string().describe('What to build and why, including what the player asked for in their own words') },
        async ({ request }) => text(await run(request)),
      ),
    ],
  }
}
