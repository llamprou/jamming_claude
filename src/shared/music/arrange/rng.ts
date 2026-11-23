/** Small seeded random source so generated parts are repeatable: same seed, same notes. */
export interface Rng {
  /** 0 <= x < 1 */
  next(): number
  /** Integer in 0..n-1 */
  int(n: number): number
  pick<T>(items: readonly T[]): T
  chance(probability: number): boolean
  /** Symmetric noise in -amount..amount, e.g. for velocities. */
  jitter(amount: number): number
}

function hash(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** `salt` keeps independent parts (bass, drums, ...) from sharing one random stream. */
export function makeRng(seed = 1, salt = ''): Rng {
  let state = hash(salt, seed) || 1
  const next = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (p) => next() < p,
    jitter: (amount) => (next() * 2 - 1) * amount,
  }
}
