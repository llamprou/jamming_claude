/**
 * WAV files in and out, as plain bytes. Captured instruments are stored as
 * mono 16-bit WAVs so any other program can open them; reading accepts the
 * common PCM and float formats and mixes channels down to mono.
 */

export interface WavAudio {
  sampleRate: number
  samples: Float32Array
}

const ascii = (bytes: Uint8Array, offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length))

/** Mono, 16-bit PCM. Samples outside -1..1 are clipped. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  tag(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, Math.round(s * 32767), true)
  }
  return bytes
}

/** Throws with a plain message if the bytes are not a WAV this can read. */
export function decodeWav(bytes: Uint8Array): WavAudio {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') throw new Error('Not a WAV file.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the sub-format field.
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      if (!channels || !sampleRate) throw new Error('WAV file has no format chunk before its audio.')
      if (!((format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && bits === 32))) throw new Error(`Unsupported WAV encoding (format ${format}, ${bits} bits).`)
      const width = bits / 8
      const frames = Math.floor(Math.min(size, bytes.length - body) / (width * channels))
      const samples = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < channels; c++) {
          const at = body + (i * channels + c) * width
          if (format === 3) sum += view.getFloat32(at, true)
          else if (bits === 8) sum += (view.getUint8(at) - 128) / 128
          else if (bits === 16) sum += view.getInt16(at, true) / 32768
          else if (bits === 24) sum += ((view.getInt8(at + 2) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at)) / 8388608
          else sum += view.getInt32(at, true) / 2147483648
        }
        samples[i] = sum / channels
      }
      return { sampleRate, samples }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('WAV file has no audio data.')
}
