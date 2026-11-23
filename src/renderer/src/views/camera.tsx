import { useEffect, useRef, useSyncExternalStore } from 'react'
import { noteName } from '@shared/music/analysis'
import { HAND_BONES, type Point } from '@shared/music/vision/landmarks'
import { bridgePoint, fretPoint } from '@shared/music/vision/neck'
import { camera, cameraVersion, subscribe } from '../features/camera/camera'
import { registerView } from './registry'

/**
 * What the buddy sees: the live picture, the hands the tracker has found, and
 * the neck or keyboard once its position has been marked. Opened by the agent
 * like any other view; it does not turn the camera on or off itself.
 */

const HAND_COLOURS = { left: '#5ac8fa', right: '#f5a524' } as const

function draw(canvas: HTMLCanvasElement): void {
  const width = camera.width || 1280
  const height = camera.height || 720
  if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height })
  const g = canvas.getContext('2d')!
  g.clearRect(0, 0, width, height)
  const px = (p: Point): [number, number] => [p.x * width, p.y * height]
  const line = (a: Point, b: Point) => {
    g.beginPath()
    g.moveTo(...px(a))
    g.lineTo(...px(b))
    g.stroke()
  }
  const unit = Math.max(2, height / 240)

  if (camera.neck) {
    const nut = camera.neck.nut
    const bridge = bridgePoint(camera.neck)
    g.strokeStyle = 'rgb(255 255 255 / 0.8)'
    g.lineWidth = unit
    line(nut, fretPoint(camera.neck, 24))
    // Fret wires as short ticks square to the neck; the usual dot frets drawn heavier.
    const [nx, ny] = [-(bridge.y - nut.y) * height, (bridge.x - nut.x) * width]
    const length = Math.hypot(nx, ny) || 1
    for (let fret = 0; fret <= 24; fret++) {
      const [x, y] = px(fretPoint(camera.neck, fret))
      const half = (fret === 0 || fret === 12 ? 7 : [3, 5, 7, 9, 15, 17].includes(fret) ? 5 : 3) * unit
      g.beginPath()
      g.moveTo(x - (nx / length) * half, y - (ny / length) * half)
      g.lineTo(x + (nx / length) * half, y + (ny / length) * half)
      g.stroke()
    }
  }
  if (camera.keyboard) {
    g.strokeStyle = 'rgb(255 255 255 / 0.8)'
    g.lineWidth = unit
    line(camera.keyboard.low, camera.keyboard.high)
    for (const end of [camera.keyboard.low, camera.keyboard.high]) {
      g.beginPath()
      g.arc(...px(end), unit * 3, 0, Math.PI * 2)
      g.stroke()
    }
  }

  // Only what the tracker saw in the last half second: a stale hand is worse than none.
  const frame = camera.frame
  if (!frame || performance.now() / 1000 - lastFrameSeen.at > 0.5) return
  for (const hand of frame.hands) {
    g.strokeStyle = g.fillStyle = HAND_COLOURS[hand.side]
    g.lineWidth = unit
    for (const [a, b] of HAND_BONES) if (hand.landmarks[a] && hand.landmarks[b]) line(hand.landmarks[a], hand.landmarks[b])
    for (const point of hand.landmarks) {
      g.beginPath()
      g.arc(...px(point), unit * 1.5, 0, Math.PI * 2)
      g.fill()
    }
  }
}

// When the frame object last changed, on the local clock (the frame's own time is on the session clock).
const lastFrameSeen = { frame: null as unknown, at: 0 }

function CameraView() {
  const version = useSyncExternalStore(subscribe, cameraVersion)
  const video = useRef<HTMLVideoElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const readout = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (video.current && video.current.srcObject !== camera.stream) video.current.srcObject = camera.stream
  }, [version])

  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (camera.frame !== lastFrameSeen.frame) Object.assign(lastFrameSeen, { frame: camera.frame, at: performance.now() / 1000 })
      if (overlay.current) draw(overlay.current)
      if (readout.current) readout.current.textContent = describe()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  if (!camera.on) return <div className="camera-view"><p className="quiet">The camera is off.</p></div>
  return (
    <div className="camera-view">
      <div className="camera-picture">
        <video ref={video} autoPlay muted playsInline />
        <canvas ref={overlay} />
      </div>
      <div className="camera-readout">
        <span className="live">Camera on · {camera.label}</span>
        <span>{camera.tracking === 'on' ? 'tracking hands' : camera.tracking === 'loading' ? 'hand tracking starting' : `hand tracking ${camera.tracking}${camera.trackingDetail ? `: ${camera.trackingDetail}` : ''}`}</span>
        <span ref={readout} className="camera-hands" />
      </div>
    </div>
  )
}

function describe(): string {
  const parts: string[] = []
  const hands = camera.frame?.hands ?? []
  if (camera.tracking === 'on') parts.push(hands.length ? `${hands.map((h) => h.side).sort().join(' and ')} hand${hands.length > 1 ? 's' : ''}` : 'no hands in view')
  const fret = camera.fretHint
  if (fret && fret.confidence >= 0.3) parts.push(fret.lowFret === fret.highFret ? `fret ${fret.lowFret}` : `frets ${fret.lowFret}–${fret.highFret}`)
  const keys = camera.keyboardHint
  if (keys?.split != null && keys.confidence >= 0.3) parts.push(`hands split at ${noteName(keys.split)}`)
  return parts.join(' · ')
}

registerView('camera', CameraView)
