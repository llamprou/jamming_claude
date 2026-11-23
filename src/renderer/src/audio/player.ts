import type { Clip } from '@shared/music/types'
import { audioContext, musicOutput } from './context'
import { voiceFor } from './voices'

/** One-shot playback of a clip, starting now. Anything already playing stops. */

let playing: AudioScheduledSourceNode[] = []
let playTimer: ReturnType<typeof setTimeout> | undefined

export function playClip(clip: Clip, onEnded?: () => void): void {
  stopClip()
  const lengthBeats = Math.max(0, ...clip.tracks.flatMap((t) => t.notes.map((n) => n.startBeat + n.durationBeats)))
  playTimer = setTimeout(() => onEnded?.(), (lengthBeats * 60 * 1000) / clip.bpm + 400)
  const beat = 60 / clip.bpm
  const t0 = audioContext().currentTime + 0.08
  for (const track of clip.tracks) {
    const voice = voiceFor(track)
    for (const n of track.notes) playing.push(...voice.play(n, t0 + n.startBeat * beat, n.durationBeats * beat, musicOutput(), track))
  }
}

export function stopClip(): void {
  clearTimeout(playTimer)
  for (const node of playing) {
    try {
      node.stop()
    } catch {
      // already stopped
    }
  }
  playing = []
}
