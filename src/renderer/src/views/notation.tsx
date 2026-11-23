import abcjs from 'abcjs'
import { useEffect, useMemo, useRef } from 'react'
import {
  analyseMeter,
  chordNames,
  chordsAsNotes,
  findKey,
  readNotationOptions,
  rhythmGrid,
  scoreToAbc,
  tabToSvg,
  transcribe,
  transcribeTab,
  type Key,
  type KeyResult,
  type MeterEstimate,
  type NotationOptions,
} from '@shared/music/notation'
import type { ChordSpan, NoteEvent } from '@shared/music/types'
import { registerView, type ViewProps } from './registry'
import './notation.css'

/**
 * Written views: sheet music, tablature, the rhythm grid and chord names, all
 * read off the same analysis (src/shared/music/notation). They supersede the
 * rough 'sheet', 'tab', 'rhythm' and 'chords' views in core.tsx. Options the
 * player asks for by voice arrive in `panel.data.notation`.
 */

/** What a view is showing: the live window, or notes or chords the agent supplied. */
interface Source {
  live: boolean
  notes: NoteEvent[]
  chords?: ChordSpan[]
  options: NotationOptions
  /** Changes only when the music or the options do, so analysis is not redone four times a second. */
  id: string
}

function sourceFor({ panel, snapshot }: ViewProps): Source {
  const asked = readNotationOptions(panel.data)
  const instrument = asked.instrument ?? panel.instrument
  let notes: NoteEvent[]
  let chords: ChordSpan[] | undefined
  let options: NotationOptions = { ...asked, instrument }
  const live = !panel.notes && !panel.chords
  if (panel.notes) {
    // Notes from the agent are in beats at 120 with a bar line at zero.
    notes = panel.notes
    options = { quarterSeconds: 0.5, origin: 0, ...options }
  } else if (panel.chords) {
    const written = chordsAsNotes(panel.chords, panel.view === 'tab' || instrument === 'guitar' ? 'guitar' : 'keyboard')
    notes = written.notes
    chords = written.chords
    options = { ...written.options, ...options }
  } else {
    notes = snapshot?.notes ?? []
  }
  const last = notes[notes.length - 1]
  const held = Math.round(notes.reduce((sum, n) => sum + n.duration, 0) * 4)
  const pitches = notes.reduce((sum, n) => sum + n.pitch, 0)
  const id = `${live ? 'live' : 'given'}|${notes.length}|${last?.start.toFixed(2) ?? ''}|${held}|${pitches}|${JSON.stringify(options)}`
  return { live, notes, chords, options, id }
}

// Views open side by side on the same music; share the expensive parts.
const cache = new Map<string, unknown>()
function cached<T>(id: string, make: () => T): T {
  if (cache.has(id)) return cache.get(id) as T
  const value = make()
  cache.set(id, value)
  if (cache.size > 16) cache.delete(cache.keys().next().value!)
  return value
}

// The live key is held steady across refreshes and shared by every view.
let liveKey: Key | null = null

function meterOf(source: Source): MeterEstimate | null {
  const { timeSignature, swing, quarterSeconds, origin } = source.options
  return cached(`meter|${source.id}`, () => analyseMeter(source.notes.filter((n) => n.duration > 0), { timeSignature, swing, quarterSeconds, origin }))
}

function keyOf(source: Source, meter: MeterEstimate | null): KeyResult | null {
  return cached(`key|${source.id}`, () => {
    const key = findKey(source.notes, { previous: source.live ? liveKey : null, meter: meter ?? undefined })
    if (source.live) liveKey = source.notes.length ? key : null
    return key
  })
}

/** Remember the key a live view settled on, so the next refresh starts from it. */
function steady<T extends { key: KeyResult | null }>(source: Source, result: T): T {
  if (source.live) liveKey = source.notes.length ? result.key : null
  return result
}

const tempoText = (meter: MeterEstimate): string => `${Math.round(meter.bpm)} bpm${meter.compound ? ' (dotted quarter)' : ''}`

function Caption({ keyName, meter, extra }: { keyName?: string; meter: MeterEstimate | null; extra?: string }) {
  const parts = [keyName, meter?.timeSignature, meter && tempoText(meter), meter?.swing ? 'swing' : undefined, extra].filter(Boolean)
  return parts.length ? <p className="notation-caption">{parts.join(' · ')}</p> : null
}

function SheetView(props: ViewProps) {
  const source = sourceFor(props)
  const paper = useRef<HTMLDivElement>(null)
  const result = useMemo(
    () => cached(`sheet|${source.id}`, () => steady(source, transcribe(source.notes, { ...source.options, bars: source.options.bars ?? 8, chords: source.chords, meter: meterOf(source), previousKey: source.live ? liveKey : null }))),
    [source.id],
  )
  const abc = useMemo(() => scoreToAbc(result.score), [result])
  useEffect(() => {
    if (!paper.current) return
    abcjs.renderAbc(paper.current, abc, { responsive: 'resize', staffwidth: 760, paddingtop: 6, paddingbottom: 6, paddingleft: 8, paddingright: 8 })
  }, [abc])
  if (source.live && source.notes.length === 0) return <p className="quiet">Listening…</p>
  return (
    <>
      <div className="sheet notation-sheet" ref={paper} role="img" aria-label={`Sheet music in ${result.score.key.name}, ${result.score.meter.timeSignature}`} />
      <Caption keyName={result.score.key.name} meter={result.score.meter} />
    </>
  )
}

