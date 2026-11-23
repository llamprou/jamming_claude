import type { Clip } from '@shared/music/types'
import { audioContext, musicOutput, sessionNow } from './context'
import { playedNotes } from './sounding'
import { voiceFor } from './voices'

/** One-shot playback of a clip, starting now. Anything already playing stops. */

/** Layer name one-shot clips use in the log of what is sounding. */
const ONE_SHOT = '(one-shot)'

let playing: AudioScheduledSourceNode[] = []
let playTimer: ReturnType<typeof setTimeout> | undefined

export function playClip(clip: Clip, onEnded?: () => void): void {
  stopClip()
  const lengthBeats = Math.max(0, ...clip.tracks.flatMap((t) => t.notes.map((n) => n.startBeat + n.durationBeats)))
  playTimer = setTimeout(() => onEnded?.(), (lengthBeats * 60 * 1000) / clip.bpm + 400)
  const beat = 60 / clip.bpm
  const audio = audioContext()
  const t0 = audio.currentTime + 0.08
  // When the first note is heard, on the session clock.
  const heardAt = sessionNow() + 0.08 + (Number.isFinite(audio.outputLatency) ? Math.min(audio.outputLatency, 0.3) : 0)
  for (const track of clip.tracks) {
    const voice = voiceFor(track)
    for (const n of track.notes) {
      playing.push(...voice.play(n, t0 + n.startBeat * beat, n.durationBeats * beat, musicOutput(), track))
      const start = heardAt + n.startBeat * beat
      playedNotes.add({ pitch: n.pitch, start, end: start + n.durationBeats * beat, layer: ONE_SHOT, role: track.role })
    }
  }
}

export function stopClip(): void {
  clearTimeout(playTimer)
  playedNotes.cut(sessionNow(), ONE_SHOT)
  for (const node of playing) {
    try {
      node.stop()
    } catch {
      // already stopped
    }
  }
  playing = []
}
