import type { ComponentType } from 'react'
import type { Instrument, NoteEvent, Snapshot } from '@shared/music/types'

/** What the agent asked to show. Absent notes and chords mean "follow the live input". */
export interface Panel {
  view: string
  title?: string
  instrument?: Instrument
  notes?: NoteEvent[]
  chords?: string[]
  /** Anything else a feature's view needs; its shape belongs to that feature. */
  data?: unknown
}

export interface ViewProps {
  panel: Panel
  /** The live transcript window, refreshed a few times a second. */
  snapshot: Snapshot | null
}

const views = new Map<string, ComponentType<ViewProps>>()

/**
 * Make a view available to `show`. Also list its kind in src/shared/views.ts
 * so the agent knows it exists. Registering a kind again replaces it, which is
 * how a better renderer supersedes an old one without editing it.
 */
export function registerView(kind: string, component: ComponentType<ViewProps>): void {
  views.set(kind, component)
}

export const viewFor = (kind: string): ComponentType<ViewProps> | undefined => views.get(kind)
