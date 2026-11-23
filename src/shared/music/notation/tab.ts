import type { Key } from './key'
import type { MeterEstimate } from './meter'
import type { Fraction } from './rational'
import type { Score, ScoreEvent } from './score'

/**
 * Tablature. String and fret choices are made for the whole phrase at once
 * (dynamic programming over hand positions), simultaneous notes are placed as
 * playable shapes, and the result keeps the score's bars and rhythm so it can
 * be drawn as a staff or exported as text.
 */

/** Open-string MIDI pitches, lowest string first. */
export const TAB_TUNINGS: Record<string, number[]> = {
  guitar: [40, 45, 50, 55, 59, 64],
  bass: [28, 33, 38, 43],
  'drop-d': [38, 45, 50, 55, 59, 64],
  dadgad: [38, 45, 50, 55, 57, 62],
  'open-g': [38, 43, 50, 55, 59, 62],
  'bass-5': [23, 28, 33, 38, 43],
}

export interface TabOptions {
  instrument: 'guitar' | 'bass'
  /** Open-string pitches, lowest first. Standard tuning for the instrument if absent. */
  tuning?: number[]
  /** Capo fret. Fret numbers are then counted from the capo. */
  capo?: number
  /** Highest fret on the neck (counted from the nut). */
  maxFret?: number
  /** Where the player's fretting hand is (index-finger fret), e.g. from video. Positions near it are preferred. */
  hand?: { fret: number; weight?: number }
}

export interface TabPosition {
  /** 0 = lowest string. */
  string: number
  /** Counted from the capo; 0 is the open (or capoed) string. */
  fret: number
  pitch: number
}

export interface TabShape {
  positions: TabPosition[]
  /** Fret of the index finger while this is played. */
  hand: number
  /** Name of the open-position chord shape this matches, if any (relative to the capo). */
  shape?: string
}

// Common open-position shapes, low string first, x = not played. They apply to standard-interval guitar tuning.
const OPEN_SHAPES: Record<string, string> = {
  C: 'x32010', A: 'x02220', G: '320003', E: '022100', D: 'xx0232', Am: 'x02210', Em: '022000', Dm: 'xx0231',
  E7: '020100', A7: 'x02020', D7: 'xx0212', G7: '320001', C7: 'x32310', B7: 'x21202', F: '133211', Fmaj7: 'xx3210',
  Cmaj7: 'x32000', Am7: 'x02010', Em7: '022030', Dm7: 'xx0211', Asus4: 'x02230', Dsus4: 'xx0233', Cadd9: 'x32030', G5: '320033',
}
const SHAPES = Object.entries(OPEN_SHAPES).map(([name, text]) => ({ name, frets: [...text].map((c) => (c === 'x' ? -1 : Number(c))) }))

