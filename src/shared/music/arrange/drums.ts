import type { ClipTrack } from '../types'
import { makeRng, type Rng } from './rng'

export const DRUM_STYLES = ['rock', 'funk', 'swing', 'bossa', 'half_time', 'four_on_the_floor'] as const
export type DrumStyle = (typeof DRUM_STYLES)[number]

/** General MIDI percussion keys. */
export const GM = {
  kick: 36,
  rim: 37,
  snare: 38,
  clap: 39,
  closedHat: 42,
  pedalHat: 44,
  openHat: 46,
  ride: 51,
  crash: 49,
  highTom: 50,
  midTom: 47,
  lowTom: 45,
  floorTom: 43,
} as const

export interface DrumOptions {
  style: DrumStyle
  /** 0 (sparse, quiet) to 1 (busy, loud). Default 0.6. */
  intensity?: number
  /** Play a fill at the end of every this many bars; 0 for none. Default 4. */
  fillEvery?: number
  seed?: number
  beatsPerBar?: number
}

type Note = ClipTrack['notes'][number]

/**
 * A lane is one drum's bar written on a grid: 16 steps for straight feels, 12
 * (triplets) for swing. `X` accent, `x` normal, `o` ghost, `.` rest.
 */
type Lane = [pitch: number, pattern: string]
type Kit = (level: 0 | 1 | 2, bar: number, rng: Rng) => Lane[]

const KITS: Record<DrumStyle, Kit> = {
  rock: (level) => [
    [GM.kick, ['X.......x.......', 'X.......x.x.....', 'X..x....x.x.....'][level]!],
    [GM.snare, '....X.......X...'],
    [GM.closedHat, ['x...x...x...x...', 'X.x.X.x.X.x.X.x.', 'X.x.X.x.X.x.X...'][level]!],
    [GM.openHat, level === 2 ? '..............x.' : ''],
  ],
  funk: (level) => [
    [GM.kick, ['X.........x.....', 'X..x......x..x..', 'X..x..x...x..x..'][level]!],
    [GM.snare, ['....X.......X...', '....X..o.o..X...', '....X..o.o..X..o'][level]!],
    [GM.closedHat, ['X.x.X.x.X.x.X.x.', 'XxxxXxxxXxxxXxxx', 'XxxxXxxxXxxxXx.x'][level]!],
    [GM.openHat, level === 2 ? '..............x.' : ''],
  ],
  swing: (level, _bar, rng) => {
    // Comping on the snare: a soft note or two on the last triplet of a beat, different every bar.
    const comp = '............'.split('')
    if (level > 0) for (const step of [2, 5, 8, 11]) if (rng.chance(level === 2 ? 0.35 : 0.2)) comp[step] = 'o'
    return [
      [GM.ride, 'x..X.xx..X.x'],
      [GM.pedalHat, '...x.....x..'],
      [GM.kick, level === 0 ? 'o...........' : 'o..o..o..o..'],
      [GM.snare, comp.join('')],
    ]
  },
  bossa: (level, bar) => [
    [GM.kick, 'x.....x.x.....x.'],
    [GM.closedHat, level === 2 ? 'xoxoxoxoxoxoxoxo' : 'x.x.x.x.x.x.x.x.'],
    // The two-bar bossa clave on the rim.
    [GM.rim, bar % 2 === 0 ? 'x.....x.....x...' : '....x.....x.....'],
  ],
  half_time: (level) => [
    [GM.kick, ['X...............', 'X.........x.....', 'X.....x...x.....'][level]!],
    [GM.snare, level === 2 ? '.......oX......o' : '........X.......'],
    [GM.closedHat, level === 0 ? 'x...x...x...x...' : 'X.x.X.x.X.x.X.x.'],
  ],
  four_on_the_floor: (level) => [
    [GM.kick, 'X...X...X...X...'],
    [level === 2 ? GM.clap : GM.snare, level === 0 ? '' : '....X.......X...'],
    [GM.closedHat, level === 2 ? 'xx.xxx.xxx.xxx.x' : level === 0 ? '..x...x...x...x.' : ''],
    [GM.openHat, level === 0 ? '' : '..x...x...x...x.'],
  ],
}

const LEVELS: Record<string, number> = { X: 0.95, x: 0.75, o: 0.3 }
const TIMEKEEPERS: number[] = [GM.closedHat, GM.openHat, GM.pedalHat, GM.ride, GM.rim]
const CYMBALS: number[] = [GM.closedHat, GM.openHat, GM.ride]
const HANDS: number[] = [GM.snare, GM.clap, GM.closedHat, GM.openHat, GM.ride, GM.rim]

