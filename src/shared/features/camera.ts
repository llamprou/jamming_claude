import type { HandMotion } from '../music/vision/gesture'
import type { KeyboardHandsHint } from '../music/vision/keyboard'
import type { Side } from '../music/vision/landmarks'
import type { HandPositionHint } from '../music/vision/neck'

/** Bus traffic for the camera feature. Main asks; the window owns the camera and answers. */
export const CAMERA = 'camera'

/** What the hand tracker is asked to derive from the hands it sees. */
export type TrackTarget = 'guitar' | 'bass' | 'piano'

/** A reference point on the instrument, marked so positions in the picture mean something. */
export type MarkPoint = 'nut' | 'fret' | 'low_key' | 'high_key'

/** main -> window, with bus.request(CAMERA, ...). Each has a matching reply type below. */
export type CameraRequest =
  /** Turn the camera on (a no-op if it is on). `camera` picks a device by part of its name. Replies CameraStatus. */
  | { type: 'start'; camera?: string }
  /** Turn it off and drop every frame held. Replies CameraStatus. */
  | { type: 'stop' }
  /** Replies CameraStatus. */
  | { type: 'status' }
  /** The current picture (or the one nearest `secondsAgo`). Replies CameraFrame. Fails if the camera is off. */
  | { type: 'frame'; maxSide?: number; quality?: number; secondsAgo?: number }
  /**
   * Mark a reference point. With x and y (0-1 across and down the picture as
   * `frame` returns it) the point is taken as given; without, it is where the
   * player's index fingertip is being held. Replies MarkReply.
   */
  | { type: 'mark'; point: MarkPoint; instrument?: 'guitar' | 'bass'; fret?: number; pitch?: number; hand?: Side; x?: number; y?: number }
  /** Forget marked points. Replies CameraStatus. */
  | { type: 'unmark'; target: TrackTarget | 'all' }

export interface CameraFrame {
  /** Base64, no data: prefix. */
  data: string
  mimeType: string
  width: number
  height: number
  /** Session-clock time the picture was taken. */
  time: number
  status: CameraStatus
}

export interface HandReadout {
  side: Side
  score: number
  motion: HandMotion
  raised: boolean
}

export interface CameraStatus {
  on: boolean
  /** The device in use. */
  camera?: string
  /** Every camera the machine offers (names are only known once permission is granted). */
  cameras: string[]
  width?: number
  height?: number
  /** The hand tracker: 'off' with the camera, 'loading' while the model starts, 'unavailable' if it cannot run here. */
  tracking: 'off' | 'loading' | 'on' | 'unavailable'
  trackingDetail?: string
  /** Tracker frames per second, recently. */
  fps?: number
  hands: HandReadout[]
  /** Which instruments have had their position marked. */
  marked: { neck: 'guitar' | 'bass' | null; neckPoints: MarkPoint[]; keyboard: boolean; keyboardPoints: MarkPoint[] }
  fretHint: HandPositionHint | null
  keyboardHint: KeyboardHandsHint | null
}

export interface MarkReply {
  ok: boolean
  /** Written for the model: what was recorded, or why not and what to ask the player. */
  message: string
  status: CameraStatus
}

/** window -> main, with sendFeature(CAMERA, ...). A few a second at most. */
export type CameraEvent =
  | { type: 'fret-hint'; hint: HandPositionHint }
  | { type: 'keyboard-hint'; hint: KeyboardHandsHint }
  /** The camera went off (asked, unplugged, or failed): hints up to now are all there will be. */
  | { type: 'off'; reason?: string }
