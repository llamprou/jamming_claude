// Downloads the hand tracking model into assets/vision/ (gitignored), where
// the camera feature's worker picks it up at build time. Run once after
// `npm ci`, then build:  node scripts/fetch-vision-assets.mjs
//
// The only host contacted is storage.googleapis.com. The wasm runtime the
// model runs on comes from the @mediapipe/tasks-vision npm package, not from
// here. Model: MediaPipe Hand Landmarker (float16, v1), Apache-2.0.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ASSETS = [
  {
    file: 'hand_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    sha256: 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1',
  },
]

const dir = join(dirname(import.meta.dirname), 'assets', 'vision')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function download(url) {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    // Node's fetch ignores HTTPS_PROXY on some versions; curl does not.
    try {
      return execFileSync('curl', ['-fsSL', url], { maxBuffer: 64 * 1024 * 1024 })
    } catch {
      throw new Error(`could not download ${url}: ${error.message}`)
    }
  }
}

mkdirSync(dir, { recursive: true })
for (const asset of ASSETS) {
  const path = join(dir, asset.file)
  if (existsSync(path) && digest(readFileSync(path)) === asset.sha256) {
    console.log(`ok: ${asset.file} already present`)
    continue
  }
  const bytes = await download(asset.url)
  if (digest(bytes) !== asset.sha256) throw new Error(`${asset.file}: checksum mismatch (got ${digest(bytes)}); not installed`)
  writeFileSync(`${path}.part`, bytes)
  renameSync(`${path}.part`, path)
  console.log(`ok: ${asset.file} downloaded (${(bytes.length / 1e6).toFixed(1)} MB)`)
}
