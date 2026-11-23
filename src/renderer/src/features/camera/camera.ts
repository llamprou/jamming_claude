import { CAMERA, type CameraEvent, type CameraFrame, type CameraRequest, type CameraStatus, type HandReadout, type MarkPoint, type MarkReply } from '@shared/features/camera'
import { handActivity } from '@shared/music/vision/gesture'
import { fretHints, keyboardHints } from '@shared/music/vision/hints'
import { keyboardHands, type KeyboardCalibration, type KeyboardHandsHint } from '@shared/music/vision/keyboard'
import { distance, landmark, LM, mean, type HandFrame, type Point, type Side, type TrackedHand } from '@shared/music/vision/landmarks'
import { frettingHint, steadyHint, type HandPositionHint, type NeckCalibration } from '@shared/music/vision/neck'
import { sessionNow } from '../../audio/context'
import { sendFeature } from '../bus'
import type { RawHand, TrackerRequest, TrackerResponse } from './tracker.worker'
import './camera.css'

/**
 * The window's camera. Off until the agent asks. While on it does three
 * things, all on this machine:
 *  - keeps the live picture available to the camera view;
 *  - runs the hand tracker in a worker at a modest rate and turns what it
 *    sees into hints for tablature and staff splitting;
 *  - keeps one small JPEG a second for the last few seconds, so the agent
 *    can look at a moment that has just passed.
 * A picture leaves the machine only inside the answer to a 'frame' request,
 * which the agent's `look` tool makes.
 */

const TRACK_INTERVAL_MS = 80 // about 12 frames a second
const TRACK_MAX_SIDE = 512
const HISTORY_SECONDS = 20
const LOOK_MAX_SIDE = 768
const LOOK_QUALITY = 0.7
const HINT_INTERVAL_S = 0.25
const TRACK_STALL_S = 15 // a frame that takes this long means the tracker has hung

/** What the camera view reads. Mutated in place; `subscribe` fires on coarse changes, `frame` changes every tracker frame. */
export const camera = {
  on: false,
  stream: null as MediaStream | null,
  label: '',
  cameras: [] as string[],
  width: 0,
  height: 0,
  tracking: 'off' as CameraStatus['tracking'],
  trackingDetail: undefined as string | undefined,
  fps: 0,
  /** Latest tracker result. */
  frame: null as HandFrame | null,
  neck: null as NeckCalibration | null,
  keyboard: null as KeyboardCalibration | null,
  fretHint: null as HandPositionHint | null,
  keyboardHint: null as KeyboardHandsHint | null,
}

const listeners = new Set<() => void>()
let version = 0
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const cameraVersion = (): number => version
function changed(): void {
  version++
  for (const listener of listeners) listener()
  indicator.hidden = !camera.on
}

/* ---------- the on-screen "camera on" light ---------- */

// Shown whenever the camera is on, whether or not the camera view is open.
const indicator = document.createElement('div')
indicator.className = 'camera-light'
indicator.setAttribute('role', 'status')
indicator.textContent = 'camera on'
indicator.hidden = true

/* ---------- capture ---------- */

const video = document.createElement('video')
video.muted = true
video.playsInline = true

let generation = 0 // bumped on every start and stop, so late async results are dropped
let history: Array<{ time: number; blob: Blob; width: number; height: number }> = []
let historyTimer: ReturnType<typeof setInterval> | undefined

const videoInputs = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')

async function open(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  })
}

async function start(wanted?: string): Promise<CameraStatus> {
  const want = wanted?.trim().toLowerCase()
  if (camera.on && (!want || camera.label.toLowerCase().includes(want))) return status()
  if (camera.on) stop()
  const mine = ++generation

  let stream = await open()
  // Device names are only readable once permission has been granted, so choose after opening.
  const devices = await videoInputs()
  const names = devices.map((d) => d.label || 'camera')
  let note: string | undefined
  if (want) {
    const match = devices.find((d) => d.label.toLowerCase().includes(want))
    if (!match) note = `No camera named like "${wanted}"; using the default.`
    else if (match.deviceId !== stream.getVideoTracks()[0]?.getSettings().deviceId) {
      stream.getTracks().forEach((t) => t.stop())
      stream = await open(match.deviceId)
    }
  }
  if (mine !== generation) {
    stream.getTracks().forEach((t) => t.stop())
    return status()
  }

  const track = stream.getVideoTracks()[0]!
  track.addEventListener('ended', () => mine === generation && stop('The camera stopped (unplugged or taken by another app).'))
  video.srcObject = stream
  await video.play()
  Object.assign(camera, { on: true, stream, label: track.label || 'camera', cameras: names, width: video.videoWidth, height: video.videoHeight, trackingDetail: note })
  if (!indicator.isConnected) document.body.appendChild(indicator)

  historyTimer = setInterval(() => void remember(mine), 1000)
  startTracker(mine)
  changed()
  return status()
}

