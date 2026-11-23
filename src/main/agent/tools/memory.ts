import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { text, type ToolModuleFactory } from '../toolkit'

/** Taste memory: what the player keeps and skips, and the profile distilled from it. */
export const memory: ToolModuleFactory = (ctx) => {
  const remember = tool(
    'remember',
    "Record a reaction that reveals the player's taste, so future ideas fit them better.",
    {
      reaction: z.enum(['loved', 'liked', 'kept', 'neutral', 'disliked', 'skipped']),
      subject: z.string().describe('What they reacted to, in musical terms specific enough to act on later'),
      evidence: z.string().optional().describe('What they said or did'),
      tags: z.array(z.string()).optional().describe('e.g. genre, feel, harmony, tempo'),
    },
    async (event) => {
      await ctx.memory.record(event)
      const pending = await ctx.memory.undistilledCount()
      return text(pending >= 8 ? `Noted. ${pending} reactions since the profile was last updated: worth rewriting it soon.` : 'Noted.')
    },
  )

  const recall = tool(
    'recall',
    "Look up the player's recorded reactions.",
    { limit: z.number().int().min(1).max(200).default(30), tag: z.string().optional() },
    async ({ limit, tag }) => {
      const events = await ctx.memory.events(limit, tag)
      if (events.length === 0) return text('No reactions recorded yet.')
      return text(
        events
          .map((e) => `${e.at.slice(0, 10)} ${e.reaction}: ${e.subject}${e.evidence ? ` ("${e.evidence}")` : ''}${e.tags?.length ? ` [${e.tags.join(', ')}]` : ''}`)
          .join('\n'),
      )
    },
  )

  const updateProfile = tool(
    'update_taste_profile',
    "Rewrite the player's taste profile (markdown). It is loaded at the start of every session, so keep it concise, concrete and current: what they gravitate to, what they avoid, and how sure you are.",
    { markdown: z.string().min(20) },
    async ({ markdown }) => {
      await ctx.memory.writeProfile(markdown)
      return text('Taste profile updated.')
    },
  )

  return {
    name: 'memory',
    guide: `- remember: note a reaction that reveals their taste. Do this quietly as you go; don't announce it.
- recall: look up earlier reactions when you need more than the profile below.
- update_taste_profile: rewrite the profile when you've learned something that should shape future sessions.`,
    tools: [remember, recall, updateProfile],
  }
}
