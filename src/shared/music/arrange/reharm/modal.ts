import { degreeOf, pcOf, spell } from '../theory'
import { substitute, type ReharmStrategy } from './types'

/** Borrow chords from the parallel key: in C major, Fm for F, Ab for Am, Bb for G. */
export const modalInterchange: ReharmStrategy = {
  name: 'modal_interchange',
  summary: 'Borrow chords from the parallel minor or major (in C: F minor for F, A flat for A minor, B flat for G). Darker or brighter without leaving home.',
  defaultAmount: 0.5,
  apply(slots, ctx) {
    const tonic = pcOf(ctx.key.tonic)
    const flat = (degree: number) => spell(tonic + degree, ctx.key, 'flat')
    return substitute(slots, ctx, (c, at) => {
      const degree = degreeOf(c.rootPc, ctx.key)
      const seventh = c.hasSeventh
      const majorish = c.kind === 'maj' || c.kind === 'dom'
      if (ctx.key.mode === 'major') {
        if (degree === 5 && c.kind === 'maj') return c.root + (seventh ? 'm7' : 'm')
        if (degree === 2 && c.kind === 'min') return `${c.root}m7b5`
        if (degree === 9 && c.kind === 'min') return flat(8) + (seventh ? 'maj7' : '')
        if (degree === 4 && c.kind === 'min') return flat(3) + (seventh ? 'maj7' : '')
        if ((degree === 7 && majorish) || degree === 11) return flat(10) + (seventh ? '7' : '')
        return null
      }
      if (degree === 5 && c.kind === 'min') return c.root + (seventh ? '7' : '')
      if (degree === 7 && c.kind === 'min') return `${c.root}7`
      if (degree === 2 && (c.kind === 'dim' || c.kind === 'hdim')) return `${c.root}m7`
      // Picardy third: a minor tune that ends on its major tonic.
      if (degree === 0 && c.kind === 'min' && at.index === at.count - 1 && at.count > 1) return c.root + (seventh ? 'maj7' : '')
      return null
    })
  },
}