function stop(reason?: string): CameraStatus {
  generation++
  clearInterval(historyTimer)
  stopTracker()
  camera.stream?.getTracks().forEach((t) => t.stop())
  video.srcObject = null
  history = []
  recent = []
  rawFret = []
  const wasOn = camera.on
  Object.assign(camera, { on: false, stream: null, label: '', width: 0, height: 0, tracking: 'off', trackingDetail: reason, fps: 0, frame: null, fretHint: null, keyboardHint: null })
  if (wasOn) send({ type: 'off', reason })
  changed()
  return status()
}

const send = (event: CameraEvent) => sendFeature(CAMERA, event)

/** The current picture as a JPEG no bigger than maxSide on its longest side. */
async function snap(maxSide: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight))
  const width = Math.max(1, Math.round(video.videoWidth * scale))
  const height = Math.max(1, Math.round(video.videoHeight * scale))
  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d')!.drawImage(video, 0, 0, width, height)
  return { blob: await canvas.convertToBlob({ type: 'image/jpeg', quality }), width, height }
}

async function remember(mine: number): Promise<void> {
  if (video.readyState < 2) return
  const time = sessionNow()
  const shot = await snap(LOOK_MAX_SIDE, LOOK_QUALITY)
  if (mine !== generation) return
  history.push({ time, ...shot })
  history = history.filter((h) => h.time >= time - HISTORY_SECONDS)
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

async function frame(request: Extract<CameraRequest, { type: 'frame' }>): Promise<CameraFrame> {
  if (!camera.on || video.readyState < 2) throw new Error('The camera is off.')
  const now = sessionNow()
  const ago = request.secondsAgo ?? 0
  const maxSide = Math.max(64, Math.min(1568, request.maxSide ?? LOOK_MAX_SIDE))
  let shot: { time: number; blob: Blob; width: number; height: number } | undefined
  if (ago >= 0.75) shot = history.reduce<typeof shot>((best, h) => (!best || Math.abs(h.time - (now - ago)) < Math.abs(best.time - (now - ago)) ? h : best), undefined)
  shot ??= { time: now, ...(await snap(maxSide, request.quality ?? LOOK_QUALITY)) }
  return { data: await toBase64(shot.blob), mimeType: 'image/jpeg', width: shot.width, height: shot.height, time: shot.time, status: status() }
}

/* ---------- hand tracking ---------- */

let worker: Worker | null = null
let trackTimer: ReturnType<typeof setInterval> | undefined
let busy = false
let nextId = 1
let sentAt = new Map<number, number>()
let recent: HandFrame[] = [] // about the last second
let rawFret: HandPositionHint[] = []
let lastHintAt = 0

function startTracker(mine: number): void {
  camera.tracking = 'loading'
  busy = true // until the model is ready
  sentAt = new Map()
  worker = new Worker(new URL('./tracker.worker.ts', import.meta.url), { type: 'module' })
  const unavailable = (detail: string) => {
    if (mine !== generation) return
    stopTracker()
    Object.assign(camera, { tracking: 'unavailable', trackingDetail: detail })
    changed()
  }
  worker.onerror = (event) => unavailable(event.message || 'The hand tracker could not start.')
  worker.onmessage = (message: MessageEvent<TrackerResponse>) => {
    if (mine !== generation) return
    const response = message.data
    if (response.type === 'failed') return unavailable(response.error)
    busy = false
    if (response.type === 'ready') {
      camera.tracking = 'on'
      return changed()
    }
    const time = sentAt.get(response.id) ?? sessionNow()
    sentAt.delete(response.id)
    if (response.type === 'hands') onHands(response.hands, time)
  }
  worker.postMessage({ type: 'init' } satisfies TrackerRequest)

  trackTimer = setInterval(() => {
    const oldest = Math.min(...sentAt.values())
    if (sessionNow() - oldest > TRACK_STALL_S) return unavailable('The hand tracker stopped answering.')
    if (busy || !worker || video.readyState < 2 || document.hidden) return
    busy = true
    const scale = Math.min(1, TRACK_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight))
    const time = sessionNow()
    createImageBitmap(video, { resizeWidth: Math.round(video.videoWidth * scale), resizeHeight: Math.round(video.videoHeight * scale), resizeQuality: 'low' }).then(
      (bitmap) => {
        if (mine !== generation || !worker) return bitmap.close()
        const id = nextId++
        sentAt.set(id, time)
        worker.postMessage({ type: 'frame', id, bitmap } satisfies TrackerRequest, [bitmap])
      },
      () => (busy = false),
    )
  }, TRACK_INTERVAL_MS)
}

