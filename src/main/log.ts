import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { entry, errorData, filterEntries, formatEntry, parseLine, type LogEntry, type LogFilter, type LogLevel } from '@shared/log'

/**
 * The diagnostic log on disk: `jamming-claude.log` plus up to `keep` older
 * files (`.1` newest ... `.N` oldest), rotated when the current one passes
 * `maxBytes`. Writes are synchronous so the last lines before a crash land.
 * Before `open()` entries are held in memory and written once it is called.
 */
export class FileLog {
  private dir: string | null = null
  private early: LogEntry[] = []
  private size = 0
  private failed = false

  constructor(
    private readonly maxBytes = 2_000_000,
    private readonly keep = 4,
    /** Also echo to the console (development). */
    private readonly echo = false,
  ) {}

  static readonly FILE = 'jamming-claude.log'

  get path(): string | null {
    return this.dir ? join(this.dir, FileLog.FILE) : null
  }

  open(dir: string): void {
    mkdirSync(dir, { recursive: true })
    this.dir = dir
    this.size = existsSync(this.path!) ? statSync(this.path!).size : 0
    const early = this.early
    this.early = []
    for (const e of early) this.write(e)
  }

  write(e: LogEntry): void {
    if (this.echo) (e.level === 'error' ? console.error : console.log)(formatEntry(e))
    if (!this.dir) {
      this.early.push(e)
      if (this.early.length > 500) this.early.shift()
      return
    }
    const line = formatEntry(e) + '\n'
    try {
      if (this.size + line.length > this.maxBytes) this.rotate()
      appendFileSync(this.path!, line)
      this.size += Buffer.byteLength(line)
      this.failed = false
    } catch (error) {
      // Logging must never take the app down; say so once on the console.
      if (!this.failed) console.error('jam log: cannot write', error)
      this.failed = true
    }
  }

  log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
    this.write(entry(level, component, message, data))
  }
  debug = (component: string, message: string, data?: Record<string, unknown>) => this.log('debug', component, message, data)
  info = (component: string, message: string, data?: Record<string, unknown>) => this.log('info', component, message, data)
  warn = (component: string, message: string, data?: Record<string, unknown>) => this.log('warn', component, message, data)
  error = (component: string, message: string, error?: unknown, data?: Record<string, unknown>) =>
    this.log('error', component, message, { ...data, ...(error === undefined ? {} : errorData(error)) })

  /** Entries from the current and rotated files, oldest first, filtered. */
  read(filter: LogFilter = {}): LogEntry[] {
    if (!this.dir) return filterEntries(this.early, filter)
    const files = [...Array.from({ length: this.keep }, (_, i) => `${this.path}.${this.keep - i}`), this.path!]
    const entries: LogEntry[] = []
    for (const file of files) {
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const parsed = parseLine(line)
        if (parsed) entries.push(parsed)
      }
    }
    return filterEntries(entries, filter)
  }

  private rotate(): void {
    const base = this.path!
    rmSync(`${base}.${this.keep}`, { force: true })
    for (let i = this.keep - 1; i >= 1; i--) if (existsSync(`${base}.${i}`)) renameSync(`${base}.${i}`, `${base}.${i + 1}`)
    if (existsSync(base)) renameSync(base, `${base}.1`)
    this.size = 0
  }
}

/** The app's one log. main/index.ts opens it; everything else just writes. */
export const jamLog = new FileLog(2_000_000, 4, !!process.env.JAM_LOG_ECHO)

/** Log crashes the process would otherwise only print (or not at all). */
export function catchProcessErrors(log: FileLog = jamLog): void {
  // The monitor variant only observes: Electron's own crash handling still runs.
  process.on('uncaughtExceptionMonitor', (error, origin) => log.error('main', `uncaught exception (${origin})`, error))
  process.on('unhandledRejection', (reason) => log.error('main', 'unhandled promise rejection', reason))
  process.on('warning', (warning) => log.warn('main', `process warning: ${warning.name}`, { message: warning.message }))
}