/** A run round the kit ending just before the next downbeat. Times are beats from the start of the fill. */
function fill(length: number, triplets: boolean, loud: number, rng: Rng): Note[] {
  const step = triplets ? 1 / 3 : 0.25
  const count = Math.round(length / step)
  const shape = rng.int(3)
  const toms = [GM.highTom, GM.midTom, GM.lowTom, GM.floorTom]
  const out: Note[] = []
  for (let i = 0; i < count; i++) {
    const progress = i / count
    let pitch: number = GM.snare
    // 0: snare roll into toms. 1: down the toms. 2: snare with a tom answer on the last beat.
    if (shape === 0 && progress >= 0.5) pitch = toms[Math.min(3, Math.floor((progress - 0.5) * 8))]!
    if (shape === 1) pitch = toms[Math.min(3, Math.floor(progress * 4))]!
    if (shape === 2 && progress >= 0.75) pitch = toms[progress >= 0.875 ? 3 : 1]!
    // Leave a little air in the busier shapes rather than a machine-gun of sixteenths.
    if (shape === 2 && !triplets && i % 4 === 1) continue
    out.push({ pitch, startBeat: i * step, durationBeats: step * 0.9, velocity: (0.55 + 0.4 * progress) * loud + rng.jitter(0.03) })
  }
  return out
}

/** A drum part of `beats` beats on a 'drums' track. Same options and seed give the same part. */
export function generateDrums(beats: number, options: DrumOptions): ClipTrack {
  const { style, seed = 1, beatsPerBar = 4 } = options
  const intensity = Math.min(1, Math.max(0, options.intensity ?? 0.6))
  const fillEvery = Math.max(0, Math.round(options.fillEvery ?? 4))
  const rng = makeRng(seed, `drums:${style}`)
  const level = intensity < 0.34 ? 0 : intensity < 0.67 ? 1 : 2
  const loud = 0.6 + 0.4 * intensity
  const triplets = style === 'swing'
  const stepsPerBeat = triplets ? 3 : 4
  const bars = Math.ceil(beats / beatsPerBar - 1e-6)
  const notes: Note[] = []
  let crashNext = fillEvery > 0 && intensity >= 0.5 && bars > 1

  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * beatsPerBar
    const barBeats = Math.min(beatsPerBar, beats - barStart)
    const lastOfPhrase = fillEvery > 0 && bars > 1 && ((bar + 1) % fillEvery === 0 || (bar === bars - 1 && bars < fillEvery))
    const fillBeats = lastOfPhrase ? Math.min(intensity >= 0.5 ? 2 : 1, Math.floor(barBeats / 2)) : 0
    const fillFrom = barBeats - fillBeats

    // A crash marks the top of a new phrase (not in bossa, where it would be out of character).
    const crash = crashNext && style !== 'bossa'
    if (crash) notes.push({ pitch: GM.crash, startBeat: barStart, durationBeats: 1, velocity: Math.min(1, 0.85 * loud) })
    for (const [pitch, pattern] of KITS[style](level, bar, rng)) {
      if (!pattern) continue
      const steps = Math.round(barBeats * stepsPerBeat)
      for (let i = 0; i < steps; i++) {
        const mark = pattern[i % pattern.length]!
        const base = LEVELS[mark]
        if (base === undefined) continue
        const at = i / stepsPerBeat
        if (fillBeats > 0 && at >= fillFrom - 1e-6 && HANDS.includes(pitch)) continue
        // The crash takes the place of whatever was keeping time on the downbeat.
        if (crash && i === 0 && CYMBALS.includes(pitch)) continue
        const quiet = TIMEKEEPERS.includes(pitch) ? 0.8 : 1
        notes.push({
          pitch,
          startBeat: barStart + at,
          durationBeats: pitch === GM.openHat ? 0.5 : 0.25,
          velocity: Math.min(1, Math.max(0.08, base * loud * quiet + (mark === 'o' ? 0 : rng.jitter(0.04)))),
        })
      }
    }
    crashNext = false
    if (fillBeats > 0) {
      for (const n of fill(fillBeats, triplets, style === 'bossa' || style === 'swing' ? loud * 0.8 : loud, rng)) {
        notes.push({ ...n, startBeat: barStart + fillFrom + n.startBeat, velocity: Math.min(1, Math.max(0.08, n.velocity)) })
      }
      crashNext = intensity >= 0.34
    }
  }
  notes.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
  return { role: 'drums', program: 0, notes }
}
