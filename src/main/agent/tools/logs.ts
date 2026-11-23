import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { LEVELS, formatEntry } from '@shared/log'
import { jamLog, type FileLog } from '../../log'
import { text, type ToolModuleFactory } from '../toolkit'

/** The diagnostic log: lets the agent work out why something (usually hearing chords from the mic) is not working. */
export const logsWith =
  (log: FileLog): ToolModuleFactory =>
  () => {
    const read = tool(
      'read_logs',
      "Read the app's diagnostic log (mic, fast pass, slow chord pass, model loading, worker, errors) to work out why something is not working. Also says where the log file is.",
      {
        component: z.string().optional().describe('Only this part, e.g. slowpass, worker, mic, fastpass, window, main, agent. Comma-separate several.'),
        level: z.enum(LEVELS).default('info').describe('Lowest level to include; "warn" for problems only'),
        minutes: z.number().positive().max(24 * 60).default(15).describe('How far back to look'),
        contains: z.string().optional().describe('Only lines containing this text'),
        last: z.number().int().positive().max(200).default(40).describe('Newest this many lines'),
      },
      async ({ component, level, minutes, contains, last }) => {
        const components = component?.split(',').map((c) => c.trim()).filter(Boolean)
        const entries = log.read({ components, minLevel: level, since: new Date(Date.now() - minutes * 60_000), contains, last })
        const where = log.path ? `Log file: ${log.path}` : 'The log file is not open yet.'
        if (entries.length === 0) return text(`No ${level}+ log lines${component ? ` from ${component}` : ''} in the last ${minutes} min. ${where}`)
        return text(`${entries.map(formatEntry).join('\n')}\n(${entries.length} lines, times UTC) ${where}`)
      },
    )
    return {
      name: 'logs',
      guide: `- read_logs: the app's own diagnostic log. When something does not work (no chords heard from the mic, the second pass failing or stuck, a view or sound missing, an error), read it before guessing: start with level "warn", then narrow by component (slowpass, worker, mic, fastpass). Summarize what you found in plain words; do not read log lines aloud. If the player wants the file, tell them where it is.`,
      tools: [read],
    }
  }

export const logs: ToolModuleFactory = logsWith(jamLog)
