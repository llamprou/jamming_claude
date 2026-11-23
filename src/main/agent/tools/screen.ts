import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { SCREEN, type ScreenEvent } from '@shared/features/screen'
import { SnapshotBuffer, type ScreenShot, type ScreenTarget } from '@shared/screen'
import { text, type ToolModuleFactory } from '../toolkit'

/** While watching: one snapshot this often, this many seconds kept, and the watch ends by itself after this long. */
export const WATCH_EVERY_MS = 2000
export const WATCH_KEEP_SECONDS = 30
export const WATCH_LIMIT_MS = 10 * 60_000

const WHAT: Record<ScreenTarget, string> = {
  app: "This app's own window, as the player sees it (the views you have shown). The small light in a corner is the capture indicator.",
  screen: "The player's whole screen (the display this app is on).",
}

/** Sight of the player's screen: stills on demand, and an opt-in short buffer of recent snapshots. Absent where capture is unavailable. */
export const screen: ToolModuleFactory = (ctx) => {
  const capturer = ctx.screen
  if (!capturer) return null
  const light = (state: ScreenEvent['state']) => ctx.bus.send(SCREEN, { type: 'light', state } satisfies ScreenEvent)
  const failed = (error: unknown) => text(error instanceof Error ? error.message : String(error))

  const buffer = new SnapshotBuffer(WATCH_KEEP_SECONDS)
  let watch: { target: ScreenTarget; timer: ReturnType<typeof setInterval>; until: number } | null = null

  const stopWatching = () => {
    if (!watch) return
    clearInterval(watch.timer)
    watch = null
    buffer.clear()
    light('off')
  }

  const snap = async () => {
    if (!watch) return
    const target = watch.target
    try {
      const shot = await capturer.capture(target, { maxEdge: 1280, quality: 70 })
      if (watch?.target === target) buffer.add(shot)
    } catch {
      stopWatching() // permission withdrawn or window gone: stop rather than retry forever
    }
    if (watch && Date.now() > watch.until) stopWatching()
  }

  const describe = (shot: ScreenShot, note?: string) => {
    const age = ctx.now() - shot.time
    const lines = [WHAT[shot.target], `${shot.width}x${shot.height}.`, age > 1 ? `This snapshot is from ${age.toFixed(0)} seconds ago.` : null, note ?? null]
    return { content: [{ type: 'image' as const, data: shot.data, mimeType: shot.mimeType }, { type: 'text' as const, text: lines.filter(Boolean).join('\n') }] }
  }

  const lookScreen = tool(
    'look_screen',
    "Take a screenshot and see it: this app's window by default, or the player's whole screen. Use it when the player refers to something on screen, or to check a view rendered right.",
    {
      target: z.enum(['app', 'screen']).default('app').describe('`app`: this window and its views. `screen`: the whole display, for things outside the app'),
      seconds_ago: z.number().min(0).max(WATCH_KEEP_SECONDS).default(0).describe(`A moment that has just passed instead of now; needs watch_screen on (one snapshot every ${WATCH_EVERY_MS / 1000} seconds is kept for ${WATCH_KEEP_SECONDS})`),
    },
    async ({ target, seconds_ago }) => {
      if (seconds_ago > 0) {
        if (!watch) return text('No recent snapshots are kept: turn watch_screen on first, or look now with seconds_ago 0.')
        const past = buffer.pick(ctx.now(), seconds_ago)
        if (past) return describe(past, past.target !== target ? `You asked for ${target}, but the watch is keeping ${past.target}.` : undefined)
      }
      light('still')
      try {
        return describe(await capturer.capture(target))
      } catch (error) {
        return failed(error)
      } finally {
        if (watch) light('watching')
      }
    },
  )

  const watchScreen = tool(
    'watch_screen',
    `Start or stop keeping a snapshot of the screen every ${WATCH_EVERY_MS / 1000} seconds for the last ${WATCH_KEEP_SECONDS}, so look_screen can see a moment just past. Nothing is sent to you unless you look. Stops by itself after ${WATCH_LIMIT_MS / 60_000} minutes.`,
    {
      on: z.boolean(),
      target: z.enum(['app', 'screen']).default('app'),
    },
    async ({ on, target }) => {
      stopWatching()
      if (!on) return text('Screen watch off; the snapshots are gone.')
      try {
        // One capture up front, so a missing permission is reported now rather than failing silently later.
        buffer.add(await capturer.capture(target, { maxEdge: 1280, quality: 70 }))
      } catch (error) {
        return failed(error)
      }
      watch = { target, timer: setInterval(() => void snap(), WATCH_EVERY_MS), until: Date.now() + WATCH_LIMIT_MS }
      light('watching')
      return text(`Watching ${target === 'app' ? 'this app window' : 'the whole screen'}: a light shows on their screen while it is on. Tell the player.`)
    },
  )

  return {
    name: 'screen',
    guide: `- look_screen: take a screenshot and see it. By default it shows this app's own window, the views exactly as the player sees them; target "screen" shows their whole display, for something outside the app such as a score, a video or another program. Use it when they refer to something on screen ("look at this", "the sheet shows something else", "see bar 9"), and to check a view rendered correctly after show or notate when they say it looks wrong. Look rather than guess, then say plainly what you see. If it reports that permission is missing, pass that on to them in a sentence.
- watch_screen: only when they want you to catch something that comes and goes, keep a snapshot every few seconds so look_screen with seconds_ago can see a moment just past. Say you are doing it; turn it off when done.
- Privacy, if they ask: nothing is captured unless you call these tools, a light shows on their screen while capturing, and only the stills you look at are sent, to Anthropic, as part of this conversation.`,
    tools: [lookScreen, watchScreen],
  }
}
