import { useEffect, useMemo, useRef, useState } from 'react'
import { findKey } from '@shared/music/notation/key'
import { analyseMeter } from '@shared/music/notation/meter'
import type { MainEvent } from '@shared/ipc'
import type { Snapshot } from '@shared/music/types'
import { flushVoice, playClip, playVoiceChunk, sessionNow, setClockOffset, startMic, startMidi, stopClip } from './audio'
import { routeFeatureEvent } from './features/bus'
import { startFeatures } from './features'
import './views'
import { viewFor, type Panel } from './views/registry'

/**
 * Voice-first: there are no controls. The mic and MIDI start on their own, the
 * player talks and plays, and the agent decides what is on screen. The only
 * things drawn here are the buddy's presence, the conversation as captions,
 * and whatever views the agent has opened.
 */

type AgentState = 'idle' | 'thinking' | 'speaking' | 'error'

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
      routeFeatureEvent(event)
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
      setClockOffset((await window.jam.clock()) - performance.now() / 1000)
      if (!cancelled) startFeatures()
      try {
        const mic = await startMic({
          onSpeechPcm: window.jam.micAudio,
          onNotes: window.jam.notes,
          onCorrection: (c) => window.jam.revise(c.from, c.to, c.notes),
          onEngine: setEngine,
          onLevel: (level) => orb.current?.style.setProperty('--level', level.toFixed(2)),
          now: sessionNow,
        })
        if (cancelled) return mic.stop()
        stopMic = mic.stop
        setInputs((i) => ({ ...i, mic: 'on' }))
      } catch (error) {
        setInputs((i) => ({ ...i, mic: `unavailable (${error instanceof Error ? error.message : String(error)})` }))
      }
    })()
    void startMidi(
      (kind, pitch, velocity) => window.jam.midi(kind, pitch, velocity, sessionNow()),
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

  // The same key and meter analysis the notation views and the agent's `listen` use, so they never disagree.
  const reading = useMemo(() => {
    const notes = snapshot?.notes ?? []
    const meter = notes.length ? analyseMeter(notes) : null
    return { key: notes.length ? (findKey(notes)?.name ?? null) : null, meter: meter ? `${meter.timeSignature} · ${Math.round(meter.bpm)} bpm` : null }
  }, [snapshot])

  const offline = config?.missing.includes('ANTHROPIC_API_KEY') ?? false
  const presence = agent.state === 'idle' ? 'listening' : agent.state
  const hint = offline ? 'The buddy is offline.' : config && !config.voice ? 'Voice is off. Type below to talk.' : 'Just talk, or play something.'

  return (
    <div className={`app ${panels.length ? 'has-panels' : 'empty'}`}>
      <main className="stage">
        {panels.map((panel) => (
          <section key={panel.view} className="panel">
            <h2>{panel.title ?? (panel.notes || panel.chords ? panel.view : `${panel.view} · live`)}</h2>
            <PanelBody panel={panel} snapshot={snapshot} />
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
          {reading.key && <span>{reading.key}</span>}
          {reading.meter && <span>{reading.meter}</span>}
          {snapshot?.correctedUntil != null && <span>corrected to {Math.max(0, snapshot.now - snapshot.correctedUntil).toFixed(0)}s ago</span>}
          {engine && <span>{engine}</span>}
        </div>
      </footer>
    </div>
  )
}

function PanelBody({ panel, snapshot }: { panel: Panel; snapshot: Snapshot | null }) {
  const View = viewFor(panel.view)
  return View ? <View panel={panel} snapshot={snapshot} /> : <p className="quiet">This build has no "{panel.view}" view.</p>
}
