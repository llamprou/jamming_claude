import { degreeOf, diatonicChord, mod12, pcOf, type Mode } from '../theory'
import { substitute, type ReharmStrategy } from './types'

/**
 * Chords a third apart share two notes and can stand in for each other.
 * Degree (semitones above the tonic) -> degrees that can replace it, best first.
 */
const RELATIVES: Record<Mode, Record<number, number[]>> = {
  major: { 0: [9, 4], 2: [5], 4: [0, 7], 5: [2, 9], 7: [4, 11], 9: [5, 0], 11: [7] },
  minor: { 0: [8, 3], 2: [5], 3: [0, 10], 5: [2, 8], 7: [10], 8: [5, 0], 10: [3, 5] },
}

/** Swap chords for their relatives in the key: C for Am, F for Dm. The first chord stays as the anchor. */
export const diatonicSub: ReharmStrategy = {
  name: 'diatonic_sub',
  summary: 'Swap chords for a relative in the same key that shares two of their notes (Am for C, Dm for F). Gentle; keeps the first chord.',
  defaultAmount: 0.5,
  apply(slots, ctx) {
    return substitute(slots, ctx, (chord, at) => {
      if (at.index === 0) return null
      // A closing tonic is the point of arrival; leave it unless there is little else to change.
      if (at.index === at.count - 1 && at.count > 3 && degreeOf(chord.rootPc, ctx.key) === 0) return null
      const options = RELATIVES[ctx.key.mode][degreeOf(chord.rootPc, ctx.key)]
      if (!options || chord.bass) return null
      const tonic = pcOf(ctx.key.tonic)
      // Don't land on the same root as a neighbour: that removes a chord change instead of colouring one.
      const taken = [at.prev?.rootPc, at.next?.rootPc]
      const degree = options.find((d) => !taken.includes(mod12(tonic + d)))
      return degree === undefined ? null : diatonicChord(degree, ctx.key, chord.hasSeventh)
    })
  },
}
