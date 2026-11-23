// Launches the built app and exercises the transport in the real window:
// the worker-driven lookahead scheduler against the real AudioContext clock,
// synced looping layers, tempo following, audio looping from Chromium's fake
// microphone, and the transport view. It stands in for the agent by sending
// the same feature-bus messages src/main/agent/tools/transport.ts sends.
// Run `npm run build` first. On Linux: `xvfb-run -a node scripts/transport-check.mjs`.
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright')

const dir = mkdtempSync(join(tmpdir(), 'jam-transport-'))

/** A looping 4 s WAV: eight plucked notes at 120 bpm, so the mic always has something in it. */
function writeRiffWav(path) {
  const rate = 48000
  const samples = new Float32Array(rate * 4)
  ;[48, 55, 60, 55, 50, 57, 62, 57].forEach((pitch, i) => {
    const hz = 440 * 2 ** ((pitch - 69) / 12)
    const offset = Math.floor(i * 0.5 * rate)
    for (let n = 0; n < 0.45 * rate; n++) {
      const t = n / rate
      const envelope = Math.min(1, t * 200) * Math.exp(-4 * t) * Math.min(1, (0.45 - t) * 50)
      let s = 0
      for (let h = 1; h <= 5; h++) s += Math.sin(2 * Math.PI * hz * h * t) / h ** 1.5
      samples[offset + n] += 0.25 * envelope * s
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

const wavPath = join(dir, 'riff.wav')
writeRiffWav(wavPath)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition, message) => {
  if (!condition) throw new Error(`transport check failed: ${message}`)
}
const beatsOf = (log, layer) => log.filter((e) => e.kind === 'note' && e.layer === layer).map((e) => e.beat)

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
  await page.waitForSelector('.orb')

  // Stand in for the main-process side of the feature bus.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__transportReplies = new Map()
    ipcMain.on('jam:feature-reply', (_e, id, result, error) => globalThis.__transportReplies.set(id, { result, error }))
  })
  const fromMain = (event) => app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0].webContents.send('jam:event', e), event)
  let nextId = 900000
  const request = async (message) => {
    const id = nextId++
    await fromMain({ type: 'feature-request', id, feature: 'transport', message })
    for (let i = 0; i < 200; i++) {
      const reply = await app.evaluate((_electron, key) => globalThis.__transportReplies.get(key), id)
      if (reply) {
        if (reply.error) throw new Error(`window answered with an error: ${reply.error}`)
        return reply.result
      }
      await sleep(10)
    }
    throw new Error(`no answer to ${message.type}`)
  }
  const audible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCurrentlyAudible())
  const clock = () => page.evaluate(() => window.jam.clock())

  const track = (role, notes) => ({ role, program: 0, notes: notes.map(([pitch, startBeat, durationBeats = 0.4]) => ({ pitch, startBeat, durationBeats, velocity: 0.8 })) })

  /* ---- 1. Two looping layers at a fixed tempo ---- */
  let state = await request({ type: 'state' })
  check(state && state.running === false, 'the transport should be idle at launch')
  const quietBefore = await audible()
  await request({ type: 'set', bpm: 120, follow: false })
  const lead = { name: 'lead', bpm: 120, tracks: [track('melody', [[72, 0], [74, 1], [76, 2], [77, 3.5]])] }
  const bass = { name: 'bass', bpm: 120, tracks: [track('bass', [[36, 0, 1], [43, 2, 1], [36, 4, 1], [41, 6.5, 1]])] }
  state = await request({ type: 'play', id: 'lead', clip: lead, loop: true, start: 'bar' })
  check(state.running && state.bpm === 120, 'play should start the transport at the set tempo')
  check(state.startsAtBeat % 4 === 0, `a part should come in on a bar line, got beat ${state.startsAtBeat}`)
  await sleep(700)
  state = await request({ type: 'play', id: 'bass', clip: bass, loop: true, start: 'bar' })
  const bassStart = state.startsAtBeat
  check(bassStart % 4 === 0 && state.startsInSeconds > 0 && state.startsInSeconds <= 2.01, `the second part should wait for the next bar line (in ${state.startsInSeconds}s)`)
  check(state.layers.length === 2, 'two layers should be listed')
  await sleep(6500)
  const playing = await audible()
  let log = await request({ type: 'log' })
  state = await request({ type: 'state' })
  const grid = state.grid
  const timeOf = (beat) => grid.anchorTime + ((beat - grid.anchorBeat) * 60) / grid.bpm

  const leadBeats = beatsOf(log, 'lead')
  check(leadBeats.length >= 12, `expected the lead to have played for several bars, got ${leadBeats.length} notes`)
  check(new Set(leadBeats).size === leadBeats.length, 'a note was scheduled twice')
  const first = leadBeats[0]
  const wanted = []
  for (let pass = 0; first + pass * 4 <= leadBeats[leadBeats.length - 1]; pass++) for (const offset of [0, 1, 2, 3.5]) wanted.push(first + pass * 4 + offset)
  check(JSON.stringify(leadBeats) === JSON.stringify(wanted.slice(0, leadBeats.length)), `notes were dropped or misplaced across loop boundaries: ${leadBeats.slice(0, 12)}`)
  const bassBeats = beatsOf(log, 'bass')
  check(bassBeats[0] === bassStart && bassBeats.every((b) => [0, 2, 4, 6.5].includes((b - bassStart) % 8)), `the bass is not on its bar grid: ${bassBeats}`)
  for (const entry of log) check(Math.abs(entry.time - timeOf(entry.beat)) < 1e-6, 'a scheduled time is off the beat grid')
  const leads = log.map((e) => e.leadMs)
  check(state.late === 0 && Math.min(...leads) > 0, `events reached WebAudio late (late ${state.late}, min lead ${Math.min(...leads).toFixed(1)} ms)`)
  console.log(
    `ok: two synced looping layers, ${log.length} events, none doubled or dropped; handed to WebAudio ${Math.min(...leads).toFixed(0)}-${Math.max(...leads).toFixed(0)} ms ahead; worst timer gap ${state.worstTickMs.toFixed(0)} ms; output latency ${state.outputLatencyMs.toFixed(1)} ms`,
  )
  console.log(`${playing && !quietBefore ? 'ok' : 'note'}: window audible before ${quietBefore}, while looping ${playing}`)

  /* ---- 2. Swap a part at the bar line, stop one part at the bar line ---- */
  const lead2 = { name: 'lead', bpm: 120, tracks: [track('melody', [[84, 0], [86, 2]])] }
  state = await request({ type: 'play', id: 'lead', clip: lead2, loop: true, start: 'bar' })
  const swapAt = state.startsAtBeat
  state = await request({ type: 'stop', id: 'bass', at: 'bar' })
  check(state.layers.find((l) => l.id === 'bass')?.stopBeat === swapAt, 'the bass should be marked to stop at the next bar line')
  await sleep(4500)
  log = await request({ type: 'log' })
  state = await request({ type: 'state' })
  const melody = log.filter((e) => e.kind === 'note' && e.layer.startsWith('lead'))
  check(melody.filter((e) => e.beat < swapAt).every((e) => e.pitch < 80) && melody.filter((e) => e.beat >= swapAt).every((e) => e.pitch >= 84), 'the swap should happen exactly at the bar line')
  check(melody.some((e) => e.beat === swapAt - 0.5) && melody.some((e) => e.beat === swapAt), 'no gap at the swap')
  check(beatsOf(log, 'bass').every((b) => b < swapAt), 'the bass played past its stop point')
  check(state.layers.length === 1 && state.layers[0].id === 'lead', `only the new lead should remain, got ${state.layers.map((l) => l.id)}`)
  console.log('ok: part swapped at the bar line with no gap; another part stopped at the bar line')

  /* ---- 3. Following a player who is faster and off our beat ---- */
  // The tracker runs in the main process and is unit-tested; here its reading is supplied directly.
  await request({ type: 'set', follow: true })
  const now = await clock()
  const player = { bpm: 126, anchorTime: now + 0.11, anchorBeat: 0, beatsPerBar: 4 }
  for (let i = 0; i < 24; i++) {
    await fromMain({ type: 'feature', feature: 'transport', message: { type: 'beat', player: { grid: player, confidence: 0.9 } } })
    await sleep(400)
  }
  state = await request({ type: 'state' })
  check(Math.abs(state.bpm - 126) < 0.5, `tempo should have followed the player to 126, got ${state.bpm.toFixed(2)}`)
  check(Math.abs(state.phaseErrorMs) < 15, `beats should have lined up with the player, still ${state.phaseErrorMs?.toFixed(1)} ms apart`)
  log = await request({ type: 'log' })
  // The lead plays every two beats: 1.000 s at 120 bpm, 0.952 s at 126, and up to 6% either side while its beat is pulled onto the player's.
  const times = log.filter((e) => e.kind === 'note' && e.layer === 'lead' && e.time > now).map((e) => e.time)
  const gaps = times.slice(1).map((t, i) => t - times[i])
  check(gaps.length > 6 && gaps.every((g) => g > 0.88 && g < 1.07), `following should never jump: note gaps ${Math.min(...gaps).toFixed(3)}-${Math.max(...gaps).toFixed(3)} s`)
  check(state.late === 0, 'events were late while following')
  // Our beat now falls on the player's.
  const ownBeatTime = state.grid.anchorTime + ((Math.ceil(state.beat) - state.grid.anchorBeat) * 60) / state.grid.bpm
  const playerBeat = ((ownBeatTime - player.anchorTime) * player.bpm) / 60
  const apart = Math.abs(playerBeat - Math.round(playerBeat)) * (60 / player.bpm) * 1000
  check(apart < 15, `our next beat is ${apart.toFixed(1)} ms from the player's`)
  console.log(`ok: followed a player from 120 to ${state.bpm.toFixed(1)} bpm; beats ${apart.toFixed(1)} ms apart; no jump (note gaps ${Math.min(...gaps).toFixed(3)}-${Math.max(...gaps).toFixed(3)} s)`)
  await request({ type: 'stop', at: 'now' })
  state = await request({ type: 'state' })
  check(!state.running && state.layers.length === 0, 'stop should stop everything')

  /* ---- 4. Looping the mic's actual sound ---- */
  await page.waitForFunction(() => document.querySelector('.meta')?.textContent?.includes('mic on'), null, { timeout: 20000 })
  await sleep(5500) // let the rolling buffer fill past one loop length
  const end = (await clock()) - 0.3
  state = await request({ type: 'loop-audio', id: 'take', startTime: end - 4, endTime: end, lengthBeats: 8, start: 'bar', bpm: 120 })
  check(state.startsAtBeat !== undefined, `the audio loop was refused: ${state.note}`)
  check(state.level > 0.01, `the take should contain the fake mic's sound, level ${state.level}`)
  const takeLevel = state.level
  await sleep(9500)
  const loopAudible = await audible()
  log = await request({ type: 'log' })
  state = await request({ type: 'state' })
  const passes = log.filter((e) => e.kind === 'audio' && e.layer === 'take')
  check(passes.length >= 2, `expected the take to have looped, got ${passes.length} passes`)
  check(passes.slice(1).every((p, i) => Math.abs(p.time - passes[i].time - 4) < 1e-6), 'audio passes should be exactly one loop length apart')
  check(passes.every((p) => p.leadMs > 20), 'an audio pass was scheduled too late for its crossfade')
  console.log(`ok: 4 s of mic audio looped (take level ${takeLevel.toFixed(3)} rms; ${passes.length} passes, exactly 4.000 s apart); window audible ${loopAudible}`)
  const refused = await request({ type: 'loop-audio', id: 'old', startTime: -500, endTime: -496, lengthBeats: 8, start: 'bar' })
  check(refused.startsAtBeat === undefined && /does not hold/.test(refused.note), 'a stretch outside the buffer should be refused')

  /* ---- 5. Count-in click, the view, Escape ---- */
  await request({ type: 'stop', at: 'now' })
  await request({ type: 'set', bpm: 100, follow: false, beatsPerBar: 3 })
  state = await request({ type: 'play', id: 'waltz', clip: { name: 'waltz', bpm: 100, tracks: [track('chords', [[60, 0], [64, 1], [67, 2]])] }, loop: true, start: 'bar', countInBars: 1 })
  const comesIn = state.startsAtBeat
  await fromMain({ type: 'show-view', view: 'transport' })
  await page.waitForSelector('.transport')
  await sleep(4500)
  log = await request({ type: 'log' })
  const clicks = log.filter((e) => e.kind === 'click' && e.beat >= comesIn - 3).map((e) => e.beat)
  check(JSON.stringify(clicks) === JSON.stringify([comesIn - 3, comesIn - 2, comesIn - 1]), `one bar of count-in clicks expected, got ${clicks} before ${comesIn}`)
  check(beatsOf(log, 'waltz')[0] === comesIn, 'the part should come in after the count-in')
  const viewText = await page.textContent('.transport')
  check(/100/.test(viewText) && /waltz/.test(viewText), `the transport view should show tempo and layers, got "${viewText}"`)
  check((await page.locator('button').count()) === 0, 'the transport view must not add buttons')
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] })
  await page.keyboard.press('Escape')
  await sleep(200)
  state = await request({ type: 'state' })
  check(!state.running && state.layers.length === 0, 'Escape should stop the transport')
  console.log('ok: one-bar count-in in 3/4, transport view on screen, Escape stops everything')
} finally {
  await app.close()
}
