// Launches the built app and checks two paths end to end:
//  1. MIDI in -> chord named on screen.
//  2. Mic in (Chromium's fake capture device playing a synthesized chord
//     progression) -> polyphonic slow pass in the worker -> chords on screen.
// Run `npm run build` first. On Linux: `xvfb-run -a npm run smoke`.
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright')

const dir = mkdtempSync(join(tmpdir(), 'jam-smoke-'))

/** A looping 8 s WAV: Dm7, G7, Cmaj7 as plucked tones. */
function writeChordWav(path) {
  const rate = 48000
  const samples = new Float32Array(rate * 8)
  const chords = [[62, 65, 69, 72], [55, 59, 62, 65], [60, 64, 67, 71]]
  chords.forEach((pitches, c) => {
    for (const pitch of pitches) {
      const hz = 440 * 2 ** ((pitch - 69) / 12)
      const offset = Math.floor((0.5 + c * 2.4) * rate)
      for (let i = 0; i < 1.8 * rate; i++) {
        const t = i / rate
        const envelope = Math.min(1, t * 200) * Math.exp(-1.5 * t) * Math.min(1, (1.8 - t) * 50)
        let s = 0
        for (let h = 1; h <= 5; h++) s += Math.sin(2 * Math.PI * hz * h * t) / h ** 1.5
        samples[offset + i] += 0.15 * envelope * s
      }
    }
  })
  const wav = Buffer.alloc(44 + samples.length * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples.length * 2, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36)
  wav.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((s, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2))
  writeFileSync(path, wav)
}

const wavPath = join(dir, 'chords.wav')
writeChordWav(wavPath)

const app = await electron.launch({
  executablePath: require('electron'),
  args: [
    '.',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavPath}`,
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ],
  env: { ...process.env, JAM_DATA_DIR: dir, ANTHROPIC_API_KEY: '' },
})
try {
  const page = await app.firstWindow()
  page.on('console', (m) => (m.type() === 'error' || process.env.JAM_SMOKE_DEBUG) && console.error('renderer:', m.text()))
  page.on('pageerror', (e) => console.error('renderer error:', e.message))
  await page.waitForSelector('.chords')

  await page.evaluate(() => {
    for (const pitch of [62, 65, 69, 72]) window.jam.midi('on', pitch, 0.8, 0)
  })
  await page.waitForFunction(() => document.querySelector('.chords .now')?.textContent === 'Dm7', null, { timeout: 5000 })
  await page.evaluate(() => {
    for (const pitch of [62, 65, 69, 72]) window.jam.midi('off', pitch, 0, 0)
  })
  console.log('ok: MIDI in -> Dm7 on screen')

  await page.click('text=Mic off')
  // Audio only: wait until a chord that could only come from the polyphonic pass shows up.
  await page.waitForFunction(
    () => {
      const text = document.querySelector('.chords')?.textContent ?? ''
      const meta = document.querySelector('.meta')?.textContent ?? ''
      return meta.includes('polyphonic pass on') && /G7|Cmaj7/.test(text)
    },
    null,
    { timeout: Number(process.env.JAM_SMOKE_TIMEOUT ?? 120000) },
  ).catch(async (error) => {
    console.error('stuck at:', await page.textContent('.chords'), '|', await page.textContent('.meta'), '|', await page.textContent('.status'))
    throw error
  })
  console.log('ok: mic audio -> polyphonic pass ->', await page.textContent('.chords'), '|', await page.textContent('.meta'))
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] })
} finally {
  await app.close()
}
