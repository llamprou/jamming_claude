import { mergeSlots, type ChordSlot } from '../progression'
import { makeRng } from '../rng'
import { guessKey, isChord, type KeySpec } from '../theory'
import { backdoor } from './backdoor'
import { diatonicSub } from './diatonic'
import { colour, sevenths, simplify } from './extensions'
import { modalInterchange } from './modal'
import { chromaticApproach, passingDiminished } from './passing'
import { secondaryDominants } from './secondary'
import { tritoneSub } from './tritone'
import { twoFive } from './twoFive'
import type { ReharmStrategy } from './types'

export type { ReharmContext, ReharmStrategy } from './types'

/** Every reharmonization strategy. To add one: write it in this folder and list it here. */
export const STRATEGIES: ReharmStrategy[] = [
  sevenths,
  colour,
  secondaryDominants,
  twoFive,
  tritoneSub,
  backdoor,
  diatonicSub,
  modalInterchange,
  passingDiminished,
  chromaticApproach,
  simplify,
]

export const strategyNames = (): string[] => STRATEGIES.map((s) => s.name)

export interface ReharmOptions {
  /** Guessed from the chords when omitted. */
  key?: KeySpec
  seed?: number
  /** 0-1; each strategy has its own default. */
  amount?: number
}

export interface ReharmResult {
  strategy: string
  slots: ChordSlot[]
  changed: boolean
}

/** Apply one named strategy. The result lasts exactly as many beats as the input. */
export function reharmonize(slots: ChordSlot[], strategy: string, options: ReharmOptions = {}): ReharmResult {
  const found = STRATEGIES.find((s) => s.name === strategy)
  if (!found) throw new Error(`Unknown reharmonization strategy "${strategy}". Known: ${strategyNames().join(', ')}`)
  const input = mergeSlots(slots)
  const key = options.key ?? guessKey(input.map((s) => s.symbol))
  const amount = Math.min(1, Math.max(0, options.amount ?? found.defaultAmount))
  const applied = found.apply(input, { key, amount, rng: makeRng(options.seed ?? 1, `reharm:${found.name}`) })
  // A strategy must never hand back something the player can't hear: fall back to the bare root.
  const safe = applied.map((s) => (isChord(s.symbol) ? s : { ...s, symbol: /^[A-G][#b]?/.exec(s.symbol)?.[0] ?? 'C' }))
  const out = mergeSlots(safe)
  const same = out.length === input.length && out.every((s, i) => s.symbol === input[i]!.symbol && s.beats === input[i]!.beats)
  return { strategy: found.name, slots: out, changed: !same }
}