function stopTracker(): void {
  clearInterval(trackTimer)
  worker?.terminate()
  worker = null
  busy = false
}

/**
 * MediaPipe's "Left" and "Right" are taken as the player's own left and right
 * in the picture as the camera delivers it (not mirrored). Checked against a
 * sample photo; older MediaPipe releases assumed a mirrored selfie instead, so
 * if hands ever come out swapped on real cameras, this is the line to flip.
 */
const toHand = (raw: RawHand): TrackedHand => ({ side: raw.label === 'Left' ? 'left' : 'right', score: raw.score, landmarks: raw.landmarks })

function onHands(raw: RawHand[], time: number): void {
  const aspect = video.videoWidth / Math.max(1, video.videoHeight)
  const hands = raw.map(toHand)
  const current: HandFrame = { time, aspect, hands }
  camera.frame = current
  recent.push(current)
  recent = recent.filter((f) => f.time >= time - 1)
  camera.fps = recent.length

  if (camera.neck) {
    // The fretting hand is whichever hand is on the neck; the other is over the body, past the last fret.
    const best = hands
      .flatMap((hand) => frettingHint(camera.neck!, hand, time) ?? [])
      .sort((a, b) => b.confidence - a.confidence)[0]
    if (best) rawFret.push(best)
    rawFret = rawFret.filter((h) => h.time >= time - 0.8)
  }
  if (time - lastHintAt < HINT_INTERVAL_S) return
  lastHintAt = time

  const fret = camera.neck && rawFret.length >= 2 ? steadyHint(rawFret) : null
  camera.fretHint = fret
  if (fret) {
    fretHints.add(fret)
    send({ type: 'fret-hint', hint: fret })
  }
  const keys = camera.keyboard ? keyboardHands(camera.keyboard, hands, time) : null
  camera.keyboardHint = keys
  if (keys && keys.confidence > 0) {
    keyboardHints.add(keys)
    send({ type: 'keyboard-hint', hint: keys })
  }
}

/* ---------- marking where the instrument is ---------- */

