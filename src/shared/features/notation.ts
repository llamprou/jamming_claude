import type { WrittenSummary } from '../music/notation/shown'

/** Bus traffic for the written views. The window knows what it drew; main asks. */
export const NOTATION = 'notation'

/** main -> window, with bus.request(NOTATION, ...). Replies NotationShown. */
export type NotationRequest = { type: 'read' }

/** What each open written view (sheet, tab) has drawn, most recently drawn first. */
export interface NotationShown {
  views: WrittenSummary[]
}
