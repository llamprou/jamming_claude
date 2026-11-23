// Launches the built app with Chromium's fake camera and checks the camera
// feature end to end, standing in for the agent's tools on the feature bus:
//  1. The camera is off at launch and turns on only when asked.
//  2. A frame comes back to main as a JPEG of the expected size.
//  3. The camera view renders the live picture and the "camera on" light shows.
//  4. The hand tracking model loads and runs in its worker from the app's own
//     files, with no Content-Security-Policy or loading errors.
//  5. If a picture of a hand can be fed to the fake camera (needs ffmpeg, and
//     either JAM_VISION_HAND_IMAGE=<jpg/png> or network access to
//     storage.googleapis.com for MediaPipe's sample photo): hands are found,
//     a touched point can be marked, and fret hints reach main.
//  6. Turning the camera off releases it.
// Run `node scripts/fetch-vision-assets.mjs && npm run build` first.
// On Linux: `xvfb-run -a node scripts/smoke-vision.mjs [screenshot.png]`.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright')

const dir = mkdtempSync(join(tmpdir(), 'jam-vision-'))
const SAMPLE = 'https://storage.googleapis.com/mediapipe-tasks/hand_landmarker/woman_hands.jpg'

/** A y4m clip of a still photo with hands in it, for the fake camera; null if it cannot be made here. */
async function handVideo() {
  try {
    let image = process.env.JAM_VISION_HAND_IMAGE
    if (!image) {
      const response = await fetch(SAMPLE).catch(() => null)
      image = join(dir, 'hands.jpg')
      if (response?.ok) writeFileSync(image, Buffer.from(await response.arrayBuffer()))
      else execFileSync('curl', ['-fsSL', '-o', image, SAMPLE], { stdio: 'ignore' })
    }
    const y4m = join(dir, 'hands.y4m')
    // Fit into a 1280x720 frame, as a webcam would deliver, on a grey background.
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', image, '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:gray', '-pix_fmt', 'yuv420p', '-frames:v', '1', y4m])
    return existsSync(y4m) ? y4m : null
  } catch {
    return null
  }
}

/** Width and height from a JPEG's frame header. */
function jpegSize(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG')
  for (let i = 2; i < bytes.length - 8; ) {
    const marker = bytes[i + 1]
    if (marker >= 0xc0 && marker <= 0xc2) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
    i += 2 + bytes.readUInt16BE(i + 2)
  }
  throw new Error('JPEG has no frame header')
}

