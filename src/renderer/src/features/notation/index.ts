import { NOTATION, type NotationShown } from '@shared/features/notation'
import type { WrittenSummary } from '@shared/music/notation/shown'
import { answerFeature } from '../bus'

/**
 * What the written views have actually drawn, so the agent can check the
 * screen without seeing it. Views record here after each render and forget
 * when they close; main asks with bus.request(NOTATION, { type: 'read' }).
 */
const shown = new Map<string, WrittenSummary>()

export function recordShown(summary: WrittenSummary): void {
  shown.delete(summary.view)
  shown.set(summary.view, summary)
}

export function forgetShown(view: string): void {
  shown.delete(view)
}

export function start(): void {
  answerFeature(NOTATION, (): NotationShown => ({ views: [...shown.values()].reverse() }))
}
