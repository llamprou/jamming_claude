import { degreeOf, inKey, isChord, mod12, type ChordInfo, type KeySpec } from '../theory'
import { substitute, type ReharmStrategy } from './types'

/** The seventh-chord suffix a plain triad would naturally take in this key. */
function seventhSuffix(c: ChordInfo, key: KeySpec): string {
  if (c.hasSeventh) return c.suffix
  const degree = degreeOf(c.rootPc, key)
  if (c.kind === 'maj') {
    // Major triads on these degrees are dominants (primary or secondary) rather than resting chords.
    const dominants = key.mode === 'major' ? [7, 2, 4, 9, 11] : [7, 10, 2]
    return dominants.includes(degree) ? '7' : 'maj7'
  }
  if (c.kind === 'min') return 'm7'
  if (c.kind === 'dim') return degree === (key.mode === 'major' ? 11 : 2) ? 'm7b5' : 'dim7'
  return c.suffix
}

const keepBass = (c: ChordInfo, symbol: string): string => (c.bass && isChord(`${symbol}/${c.bass}`) ? `${symbol}/${c.bass}` : symbol)

/** Triads become seventh chords that fit the key: C -> Cmaj7, G -> G7, Am -> Am7. */
export const sevenths: ReharmStrategy = {
  name: 'sevenths',
  summary: 'Turn plain triads into the seventh chords that fit the key (C major seven, G seven, A minor seven).',
  defaultAmount: 1,
  apply(slots, ctx) {
    return substitute(slots, ctx, (c) => (c.hasSeventh ? null : keepBass(c, c.root + seventhSuffix(c, ctx.key))))
  },
}

/** Richer colours: ninths, thirteenths, six-nines, flat nines on dominants heading to minor chords. */
export const colour: ReharmStrategy = {
  name: 'colour',
  summary: 'Add colour tones: ninths, six-nines, thirteenths, and flat nines on dominants that resolve to minor chords.',
  defaultAmount: 1,
  apply(slots, ctx) {
    return substitute(slots, ctx, (c, at) => {
      // Already carries a ninth or more: leave the player's (or an earlier pass's) choice alone.
      if (c.semitones.some((s) => s >= 13)) return null
      const base = seventhSuffix(c, ctx.key)
      const kind = c.kind === 'maj' && base === '7' ? 'dom' : c.kind
      const ninth = inKey(c.rootPc + 2, ctx.key)
      let suffix: string | null = null
      if (kind === 'maj') suffix = !ninth ? base : base === '6' || ctx.rng.chance(0.3) ? '69' : 'maj9'
      else if (kind === 'dom') {
        const toMinor = at.next?.kind === 'min' && mod12(at.next.rootPc - c.rootPc) === 5
        suffix = toMinor || !ninth ? '7b9' : inKey(c.rootPc + 9, ctx.key) && ctx.rng.chance(0.4) ? '13' : '9'
      } else if (kind === 'min') suffix = !ninth ? base : base === 'm6' ? 'm69' : 'm9'
      else if (kind === 'dim') suffix = base
      return suffix === null ? null : keepBass(c, c.root + suffix)
    })
  },
}

/** Back to basics: strip everything to triads. */
export const simplify: ReharmStrategy = {
  name: 'simplify',
  summary: 'Strip chords back to plain triads.',
  defaultAmount: 1,
  apply(slots, ctx) {
    return substitute(slots, ctx, (c) => {
      const suffix = { maj: '', dom: '', min: 'm', hdim: 'dim', dim: 'dim', aug: 'aug', sus: c.semitones.includes(5) ? 'sus4' : 'sus2', other: c.suffix }[c.kind]
      return c.root + suffix
    })
  },
}
