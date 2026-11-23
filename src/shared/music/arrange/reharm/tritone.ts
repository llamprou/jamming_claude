import { degreeOf, mod12, spell, type ChordInfo } from '../theory'
import { substitute, type ReharmStrategy } from './types'

/** Swap a dominant for the dominant a tritone away: G7 -> Db7, sliding down a half step into the target. */
export const tritoneSub: ReharmStrategy = {
  name: 'tritone_sub',
  summary: 'Replace dominant chords with the dominant a tritone away, so the bass slides down by half step (G7 becomes Db7).',
  defaultAmount: 1,
  apply(slots, ctx) {
    const dominant = (c: ChordInfo) => c.kind === 'dom' || (c.kind === 'maj' && !c.hasSeventh && degreeOf(c.rootPc, ctx.key) === 7)
    const resolves = (c: ChordInfo, next: ChordInfo | null) => !!next && mod12(next.rootPc - c.rootPc) === 5
    // Where a dominant resolves down a fifth the swap is at its smoothest; only fall back to the others if none does.
    let anyResolve = false
    substitute(slots, ctx, (c, at) => {
      if (dominant(c) && resolves(c, at.next)) anyResolve = true
      return null
    })
    return substitute(slots, ctx, (c, at) => {
      if (!dominant(c) || (anyResolve && !resolves(c, at.next))) return null
      return spell(c.rootPc + 6, ctx.key, 'flat') + (['9', '13'].includes(c.suffix) ? c.suffix : '7')
    })
  },
}
