import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { WHITEBOARD, type WhiteboardEvent } from '@shared/features/whiteboard'
import { BOARD_HEIGHT, BOARD_WIDTH } from '@shared/whiteboard'
import { sendFeature } from '../features/bus'
import { board, boardVersion, changed, drawStrokes, subscribe } from '../features/whiteboard/board'
import { registerView } from './registry'
import './whiteboard.css'

/**
 * A pop-up whiteboard the agent opens when the player asks for it: draw with
 * a mouse, finger or pen (pressure where the pen reports it), or type. Unlike
 * other views it has a few controls of its own, because writing on it is the
 * point. The agent reads it with read_whiteboard; Done tells the agent to look.
 */

type Tool = 'pen' | 'eraser'

function WhiteboardView() {
  const version = useSyncExternalStore(subscribe, boardVersion)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [sent, setSent] = useState(false)

  // Redraw on every change, at the canvas's real pixel size.
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ratio = window.devicePixelRatio || 1
    const width = Math.round(el.clientWidth * ratio)
    const height = Math.round(el.clientHeight * ratio)
    if (el.width !== width || el.height !== height) Object.assign(el, { width, height })
    const g = el.getContext('2d')!
    g.clearRect(0, 0, width, height)
    drawStrokes(g, width / BOARD_WIDTH, '#ecebe6')
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault()
        if (board.undo()) changed()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toBoard = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    // Mice report 0.5 while pressed; touch often 0 or 1 with no real pressure. Only pens get to vary.
    const pressure = e.pointerType === 'pen' ? e.pressure : 0.5
    return { x: ((e.clientX - rect.left) / rect.width) * BOARD_WIDTH, y: ((e.clientY - rect.top) / rect.height) * BOARD_HEIGHT, pressure }
  }

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.currentTarget.setPointerCapture(e.pointerId)
    // A pen's eraser end (button 5) rubs out whatever tool is chosen.
    board.begin(toBoard(e), { erase: tool === 'eraser' || e.button === 5 })
    setSent(false)
    changed()
  }
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!board.isDrawing) return
    const events = e.nativeEvent.getCoalescedEvents?.() ?? []
    if (events.length) {
      const rect = e.currentTarget.getBoundingClientRect()
      for (const c of events) board.extend({ x: ((c.clientX - rect.left) / rect.width) * BOARD_WIDTH, y: ((c.clientY - rect.top) / rect.height) * BOARD_HEIGHT, pressure: e.pointerType === 'pen' ? c.pressure : 0.5 })
    } else board.extend(toBoard(e))
    changed()
  }
  const up = () => board.end()

  const done = () => {
    sendFeature(WHITEBOARD, { type: 'done' } satisfies WhiteboardEvent)
    setSent(true)
  }

  return (
    <div className="whiteboard" data-version={version}>
      <canvas
        ref={canvas}
        className={`whiteboard-surface ${tool}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      />
      <textarea
        className="whiteboard-text"
        placeholder="Type here…"
        value={board.text}
        onChange={(e) => {
          board.setText(e.target.value)
          setSent(false)
          changed()
        }}
        rows={2}
      />
      <div className="whiteboard-tools">
        <button className={tool === 'pen' ? 'on' : ''} onClick={() => setTool('pen')}>Pen</button>
        <button className={tool === 'eraser' ? 'on' : ''} onClick={() => setTool('eraser')}>Eraser</button>
        <button onClick={() => board.undo() && changed()}>Undo</button>
        <button onClick={() => (board.clear(), changed())}>Clear</button>
        <span className="spacer" />
        <button className="done" onClick={done} disabled={board.isEmpty()}>{sent ? 'Sent' : 'Done'}</button>
      </div>
    </div>
  )
}

registerView('whiteboard', WhiteboardView)
