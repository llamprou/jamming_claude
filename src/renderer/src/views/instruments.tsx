import { useEffect, useMemo, useRef, useState } from 'react'
import type { InstrumentViewData } from '@shared/features/instruments'
import { chordPitches, fretboardSvg, pianoSvg } from '@shared/music/render'
import { heldPitches, keyboardRange, stepLength, stepPitches } from '@shared/music/sounding'
import type { Snapshot } from '@shared/music/types'
import { sessionNow } from '../audio/context'
import { playedNotes, playingNow } from '../audio/sounding'
import { engine } from '../features/transport/engine'
import { registerView, type Panel, type ViewProps } from './registry'

/**
 * Piano, guitar and bass, animated: the keys light as notes sound. Supersedes
 * core's still diagrams. Three sources, chosen by what `show` sent:
 *
 * - steps (timed notes or a chord progression): stepped through in time, on the
 *   transport's beat when it is running, otherwise at the given tempo;
 * - plain notes or a single chord: one still frame, as before;
 * - nothing: what the app is playing back and/or what the player is playing.
 */

/** Playback counts as under way if a note sounds within this many seconds of now (so rests don't flick to the player). */
const PLAYBACK_WINDOW = 1.2

function stillFrame(panel: Panel): number[] {
  if (panel.chords?.length) return chordPitches(panel.chords[panel.chords.length - 1]!)
  const notes = panel.notes ?? []
  const end = Math.max(0, ...notes.map((n) => n.start + n.duration))
  return [...new Set(notes.filter((n) => n.start + n.duration >= end - 0.25).map((n) => n.pitch))]
}

function livePitches(data: InstrumentViewData, snapshot: Snapshot | null): number[] {
  const follow = data.follow ?? 'both'
  const now = sessionNow()
  const player = snapshot?.notes ?? []
  if (follow === 'playback') return playingNow(data.parts)
  if (follow === 'both' && playedNotes.activeAround(now, PLAYBACK_WINDOW, data.parts)) {
    return [...new Set([...playingNow(data.parts), ...heldPitches(player, snapshot?.now ?? now)])]
  }
  // What the player last played, held on screen.
  const end = Math.max(0, ...player.map((n) => n.start + n.duration))
  return [...new Set(player.filter((n) => n.duration === 0 || n.start + n.duration >= end - 0.25).map((n) => n.pitch))]
}

function InstrumentView({ panel, snapshot }: ViewProps) {
  const data = (panel.data ?? {}) as InstrumentViewData
  const steps = data.steps?.length ? data.steps : null
  const live = !steps && !panel.notes && !panel.chords
  const shownAt = useMemo(() => sessionNow(), [panel])
  const snap = useRef(snapshot)
  snap.current = snapshot

  const [pitches, setPitches] = useState<number[]>(() => (live || steps ? [] : stillFrame(panel)))

  useEffect(() => {
    if (!live && !steps) {
      setPitches(stillFrame(panel))
      return
    }
    const length = steps ? stepLength(steps) : 0
    const loop = data.loop ?? true
    const notesEnd = steps ? Math.max(...steps.map((s) => s.startBeat + s.durationBeats)) : 0
    const lastOnset = steps ? Math.max(...steps.map((s) => s.startBeat)) : 0
    let frame = 0
    let last = ''
    const draw = () => {
      let next: number[]
      if (steps) {
        const transport = engine.state()
        let beat: number
        if (transport.running) {
          const anchor = Math.min(...transport.layers.filter((l) => !l.id.includes('~')).map((l) => l.startBeat), Infinity)
          beat = transport.beat - (Number.isFinite(anchor) ? anchor : 0)
        } else beat = ((sessionNow() - shownAt) * (data.bpm ?? 120)) / 60
        if (!loop && beat >= notesEnd) beat = lastOnset
        next = stepPitches(steps, beat, length, loop)
      } else next = livePitches(data, snap.current)
      const key = next.join(',')
      if (key !== last) {
        last = key
        setPitches(next)
      }
      frame = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(frame)
  }, [panel, live, steps, shownAt])

  // The keyboard widens to fit what has been lit, and never shrinks while open, so it doesn't jump about.
  const range = useRef({ low: 36, high: 84 })
  range.current = keyboardRange(pitches, range.current.low, range.current.high)

  const svg = panel.view === 'piano' ? pianoSvg(pitches, range.current.low, range.current.high) : fretboardSvg(pitches, panel.view === 'bass' ? 'bass' : 'guitar')
  return <div className="diagram" dangerouslySetInnerHTML={{ __html: svg }} />
}

for (const kind of ['piano', 'guitar', 'bass']) registerView(kind, InstrumentView)
