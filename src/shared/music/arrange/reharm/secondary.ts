import { mod12, spell } from '../theory'
import { approach, type ReharmStrategy } from './types'

/** Put each chord's own dominant in front of it: C | Am becomes C E7 | Am. */
export const secondaryDominants: ReharmStrategy = {
  name: 'secondary_dominants',
  summary: "Lead into chords with their own dominant seventh, taking the time from the chord before (E7 before Am).",
  defaultAmount: 0.5,
  apply(slots, ctx) {
    return approach(slots, ctx, (target, prev) => {
      if (target.kind === 'dim' || target.kind === 'hdim') return null
      const fifth = mod12(target.rootPc + 7)
      if (prev.rootPc === fifth && prev.kind === 'dom') return null
      return [`${spell(fifth, ctx.key)}7`]
    })
  },
}
