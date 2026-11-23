import { peakLevel, trimLeadingSilence } from '@shared/music/capture'
import type { InstrumentDef, Zone } from '@shared/music/sampler'
import { generateStandIn, type StandIn } from '@shared/music/synthkit'
import { audioContext } from '../../audio/context'
import { addInstrument, getInstrument, monoBuffer, type LoadedInstrument } from './engine'

/**
 * The instruments every session starts with. Real samples come from the
 * `stock/` folder next to this file, which scripts/fetch-samples.mjs fills and
 * the build bundles as ordinary files of the app (nothing is fetched from the
 * network at run time). Any instrument missing from that folder gets a
 * synthesized stand-in instead, labelled as such.
 */

interface StockManifest {
  instruments: Array<{
    name: string
    label: string
    kind: InstrumentDef['kind']
    release?: number
    /** Longest stretch of each recording worth keeping in memory. */
    maxSeconds?: number
    credit: string
    zones: Zone[]
  }>
}

// Both globs are empty when the samples have not been fetched; the build still works.
const manifests = import.meta.glob<StockManifest>('./stock/manifest.json', { eager: true, import: 'default' })
const urls = import.meta.glob<string>('./stock/**/*.mp3', { eager: true, query: '?url&no-inline', import: 'default' })

const STAND_INS: StandIn[] = ['piano', 'guitar', 'bass', 'drums']
/** Playback level for a full-scale sample at full velocity; several notes sound at once. */
const LEVEL = { pitched: 0.35, drums: 0.5 }

async function decodeMono(url: string, maxSeconds: number): Promise<{ samples: Float32Array; sampleRate: number }> {
  const bytes = await (await fetch(url)).arrayBuffer()
  const decoded = await audioContext().decodeAudioData(bytes)
  const mixed = new Float32Array(decoded.length)
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const channel = decoded.getChannelData(c)
    for (let i = 0; i < mixed.length; i++) mixed[i]! += channel[i]! / decoded.numberOfChannels
  }
  const trimmed = trimLeadingSilence(mixed, decoded.sampleRate)
  const samples = Float32Array.from(trimmed.subarray(0, Math.round(maxSeconds * decoded.sampleRate)))
  if (samples.length < trimmed.length) {
    // Shortened: fade the cut over 150 ms.
    const fade = Math.min(samples.length, Math.round(decoded.sampleRate * 0.15))
    for (let i = 0; i < fade; i++) samples[samples.length - 1 - i]! *= i / fade
  }
  return { samples, sampleRate: decoded.sampleRate }
}

async function loadSampled(entry: StockManifest['instruments'][number]): Promise<LoadedInstrument> {
  const buffers = new Map<string, AudioBuffer>()
  let loudest = 0
  // One at a time, yielding between files: decoding everything at once stalls
  // the window for about a second at launch, which the transport's timing cannot afford.
  for (const zone of entry.zones) {
    const url = urls[`./stock/${zone.sample}`]
    if (!url) throw new Error(`stock sample ${zone.sample} is listed but was not bundled`)
    const { samples, sampleRate } = await decodeMono(url, entry.maxSeconds ?? 4)
    loudest = Math.max(loudest, peakLevel(samples))
    buffers.set(zone.sample, monoBuffer(samples, sampleRate))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  // Bring the loudest recording to full scale; recordings keep their balance with each other.
  const gain = (LEVEL[entry.kind] * 0.9) / (loudest || 1)
  return { def: { name: entry.name, label: entry.label, kind: entry.kind, origin: 'sampled', zones: entry.zones, release: entry.release, gain, credit: entry.credit }, buffers }
}

function loadStandIn(which: StandIn): LoadedInstrument {
  const generated = generateStandIn(which)
  const buffers = new Map<string, AudioBuffer>()
  for (const [id, samples] of generated.samples) buffers.set(id, monoBuffer(samples, generated.sampleRate))
  return { def: generated.def, buffers }
}

/** Load real samples where they are bundled, stand-ins for the rest. */
export async function loadStock(): Promise<void> {
  const entries = Object.values(manifests)[0]?.instruments ?? []
  for (const entry of entries) {
    try {
      addInstrument(await loadSampled(entry))
    } catch (error) {
      console.warn(`sampler: could not load stock ${entry.name}, using a synthesized stand-in`, error)
    }
  }
  for (const which of STAND_INS) {
    if (getInstrument(which)) continue
    addInstrument(loadStandIn(which))
    // Generating takes a moment; let the audio and UI threads breathe between instruments.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
