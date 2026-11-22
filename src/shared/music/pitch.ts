/**
 * Fast monophonic pitch detection (YIN). This is the low-latency, lossy half
 * of audio transcription: it gives a note within tens of milliseconds but
 * hears only one pitch at a time. Polyphony is the slow pass's job.
 */

export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440)

export function detectPitch(frame: Float32Array, sampleRate: number, opts: { minHz?: number; maxHz?: number; threshold?: number } = {}): number | null {
  const minHz = opts.minHz ?? 40
  const maxHz = opts.maxHz ?? 1600
  const threshold = opts.threshold ?? 0.12

  let energy = 0
  for (let i = 0; i < frame.length; i++) energy += frame[i]! * frame[i]!
  if (Math.sqrt(energy / frame.length) < 0.01) return null // silence

  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz))
  const tauMax = Math.min(Math.floor(frame.length / 2), Math.ceil(sampleRate / minHz))
  const window = frame.length - tauMax
  const difference = new Float32Array(tauMax + 1)
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0
    for (let i = 0; i < window; i++) {
      const delta = frame[i]! - frame[i + tau]!
      sum += delta * delta
    }
    difference[tau] = sum
  }

  // Cumulative mean normalised difference.
  let running = 0
  let tauFound = -1
  const normalised = new Float32Array(tauMax + 1)
  normalised[0] = 1
  for (let tau = 1; tau <= tauMax; tau++) {
    running += difference[tau]!
    normalised[tau] = running === 0 ? 1 : (difference[tau]! * tau) / running
  }
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (normalised[tau]! < threshold) {
      while (tau + 1 <= tauMax && normalised[tau + 1]! < normalised[tau]!) tau++
      tauFound = tau
      break
    }
  }
  if (tauFound < 0) return null

  // Parabolic interpolation around the minimum for sub-sample accuracy.
  const a = normalised[tauFound - 1] ?? normalised[tauFound]!
  const b = normalised[tauFound]!
  const c = normalised[tauFound + 1] ?? normalised[tauFound]!
  const denominator = a - 2 * b + c
  const shift = denominator === 0 ? 0 : (a - c) / (2 * denominator)
  return sampleRate / (tauFound + shift)
}
