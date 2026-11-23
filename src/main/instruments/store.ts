import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { SavedInstrument, SavedRecording } from '@shared/features/sampler'
import type { HeardNote } from '@shared/music/capture'

/**
 * Captured instruments on disk, one folder each:
 *
 *   <dir>/<name>/instrument.json   the manifest (zones, coverage, when it was made)
 *   <dir>/<name>/<note>.wav        one mono 16-bit WAV per captured note
 *   <dir>/<name>/recording.wav     the audio it was built from
 *   <dir>/<name>/recording.json    the notes heard in that audio
 *
 * A WAV dropped into <dir>/recordings/ can also be built from, by file name.
 */
export class InstrumentStore {
  constructor(private readonly dir: string) {}

  /** Lower-case letters, digits and dashes: safe as a folder name and easy to say. */
  static slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  }

  async names(): Promise<string[]> {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => [])
    return entries.filter((e) => e.isDirectory() && e.name !== 'recordings').map((e) => e.name).sort()
  }

  /** Loose WAV files the player has put in the recordings folder, without the extension. */
  async looseRecordings(): Promise<string[]> {
    const entries = await readdir(join(this.dir, 'recordings')).catch(() => [])
    return entries.filter((f) => f.toLowerCase().endsWith('.wav')).map((f) => f.slice(0, -4)).sort()
  }

  async save(instrument: SavedInstrument, recording?: SavedRecording): Promise<string> {
    const folder = join(this.dir, instrument.def.name)
    await rm(folder, { recursive: true, force: true })
    await mkdir(folder, { recursive: true })
    const { files, ...manifest } = instrument
    await writeFile(join(folder, 'instrument.json'), JSON.stringify(manifest, null, 2))
    for (const [file, bytes] of Object.entries(files)) await writeFile(join(folder, basename(file)), bytes)
    if (recording) {
      await writeFile(join(folder, 'recording.wav'), recording.wav)
      await writeFile(join(folder, 'recording.json'), JSON.stringify({ notes: recording.notes }))
    }
    return folder
  }

  async load(name: string): Promise<SavedInstrument | null> {
    try {
      const folder = join(this.dir, name)
      const manifest = JSON.parse(await readFile(join(folder, 'instrument.json'), 'utf8')) as Omit<SavedInstrument, 'files'>
      const files: Record<string, Uint8Array> = {}
      for (const zone of manifest.def.zones) files[zone.sample] = new Uint8Array(await readFile(join(folder, basename(zone.sample))))
      return { ...manifest, files }
    } catch {
      return null
    }
  }

  async loadAll(): Promise<SavedInstrument[]> {
    const loaded = await Promise.all((await this.names()).map((name) => this.load(name)))
    return loaded.filter((i): i is SavedInstrument => i !== null)
  }

  /** The audio a captured instrument was built from, or a loose WAV from the recordings folder. */
  async recording(name: string): Promise<SavedRecording | null> {
    const slug = InstrumentStore.slug(name)
    try {
      const folder = join(this.dir, slug)
      const wav = new Uint8Array(await readFile(join(folder, 'recording.wav')))
      const notes = await readFile(join(folder, 'recording.json'), 'utf8').then((json) => (JSON.parse(json) as { notes: HeardNote[] }).notes, () => [])
      return { wav, notes }
    } catch {
      // Not a captured instrument's recording; try the loose files.
    }
    const loose = (await this.looseRecordings()).find((file) => file === name || InstrumentStore.slug(file) === slug)
    if (!loose) return null
    return { wav: new Uint8Array(await readFile(join(this.dir, 'recordings', `${loose}.wav`))), notes: [] }
  }

  async remove(name: string): Promise<boolean> {
    if (!(await this.names()).includes(name)) return false
    await rm(join(this.dir, name), { recursive: true, force: true })
    return true
  }
}
