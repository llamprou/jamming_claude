import type { ChordSlot } from '../progression'
import type { Rng } from '../rng'
import { parseChord, type ChordInfo, type KeySpec } from '../theory'

export interface ReharmContext {
  key: KeySpec
  rng: Rng
  /** 0-1: what share of the places a strategy could act on it does act on (at least one). */
  amount: number
}

/**
 * One way of reharmonizing. A strategy is a pure function of the progression:
 * it returns new slots that add up to the same number of beats. To add one,
 * write it in its own file and list it in reharm/index.ts.
 */
export interface ReharmStrategy {
  name: string
  /** One plain sentence, shown to the agent. */
  summary: string
  defaultAmount: number
  apply(slots: ChordSlot[], ctx: ReharmContext): ChordSlot[]
}

/** Choose which of the possible places to change, honouring `amount`. */
export function choose(candidates: number[], ctx: ReharmContext): Set<number> {
  if (candidates.length === 0) return new Set()
  const count = Math.min(candidates.length, Math.max(1, Math.round(candidates.length * ctx.amount)))
  const pool = [...candidates]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = ctx.rng.int(i + 1)
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  return new Set(pool.slice(0, count))
}

export type Neighbours = { index: number; count: number; prev: ChordInfo | null; next: ChordInfo | null }

/** Replace chords in place. `propose` returns the new symbol, or null to leave the chord alone. */
export function substitute(
  slots: ChordSlot[],
  ctx: ReharmContext,
  propose: (chord: ChordInfo, at: Neighbours) => string | null,
): ChordSlot[] {
  const infos = slots.map((s) => parseChord(s.symbol))
  const n = slots.length
  const proposals = infos.map((info, i) => {
    if (!info) return null
    const symbol = propose(info, { index: i, count: n, prev: infos[(i - 1 + n) % n] ?? null, next: infos[(i + 1) % n] ?? null })
    return symbol && symbol !== info.symbol ? symbol : null
  })
  const chosen = choose(proposals.flatMap((p, i) => (p ? [i] : [])), ctx)
  return slots.map((slot, i) => (chosen.has(i) ? { symbol: proposals[i]!, beats: slot.beats } : { ...slot }))
}

/**
 * Lead into chords by inserting new ones in the back half of the chord before.
 * `propose` returns the chords to play on the way into `target` (in order), or
 * null. The progression loops, so the first chord is approached from the last.
 */
export function approach(
  slots: ChordSlot[],
  ctx: ReharmContext,
  propose: (target: ChordInfo, prev: ChordInfo) => string[] | null,
): ChordSlot[] {
  const infos = slots.map((s) => parseChord(s.symbol))
  const n = slots.length
  const plans = slots.map((slot, i) => {
    const prev = infos[i]
    const target = infos[(i + 1) % n]
    if (!prev || !target) return null
    const room = Math.floor(slot.beats / 2)
    let chords = propose(target, prev)
    if (!chords || room < 1) return null
    // Not enough room for all of them: keep the ones nearest the target.
    if (chords.length > room) chords = chords.slice(chords.length - room)
    if (chords.length === 0 || chords[chords.length - 1] === prev.symbol) return null
    const each = Math.floor(room / chords.length)
    return { chords, each }
  })
  const chosen = choose(plans.flatMap((p, i) => (p ? [i] : [])), ctx)
  return slots.flatMap((slot, i) => {
    const plan = plans[i]
    if (!plan || !chosen.has(i)) return [{ ...slot }]
    return [
      { symbol: slot.symbol, beats: slot.beats - plan.each * plan.chords.length },
      ...plan.chords.map((symbol) => ({ symbol, beats: plan.each })),
    ]
  })
}
