import abcjs from 'abcjs'
import { useEffect, useMemo, useRef } from 'react'
import { detectChords } from '@shared/music/analysis'
import { chordPitches, diagramSvg, tabToAscii, toAbc, toTab } from '@shared/music/render'
import { registerView, type ViewProps } from './registry'

/** The original seven views. Each is small; they share one component. */

function CoreView({ panel, snapshot }: ViewProps) {
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
    default:
      return null
  }
}

for (const kind of ['chords', 'rhythm', 'sheet', 'tab', 'piano', 'guitar', 'bass']) registerView(kind, CoreView)
