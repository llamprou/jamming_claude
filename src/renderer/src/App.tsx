import abcjs from 'abcjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MainEvent } from '@shared/ipc'
import { detectChords } from '@shared/music/analysis'
import { chordPitches, diagramSvg, tabToAscii, toAbc, toTab } from '@shared/music/render'
import type { Instrument, NoteEvent, Snapshot, ViewKind } from '@shared/music/types'
import { flushVoice, playClip, playVoiceChunk, startMic, startMidi, stopClip, type MicHandle } from './audio'

interface Line {
  role: 'user' | 'buddy'
  text: string
  final: boolean
}

/** What the agent asked to show; `null` content means "follow the live input". */
interface Shown {
  view: ViewKind
  title?: string
  instrument?: Instrument
  notes?: NoteEvent[]
  chords?: string[]
}

const VIEWS: ViewKind[] = ['chords', 'rhythm', 'sheet', 'tab', 'piano', 'guitar', 'bass']
const clock = () => performance.now() / 1000

export function App() {
  const [status, setStatus] = useState<{ agent: string; detail?: string }>({ agent: 'idle' })
  const [config, setConfig] = useState<{ voice: boolean; missing: string[] } | null>(null)
  const [log, setLog] = useState<Line[]>([])
  const [shown, setShown] = useState<Shown>({ view: 'chords' })
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [mic, setMic] = useState<MicHandle | null>(null)
  const [midiInputs, setMidiInputs] = useState<string[] | null>(null)
  const [draft, setDraft] = useState('')
  const logEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const append = (role: Line['role'], text: string, final: boolean) =>
      setLog((lines) => {
        const last = lines[lines.length - 1]
        if (last && last.role === role && !last.final) {
          // Speech partials replace; streamed buddy text accumulates.
          const merged = role === 'user' ? text : last.text + text
          return [...lines.slice(0, -1), { role, text: merged || last.text, final }]
        }
        return text ? [...lines, { role, text, final }] : lines
      })

    return window.jam.onEvent((event: MainEvent) => {
      switch (event.type) {
        case 'status':
          return setStatus(event)
        case 'config':
          return setConfig(event)
        case 'transcript':
          return append(event.role, event.text, event.final)
        case 'show-view':
          return setShown({ view: event.view, title: event.title, instrument: event.instrument, notes: event.notes, chords: event.chords })
        case 'play-clip':
          return playClip(event.clip)
        case 'stop-playback':
          return stopClip()
        case 'tts-audio':
          return playVoiceChunk(event.pcm16Base64, event.sampleRate)
        case 'tts-flush':
          return flushVoice()
      }
    })
  }, [])

  // Live views follow the transcript in main.
  useEffect(() => {
    const timer = setInterval(() => void window.jam.snapshot(16).then(setSnapshot), 250)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => logEnd.current?.scrollIntoView({ block: 'end' }), [log])

  const toggleMic = async () => {
    if (mic) {
      mic.stop()
      return setMic(null)
    }
    setMic(await startMic({ onSpeechPcm: window.jam.micAudio, onNotes: window.jam.notes, now: clock }))
  }

  const connectMidi = async () => setMidiInputs(await startMidi((kind, pitch, velocity) => window.jam.midi(kind, pitch, velocity, clock())))

  const live = !shown.notes && !shown.chords
  const notes = shown.notes ?? snapshot?.notes ?? []
  const chordSymbols = shown.chords ?? (shown.notes ? detectChords(shown.notes).map((c) => c.symbol) : (snapshot?.chords.map((c) => c.symbol) ?? []))
  const sounding = useMemo(() => {
    if (shown.chords?.length) return chordPitches(shown.chords[shown.chords.length - 1]!)
    const end = Math.max(0, ...notes.map((n) => n.start + n.duration))
    return notes.filter((n) => n.start + n.duration >= end - 0.25).map((n) => n.pitch)
  }, [notes, shown.chords])

  return (
    <div className="app">
      <main className="stage">
        <div className="bar">
          <h1>Jamming Claude</h1>
          <button aria-pressed={Boolean(mic)} onClick={() => void toggleMic()}>
            {mic ? 'Mic on' : 'Mic off'}
          </button>
          <button aria-pressed={Boolean(midiInputs)} onClick={() => void connectMidi()}>
            {midiInputs ? `MIDI: ${midiInputs.join(', ') || 'no device'}` : 'Connect MIDI'}
          </button>
          <select value={shown.view} onChange={(e) => setShown({ view: e.target.value as ViewKind })} aria-label="View">
            {VIEWS.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <button onClick={() => window.jam.interrupt()}>Stop</button>
          <span className={`status ${status.agent}`}>{status.detail ? `${status.agent}: ${status.detail}` : status.agent}</span>
        </div>

        <section className="card">
          <h2>{shown.title ?? (live ? `${shown.view} · live` : shown.view)}</h2>
          <View view={shown.view} instrument={shown.instrument} notes={notes} chords={chordSymbols} sounding={sounding} snapshot={live ? snapshot : null} />
        </section>

        {snapshot && (
          <p className="meta">
            {snapshot.key ? `Key ${snapshot.key.tonic} ${snapshot.key.mode}` : 'Key unclear'}
            {snapshot.rhythm ? ` · ${snapshot.rhythm.bpm} bpm` : ''} · {snapshot.notes.length} notes in the last {snapshot.windowSeconds}s ·{' '}
            {snapshot.corrected ? 'corrected' : 'fast pass'}
          </p>
        )}
      </main>

      <aside className="side">
        {config && config.missing.length > 0 && (
          <div className="notice">
            {config.missing.includes('ANTHROPIC_API_KEY') ? 'The buddy is offline. ' : 'Voice is off; type to talk. '}
            Missing: {config.missing.join(', ')}. Add them to .env and restart.
          </div>
        )}
        <div className="log">
          {log.map((line, i) => (
            <p key={i} className={`${line.role} ${line.final ? '' : 'partial'}`}>
              {line.text}
            </p>
          ))}
          <div ref={logEnd} />
        </div>
        <form
          className="say"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft.trim()) void window.jam.say(draft)
            setDraft('')
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Say something…" aria-label="Message" />
          <button type="submit">Send</button>
        </form>
      </aside>
    </div>
  )
}

