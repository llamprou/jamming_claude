/** Exact fractions, used for note positions and lengths (in whole notes). */
export interface Fraction {
  n: number
  d: number
}

const gcd = (a: number, b: number): number => {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) [a, b] = [b, a % b]
  return a || 1
}

export function frac(n: number, d = 1): Fraction {
  if (d < 0) {
    n = -n
    d = -d
  }
  const g = gcd(n, d)
  return { n: n / g, d: d / g }
}

export const ZERO: Fraction = { n: 0, d: 1 }
export const add = (a: Fraction, b: Fraction): Fraction => frac(a.n * b.d + b.n * a.d, a.d * b.d)
export const sub = (a: Fraction, b: Fraction): Fraction => frac(a.n * b.d - b.n * a.d, a.d * b.d)
export const mul = (a: Fraction, b: Fraction): Fraction => frac(a.n * b.n, a.d * b.d)
export const div = (a: Fraction, b: Fraction): Fraction => frac(a.n * b.d, a.d * b.n)
export const cmp = (a: Fraction, b: Fraction): number => a.n * b.d - b.n * a.d
export const eq = (a: Fraction, b: Fraction): boolean => cmp(a, b) === 0
export const toNumber = (a: Fraction): number => a.n / a.d
export const fracText = (a: Fraction): string => (a.d === 1 ? `${a.n}` : `${a.n}/${a.d}`)
