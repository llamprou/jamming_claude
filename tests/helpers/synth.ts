/** Plucked-string-like tones with harmonics, for testing transcription without recordings. */
export function synth(seconds: number, notes: Array<{ pitch: number; start: number; duration: number }>, sampleRate = 22050): Float32Array {
  const audio = new Float32Array(Math.ceil(seconds * sampleRate))
  for (const note of notes) {
    const hz = 440 * 2 ** ((note.pitch - 69) / 12)
    const offset = Math.floor(note.start * sampleRate)
    for (let i = 0; i < note.duration * sampleRate && offset + i < audio.length; i++) {
      const t = i / sampleRate
      const envelope = Math.min(1, t * 200) * Math.exp(-1.5 * t) * Math.min(1, (note.duration - t) * 50)
      let sample = 0
      for (let h = 1; h <= 5; h++) sample += Math.sin(2 * Math.PI * hz * h * t) / h ** 1.5
      audio[offset + i]! += 0.15 * envelope * sample
    }
  }
  return audio
}

export const chord = (pitches: number[], start: number, duration: number) => pitches.map((pitch) => ({ pitch, start, duration }))