const video = await handVideo()
const app = await electron.launch({
  executablePath: require('electron'),
  args: [
    '.',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    ...(video ? [`--use-file-for-fake-video-capture=${video}`] : []),
    // A Linux box without a GPU offers no WebGL unless told to use the software renderer; the hand tracker needs it.
    ...(process.platform === 'linux' ? ['--no-sandbox', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
  ],
  env: { ...process.env, JAM_DATA_DIR: dir, ANTHROPIC_API_KEY: '' },
})

const problems = []
try {
  const page = await app.firstWindow()
  page.on('console', (m) => {
    if (process.env.JAM_SMOKE_DEBUG) console.error('renderer:', m.text())
    // Anything the camera, its worker, wasm or the page's security policy complains about.
    // MediaPipe writes its own log through the console; its info and warning lines ("I1123 ...", "W1123 ...") are not errors.
    if (/^(INFO|[IW]\d{4} )/.test(m.text())) return
    if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text())
  })
  page.on('pageerror', (e) => problems.push(e.message))
  await page.waitForSelector('.orb')

  // Stand in for main's feature bus: ask the window as bus.request would, and collect what it sends.
  await app.evaluate(({ ipcMain }) => {
    globalThis.cameraEvents = []
    globalThis.cameraReplies = new Map()
    ipcMain.on('jam:feature', (_e, feature, message) => feature === 'camera' && globalThis.cameraEvents.push(message))
    ipcMain.on('jam:feature-reply', (_e, id, result, error) => globalThis.cameraReplies.get(id)?.({ result, error }))
  })
  let nextId = 900000
  const ask = async (message) => {
    const { result, error } = await app.evaluate(
      ({ BrowserWindow }, { id, message }) =>
        new Promise((resolve) => {
          globalThis.cameraReplies.set(id, resolve)
          BrowserWindow.getAllWindows()[0].webContents.send('jam:event', { type: 'feature-request', id, feature: 'camera', message })
        }),
      { id: nextId++, message },
    )
    if (error) throw new Error(error)
    return result
  }
  const fromAgent = (event) => app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0].webContents.send('jam:event', e), event)
  const until = async (what, check, timeout = 60000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const status = await ask({ type: 'status' })
      if (check(status)) return status
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; status: ${JSON.stringify(status)}`)
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  // 1. Off until asked. Give the app a moment in which it could have (wrongly) started it.
  await page.waitForTimeout(1500)
  const before = await ask({ type: 'status' })
  if (before.on || before.tracking !== 'off') throw new Error(`the camera should be off at launch: ${JSON.stringify(before)}`)
  if (await page.locator('.camera-light:visible').count()) throw new Error('the camera light is lit at launch')
  await ask({ type: 'frame' }).then(
    () => Promise.reject(new Error('a frame was returned while the camera is off')),
    (e) => /camera is off/.test(e.message) || Promise.reject(e),
  )
  console.log('ok: camera off at launch; no frame available')

  const started = await ask({ type: 'start' })
  if (!started.on || !started.width || !started.height) throw new Error(`camera did not start: ${JSON.stringify(started)}`)
  await page.waitForSelector('.camera-light', { state: 'visible' })
  console.log(`ok: camera on when asked -> ${started.camera} ${started.width}x${started.height}; camera light lit`)

  // 2. A frame, as `look` would get it.
  await page.waitForTimeout(500)
  const frame = await ask({ type: 'frame' })
  const jpeg = Buffer.from(frame.data, 'base64')
  const size = jpegSize(jpeg)
  if (frame.mimeType !== 'image/jpeg' || size.width !== frame.width || size.height !== frame.height) throw new Error(`frame header ${JSON.stringify(size)} does not match reply ${frame.width}x${frame.height} ${frame.mimeType}`)
  if (Math.max(size.width, size.height) !== Math.min(768, Math.max(started.width, started.height))) throw new Error(`frame is ${size.width}x${size.height}; expected the longest side to be 768`)
  console.log(`ok: frame -> JPEG ${size.width}x${size.height}, ${jpeg.length} bytes (${frame.data.length} base64 chars), about ${Math.round((size.width * size.height) / 750)} image tokens`)
  if (process.argv[3]) writeFileSync(process.argv[3], jpeg)
  await page.waitForTimeout(1200)
  const earlier = await ask({ type: 'frame', secondsAgo: 1 })
  if (!(earlier.time < frame.time + 1.5) || jpegSize(Buffer.from(earlier.data, 'base64')).width !== size.width) throw new Error('the kept history did not return an earlier frame')
  console.log('ok: a frame from a moment ago comes from the kept history')

  // 3. The view.
  await fromAgent({ type: 'show-view', view: 'camera' })
  await page.waitForFunction(() => (document.querySelector('.camera-view video')?.videoWidth ?? 0) > 0, null, { timeout: 10000 })
  await page.waitForSelector('.camera-view canvas')
  if (!/Camera on/.test(await page.textContent('.camera-readout'))) throw new Error('the camera view does not say the camera is on')
  if (await page.locator('button').count()) throw new Error('the camera view should add no buttons')
  console.log('ok: camera view shows the live picture and says the camera is on')

  // 4. The hand tracker.
  const tracking = await until('the hand tracker to load and run', (s) => s.tracking === 'on' ? s.fps > 0 : s.tracking === 'unavailable')
  if (tracking.tracking !== 'on') throw new Error(`hand tracking is unavailable: ${tracking.trackingDetail}`)
  console.log(`ok: hand model loaded in its worker and is running on frames (${tracking.fps} frames in the last second)`)

  // 5. Detection, when the fake camera is showing a hand.
  if (!video) console.log('skipped: hand detection (no hand picture available: needs ffmpeg and JAM_VISION_HAND_IMAGE or network)')
  else {
    const seen = await until('hands to be found in the picture', (s) => s.hands.length > 0, 30000)
    console.log(`ok: hands found -> ${seen.hands.map((h) => `${h.side} (${h.score.toFixed(2)}, ${h.motion})`).join(', ')}`)
    await page.waitForFunction(() => /hand/.test(document.querySelector('.camera-hands')?.textContent ?? ''))

    // Mark the fifth fret where a fingertip is held, then put the nut to one side of it.
    const touched = await ask({ type: 'mark', point: 'fret', fret: 5, instrument: 'guitar', hand: seen.hands[0].side })
    const at = /at ([\d.]+) across, ([\d.]+) down/.exec(touched.message)
    if (!touched.ok || !at) throw new Error(`could not mark a held fingertip: ${touched.message}`)
    const x = Number(at[1])
    const marked = await ask({ type: 'mark', point: 'nut', x: x > 0.5 ? x - 0.2 : x + 0.2, y: Number(at[2]) })
    if (!marked.ok || marked.status.marked.neck !== 'guitar') throw new Error(`neck not marked: ${marked.message}`)
    const hinted = await until('a fret hint', (s) => s.fretHint !== null, 15000)
    const events = await app.evaluate(() => globalThis.cameraEvents.filter((e) => e.type === 'fret-hint'))
    if (events.length === 0) throw new Error('no fret hint reached main')
    console.log(`ok: fingertip marked ${at[0]}; fret hints reach main -> frets ${hinted.fretHint.lowFret}-${hinted.fretHint.highFret}, confidence ${hinted.fretHint.confidence.toFixed(2)} (${events.length} so far)`)
  }
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] })

  // 6. Off again.
  const stopped = await ask({ type: 'stop' })
  if (stopped.on || stopped.tracking !== 'off') throw new Error(`camera did not stop: ${JSON.stringify(stopped)}`)
  await page.waitForSelector('.camera-light', { state: 'hidden' })
  await page.waitForFunction(() => document.querySelector('.camera-view')?.textContent?.includes('The camera is off'))
  if (!(await app.evaluate(() => globalThis.cameraEvents.some((e) => e.type === 'off')))) throw new Error('main was not told the camera went off')
  console.log('ok: camera off when asked; light out; main told')

  if (problems.length) throw new Error(`the window reported errors:\n  ${problems.join('\n  ')}`)
  console.log('ok: no errors from the window (Content-Security-Policy, wasm, worker)')
} finally {
  await app.close()
}
