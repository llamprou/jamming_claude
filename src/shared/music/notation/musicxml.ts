import type { Score, ScoreEvent, ScoreStaff } from './score'

/** A Score as MusicXML 4.0 (score-partwise), for opening in other notation software. */

const DIVISIONS = 12 // per quarter note; equals the score's ticks, so triplets and sixteenths are whole numbers
const ticks = (value: { n: number; d: number }): number => Math.round((value.n * DIVISIONS * 4) / value.d)
const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const TYPES: Record<number, string> = { 3: '16th', 6: 'eighth', 12: 'quarter', 24: 'half', 48: 'whole' }
const ACCIDENTALS: Record<number, string> = { [-2]: 'flat-flat', [-1]: 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' }
const KINDS: Record<string, string> = {
  '': 'major', m: 'minor', '7': 'dominant', maj7: 'major-seventh', m7: 'minor-seventh', dim: 'diminished', dim7: 'diminished-seventh',
  aug: 'augmented', m7b5: 'half-diminished', sus4: 'suspended-fourth', sus2: 'suspended-second', '6': 'major-sixth', m6: 'minor-sixth',
  '9': 'dominant-ninth', maj9: 'major-ninth', m9: 'minor-ninth', mMaj7: 'major-minor',
}

function clefXml(staff: ScoreStaff, number: number, many: boolean): string {
  const [sign, line] = staff.clef === 'bass' ? ['F', 4] : ['G', 2]
  const octave = staff.octaveShift ? `<clef-octave-change>${-staff.octaveShift}</clef-octave-change>` : ''
  return `<clef${many ? ` number="${number}"` : ''}><sign>${sign}</sign><line>${line}</line>${octave}</clef>`
}

function harmonyXml(symbol: string): string {
  const match = /^([A-G])(#|b)?([^/]*)(?:\/([A-G])(#|b)?)?$/.exec(symbol)
  if (!match) return ''
  const [, step, accidental, quality, bassStep, bassAccidental] = match
  const alter = (a?: string): string => (a ? `<root-alter>${a === '#' ? 1 : -1}</root-alter>` : '')
  const bass = bassStep ? `<bass><bass-step>${bassStep}</bass-step>${bassAccidental ? `<bass-alter>${bassAccidental === '#' ? 1 : -1}</bass-alter>` : ''}</bass>` : ''
  return `<harmony><root><root-step>${step}</root-step>${alter(accidental)}</root><kind text="${escapeXml(quality!)}">${KINDS[quality!] ?? 'other'}</kind>${bass}</harmony>`
}

function noteXml(event: ScoreEvent, voice: number, staffNumber: number, many: boolean): string {
  const duration = ticks(event.duration)
  const base = ticks(event.value) / (event.dots ? 1.5 : 1)
  const type = event.fullBar ? '' : `<type>${TYPES[base] ?? 'quarter'}</type>${'<dot/>'.repeat(event.dots)}`
  const modification = event.tuplet ? `<time-modification><actual-notes>${event.tuplet.actual}</actual-notes><normal-notes>${event.tuplet.normal}</normal-notes></time-modification>` : ''
  const staff = many ? `<staff>${staffNumber}</staff>` : ''
  const beam = event.beam ? `<beam number="1">${event.beam}</beam>` : ''
  const tupletMark = event.tuplet && event.tuplet.role !== 'inner' ? `<tuplet type="${event.tuplet.role}"/>` : ''
  if (event.pitches.length === 0) {
    const notations = tupletMark ? `<notations>${tupletMark}</notations>` : ''
    return `<note><rest${event.fullBar ? ' measure="yes"' : ''}/><duration>${duration}</duration><voice>${voice}</voice>${type}${modification}${staff}${notations}</note>`
  }
  return event.pitches
    .map((pitch, i) => {
      const ties = `${event.tied ? '<tie type="stop"/>' : ''}${event.tie ? '<tie type="start"/>' : ''}`
      const tied = `${event.tied ? '<tied type="stop"/>' : ''}${event.tie ? '<tied type="start"/>' : ''}`
      const marks = `${tied}${i === 0 ? tupletMark : ''}`
      const accidental = pitch.accidental === undefined ? '' : `<accidental>${ACCIDENTALS[pitch.accidental] ?? 'natural'}</accidental>`
      return (
        `<note>${i > 0 ? '<chord/>' : ''}<pitch><step>${pitch.step}</step>${pitch.alter ? `<alter>${pitch.alter}</alter>` : ''}<octave>${pitch.octave}</octave></pitch>` +
        `<duration>${duration}</duration>${ties}<voice>${voice}</voice>${type}${accidental}${modification}${staff}${i === 0 ? beam : ''}` +
        `${marks ? `<notations>${marks}</notations>` : ''}</note>`
      )
    })
    .join('\n      ')
}

export function scoreToMusicXml(score: Score, opts: { title?: string } = {}): string {
  const { meter, key } = score
  const many = score.staves.length > 1
  const barTicks = ticks(score.barLength)
  const title = opts.title ?? score.title ?? 'Jam'
  const measures = score.bars.map((bar, index) => {
    const parts: string[] = []
    if (index === 0) {
      parts.push(
        `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>${key.fifths}</fifths><mode>${key.mode}</mode></key>` +
          `<time><beats>${meter.numerator}</beats><beat-type>${meter.denominator}</beat-type></time>` +
          `${many ? `<staves>${score.staves.length}</staves>` : ''}${score.staves.map((s, i) => clefXml(s, i + 1, many)).join('')}</attributes>`,
        `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>${meter.compound ? '<beat-unit-dot/>' : ''}<per-minute>${Math.round(meter.bpm)}</per-minute></metronome></direction-type>` +
          `<sound tempo="${Math.round(meter.bpm * (meter.compound ? 1.5 : 1))}"/></direction>`,
      )
      if (meter.swing) parts.push('<direction placement="above"><direction-type><words>Swing</words></direction-type></direction>')
    }
    bar.voices.forEach((events, voice) => {
      if (voice > 0) parts.push(`<backup><duration>${barTicks}</duration></backup>`)
      const chords = voice === 0 ? [...bar.chords].sort((a, b) => a.at.n / a.at.d - b.at.n / b.at.d) : []
      events.forEach((event, i) => {
        const at = event.start.n / event.start.d
        while (chords.length && (chords[0]!.at.n / chords[0]!.at.d <= at + 1e-9 || i === events.length - 1)) parts.push(harmonyXml(chords.shift()!.symbol))
        parts.push(noteXml(event, voice + 1, voice + 1, many))
      })
    })
    return `    <measure number="${bar.number}">\n      ${parts.filter(Boolean).join('\n      ')}\n    </measure>`
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    `  <work><work-title>${escapeXml(title)}</work-title></work>`,
    '  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>',
    '  <part id="P1">',
    ...measures,
    '  </part>',
    '</score-partwise>',
    '',
  ].join('\n')
}
