// Launches the built app and checks the sampler end to end, with Chromium's
// fake microphone playing synthesized single plucked notes:
//  1. Stock instruments load (real samples if fetched, else synthesized stand-ins)
//     and the voice registry picks them; a note rendered offline is in tune.
//  2. An instrument is captured from the fake mic using the notes the app's own
//     transcript heard, travels to the main process as WAV bytes, can be chosen
//     for a part, plays in tune at a pitch that was never recorded, and can be
//     handed back to the window the way a saved instrument is at startup.
// It stands in for the agent's tool module by speaking the feature bus's wire
// format directly (the tool module itself is covered by tests/sampler.test.ts).
// Run `npm run build` first. On Linux: `xvfb-run -a node scripts/smoke-sampler.mjs`.
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright')

const dir = mkdtempSync(join(tmpdir(), 'jam-smoke-sampler-'))
const PLAYED = [52, 55, 59, 62, 64, 67]
const hzOf = (pitch) => 440 * 2 ** ((pitch - 69) / 12)

/** A looping 8 s WAV: six single plucked notes, 1.2 s apart, each left to ring for a second. */
function writeNotesWav(path) {
  const rate = 48000
  const samples = new Float32Array(rate * 8)
  PLAYED.forEach((pitch, n) => {
    const offset = Math.floor((0.4 + n * 1.2) * rate)
    for (let i = 0; i < rate; i++) {
      const t = i / rate
      const envelope = Math.min(1, t * 200) * Math.exp(-2.5 * t) * Math.min(1, (1 - t) * 50)
      let s = 0
      for (let h = 1; h <= 5; h++) s += Math.sin(2 * Math.PI * hzOf(pitch) * h * t) / h ** 1.5
      samples[offset + i] += 0.25 * envelope * s
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

const check = (condition, message) => {
  if (!condition) throw new Error(message)
}
const near = (hz, pitch, cents = 25) => hz !== null && Math.abs(1200 * Math.log2(hz / hzOf(pitch))) < cents

const wavPath = join(dir, 'notes.wav')
writeNotesWav(wavPath)
const stockFetched = existsSync(new URL('../src/renderer/src/features/sampler/stock/manifest.json', import.meta.url))

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
  env: { ...process.env, JAM_DATA_DIR: dir, ANTHROPIC_API_KEY: '' },
})
const pageErrors = []
try {
  const page = await app.firstWindow()
  page.on('console', (m) => (m.type() === 'error' || process.env.JAM_SMOKE_DEBUG) && console.error('renderer:', m.text()))
  page.on('pageerror', (e) => pageErrors.push(e.message))

  // Speak the feature bus's wire format from the main process, as a tool module would through bus.request.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__sampler = { replies: new Map(), next: 900000, captured: null }
    ipcMain.on('jam:feature-reply', (_e, id, result, error) => globalThis.__sampler.replies.set(id, { result, error }))
  })
  const ask = (message) =>
    app.evaluate(async ({ BrowserWindow }, request) => {
      const state = globalThis.__sampler
      const id = state.next++
      // 'reload' hands the captured instrument back exactly as it arrived, as main does with saved ones.
      const message = request.type === 'reload' ? { type: 'load', instruments: [state.captured.instrument] } : request
      BrowserWindow.getAllWindows()[0].webContents.send('jam:event', { type: 'feature-request', id, feature: 'sampler', message })
      for (let i = 0; i < 300 && !state.replies.has(id); i++) await new Promise((resolve) => setTimeout(resolve, 100))
      const reply = state.replies.get(id)
      if (!reply) throw new Error(`no answer to ${message.type}`)
      if (reply.error) throw new Error(reply.error)
      if (message.type !== 'capture' || !reply.result.ok) return reply.result
      // Keep the audio in the main process; report what arrived.
      state.captured = reply.result
      const describe = (bytes) => ({ bytes: bytes.length, binary: bytes instanceof Uint8Array, riff: String.fromCharCode(...bytes.slice(0, 4)) })
      const { instrument, recording, ...rest } = reply.result
      return { ...rest, def: instrument.def, coverage: instrument.coverage, files: Object.entries(instrument.files).map(([name, bytes]) => ({ name, ...describe(bytes) })), recording: describe(recording.wav) }
    }, message)

  await page.waitForSelector('.orb')

  // 1. Stock instruments.
  let state
  for (let i = 0; i < 100; i++) {
    state = await ask({ type: 'state' }).catch(() => null)
    if (state && ['piano', 'guitar', 'bass', 'drums'].every((name) => state.instruments.some((x) => x.name === name))) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const origins = Object.fromEntries((state?.instruments ?? []).map((x) => [x.name, x.origin]))
  check(['piano', 'guitar', 'bass', 'drums'].every((name) => origins[name]), `stock instruments did not load: ${JSON.stringify(origins)}`)
  const expected = stockFetched ? 'sampled' : 'synthesized'
  check(Object.values(origins).every((origin) => origin === expected), `expected ${expected} stock instruments (samples ${stockFetched ? '' : 'not '}fetched), got ${JSON.stringify(origins)}. Rebuild after fetching?`)
  console.log(`ok: stock instruments loaded as ${expected}:`, state.instruments.map((x) => `${x.name} (${x.kind === 'drums' ? `${x.hits} hits` : `${x.pitches.length} notes`})`).join(', '))

  for (const [role, pitch, instrument] of [['chords', 69, 'piano'], ['melody', 61, 'piano'], ['bass', 40, 'bass'], ['bass', 43, 'bass'], ['solo', 64, 'guitar'], ['solo', 58, 'guitar']]) {
    const probe = await ask({ type: 'probe', role, pitch })
    check(probe.instrument === instrument, `${role} should play on ${instrument}, the registry chose ${probe.instrument}`)
    check(near(probe.hz, pitch), `${instrument} asked for ${hzOf(pitch).toFixed(1)} Hz rendered ${probe.hz?.toFixed(1)} Hz`)
    check(probe.peak > 0.02, `${instrument} rendered almost silent (peak ${probe.peak})`)
  }
  const kick = await ask({ type: 'probe', role: 'drums', pitch: 36 })
  check(kick.instrument === 'drums' && kick.peak > 0.02, `drums did not render: ${JSON.stringify(kick)}`)
  console.log('ok: voice registry picks the sampler for every part; offline renders are in tune (within 25 cents)')

  // 2. Capture from the fake mic, using the notes the transcript really heard.
  let snap
  const deadline = Date.now() + Number(process.env.JAM_SMOKE_TIMEOUT ?? 120000)
  for (;;) {
    snap = await page.evaluate(() => window.jam.snapshot(20))
    const heard = new Set(snap.notes.filter((n) => n.source === 'audio').map((n) => n.pitch))
    if (snap.now > 21 && PLAYED.filter((p) => heard.has(p)).length >= 5) break
    check(Date.now() < deadline, `the transcript never heard the notes: ${[...heard]}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const notes = snap.notes.filter((n) => n.source === 'audio').map(({ pitch, start, duration }) => ({ pitch, start, duration }))
  const built = await ask({ type: 'capture', name: 'smoke-voice', label: 'Smoke voice', from: snap.now - 20, to: snap.now, notes })
  check(built.ok, `capture failed: ${JSON.stringify(built)}`)
  const pitches = built.def.zones.map((z) => z.pitch)
  check(pitches.every((p) => PLAYED.includes(p)), `captured a pitch that was never played: ${pitches}`)
  check(pitches.length >= 5, `captured only ${pitches.length} of ${PLAYED.length} pitches: ${pitches} (${JSON.stringify(built.rejected)})`)
  check(built.files.length === pitches.length && built.files.every((f) => f.binary && f.riff === 'RIFF' && f.bytes > 5000), `sample files did not arrive as WAV bytes: ${JSON.stringify(built.files)}`)
  check(built.recording.riff === 'RIFF' && built.recording.bytes > 48000 * 2 * 15, 'the source recording did not arrive')
  console.log(`ok: captured ${pitches.length} notes from the fake mic (${pitches.join(' ')}) out of ${built.heard} heard; set aside ${JSON.stringify(built.rejected)}, ${built.duplicates} repeats; coverage ${built.coverage.low}-${built.coverage.high}, largest shift ${built.coverage.largestShift}`)

  // 3. Choose it for a part and play a pitch that was never recorded.
  const assigned = await ask({ type: 'assign', role: 'melody', instrument: 'smoke-voice' })
  check(assigned.roles?.[0] === 'melody' && assigned.state.playing.melody === 'smoke-voice', `assign failed: ${JSON.stringify(assigned)}`)
  for (const pitch of [57, 60, 65]) {
    const probe = await ask({ type: 'probe', role: 'melody', pitch })
    check(probe.instrument === 'smoke-voice' && probe.origin === 'captured', `melody should play on the captured instrument, got ${probe.instrument}`)
    check(near(probe.hz, pitch), `captured instrument asked for ${hzOf(pitch).toFixed(1)} Hz rendered ${probe.hz?.toFixed(1)} Hz`)
  }
  check((await ask({ type: 'probe', role: 'chords', pitch: 60 })).instrument === 'piano', 'other parts should be unaffected')
  console.log('ok: captured instrument chosen for melody; shifted notes render in tune')

  // 4. Remove it, then hand it back the way a saved instrument is loaded at startup.
  check((await ask({ type: 'remove', name: 'smoke-voice' })) === true, 'remove failed')
  check((await ask({ type: 'probe', role: 'melody', pitch: 60 })).instrument === 'piano', 'melody should fall back to the default after removal')
  check((await ask({ type: 'reload' })) === 1, 'reload failed')
  await ask({ type: 'assign', role: 'melody', instrument: 'smoke-voice' })
  const again = await ask({ type: 'probe', role: 'melody', pitch: 60 })
  check(again.instrument === 'smoke-voice' && near(again.hz, 60), `reloaded instrument did not play: ${JSON.stringify(again)}`)
  console.log('ok: instrument reloaded from its WAV bytes and plays')

  // 5. Real playback path (to the null audio device): must schedule without errors.
  await app.evaluate(({ BrowserWindow }) => {
    const note = (pitch, startBeat) => ({ pitch, startBeat, durationBeats: 1, velocity: 0.8 })
    const clip = {
      name: 'smoke',
      bpm: 240,
      tracks: [
        { role: 'chords', program: 0, notes: [note(60, 0), note(64, 0), note(67, 0)] },
        { role: 'melody', program: 0, notes: [note(72, 0), note(74, 1)] },
        { role: 'bass', program: 32, notes: [note(36, 0)] },
        { role: 'drums', program: 0, notes: [note(36, 0), note(42, 1), note(38, 2)] },
      ],
    }
    BrowserWindow.getAllWindows()[0].webContents.send('jam:event', { type: 'play-clip', clip })
  })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  check(pageErrors.length === 0, `renderer errors: ${pageErrors.join('; ')}`)
  console.log('ok: a clip with all four kinds of part plays through the sampler without errors')
} finally {
  await app.close()
}
