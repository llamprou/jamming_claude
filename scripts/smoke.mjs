// Launches the built app, plays a chord over the MIDI bridge and checks the
// live view names it. Run `npm run build` first. On Linux: `xvfb-run -a npm run smoke`.
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'jam-smoke-'))
const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
  env: { ...process.env, JAM_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '' },
})
try {
  const page = await app.firstWindow()
  await page.waitForSelector('.chords')
  await page.evaluate(() => {
    for (const pitch of [62, 65, 69, 72]) window.jam.midi('on', pitch, 0.8, 0)
  })
  await page.waitForFunction(() => document.querySelector('.chords .now')?.textContent === 'Dm7', null, { timeout: 5000 })
  await page.selectOption('select', 'piano')
  await page.waitForSelector('.diagram svg')
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] })
  console.log('smoke ok: window up, MIDI in -> Dm7 on screen, piano diagram drawn')
} finally {
  await app.close()
}
