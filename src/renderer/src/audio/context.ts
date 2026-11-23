/**
 * All sound in and out of the app goes through one AudioContext in the
 * window. That is deliberate: Chromium's echo canceller can only remove the
 * buddy's voice and playback from the mic if it plays them itself.
 */

let context: AudioContext | null = null
let master: GainNode | null = null

export const audioContext = (): AudioContext => (context ??= new AudioContext({ latencyHint: 'interactive' }))

/** Everything musical the app plays connects here, never straight to the destination. */
export function musicOutput(): AudioNode {
  if (!master) {
    master = audioContext().createGain()
    master.connect(audioContext().destination)
  }
  return master
}

/* ---------- session clock ---------- */

let clockOffset = 0
/** Called once at startup with (main-process session time - local time). */
export const setClockOffset = (offset: number) => (clockOffset = offset)
/** Seconds on the session clock shared with the main process and the transcript. */
export const sessionNow = (): number => performance.now() / 1000 + clockOffset
/** Convert a session time to this AudioContext's timeline, for scheduling. */
export const toAudioTime = (sessionTime: number): number => audioContext().currentTime + (sessionTime - sessionNow())

/* ---------- mic taps ---------- */

export type MicBlockListener = (block: Float32Array, sampleRate: number, sessionTime: number) => void
const micListeners = new Set<MicBlockListener>()

/**
 * Receive every block of raw mic samples (about 128 at a time) with the
 * session time at the end of the block. Features that need the mic (looping,
 * sampling, beat tracking) subscribe here; they never open the mic themselves.
 */
export function onMicBlock(listener: MicBlockListener): () => void {
  micListeners.add(listener)
  return () => micListeners.delete(listener)
}

/** Called by the mic module only. */
export function publishMicBlock(block: Float32Array, sampleRate: number, sessionTime: number): void {
  for (const listener of micListeners) listener(block, sampleRate, sessionTime)
}
