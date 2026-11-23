import { mod12, spell } from '../theory'
import { approach, type ReharmStrategy } from './types'

/** Approach chords with a two-five of their own: into Fmaj7 that is Gm7 C7; into Dm it is Em7b5 A7b9. */
export const twoFive: ReharmStrategy = {
  name: 'two_five',
  summary: 'Approach chords with their own two-five (Gm7 C7 into F); a minor target gets the minor two-five. Falls back to just the five when there is only room for one chord.',
  defaultAmount: 0.5,
  apply(slots, ctx) {
    return approach(slots, ctx, (target, prev) => {
      if (target.kind === 'dim' || target.kind === 'hdim') return null
      const minor = target.kind === 'min'
      const two = mod12(target.rootPc + 2)
      const five = mod12(target.rootPc + 7)
      if (prev.rootPc === five && prev.kind === 'dom') return null
      const fiveChord = spell(five, ctx.key) + (minor ? '7b9' : '7')
      // Already sitting on the two: only the five is missing.
      if (prev.rootPc === two && (prev.kind === 'min' || prev.kind === 'hdim')) return [fiveChord]
      return [spell(two, ctx.key) + (minor ? 'm7b5' : 'm7'), fiveChord]
    })
  },
}
