/**
 * Screenshots for the agent: what it may capture, how big, and the short
 * buffer of recent snapshots kept while it is watching. Pure; the Electron
 * capture lives in src/main/screen/.
 */

/** `app` is this app's own window (the views); `screen` is the whole display the app is on. */
export type ScreenTarget = 'app' | 'screen'

export interface ScreenShot {
  /** Base64, no data: prefix. */
  data: string
  mimeType: 'image/jpeg' | 'image/png'
  width: number
  height: number
  /** Session clock, seconds. */
  time: number
  target: ScreenTarget
}

/** Captures stills on demand. Throws an Error whose message is written for the model (e.g. missing permission). */
export interface ScreenCapturer {
  capture(target: ScreenTarget, options?: { maxEdge?: number; quality?: number }): Promise<ScreenShot>
}

/** Longer edges are downscaled by the model anyway; sending more only costs time. */
export const MAX_EDGE = 1568

/** Scale a size down (never up) so its longer edge fits `maxEdge`, keeping the aspect ratio. */
export function fitWithin(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest <= 0) return { width: Math.round(width), height: Math.round(height) }
  const scale = maxEdge / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** The last few seconds of snapshots, held in memory only while the agent is watching. */
export class SnapshotBuffer {
  private shots: ScreenShot[] = []

  constructor(readonly keepSeconds: number) {}

  add(shot: ScreenShot): void {
    this.shots.push(shot)
    this.shots = this.shots.filter((s) => s.time >= shot.time - this.keepSeconds)
  }

  /** The snapshot nearest to `secondsAgo` before `now`, or null when none is held. */
  pick(now: number, secondsAgo: number): ScreenShot | null {
    const target = now - secondsAgo
    let best: ScreenShot | null = null
    for (const shot of this.shots) if (!best || Math.abs(shot.time - target) < Math.abs(best.time - target)) best = shot
    return best
  }

  clear(): void {
    this.shots = []
  }

  get size(): number {
    return this.shots.length
  }
}

/** What to tell the model when macOS has not granted Screen Recording. `appName` is what the player will see in System Settings. */
export function permissionMessage(status: string, appName: string): string {
  const where = `System Settings, Privacy & Security, Screen & System Audio Recording, switch on ${appName}, then quit and reopen this app`
  const lead =
    status === 'restricted'
      ? 'Screen capture is blocked on this Mac by a management policy, so you cannot see the whole screen.'
      : status === 'not-determined'
        ? 'macOS has just asked the player for Screen Recording permission. Ask them to allow it in the prompt, or in'
        : 'You cannot see the whole screen: macOS has not given this app Screen Recording permission. Ask the player to open'
  const tail = 'Until then you can still look at this app\'s own window with target "app".'
  return status === 'restricted' ? `${lead} ${tail}` : `${lead} ${where}. ${tail}`
}
