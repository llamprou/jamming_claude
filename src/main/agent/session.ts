import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MainEvent } from '@shared/ipc'
import { EXTENDER_PROMPT, systemPrompt } from './prompt'
import type { ToolContext } from './toolkit'
import { buildToolbox } from './tools'

export interface SessionOptions {
  model: string
  voice: boolean
  /** Source checkout to extend, or undefined to disable self-extension. */
  sourceDir?: string
  /** Called with each chunk of text the buddy says, as it streams. */
  onSpeech(chunk: string): void
  /** Called when the buddy finishes (or abandons) a spoken turn. */
  onSpeechEnd(): void
}

/** A push-driven async queue: the SDK reads user turns from it for the whole session. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(text: string): void {
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.queue.shift()
      if (next) yield next
      else await new Promise<void>((resolve) => (this.wake = resolve))
    }
  }
}

/**
 * The live agent: one long-running Claude Agent SDK session whose only tools
 * are the jam tools. Coding tools are deliberately absent here; self-extension
 * runs as a separate session (see `extend`) so the live loop stays fast and
 * cannot edit files mid-jam.
 */
export class JamSession {
  private inbox = new Inbox()
  private run: Query | null = null
  private busy = false

  constructor(
    private readonly ctx: Omit<ToolContext, 'extend'>,
    private readonly opts: SessionOptions,
  ) {}

  async start(): Promise<void> {
    const tasteProfile = await this.ctx.memory.profile()
    const canExtend = Boolean(this.opts.sourceDir)
    const toolbox = buildToolbox({ ...this.ctx, notify: (note) => this.notify(note), extend: canExtend ? (request) => this.extend(request) : undefined })

    this.run = query({
      prompt: this.inbox,
      options: {
        model: this.opts.model,
        effort: 'low', // conversational latency matters more than depth here
        systemPrompt: systemPrompt({ tasteProfile, voice: this.opts.voice, toolGuide: toolbox.guide }),
        mcpServers: { jam: toolbox.server },
        tools: [], // no built-in tools in the live loop
        allowedTools: toolbox.allowedTools,
        permissionMode: 'dontAsk',
        settingSources: [],
        includePartialMessages: true,
        persistSession: false,
      },
    })
    void this.pump(this.run)
    if (this.opts.voice) {
      // There is no button to press, so the buddy speaks first: that is how the player knows it is live.
      this.busy = true
      this.inbox.push('[System note, not from the player] The session has just started and the player can hear you. Greet them in one short sentence and invite them to play or ask for something.')
    }
  }

  /** A turn from the player, typed or transcribed from speech. */
  say(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.ctx.emit({ type: 'transcript', role: 'user', text: trimmed, final: true })
    this.ctx.emit({ type: 'status', agent: 'thinking' })
    this.busy = true
    this.inbox.push(trimmed)
  }

  /** A turn prompted by something the player did without speaking, e.g. pressing Done on the whiteboard. */
  private notify(note: string): void {
    this.ctx.emit({ type: 'status', agent: 'thinking' })
    this.busy = true
    this.inbox.push(`[System note, not from the player] ${note}`)
  }

  /** Barge-in: the player started talking (or hit stop) while the buddy was mid-turn. */
  async interrupt(): Promise<void> {
    if (!this.busy || !this.run) return
    this.opts.onSpeechEnd()
    await this.run.interrupt().catch(() => undefined)
  }

  stop(): void {
    this.inbox.close()
    this.run?.close()
    this.run = null
  }

  private async pump(run: Query): Promise<void> {
    try {
      for await (const message of run) {
        if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
          const event = message.event
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            this.ctx.emit({ type: 'status', agent: 'speaking' })
            this.ctx.emit({ type: 'transcript', role: 'buddy', text: event.delta.text, final: false })
            this.opts.onSpeech(event.delta.text)
          }
        } else if (message.type === 'result') {
          this.busy = false
          this.opts.onSpeechEnd()
          this.ctx.emit({ type: 'transcript', role: 'buddy', text: '', final: true })
          if (message.subtype === 'success') this.ctx.emit({ type: 'status', agent: 'idle' })
          else this.ctx.emit({ type: 'status', agent: 'error', detail: message.subtype })
        }
      }
    } catch (error) {
      this.busy = false
      this.opts.onSpeechEnd()
      this.ctx.emit({ type: 'status', agent: 'error', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Self-extension: start a Claude Code session on this app's own source. It
   * runs in the background on its own branch; when it finishes, the result is
   * delivered to the live agent as a new turn so it can tell the player.
   */
  private async extend(request: string): Promise<string> {
    const cwd = this.opts.sourceDir
    if (!cwd) return 'Self-extension is not available in this build.'
    void (async () => {
      let summary = 'The coding session ended without a summary.'
      try {
        const coder = query({
          prompt: `Capability request from the live jamming agent:\n\n${request}`,
          options: {
            cwd,
            model: this.opts.model,
            systemPrompt: { type: 'preset', preset: 'claude_code', append: EXTENDER_PROMPT },
            settingSources: ['project'],
            allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git:*)', 'Bash(npm run:*)', 'Bash(npm test:*)'],
            disallowedTools: ['Bash(git push:*)', 'WebFetch', 'WebSearch'],
            permissionMode: 'dontAsk',
          },
        })
        for await (const message of coder) {
          if (message.type === 'result') summary = message.subtype === 'success' ? message.result : `The coding session failed (${message.subtype}).`
        }
      } catch (error) {
        summary = `The coding session crashed: ${error instanceof Error ? error.message : String(error)}`
      }
      this.inbox.push(`[System note, not from the player] Your extend_self request has finished. Report from the coding session:\n\n${summary}\n\nTell the player briefly what is ready for them to review. The change is on a separate branch and is not active until they restart the app on it.`)
    })()
    return 'A coding session has started on this in the background. Tell the player you are building it and carry on; you will get a note when it is done.'
  }
}
