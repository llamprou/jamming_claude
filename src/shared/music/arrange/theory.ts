import { Chord, Interval, Key, Note } from 'tonal'

/**
 * The bits of harmony the arranger needs: what a chord symbol is made of,
 * where it sits in a key, and how to spell a new one so `chordPitches` can
 * voice it.
 */

export type Mode = 'major' | 'minor'
export interface KeySpec {
  tonic: string
  mode: Mode
}

export type ChordKind = 'maj' | 'dom' | 'min' | 'hdim' | 'dim' | 'sus' | 'aug' | 'other'

export interface ChordInfo {
  symbol: string
  root: string
  rootPc: number
  /** Everything after the root, without any slash bass: "m7", "maj9", "". */
  suffix: string
  kind: ChordKind
  /** True when the chord has a sixth, seventh or any extension. */
  hasSeventh: boolean
  bass: string | null
  /** Chord tones as semitones above the root, in stacking order (a ninth is 14). */
  semitones: number[]
}

const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
const NOTE = /^[A-G](?:#{1,2}|b{1,2})?$/

export const mod12 = (n: number): number => ((n % 12) + 12) % 12
export const pcOf = (name: string): number => Note.chroma(name) ?? 0

export function parseChord(symbol: string): ChordInfo | null {
  const trimmed = symbol.trim()
  const slash = trimmed.lastIndexOf('/')
  const hasBass = slash > 0 && NOTE.test(trimmed.slice(slash + 1))
  const body = hasBass ? trimmed.slice(0, slash) : trimmed
  const match = /^([A-G](?:#{1,2}|b{1,2})?)(.*)$/.exec(body)
  if (!match) return null
  const root = match[1]!
  const suffix = match[2] === 'M' ? '' : match[2]!
  const chord = Chord.get(root + suffix)
  if (chord.empty || !chord.tonic) return null
  const semitones = chord.intervals.map((i) => Interval.semitones(i) ?? 0)
  const has = (n: number) => semitones.includes(n)
  let kind: ChordKind = 'other'
  if (has(4)) kind = has(10) ? 'dom' : has(8) && !has(7) ? 'aug' : 'maj'
  else if (has(3)) kind = has(6) && !has(7) ? (has(10) ? 'hdim' : 'dim') : 'min'
  else if (has(5) || has(2)) kind = 'sus'
  return {
    symbol: trimmed,
    root,
    rootPc: pcOf(root),
    suffix,
    kind,
    hasSeventh: semitones.some((s) => s >= 9),
    bass: hasBass ? trimmed.slice(slash + 1) : null,
    semitones,
  }
}

/** True when `chordPitches` (render.ts) will be able to voice the symbol. */
export function isChord(symbol: string): boolean {
  const chord = Chord.get(symbol)
  return !chord.empty && !!chord.tonic && chord.notes.length > 0
}

/** Tidy a symbol from chord detection ("CM" -> "C"); null if it is not a chord. */
export function normalizeSymbol(symbol: string): string | null {
  const info = parseChord(symbol)
  if (!info) return null
  const plain = info.root + info.suffix
  const withBass = info.bass && pcOf(info.bass) !== info.rootPc ? `${plain}/${info.bass}` : plain
  return isChord(withBass) ? withBass : isChord(plain) ? plain : null
}

/** "C", "C major", "Am", "a minor", "F# min", "B flat". */
export function parseKey(text: string): KeySpec | null {
  const match = /^\s*([A-Ga-g])\s*(#|b|sharp|flat)?\s*(.*)$/.exec(text)
  if (!match) return null
  const accidental = { '#': '#', b: 'b', sharp: '#', flat: 'b' }[match[2] ?? ''] ?? ''
  const rest = match[3]!.trim()
  const minor = rest === 'm' || rest === '-' || /^(min|minor)$/i.test(rest)
  if (rest && !minor && rest !== 'M' && !/^(maj|major)$/i.test(rest)) return null
  return { tonic: match[1]!.toUpperCase() + accidental, mode: minor ? 'minor' : 'major' }
}

export const keyName = (key: KeySpec): string => `${key.tonic} ${key.mode}`

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10]

/** Semitones above the tonic, 0-11. */
export const degreeOf = (pc: number, key: KeySpec): number => mod12(pc - pcOf(key.tonic))
export const inKey = (pc: number, key: KeySpec): boolean =>
  (key.mode === 'major' ? MAJOR_STEPS : MINOR_STEPS).includes(degreeOf(pc, key))

function scaleNames(key: KeySpec): readonly string[] {
  return key.mode === 'major' ? Key.majorKey(key.tonic).scale : Key.minorKey(key.tonic).natural.scale
}

/**
 * Name a pitch class the way the key would: scale notes get the key's own
 * spelling, chromatic ones follow `prefer`, or else the commonest spelling.
 */
export function spell(pc: number, key: KeySpec, prefer?: 'flat' | 'sharp'): string {
  const target = mod12(pc)
  const names = scaleNames(key)
  const own = names.find((n) => pcOf(n) === target)
  // E#, Cb and double accidentals are correct but awkward to read and to say.
  if (own && own.length <= 2 && !['E#', 'B#', 'Cb', 'Fb'].includes(own)) return own
  // Chromatic notes are usually lowered ones (flat two, three, six, seven); the raised fourth of a major key
  // and the major third, sixth and seventh over a minor tonic are the ones written with sharps.
  const raised = key.mode === 'major' ? [6] : [4, 9, 11]
  const side = prefer ?? (raised.includes(degreeOf(target, key)) ? 'sharp' : 'flat')
  return (side === 'sharp' ? SHARP : FLAT)[target]!
}

const DIATONIC: Record<Mode, Record<number, [triad: string, seventh: string]>> = {
  major: { 0: ['', 'maj7'], 2: ['m', 'm7'], 4: ['m', 'm7'], 5: ['', 'maj7'], 7: ['', '7'], 9: ['m', 'm7'], 11: ['dim', 'm7b5'] },
  // Natural minor, with the dominant borrowed from harmonic minor as players expect.
  minor: { 0: ['m', 'm7'], 2: ['dim', 'm7b5'], 3: ['', 'maj7'], 5: ['m', 'm7'], 7: ['', '7'], 8: ['', 'maj7'], 10: ['', '7'] },
}

/** The key's own chord on a degree (semitones above the tonic), or null if the degree is chromatic. */
export function diatonicChord(degree: number, key: KeySpec, seventh: boolean): string | null {
  const entry = DIATONIC[key.mode][mod12(degree)]
  if (!entry) return null
  return spell(pcOf(key.tonic) + degree, key) + entry[seventh ? 1 : 0]
}

const kindFamily = (kind: ChordKind): string => (kind === 'dom' ? 'maj' : kind === 'hdim' ? 'dim' : kind)

/** Pick the key a chord progression most plausibly sits in. */
export function guessKey(symbols: string[]): KeySpec {
  const chords = symbols.map(parseChord).filter((c): c is ChordInfo => c !== null)
  let best: KeySpec = { tonic: chords[0]?.root ?? 'C', mode: chords[0]?.kind === 'min' ? 'minor' : 'major' }
  let bestScore = -Infinity
  for (const mode of ['major', 'minor'] as const) {
    for (let pc = 0; pc < 12; pc++) {
      const key: KeySpec = { tonic: FLAT[pc]!, mode }
      const tonicKind = mode === 'major' ? 'maj' : 'min'
      let score = 0
      chords.forEach((chord, i) => {
        const degree = degreeOf(chord.rootPc, key)
        const own = DIATONIC[mode][degree]
        if (own) {
          const ownKind = parseChord(`C${own[0]}`)!.kind
          score += kindFamily(chord.kind) === kindFamily(ownKind) ? 1 : 0.25
        }
        if (degree === 7 && chord.kind === 'dom') score += 0.5
        // A dominant seventh on the first degree is a blues colour or a chord on its way somewhere, not home.
        const home = degree === 0 && chord.kind === tonicKind
        if (home && i === 0) score += 0.75
        if (home && i === chords.length - 1) score += 0.5
      })
      if (score > bestScore + 1e-9) {
        bestScore = score
        best = key
      }
    }
  }
  // Prefer the usual spelling of the key (F# minor rather than Gb minor).
  const pc = pcOf(best.tonic)
  const sharpMinor = best.mode === 'minor' && [1, 6, 8].includes(pc)
  return { tonic: sharpMinor ? SHARP[pc]! : best.tonic, mode: best.mode }
}

/** Move a chord symbol by semitones, spelling the new root for `key` (the key after the move). */
export function transposeSymbol(symbol: string, semitones: number, key: KeySpec): string {
  const info = parseChord(symbol)
  if (!info) return symbol
  const moved = spell(info.rootPc + semitones, key) + info.suffix
  if (!info.bass) return moved
  const withBass = `${moved}/${spell(pcOf(info.bass) + semitones, key)}`
  return isChord(withBass) ? withBass : moved
}

export function transposeKey(key: KeySpec, semitones: number): KeySpec {
  const pc = mod12(pcOf(key.tonic) + semitones)
  const sharp = key.mode === 'minor' ? [1, 6, 8].includes(pc) : pc === 6
  return { tonic: (sharp ? SHARP : FLAT)[pc]!, mode: key.mode }
}
