import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Taste memory. Two layers, both plain files the user can read and edit:
 *
 *  - events.jsonl: append-only log of what the player actually did with the
 *    buddy's ideas (kept, asked for more, skipped, said "too busy"...).
 *  - profile.md:   the distilled taste the agent writes from those events.
 *    It is loaded into the system prompt at the start of every session, so
 *    generation is shaped by it from the first note.
 */

export type Reaction = 'loved' | 'liked' | 'kept' | 'neutral' | 'disliked' | 'skipped'

export interface TasteEvent {
  at: string
  reaction: Reaction
  /** What was reacted to, in musical terms: "ii-V-I in Bb with tritone sub", "busy 16th hi-hats". */
  subject: string
  /** What the player said or did, if anything. */
  evidence?: string
  /** Free tags: genre, feel, harmony, tempo... */
  tags?: string[]
}

const EMPTY_PROFILE = `# Taste profile

Nothing learned yet. As we jam, I note what you keep, repeat, skip or comment on,
and distil it here.
`

export class TasteMemory {
  private readonly eventsPath: string
  private readonly profilePath: string

  constructor(private readonly dir: string) {
    this.eventsPath = join(dir, 'events.jsonl')
    this.profilePath = join(dir, 'profile.md')
  }

  async record(event: Omit<TasteEvent, 'at'>, at = new Date()): Promise<TasteEvent> {
    const full: TasteEvent = { at: at.toISOString(), ...event }
    await mkdir(this.dir, { recursive: true })
    await appendFile(this.eventsPath, `${JSON.stringify(full)}\n`, 'utf8')
    return full
  }

  async events(limit = 50, tag?: string): Promise<TasteEvent[]> {
    let raw: string
    try {
      raw = await readFile(this.eventsPath, 'utf8')
    } catch {
      return []
    }
    const all = raw
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as TasteEvent]
        } catch {
          return [] // a half-written line must not take the memory down
        }
      })
    const filtered = tag ? all.filter((e) => e.tags?.includes(tag)) : all
    return filtered.slice(-limit)
  }

  async profile(): Promise<string> {
    try {
      return await readFile(this.profilePath, 'utf8')
    } catch {
      return EMPTY_PROFILE
    }
  }

  async writeProfile(markdown: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.profilePath, markdown, 'utf8')
  }

  /** How many events have been logged since the profile was last rewritten. */
  async undistilledCount(): Promise<number> {
    const { stat } = await import('node:fs/promises')
    const events = await this.events(Number.MAX_SAFE_INTEGER)
    try {
      const { mtime } = await stat(this.profilePath)
      return events.filter((e) => new Date(e.at) > mtime).length
    } catch {
      return events.length
    }
  }
}
