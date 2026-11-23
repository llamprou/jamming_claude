import type { Score, ScoreBar, ScoreEvent, ScorePitch, ScoreStaff } from './score'

/**
 * A Score as ABC notation for abcjs: key and time signature, spelled pitches
 * with only the accidentals that need drawing, ties, tuplets, beams by beat,
 * chord symbols, a grand staff when the score has two staves, and several bars
 * to a line.
 */

export interface AbcOptions {
  title?: string
  /** Bars on each line. Chosen from how busy the bars are if absent. */
  barsPerLine?: number
}

const sixteenths = (value: { n: number; d: number }): number => (value.n * 16) / value.d

function abcPitch(pitch: ScorePitch, staff: ScoreStaff): string {
  const sign = pitch.accidental === undefined ? '' : pitch.accidental === 0 ? '=' : pitch.accidental > 0 ? '^'.repeat(pitch.accidental) : '_'.repeat(-pitch.accidental)
  const octave = pitch.octave + staff.octaveShift
  if (octave >= 5) return `${sign}${pitch.step.toLowerCase()}${"'".repeat(octave - 5)}`
  return `${sign}${pitch.step}${','.repeat(4 - octave)}`
}

function abcEvent(event: ScoreEvent, staff: ScoreStaff): string {
  const length = sixteenths(event.value)
  const count = length === 1 ? '' : String(length)
  const tuplet = event.tuplet?.role === 'start' ? `(${event.tuplet.actual}:${event.tuplet.normal}:${event.tuplet.size}` : ''
  if (event.pitches.length === 0) return `${tuplet}z${count}`
  const notes = event.pitches.map((p) => abcPitch(p, staff))
  const body = notes.length > 1 ? `[${notes.join('')}]` : notes[0]!
  return `${tuplet}${body}${count}${event.tie ? '-' : ''}`
}

function abcBar(bar: ScoreBar, voice: number, staff: ScoreStaff, withChords: boolean): string {
  const events = bar.voices[voice] ?? []
  const chords = withChords ? [...bar.chords].sort((a, b) => a.at.n / a.at.d - b.at.n / b.at.d) : []
  let out = ''
  events.forEach((event, i) => {
    const at = event.start.n / event.start.d
    // A chord symbol goes on the first event at or after its beat.
    while (chords.length && (chords[0]!.at.n / chords[0]!.at.d <= at + 1e-9 || i === events.length - 1)) out += `"${chords.shift()!.symbol}"`
    out += abcEvent(event, staff)
    // No space inside a beam; a space everywhere else breaks it.
    const joined = (event.beam === 'begin' || event.beam === 'continue') && events[i + 1]?.beam !== undefined
    if (!joined && i < events.length - 1) out += ' '
  })
  return out
}

export function scoreToAbc(score: Score, opts: AbcOptions = {}): string {
  const { meter, key } = score
  const busiest = Math.max(1, ...score.bars.flatMap((b) => b.voices.map((v) => v.length)))
  const perLine = opts.barsPerLine ?? (busiest > 12 ? 2 : busiest > 7 ? 3 : 4)
  const grand = score.staves.length > 1
  const tempo = `${meter.compound ? '3/8' : '1/4'}=${Math.round(meter.bpm)}`
  const header = ['X:1']
  const title = opts.title ?? score.title
  if (title) header.push(`T:${title.replace(/\n/g, ' ')}`)
  header.push(`M:${meter.timeSignature}`, 'L:1/16', `Q:${meter.swing ? '"Swing" ' : ''}${tempo}`)
  if (grand) {
    header.push(`%%score {${score.staves.map((_, i) => i + 1).join(' | ')}}`)
    score.staves.forEach((staff, i) => header.push(`V:${i + 1} clef=${staff.clef}`))
  }
  header.push(`K:${key.tonic}${key.mode === 'minor' ? 'm' : ''}${grand ? '' : ` clef=${score.staves[0]!.clef}`}`)

  const lines: string[] = []
  for (let from = 0; from < score.bars.length; from += perLine) {
    const bars = score.bars.slice(from, from + perLine)
    const final = from + perLine >= score.bars.length
    score.staves.forEach((staff, voice) => {
      const body = bars.map((bar) => abcBar(bar, voice, staff, voice === 0)).join(' | ')
      lines.push(`${grand ? `[V:${voice + 1}] ` : ''}${body} ${final ? '|]' : '|'}`)
    })
  }
  return [...header, ...lines].join('\n')
}
