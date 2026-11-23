import abcjs from 'abcjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MainEvent } from '@shared/ipc'
import { detectChords } from '@shared/music/analysis'
import { chordPitches, diagramSvg, tabToAscii, toAbc, toTab } from '@shared/music/render'
import type { Instrument, NoteEvent, Snapshot, ViewKind } from '@shared/music/types'
import { flushVoice, playClip, playVoiceChunk, startMic, startMidi, stopClip } from './audio'

/**
 * Voice-first: there are no controls. The mic and MIDI start on their own, the
 * player talks and plays, and the agent decides what is on screen. The only
 * things drawn here are the buddy's presence, the conversation as captions,
 * and whatever views the agent has opened.
 */

interface Panel {
  view: ViewKind
  title?: string
  instrument?: Instrument
  /** Absent means "follow the live input". */
  notes?: NoteEvent[]
  chords?: string[]
}

type AgentState = 'idle' | 'thinking' | 'speaking' | 'error'

const clock = () => performance.now() / 1000

export function App() {
  const [agent, setAgent] = useState<{ state: AgentState; detail?: string }>({ state: 'idle' })
  const [config, setConfig] = useState<{ voice: boolean; missing: string[] } | null>(null)
  const [heard, setHeard] = useState('')
  const [said, setSaid] = useState('')
  const [panels, setPanels] = useState<Panel[]>([])
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [playing, setPlaying] = useState<{ name: string; savedTo?: string } | null>(null)
  const [inputs, setInputs] = useState<{ mic: string; midi: string }>({ mic: 'starting', midi: 'looking' })
  const [engine, setEngine] = useState('')
  const [draft, setDraft] = useState('')
  const orb = useRef<HTMLDivElement>(null)
  const buddyDone = useRef(true)

  useEffect(() => {
    return window.jam.onEvent((event: MainEvent) => {
      switch (event.type) {
        case 'status':
          return setAgent({ state: event.agent, detail: event.detail })
        case 'config':
          return setConfig(event)
        case 'transcript':
          if (event.role === 'user') return setHeard(event.text)
          // Streamed reply: start a fresh caption when a new turn begins.
          setSaid((previous) => (buddyDone.current ? event.text : previous + event.text))
          buddyDone.current = event.final
          return
        case 'show-view':
          return setPanels((open) => [{ ...event }, ...open.filter((p) => p.view !== event.view)].slice(0, 4))
        case 'hide-view':
          return setPanels((open) => (event.view === 'all' ? [] : open.filter((p) => p.view !== event.view)))
        case 'play-clip':
          setPlaying({ name: event.clip.name, savedTo: event.savedTo })
          return playClip(event.clip, () => setPlaying(null))
        case 'stop-playback':
          setPlaying(null)
          return stopClip()
        case 'tts-audio':
          return playVoiceChunk(event.pcm16Base64, event.sampleRate)
        case 'tts-flush':
          return flushVoice()
      }
    })
  }, [])

  // Inputs come up on their own: no button to press.
  useEffect(() => {
    let cancelled = false
    let stopMic = () => {}
    void (async () => {
      const offset = (await window.jam.clock()) - clock()
      try {
        const mic = await startMic({
          onSpeechPcm: window.jam.micAudio,
          onNotes: window.jam.notes,
          onCorrection: (c) => window.jam.revise(c.from, c.to, c.notes),
          onEngine: setEngine,
          onLevel: (level) => orb.current?.style.setProperty('--level', level.toFixed(2)),
          now: () => clock() + offset,
        })
        if (cancelled) return mic.stop()
        stopMic = mic.stop
        setInputs((i) => ({ ...i, mic: 'on' }))
      } catch (error) {
        setInputs((i) => ({ ...i, mic: `unavailable (${error instanceof Error ? error.message : String(error)})` }))
      }
    })()
    void startMidi(
      (kind, pitch, velocity) => window.jam.midi(kind, pitch, velocity, clock()),
      (names) => setInputs((i) => ({ ...i, midi: names.join(', ') || 'none connected' })),
    ).catch(() => setInputs((i) => ({ ...i, midi: 'unavailable' })))
    return () => {
      cancelled = true
      stopMic()
    }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => void window.jam.snapshot(16).then(setSnapshot), 250)
    return () => clearInterval(timer)
  }, [])

  // The one keyboard affordance: Escape silences everything.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && window.jam.interrupt()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const offline = config?.missing.includes('ANTHROPIC_API_KEY') ?? false
  const presence = agent.state === 'idle' ? 'listening' : agent.state
  const hint = offline ? 'The buddy is offline.' : config && !config.voice ? 'Voice is off. Type below to talk.' : 'Just talk, or play something.'

  return (
    <div className={`app ${panels.length ? 'has-panels' : 'empty'}`}>
      <main className="stage">
        {panels.map((panel) => (
          <section key={panel.view} className="panel">
            <h2>{panel.title ?? (panel.notes || panel.chords ? panel.view : `${panel.view} · live`)}</h2>
            <PanelView panel={panel} snapshot={snapshot} />
          </section>
        ))}
      </main>

      <footer className="presence">
        <div ref={orb} className={`orb ${presence}`} role="status" aria-label={`Buddy is ${presence}`} />
        <div className="captions" aria-live="polite">
          {said ? <p className="said">{said}</p> : <p className="said hint">{hint}</p>}
          {heard && <p className="heard">{heard}</p>}
          {agent.state === 'error' && <p className="problem">{agent.detail}</p>}
          {config && config.missing.length > 0 && <p className="problem">Missing in .env: {config.missing.join(', ')}</p>}
          {config && !config.voice && !offline && (
            <form
              className="say"
              onSubmit={(e) => {
                e.preventDefault()
                if (draft.trim()) void window.jam.say(draft)
                setDraft('')
              }}
            >
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type to talk (voice is off)" aria-label="Message" />
            </form>
          )}
        </div>
        <div className="meta">
          {playing && <span className="playing">♪ {playing.name}</span>}
          <span>mic {inputs.mic}</span>
          <span>MIDI {inputs.midi}</span>
          {snapshot?.key && <span>{`${snapshot.key.tonic} ${snapshot.key.mode}`}</span>}
          {snapshot?.rhythm && <span>{snapshot.rhythm.bpm} bpm</span>}
          {snapshot?.correctedUntil != null && <span>corrected to {Math.max(0, snapshot.now - snapshot.correctedUntil).toFixed(0)}s ago</span>}
          {engine && <span>{engine}</span>}
        </div>
      </footer>
    </div>
  )
}