const marks: { neck: { instrument: 'guitar' | 'bass'; nut?: Point; ref?: Point; refFret: number }; keyboard: { low?: Point; lowPitch: number; high?: Point; highPitch: number } } = {
  neck: { instrument: 'guitar', refFret: 12 },
  keyboard: { lowPitch: 21, highPitch: 108 },
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Where the index fingertip of the chosen hand is being held, once it has been still for a moment. */
async function heldFingertip(prefer: Side | undefined): Promise<{ point: Point } | { problem: string }> {
  if (camera.tracking !== 'on') return { problem: `Hand tracking is ${camera.tracking}${camera.trackingDetail ? ` (${camera.trackingDetail})` : ''}, so a touched point cannot be read. Look at the picture and pass x and y instead.` }
  const deadline = performance.now() + 3000
  let problem = 'No hand is in view. Ask them to bring the fingertip into the picture.'
  while (performance.now() < deadline) {
    const latest = recent[recent.length - 1]
    const sides = [...new Set(latest?.hands.map((h) => h.side) ?? [])]
    const side = prefer && sides.includes(prefer) ? prefer : sides.length === 1 ? sides[0] : sides.includes('left') ? 'left' : undefined
    if (side) {
      const window = recent.filter((f) => f.time >= (latest?.time ?? 0) - 0.5)
      if (handActivity(window, side).motion === 'still') {
        const tips = window.flatMap((f) => f.hands.filter((h) => h.side === side).map((h) => landmark(h, LM.indexTip)))
        return { point: mean(tips) }
      }
      problem = 'Their hand is moving. Ask them to hold the fingertip still on the spot, then try again.'
    }
    await sleep(150)
  }
  return { problem }
}

async function mark(request: Extract<CameraRequest, { type: 'mark' }>): Promise<MarkReply> {
  if (!camera.on) return { ok: false, message: 'The camera is off.', status: status() }
  const fail = (message: string): MarkReply => ({ ok: false, message, status: status() })
  const aspect = video.videoWidth / Math.max(1, video.videoHeight)
  let point: Point
  if (request.x !== undefined && request.y !== undefined) point = { x: request.x, y: request.y }
  else {
    const defaultSide: Side | undefined = request.point === 'high_key' ? 'right' : request.point === 'low_key' ? 'left' : undefined
    const held = await heldFingertip(request.hand ?? defaultSide)
    if ('problem' in held) return fail(held.problem)
    point = held.point
  }
  const where = `at ${point.x.toFixed(2)} across, ${point.y.toFixed(2)} down`

  if (request.point === 'nut' || request.point === 'fret') {
    const neck = marks.neck
    if (request.instrument) neck.instrument = request.instrument
    if (request.point === 'nut') neck.nut = point
    else {
      neck.ref = point
      neck.refFret = request.fret ?? 12
    }
    if (!neck.nut || !neck.ref) return { ok: true, message: `Marked the ${request.point === 'nut' ? 'nut' : `fret ${neck.refFret}`} ${where}. Now mark the ${neck.nut ? 'twelfth fret' : 'nut'}.`, status: status() }
    if (distance(neck.nut, neck.ref, aspect) < 0.08) return fail('The nut and the fret are marked at almost the same place. Mark them again, one at a time.')
    camera.neck = { instrument: neck.instrument, nut: neck.nut, ref: neck.ref, refFret: neck.refFret, aspect }
    rawFret = []
    changed()
    return { ok: true, message: `Marked ${where}. The ${neck.instrument} neck is located: hand position now feeds tablature. It needs marking again if they or the camera move much.`, status: status() }
  }

  const keys = marks.keyboard
  if (request.point === 'low_key') {
    keys.low = point
    keys.lowPitch = request.pitch ?? 21
  } else {
    keys.high = point
    keys.highPitch = request.pitch ?? 108
  }
  if (!keys.low || !keys.high) return { ok: true, message: `Marked ${where}. Now mark the ${keys.low ? 'highest' : 'lowest'} key.`, status: status() }
  if (distance(keys.low, keys.high, aspect) < 0.15 || keys.highPitch - keys.lowPitch < 12) return fail('The two keys are marked too close together. Mark the lowest and the highest key in view.')
  camera.keyboard = { low: keys.low, lowPitch: keys.lowPitch, high: keys.high, highPitch: keys.highPitch, aspect }
  changed()
  return { ok: true, message: `Marked ${where}. The keyboard is located: which hand is where now feeds the staff split.`, status: status() }
}

function unmark(target: Extract<CameraRequest, { type: 'unmark' }>['target']): CameraStatus {
  if (target !== 'piano') {
    marks.neck = { instrument: 'guitar', refFret: 12 }
    camera.neck = null
    camera.fretHint = null
    rawFret = []
  }
  if (target === 'piano' || target === 'all') {
    marks.keyboard = { lowPitch: 21, highPitch: 108 }
    camera.keyboard = null
    camera.keyboardHint = null
  }
  changed()
  return status()
}

/* ---------- status ---------- */

function status(): CameraStatus {
  const latest = recent[recent.length - 1]
  const hands: HandReadout[] = (latest?.hands ?? []).map((hand) => {
    const activity = handActivity(recent, hand.side)
    return { side: hand.side, score: hand.score, motion: activity.motion, raised: activity.raised }
  })
  const neckPoints: MarkPoint[] = [...(marks.neck.nut ? (['nut'] as const) : []), ...(marks.neck.ref ? (['fret'] as const) : [])]
  const keyboardPoints: MarkPoint[] = [...(marks.keyboard.low ? (['low_key'] as const) : []), ...(marks.keyboard.high ? (['high_key'] as const) : [])]
  return {
    on: camera.on,
    camera: camera.label || undefined,
    cameras: camera.cameras,
    width: camera.width || undefined,
    height: camera.height || undefined,
    tracking: camera.tracking,
    trackingDetail: camera.trackingDetail,
    fps: camera.on ? camera.fps : undefined,
    hands,
    marked: { neck: camera.neck?.instrument ?? null, neckPoints, keyboard: camera.keyboard !== null, keyboardPoints },
    fretHint: camera.fretHint,
    keyboardHint: camera.keyboardHint,
  }
}

/** Answers every request main makes on the camera's bus name. */
export async function answer(message: unknown): Promise<CameraStatus | CameraFrame | MarkReply> {
  const request = message as CameraRequest
  switch (request.type) {
    case 'start':
      return start(request.camera).catch((error: unknown) => {
        stop()
        throw new Error(`The camera could not be opened: ${error instanceof Error ? error.message : String(error)}`)
      })
    case 'stop':
      return stop()
    case 'status':
      return status()
    case 'frame':
      return frame(request)
    case 'mark':
      return mark(request)
    case 'unmark':
      return unmark(request.target)
  }
}
