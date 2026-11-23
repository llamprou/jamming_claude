import { abcBarsPerLine } from './abc'
import type { Score } from './score'

/**
 * What a written view has on screen, in words the agent can check without
 * seeing it: how many bars, on how many lines, and the chord symbols bar by bar.
 */
export interface WrittenSummary {
  view: string
  title?: string
  live: boolean
  /** Bars drawn, and how many there were before any `bars` limit cut the oldest. */
  bars: number
  totalBars: number
  firstBar: number
  /** Sheet music only: lines (systems) the bars wrap onto. */
  lines?: number
  key: string
  timeSignature: string
  /** One entry per drawn bar, in order: the symbols written above it. */
  chordsByBar: string[][]
}

export function summariseScore(score: Score, info: { view: string; title?: string; live: boolean }): WrittenSummary {
  const perLine = abcBarsPerLine(score)
  return {
    view: info.view,
    title: info.title,
    live: info.live,
    bars: score.bars.length,
    // Bars keep their numbers when the oldest are cut, so the last number is the full count.
    totalBars: score.bars.at(-1)?.number ?? 0,
    firstBar: score.bars[0]?.number ?? 1,
    ...(info.view === 'sheet' ? { lines: Math.ceil(score.bars.length / perLine) } : {}),
    key: score.key.name,
    timeSignature: score.meter.timeSignature,
    chordsByBar: score.bars.map((bar) => [...bar.chords].sort((a, b) => a.at.n / a.at.d - b.at.n / b.at.d).map((c) => c.symbol)),
  }
}

/** One or two lines for the agent: e.g. "sheet: 16 bars on 4 lines, C major, 4/4. Chords by bar: 1 C | 2 Bb | ...". */
export function describeWritten(s: WrittenSummary): string {
  const name = `${s.view}${s.title ? ` "${s.title}"` : ''}${s.live ? ' (live)' : ''}`
  const cut = s.totalBars > s.bars ? ` (the last ${s.bars} of ${s.totalBars})` : ''
  const lines = s.lines === undefined ? '' : ` on ${s.lines} line${s.lines === 1 ? '' : 's'}`
  const head = `${name}: ${s.bars} bar${s.bars === 1 ? '' : 's'}${cut}${lines}, ${s.key}, ${s.timeSignature}.`
  const chords = s.chordsByBar.map((symbols, i) => `${s.firstBar + i} ${symbols.length ? symbols.join(' ') : '-'}`)
  return s.chordsByBar.some((c) => c.length) ? `${head} Chords by bar: ${chords.join(' | ')}` : `${head} No chord symbols.`
}
