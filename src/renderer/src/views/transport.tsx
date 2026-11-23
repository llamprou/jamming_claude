import { useEffect, useState } from 'react'
import type { TransportState } from '@shared/features/transport'
import { engine } from '../features/transport/engine'
import { registerView } from './registry'

/** Where the transport is: tempo, the beat of the bar, and the layers that are looping. */
function TransportView() {
  const [state, setState] = useState<TransportState>(() => engine.state())
  useEffect(() => {
    const timer = setInterval(() => setState(engine.state()), 60)
    return () => clearInterval(timer)
  }, [])

  if (!state.running) return <p className="quiet">Nothing is looping.</p>
  const beatNow = Math.floor(state.beatInBar)
  return (
    <div className="transport">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <strong style={{ fontSize: 28 }}>{Math.round(state.bpm)}</strong>
        <span className="quiet">bpm · bar {state.bar + 1}{state.follow ? ' · following you' : ' · fixed tempo'}</span>
        <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }} role="img" aria-label={`Beat ${beatNow + 1} of ${state.beatsPerBar}`}>
          {Array.from({ length: state.beatsPerBar }, (_, i) => (
            <span key={i} style={{ width: 14, height: 14, borderRadius: 7, background: 'currentColor', opacity: i === beatNow ? 1 : 0.2 }} />
          ))}
        </span>
      </div>
      {state.layers
        .filter((layer) => !layer.id.includes('~'))
        .map((layer) => {
          const progress = layer.startsIn > 0 ? 0 : (((state.beat - layer.startBeat) % layer.lengthBeats) + layer.lengthBeats) % layer.lengthBeats / layer.lengthBeats
          return (
            <div key={layer.id} style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{layer.id}</span>
                <span className="quiet">
                  {layer.kind === 'audio' ? 'your sound' : 'notes'} · {Math.round(layer.lengthBeats / state.beatsPerBar)} bar{layer.lengthBeats > state.beatsPerBar ? 's' : ''}
                  {layer.startsIn > 0 ? ' · coming in' : ''}
                  {layer.stopBeat !== undefined ? ' · stopping' : ''}
                </span>
              </div>
              <div style={{ height: 4, borderRadius: 2, background: 'rgba(128,128,128,0.25)', marginTop: 4 }}>
                <div style={{ height: 4, borderRadius: 2, background: 'currentColor', width: `${progress * 100}%` }} />
              </div>
            </div>
          )
        })}
    </div>
  )
}

registerView('transport', TransportView)
