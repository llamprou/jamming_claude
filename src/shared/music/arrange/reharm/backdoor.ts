import { mod12, spell } from '../theory'
import { substitute, type ReharmStrategy } from './types'

/** The backdoor dominant: reach a major chord from the dominant a whole step below it (Bb7 -> C instead of G7 -> C). */
export const backdoor: ReharmStrategy = {
  name: 'backdoor',
  summary: 'Replace a dominant that resolves to a major chord with the dominant a whole step below the target (B flat seven into C). Warm, bluesy.',
  defaultAmount: 1,
  apply(slots, ctx) {
    return substitute(slots, ctx, (c, at) => {
      if (c.kind !== 'dom' || !at.next || at.next.kind !== 'maj') return null
      if (mod12(at.next.rootPc - c.rootPc) !== 5) return null
      return `${spell(at.next.rootPc - 2, ctx.key, 'flat')}7`
    })
  },
}