function TabView(props: ViewProps) {
  const source = sourceFor(props)
  const result = useMemo(
    () => cached(`tab|${source.id}`, () => steady(source, transcribeTab(source.notes, { ...source.options, bars: source.options.bars ?? 8, chords: source.chords, meter: meterOf(source), previousKey: source.live ? liveKey : null }))),
    [source.id],
  )
  const svg = useMemo(() => tabToSvg(result.tab), [result])
  if (source.live && source.notes.length === 0) return <p className="quiet">Listening…</p>
  const { tab } = result
  const extra = `${tab.instrument} ${[...tab.stringNames].join(' ')}${tab.capo ? `, capo ${tab.capo}` : ''}`
  return (
    <>
      <div className="notation-tab" dangerouslySetInnerHTML={{ __html: svg }} />
      <Caption keyName={result.score.key.name} meter={result.score.meter} extra={extra} />
    </>
  )
}

function RhythmView(props: ViewProps) {
  const source = sourceFor(props)
  const meter = meterOf(source)
  const grid = useMemo(() => (meter ? cached(`rhythm|${source.id}`, () => rhythmGrid(source.notes, meter, { bars: 2 })) : null), [source.id])
  if (!meter || !grid) {
    return (
      <div className="rhythm" role="img" aria-label="Rhythm: not enough played yet">
        <p className="quiet">{source.notes.length ? 'Keep going, a few more notes and I can count it.' : 'Listening…'}</p>
      </div>
    )
  }
  const beats = Array.from({ length: meter.beatsPerBar }, (_, i) => i)
  const row = (levels: number[], label: string, usual: boolean) => (
    <div className={`rhythm-row${usual ? ' usual' : ''}`} key={label}>
      <span className="rhythm-label">{label}</span>
      <div className="rhythm-bar">
        {beats.map((b) => (
          <div className="rhythm-beat" key={b} style={{ gridTemplateColumns: `repeat(${grid.slotsPerBeat}, 1fr)` }}>
            {Array.from({ length: grid.slotsPerBeat }, (_, s) => {
              const i = b * grid.slotsPerBeat + s
              const level = levels[i] ?? 0
              return <span key={s} className={`slot s${grid.strengths[i]}${level > 0 ? ' on' : ''}`} style={level > 0 ? { opacity: 0.45 + 0.55 * Math.min(1, level) } : undefined} />
            })}
          </div>
        ))}
      </div>
    </div>
  )
  const recent = grid.bars.map((bar, i) => row(bar, i === grid.bars.length - 1 ? 'now' : 'before', false))
  return (
    <div className="rhythm" role="img" aria-label={`Rhythm in ${meter.timeSignature} at ${Math.round(meter.bpm)} beats a minute${meter.swing ? ', swung' : ''}`}>
      <div className="rhythm-head">
        <span className="rhythm-signature">
          <b>{meter.numerator}</b>
          <b>{meter.denominator}</b>
        </span>
        <span className="rhythm-tempo">{Math.round(meter.bpm)}</span>
        <span className="rhythm-feel">{meter.compound ? 'dotted-quarter beats a minute' : 'beats a minute'}</span>
        <span className="rhythm-feel">{meter.swing ? 'swing' : 'straight'}</span>
      </div>
      {grid.barCount >= 3 && row(grid.pattern, 'usual', true)}
      {recent}
      <div className="rhythm-row count">
        <span className="rhythm-label" />
        <div className="rhythm-bar">
          {beats.map((b) => (
            <div className="rhythm-beat" key={b}>
              <span className={b === 0 ? 'one' : ''}>{b + 1}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ChordsView(props: ViewProps) {
  const { panel, snapshot } = props
  const source = sourceFor(props)
  // Chords the agent names are shown as given; chords heard are spelled for the key being played in.
  const key = panel.chords ? null : keyOf(source, meterOf(source))
  const heard = panel.notes ? cached(`chords|${source.id}`, () => transcribe(source.notes, { ...source.options, meter: meterOf(source) }).chords) : (snapshot?.chords ?? [])
  const names = panel.chords ?? chordNames(heard, key)
  return (
    <>
      <div className="chords">
        {names.length === 0 && <span className="quiet">Listening…</span>}
        {names.slice(-8).map((c, i, all) => (
          <span key={i} className={i === all.length - 1 ? 'now' : ''}>
            {c}
          </span>
        ))}
      </div>
      {key && names.length > 0 && <p className="notation-caption">{key.confidence >= 0.5 ? key.name : `${key.name}?`}</p>}
    </>
  )
}

registerView('sheet', SheetView)
registerView('tab', TabView)
registerView('rhythm', RhythmView)
registerView('chords', ChordsView)