function PanelView({ panel, snapshot }: { panel: Panel; snapshot: Snapshot | null }) {
  const live = !panel.notes && !panel.chords
  const notes = panel.notes ?? snapshot?.notes ?? []
  const chords = panel.chords ?? (panel.notes ? detectChords(panel.notes).map((c) => c.symbol) : (snapshot?.chords.map((c) => c.symbol) ?? []))
  const sounding = useMemo(() => {
    if (panel.chords?.length) return chordPitches(panel.chords[panel.chords.length - 1]!)
    const end = Math.max(0, ...notes.map((n) => n.start + n.duration))
    return notes.filter((n) => n.start + n.duration >= end - 0.25).map((n) => n.pitch)
  }, [notes, panel.chords])
  const sheet = useRef<HTMLDivElement>(null)
  const bpm = live ? (snapshot?.rhythm?.bpm ?? 120) : 120
  const key = live && snapshot?.key ? `${snapshot.key.tonic}${snapshot.key.mode === 'minor' ? 'm' : ''}` : 'C'

  useEffect(() => {
    if (panel.view !== 'sheet' || !sheet.current) return
    abcjs.renderAbc(sheet.current, toAbc(notes.slice(-64), { bpm, key }), { responsive: 'resize' })
  }, [panel.view, notes, bpm, key])

  switch (panel.view) {
    case 'chords':
      return (
        <div className="chords">
          {chords.length === 0 && <span className="quiet">Listening…</span>}
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
      const instrument = panel.instrument === 'bass' ? 'bass' : 'guitar'
      return <pre className="tab">{tabToAscii(toTab(notes.slice(-48), instrument), instrument)}</pre>
    }
    case 'piano':
    case 'guitar':
    case 'bass':
      return <div className="diagram" dangerouslySetInnerHTML={{ __html: diagramSvg(sounding, panel.view) }} />
  }
}
