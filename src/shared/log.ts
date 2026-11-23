/**
 * Diagnostic log entries: one format for the main process, the window and the
 * transcriber worker. Pure: formatting, parsing, filtering and the small
 * summarizers that keep per-block data down to one line every so often.
 * Entries never carry audio or anything the player said.
 */

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LEVELS)[number]

export interface LogEntry {
  /** Wall-clock time, ISO 8601. */
  time: string
  level: LogLevel
  /** Which part of the app: main, window, mic, fastpass, slowpass, worker... */
  component: string
  message: string
  /** Small structured details (numbers, short strings, an error stack). */
  data?: Record<string, unknown>
}

/** Feature-bus name the window uses to send log entries to main. */
export const LOG_FEATURE = 'log'

export const levelRank = (level: LogLevel): number => LEVELS.indexOf(level)

export function entry(level: LogLevel, component: string, message: string, data?: Record<string, unknown>, time = new Date()): LogEntry {
  return data && Object.keys(data).length > 0 ? { time: time.toISOString(), level, component, message, data } : { time: time.toISOString(), level, component, message }
}

/** An error as loggable data: message and the top of the stack. */
export function errorData(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { error: error.message, stack: error.stack?.split('\n').slice(0, 8).join('\n') }
  return { error: String(error) }
}

/** One line: `2026-11-23T10:00:00.000Z INFO  [slowpass] run done {"ms":812}` */
export function formatEntry(e: LogEntry): string {
  const data = e.data ? ` ${safeJson(e.data)}` : ''
  return `${e.time} ${e.level.toUpperCase().padEnd(5)} [${e.component}] ${e.message.replace(/\n/g, ' ')}${data}`
}

const LINE = /^(\S+) (DEBUG|INFO|WARN|ERROR) +\[([^\]]*)\] (.*)$/

export function parseLine(line: string): LogEntry | null {
  const match = LINE.exec(line)
  if (!match) return null
  const [, time, level, component, rest] = match as unknown as [string, string, string, string, string]
  const brace = rest.indexOf(' {')
  let message = rest
  let data: Record<string, unknown> | undefined
  if (brace >= 0 && rest.endsWith('}')) {
    try {
      data = JSON.parse(rest.slice(brace + 1)) as Record<string, unknown>
      message = rest.slice(0, brace)
    } catch {
      data = undefined
    }
  }
  return data ? { time, level: level.toLowerCase() as LogLevel, component, message, data } : { time, level: level.toLowerCase() as LogLevel, component, message }
}

export interface LogFilter {
  /** Component names to keep (case-insensitive prefix match). */
  components?: string[]
  /** Lowest level to keep. */
  minLevel?: LogLevel
  /** Keep entries at or after this time. */
  since?: Date
  /** Case-insensitive text to look for in the message or data. */
  contains?: string
  /** Keep only the newest this many. */
  last?: number
}

export function filterEntries(entries: LogEntry[], filter: LogFilter): LogEntry[] {
  const components = filter.components?.map((c) => c.toLowerCase())
  const min = filter.minLevel ? levelRank(filter.minLevel) : 0
  const since = filter.since?.toISOString()
  const needle = filter.contains?.toLowerCase()
  const kept = entries.filter(
    (e) =>
      levelRank(e.level) >= min &&
      (!since || e.time >= since) &&
      (!components || components.some((c) => e.component.toLowerCase().startsWith(c))) &&
      (!needle || formatEntry(e).toLowerCase().includes(needle)),
  )
  return filter.last !== undefined ? kept.slice(-filter.last) : kept
}

/** JSON that cannot throw (cycles, BigInt) and stays short. */
export function safeJson(value: unknown, maxLength = 2000): string {
  let text: string
  try {
    text = JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v))
  } catch {
    text = JSON.stringify({ unserializable: String(value) })
  }
  return text.length > maxLength ? JSON.stringify({ truncated: text.slice(0, maxLength) }) : text
}

/**
 * Mic loudness summarized over a period: called once per audio block with
 * that block's RMS, read out (and reset) every so often. Also notices when
 * the input goes silent or comes back, so those are logged once, not per block.
 */
export class LevelSummary {
  private blocks = 0
  private silentBlocks = 0
  private sum = 0
  private peak = 0
  private silentSince: number | null = null
  private wasSilent: boolean | null = null

  constructor(
    private readonly silenceRms = 0.004,
    /** Silence must last this long (seconds) before it counts as the input going quiet. */
    private readonly quietAfter = 5,
  ) {}

  /** Returns 'silent' or 'sound' when the input changes state, otherwise null. */
  add(rms: number, time: number): 'silent' | 'sound' | null {
    this.blocks += 1
    this.sum += rms
    this.peak = Math.max(this.peak, rms)
    const silent = rms < this.silenceRms
    if (silent) this.silentBlocks += 1
    if (!silent) {
      this.silentSince = null
      if (this.wasSilent !== false) {
        this.wasSilent = false
        return 'sound'
      }
      return null
    }
    this.silentSince ??= time
    if (this.wasSilent !== true && time - this.silentSince >= this.quietAfter) {
      this.wasSilent = true
      return 'silent'
    }
    return null
  }

  /** The period's numbers, then start a new period. Null if no audio came in. */
  take(): { blocks: number; meanRms: number; peakRms: number; silentPct: number } | null {
    if (this.blocks === 0) return null
    const out = { blocks: this.blocks, meanRms: this.sum / this.blocks, peakRms: this.peak, silentPct: Math.round((100 * this.silentBlocks) / this.blocks) }
    this.blocks = this.silentBlocks = this.sum = this.peak = 0
    return out
  }
}

/** Most notes sounding at once: a chord-hearing pass that only ever finds 1 is not hearing chords. */
export function maxPolyphony(notes: Array<{ start: number; duration: number }>): number {
  const edges = notes.flatMap((n) => [
    [n.start, 1],
    [n.start + n.duration, -1],
  ]) as Array<[number, number]>
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let current = 0
  let most = 0
  for (const [, step] of edges) most = Math.max(most, (current += step))
  return most
}