function View(props: { view: ViewKind; instrument?: Instrument; notes: NoteEvent[]; chords: string[]; sounding: number[]; snapshot: Snapshot | null }) {
  const { view, notes, chords, sounding, snapshot } = props
  const sheet = useRef<HTMLDivElement>(null)
  const bpm = snapshot?.rhythm?.bpm ?? 120

  useEffect(() => {
    if (view !== 'sheet' || !sheet.current) return
    const key = snapshot?.key ? `${snapshot.key.tonic}${snapshot.key.mode === 'minor' ? 'm' : ''}` : 'C'
    abcjs.renderAbc(sheet.current, toAbc(notes.slice(-64), { bpm, key }), { responsive: 'resize' })
  }, [view, notes, bpm, snapshot?.key])

  switch (view) {
    case 'chords':
      return (
        <div className="chords">
          {chords.length === 0 && <span className="meta">Play something…</span>}
          {chords.slice(-8).map((c, i, all) => (
            <span key={i} className={i === all.length - 1 ? 'now' : ''}>
              {c}
            </span>
          ))}
        </div>
      )
    case 'rhythm': {
      const pattern = snapshot?.rhythm?.pattern ?? '................'
      return (
        <div className="grid" role="img" aria-label={`Rhythm ${pattern}`}>
          {[...pattern].map((c, i) => (
            <span key={i} className={c === 'x' ? 'on' : ''} />
          ))}
        </div>
      )
    }
    case 'sheet':
      return <div className="sheet" ref={sheet} />
    case 'tab': {
      const instrument = props.instrument === 'bass' ? 'bass' : 'guitar'
      return <pre className="tab">{tabToAscii(toTab(notes.slice(-48), instrument), instrument)}</pre>
    }
    case 'piano':
    case 'guitar':
    case 'bass':
      return <div className="diagram" dangerouslySetInnerHTML={{ __html: diagramSvg(sounding, view) }} />
  }
}
