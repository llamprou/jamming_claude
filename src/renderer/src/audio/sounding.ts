import { SoundingLog } from '@shared/music/sounding'
import { sessionNow } from './context'

/**
 * Every note the app hands to WebAudio (the transport's layers and one-shot
 * clips), stamped on the session clock at the moment it is heard, so views can
 * light what is sounding in time with the sound.
 */
export const playedNotes = new SoundingLog()

/** Pitches the app is sounding right now, optionally only some parts (layer ids or track roles). */
export function playingNow(parts?: string[]): number[] {
  const now = sessionNow()
  playedNotes.prune(now)
  return playedNotes.at(now, parts)
}
