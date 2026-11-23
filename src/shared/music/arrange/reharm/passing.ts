import { mod12, spell } from '../theory'
import { approach, type ReharmStrategy } from './types'

/** Diminished sevenths that fill the gap between roots: C | Dm becomes C C#dim7 | Dm. */
export const passingDiminished: ReharmStrategy = {
  name: 'passing_diminished',
  summary: 'Slip a diminished seventh between chords: between roots a whole step apart, otherwise a half step under the next chord (C, C sharp diminished, D minor).',
  defaultAmount: 0.5,
  apply(slots, ctx) {
    return approach(slots, ctx, (target, prev) => {
      const step = mod12(target.rootPc - prev.rootPc)
      if (step === 0 || step === 1 || step === 11) return null
      if (step === 2) return [`${spell(prev.rootPc + 1, ctx.key, 'sharp')}dim7`]
      if (step === 10) return [`${spell(prev.rootPc - 1, ctx.key, 'flat')}dim7`]
      return [`${spell(target.rootPc - 1, ctx.key, 'sharp')}dim7`]
    })
  },
}

/** Side-slip: the target chord itself, a half step away, just before it lands. */
export const chromaticApproach: ReharmStrategy = {
  name: 'chromatic_approach',
  summary: 'Approach chords from a half step above or below with the same chord shape (E flat minor seven sliding into D minor seven).',
  defaultAmount: 0.5,
  apply(slots, ctx) {
    return approach(slots, ctx, (target, prev) => {
      if (target.rootPc === prev.rootPc) return null
      const above = ctx.rng.chance(0.6)
      const root = above ? spell(target.rootPc + 1, ctx.key, 'flat') : spell(target.rootPc - 1, ctx.key, 'sharp')
      return [root + target.suffix]
    })
  },
}