/** Pitches of a common open-position guitar chord in standard tuning ("G" gives 320003), or null if it has no such shape. */
export function openShapePitches(symbol: string): number[] | null {
  const shape = SHAPES.find((s) => s.name === symbol.replace(/^([A-G][#b]?)M$/, '$1'))
  if (!shape) return null
  return shape.frets.flatMap((fret, string) => (fret < 0 ? [] : [TAB_TUNINGS.guitar![string]! + fret]))
}

interface State {
  positions: TabPosition[]
  /** null: only open strings, so the hand stays where it was. */
  hand: number | null
  cost: number
  shape?: string
}

interface Neck {
  open: number[]
  maxFret: number
  standard: boolean
}

function neckFor(opts: TabOptions): Neck & { capo: number; tuning: number[] } {
  const tuning = opts.tuning?.length ? [...opts.tuning].sort((a, b) => a - b) : TAB_TUNINGS[opts.instrument]!
  const capo = Math.max(0, Math.min(12, Math.round(opts.capo ?? 0)))
  const standard = tuning.length === 6 && tuning.every((p, i) => i === 0 || p - tuning[i - 1]! === [5, 5, 5, 4, 5][i - 1])
  return { tuning, capo, open: tuning.map((p) => p + capo), maxFret: (opts.maxFret ?? (opts.instrument === 'bass' ? 20 : 19)) - capo, standard }
}

/** Move a pitch by octaves until it is on the neck. */
function fit(pitch: number, neck: Neck): number {
  const low = neck.open[0]!
  const high = neck.open[neck.open.length - 1]! + neck.maxFret
  while (pitch < low) pitch += 12
  while (pitch > high) pitch -= 12
  return pitch
}

function singleStates(pitch: number, neck: Neck): State[] {
  const states: State[] = []
  neck.open.forEach((open, string) => {
    const fret = pitch - open
    if (fret < 0 || fret > neck.maxFret) return
    const positions = [{ string, fret, pitch }]
    if (fret === 0) states.push({ positions, hand: null, cost: -0.15 })
    else for (let hand = Math.max(1, fret - 3); hand <= fret; hand++) states.push({ positions, hand, cost: 0.04 * hand })
  })
  return states
}

function chordStates(pitches: number[], neck: Neck): State[] {
  const states: State[] = []
  const place = (i: number, fromString: number, positions: TabPosition[]): void => {
    if (i === pitches.length) {
      const fretted = positions.filter((p) => p.fret > 0).map((p) => p.fret)
      const opens = positions.length - fretted.length
      if (fretted.length === 0) {
        states.push({ positions: [...positions], hand: null, cost: -0.15 * opens })
        return
      }
      const hand = Math.min(...fretted)
      const span = Math.max(...fretted) - hand
      // One finger can bar everything at the lowest fret; each other note needs its own.
      const fingers = 1 + fretted.filter((f) => f > hand).length
      if (span > 4 || fingers > 4) return
      let cost = 0.04 * hand + 0.4 * span + (span === 4 ? 2.5 : 0) + (hand <= 4 ? -0.15 : 0.6) * opens
      let shape: string | undefined
      if (neck.standard && positions.length >= 3) {
        const match = SHAPES.find((s) => positions.every((p) => s.frets[p.string] === p.fret))
        if (match) {
          cost -= 3
          shape = match.name
        }
      }
      states.push({ positions: [...positions], hand, cost, shape })
      return
    }
    // Higher notes go on higher strings, as in every ordinary chord shape.
    for (let string = fromString; string < neck.open.length - (pitches.length - 1 - i); string++) {
      const fret = pitches[i]! - neck.open[string]!
      if (fret < 0 || fret > neck.maxFret) continue
      positions.push({ string, fret, pitch: pitches[i]! })
      place(i + 1, string + 1, positions)
      positions.pop()
    }
  }
  place(0, 0, [])
  return states.sort((a, b) => a.cost - b.cost).slice(0, 16)
}

function statesFor(group: number[], neck: Neck): State[] {
  let pitches = [...new Set(group.map((p) => fit(p, neck)))].sort((a, b) => a - b)
  while (pitches.length > 1) {
    const states = pitches.length <= neck.open.length ? chordStates(pitches, neck) : []
    if (states.length) return states
    // Unplayable as written: drop an inner note, keeping the bass and the top.
    pitches = pitches.filter((_, i) => i !== Math.floor(pitches.length / 2))
  }
  return pitches.length ? singleStates(pitches[0]!, neck) : []
}

/**
 * Choose strings and frets for a sequence of note groups (each group sounds
 * together). The whole sequence is optimised at once: the cost is hand
 * movement between groups plus stretch and position within each.
 */
export function arrangeTab(groups: number[][], opts: TabOptions): TabShape[] {
  const neck = neckFor(opts)
  const hint = opts.hand
  type Node = { state: State; hand: number; total: number; from: number }
  const layers: Node[][] = []
  for (const group of groups) {
    const previous = layers[layers.length - 1]
    const hands = previous ? [...new Set(previous.map((n) => n.hand))] : [hint ? Math.max(1, Math.round(hint.fret)) : 1]
    const nodes: Node[] = []
    for (const state of statesFor(group, neck)) {
      for (const hand of state.hand === null ? hands : [state.hand]) {
        // A seen hand position pulls notes towards it, and away from open strings it could have used instead.
        const opens = state.positions.filter((p) => p.fret === 0).length
        let total = state.cost + (hint ? (hint.weight ?? 0.6) * (Math.abs(hand - hint.fret) + (hint.fret >= 4 ? opens : 0)) : 0)
        let from = -1
        if (previous) {
          let best = Infinity
          previous.forEach((p, i) => {
            const shift = Math.abs(hand - p.hand)
            let move = shift === 0 ? 0 : 1.2 + 0.5 * shift
            if (state.positions.length === 1 && p.state.positions.length === 1) move += 0.1 * Math.max(0, Math.abs(state.positions[0]!.string - p.state.positions[0]!.string) - 1)
            if (p.total + move < best) {
              best = p.total + move
              from = i
            }
          })
          total += best
        }
        nodes.push({ state, hand, total, from })
      }
    }
    // A group with no playable note keeps the chain alive with an empty shape.
    if (nodes.length === 0) {
      const carry = previous?.reduce((a, b) => (b.total < a.total ? b : a))
      nodes.push({ state: { positions: [], hand: null, cost: 0 }, hand: carry?.hand ?? 1, total: carry?.total ?? 0, from: previous ? previous.indexOf(carry!) : -1 })
    }
    layers.push(nodes)
  }
  const out: TabShape[] = new Array(groups.length)
  let at = layers.length ? layers[layers.length - 1]!.reduce((best, n, i, all) => (n.total < all[best]!.total ? i : best), 0) : -1
  for (let i = layers.length - 1; i >= 0; i--) {
    const node = layers[i]![at]!
    out[i] = { positions: node.state.positions, hand: node.hand, ...(node.state.shape ? { shape: node.state.shape } : {}) }
    at = node.from
  }
  return out
}

/* ---------- tablature with rhythm ---------- */

export interface TabEvent extends ScoreEvent {
  positions: TabPosition[]
}

export interface Tablature {
  instrument: 'guitar' | 'bass'
  /** Open-string pitches without the capo, lowest first. */
  tuning: number[]
  capo: number
  /** One name per string, lowest first, e.g. E A D G B e. */
  stringNames: string[]
  key: Key
  meter: MeterEstimate
  barLength: Fraction
  bars: Array<{ number: number; events: TabEvent[]; chords: Array<{ at: Fraction; symbol: string }> }>
}

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

/** Lay a score's first staff out as tablature. Build the score with a single staff (staff: 'guitar' or 'bass-guitar'). */
export function scoreToTab(score: Score, opts: TabOptions): Tablature {
  const neck = neckFor(opts)
  const events = score.bars.flatMap((bar) => bar.voices[0] ?? [])
  const struck = events.filter((e) => e.pitches.length > 0 && !e.tied)
  const shapes = arrangeTab(struck.map((e) => e.pitches.map((p) => p.midi)), opts)
  const byEvent = new Map<ScoreEvent, TabPosition[]>()
  struck.forEach((e, i) => byEvent.set(e, shapes[i]!.positions))
  let held: TabPosition[] = []
  const names = neck.tuning.map((p) => NAMES[((p % 12) + 12) % 12]!)
  const top = names.length - 1
  if (names[top] === names[0]) names[top] = names[top]!.toLowerCase()
  return {
    instrument: opts.instrument,
    tuning: neck.tuning,
    capo: neck.capo,
    stringNames: names,
    key: score.key,
    meter: score.meter,
    barLength: score.barLength,
    bars: score.bars.map((bar) => ({
      number: bar.number,
      chords: bar.chords,
      events: (bar.voices[0] ?? []).map((e) => {
        if (e.pitches.length === 0) held = []
        else if (!e.tied || byEvent.has(e)) held = byEvent.get(e) ?? held
        return { ...e, positions: e.pitches.length ? held : [] }
      }),
    })),
  }
}


const ticks = (f: Fraction): number => Math.round((f.n * 48) / f.d)
const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function barsPerLine(tab: Tablature, wanted?: number): number {
  const busiest = Math.max(1, ...tab.bars.map((b) => b.events.length))
  return wanted ?? (busiest > 12 ? 2 : busiest > 7 ? 3 : 4)
}

/** Simple rest shapes for the rhythm row, centred on (x, y). */
function restSvg(event: ScoreEvent, x: number, y: number): string {
  const base = ticks(event.value) / (event.dots ? 1.5 : 1)
  const dot = event.dots ? `<circle cx="${x + 7}" cy="${y}" r="1.3"/>` : ''
  if (base >= 48) return `<rect x="${x - 5}" y="${y - 4}" width="10" height="4"/>${dot}`
  if (base >= 24) return `<rect x="${x - 5}" y="${y - 2}" width="10" height="4"/><line x1="${x - 8}" y1="${y + 2}" x2="${x + 8}" y2="${y + 2}" stroke-width="1"/>${dot}`
  if (base >= 12) return `<path d="M${x - 2} ${y - 8} l4 5 l-4 4 l4 5 q-5 -2 -3 3" fill="none" stroke-width="1.6"/>${dot}`
  const flags = base >= 6 ? 1 : 2
  let out = `<line x1="${x + 3}" y1="${y - 6}" x2="${x - 2}" y2="${y + 7}" stroke-width="1.3"/>`
  for (let i = 0; i < flags; i++) out += `<circle cx="${x - 3 - i}" cy="${y - 4 + i * 5}" r="1.8"/><line x1="${x - 3 - i}" y1="${y - 3.5 + i * 5}" x2="${x + 2.6 - i * 1.6}" y2="${y - 5.5 + i * 5}" stroke-width="1"/>`
  return out + dot
}

/**
 * Draw the tablature: string lines, bar lines, fret numbers placed by their
 * position in the bar, stems, beams, flags and dots underneath for the rhythm,
 * rests, ties, triplet marks and chord symbols above.
 */
export function tabToSvg(tab: Tablature, opts: { barsPerLine?: number; width?: number } = {}): string {
  const perLine = barsPerLine(tab, opts.barsPerLine)
  const strings = tab.stringNames.length
  const width = opts.width ?? 900
  const left = 52
  const right = 8
  const gap = 12
  const head = 30
  const staffHeight = (strings - 1) * gap
  const systemHeight = head + staffHeight + 52
  const systems = Math.ceil(tab.bars.length / perLine) || 1
  const labelHeight = tab.capo ? 16 : 0
  const height = systems * systemHeight + labelHeight + 6
  const barWidth = (width - left - right) / perLine
  const barTicks = ticks(tab.barLength)
  const ink = '#1b1b1b'
  const paper = '#fbfaf6'
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${tab.instrument} tablature" font-family="Helvetica, Arial, sans-serif" fill="${ink}" stroke="${ink}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${paper}" stroke="none"/>`,
  ]
  if (tab.capo) out.push(`<text x="${left}" y="13" font-size="11" stroke="none">Capo ${tab.capo}</text>`)
  for (let system = 0; system < systems; system++) {
    const top = labelHeight + system * systemHeight + head
    const bars = tab.bars.slice(system * perLine, (system + 1) * perLine)
    const end = left + bars.length * barWidth
    const yOf = (string: number): number => top + (strings - 1 - string) * gap
    const stemTop = top + staffHeight + 9
    const stemBottom = stemTop + 18
    for (let s = 0; s < strings; s++) {
      out.push(`<line x1="${left - 22}" y1="${yOf(s)}" x2="${end}" y2="${yOf(s)}" stroke-width="0.7" stroke="#8a8a8a"/>`)
      out.push(`<text x="${left - 36}" y="${yOf(s) + 3.5}" font-size="9" text-anchor="middle" stroke="none" fill="#666">${tab.stringNames[s]}</text>`)
    }
    out.push(`<line x1="${left - 22}" y1="${top}" x2="${left - 22}" y2="${top + staffHeight}" stroke-width="1"/>`)
    if (system === 0) {
      const mid = top + staffHeight / 2
      out.push(`<text x="${left - 10}" y="${mid - 2}" font-size="15" font-weight="bold" text-anchor="middle" stroke="none">${tab.meter.numerator}</text>`)
      out.push(`<text x="${left - 10}" y="${mid + 13}" font-size="15" font-weight="bold" text-anchor="middle" stroke="none">${tab.meter.denominator}</text>`)
    }
    bars.forEach((bar, b) => {
      const x0 = left + b * barWidth
      const pad = 13
      const xOf = (start: Fraction): number => x0 + pad + (ticks(start) / barTicks) * (barWidth - pad - 5)
      out.push(`<line x1="${x0 + barWidth}" y1="${top}" x2="${x0 + barWidth}" y2="${top + staffHeight}" stroke-width="${system === systems - 1 && b === bars.length - 1 ? 2.5 : 1}"/>`)
      out.push(`<text x="${x0 + 3}" y="${top - 5}" font-size="8" stroke="none" fill="#888">${bar.number}</text>`)
      for (const chord of bar.chords) out.push(`<text x="${xOf(chord.at)}" y="${top - 13}" font-size="13" font-weight="bold" stroke="none">${escapeXml(chord.symbol)}</text>`)
      bar.events.forEach((event, i) => {
        const x = xOf(event.start)
        const base = ticks(event.value) / (event.dots ? 1.5 : 1)
        if (event.pitches.length === 0) {
          out.push(`<g>${restSvg(event, event.fullBar ? x0 + barWidth / 2 : x, event.fullBar ? top + staffHeight / 2 : stemTop + 9)}</g>`)
        } else {
          for (const p of event.positions) {
            const label = event.tied ? `(${p.fret})` : String(p.fret)
            const w = label.length * 6.2 + 2
            const y = yOf(p.string)
            out.push(`<rect x="${x - w / 2}" y="${y - 6}" width="${w}" height="12" fill="${paper}" stroke="none"/>`)
            out.push(`<text x="${x}" y="${y + 4}" font-size="${event.tied ? 10 : 12}" text-anchor="middle" stroke="none"${event.tied ? ' fill="#777"' : ''}>${label}</text>`)
            if (event.tie) {
              const next = bar.events[i + 1]
              const x2 = next ? xOf(next.start) : x0 + barWidth
              out.push(`<path d="M${x + w / 2} ${y + 6} Q${(x + x2) / 2} ${y + 12} ${x2 - (next ? 8 : 0)} ${y + 6}" fill="none" stroke-width="0.9"/>`)
            }
          }
          // Rhythm: no stem for a whole note, a short one for a half, beams or flags below a quarter.
          if (base < 48) out.push(`<line x1="${x}" y1="${base >= 24 ? stemTop + 9 : stemTop}" x2="${x}" y2="${stemBottom}" stroke-width="1.2"/>`)
          if (event.dots) out.push(`<circle cx="${x + 4.5}" cy="${stemBottom - 2}" r="1.4" stroke="none"/>`)
          if (base < 12 && !event.beam) {
            out.push(`<line x1="${x}" y1="${stemBottom}" x2="${x + 6}" y2="${stemBottom - 7}" stroke-width="1.6"/>`)
            if (base < 6) out.push(`<line x1="${x}" y1="${stemBottom - 5}" x2="${x + 6}" y2="${stemBottom - 12}" stroke-width="1.6"/>`)
          }
          if (event.beam === 'begin' || event.beam === 'continue') {
            const next = bar.events[i + 1]!
            const x2 = xOf(next.start)
            const nextBase = ticks(next.value) / (next.dots ? 1.5 : 1)
            out.push(`<line x1="${x}" y1="${stemBottom}" x2="${x2}" y2="${stemBottom}" stroke-width="3"/>`)
            if (base < 6 && nextBase < 6) out.push(`<line x1="${x}" y1="${stemBottom - 5}" x2="${x2}" y2="${stemBottom - 5}" stroke-width="2.5"/>`)
            else if (base < 6) out.push(`<line x1="${x}" y1="${stemBottom - 5}" x2="${x + 6}" y2="${stemBottom - 5}" stroke-width="2.5"/>`)
            else if (nextBase < 6 && (next.beam === 'end' || ticks((bar.events[i + 2] ?? next).value) >= 6)) out.push(`<line x1="${x2 - 6}" y1="${stemBottom - 5}" x2="${x2}" y2="${stemBottom - 5}" stroke-width="2.5"/>`)
          }
        }
        if (event.tuplet?.role === 'start') {
          const lastOfGroup = bar.events[i + event.tuplet.size - 1] ?? event
          out.push(`<text x="${(x + xOf(lastOfGroup.start)) / 2}" y="${stemBottom + 12}" font-size="10" font-style="italic" text-anchor="middle" stroke="none">${event.tuplet.actual}</text>`)
        }
      })
    })
  }
  out.push('</svg>')
  return out.join('')
}

/** Plain-text tablature with bar lines; columns are spaced by time, so the rhythm reads off the page. */
export function tabToText(tab: Tablature, opts: { barsPerLine?: number } = {}): string {
  const perLine = opts.barsPerLine ?? 4
  const barTicks = ticks(tab.barLength)
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const lines: string[] = []
  const tuningNote = `${tab.meter.timeSignature}, ${Math.round(tab.meter.bpm)} bpm${tab.meter.swing ? ', swing' : ''}${tab.capo ? `, capo ${tab.capo}` : ''}`
  lines.push(tuningNote)
  for (let from = 0; from < tab.bars.length; from += perLine) {
    const bars = tab.bars.slice(from, from + perLine)
    const rows = tab.stringNames.map((name) => `${name.padEnd(2)}|`)
    let chordRow = '   '
    let anyChord = false
    for (const bar of bars) {
      const unit = bar.events.reduce((g, e) => gcd(g, ticks(e.start)), 6)
      const columns = barTicks / unit
      const wide = bar.events.some((e) => e.positions.some((p) => p.fret > 9)) ? 3 : 2
      const cells = tab.stringNames.map(() => new Array<string>(columns).fill('-'.repeat(wide)))
      for (const e of bar.events) {
        if (e.tied) continue
        for (const p of e.positions) cells[p.string]![ticks(e.start) / unit] = String(p.fret).padEnd(wide, '-')
      }
      const text = new Array<string>(columns * wide + 2).fill(' ')
      for (const chord of bar.chords) {
        anyChord = true
        const at = 1 + (ticks(chord.at) / unit) * wide
        ;[...chord.symbol].forEach((c, i) => (text[Math.floor(at) + i] = c))
      }
      chordRow += text.join('').slice(0, columns * wide + 2)
      rows.forEach((_, s) => (rows[s] += `-${cells[s]!.join('')}|`))
    }
    lines.push('')
    if (anyChord) lines.push(chordRow.trimEnd())
    lines.push(...rows.reverse())
  }
  return lines.join('\n')
}


