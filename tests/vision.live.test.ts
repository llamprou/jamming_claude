import { Playback } from '../src/main/playback'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { CameraFrame, CameraRequest, CameraStatus } from '@shared/features/camera'
import type { MainEvent } from '@shared/ipc'
import { Transcript } from '@shared/music/transcript'
import { JamSession } from '../src/main/agent/session'
import { FeatureBus } from '../src/main/bus'
import { TasteMemory } from '../src/main/memory/taste'

/** A PNG of a filled red circle on white: something no one could describe without seeing it. */
function redCirclePng(size = 256): Buffer {
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3)
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(x - size / 2, y - size / 2) < size * 0.35
      raw.set(inside ? [220, 20, 20] : [255, 255, 255], row + 1 + x * 3)
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/**
 * Talks to the real model, so it is opt-in: JAM_LIVE=1 npx vitest run tests/vision.live.test.ts
 * Checks that a picture returned by `look` really reaches the model as an
 * image: the window is faked and answers every frame request with a red
 * circle, which the buddy must then describe.
 */
describe.skipIf(!process.env.JAM_LIVE)('live agent: sight', () => {
  it('looks when asked what is in front of the camera, and describes the picture it gets', async () => {
    const events: MainEvent[] = []
    const asked: CameraRequest[] = []
    let cameraOn = false
    const status = (): CameraStatus => ({
      on: cameraOn,
      camera: cameraOn ? 'Test camera' : undefined,
      cameras: ['Test camera'],
      width: cameraOn ? 256 : undefined,
      height: cameraOn ? 256 : undefined,
      tracking: cameraOn ? 'on' : 'off',
      hands: [],
      marked: { neck: null, neckPoints: [], keyboard: false, keyboardPoints: [] },
      fretHint: null,
      keyboardHint: null,
    })
    const bus: FeatureBus = new FeatureBus((event) => {
      events.push(event)
      if (event.type !== 'feature-request' || event.feature !== 'camera') return
      const request = event.message as CameraRequest
      asked.push(request)
      if (request.type === 'start') cameraOn = true
      if (request.type === 'stop') cameraOn = false
      const frame: CameraFrame = { data: redCirclePng().toString('base64'), mimeType: 'image/png', width: 256, height: 256, time: 6, status: status() }
      queueMicrotask(() => bus.settle(event.id, request.type === 'frame' ? frame : status()))
    })

    let spoken = ''
    const turn = () =>
      new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
          const last = events.findLast((e) => e.type === 'status')
          if (last?.type !== 'status' || last.agent === 'thinking' || last.agent === 'speaking') return
          clearInterval(timer)
          events.push({ type: 'status', agent: 'thinking' }) // so the next turn() waits for the next result
          if (last.agent === 'error') reject(new Error(last.detail))
          else resolve()
        }, 100)
      })

    const jam = new JamSession(
      { transcript: new Transcript(), memory: new TasteMemory(await mkdtemp(join(tmpdir(), 'jam-live-vision-'))), now: () => 6, emit: (e) => events.push(e), bus, playback: new Playback((e) => events.push(e)), saveMidi: async (name) => `/tmp/${name}.mid` },
      { model: process.env.JAM_AGENT_MODEL ?? 'claude-opus-5-5', voice: true, onSpeech: (chunk) => (spoken += chunk), onSpeechEnd: () => undefined },
    )
    await jam.start()
    try {
      // With voice on, the buddy speaks first.
      events.push({ type: 'status', agent: 'thinking' })
      await turn()
      spoken = ''
      jam.say("Have a look through the camera. I'm holding something up: what shape is it, and what colour?")
      await turn()
      console.log({ asked: asked.map((r) => r.type), spoken })
      expect(asked.some((r) => r.type === 'frame'), `the buddy never looked; it said: ${spoken}`).toBe(true)
      expect(asked.some((r) => r.type === 'start'), 'the camera was off, so looking should have turned it on').toBe(true)
      expect(spoken).toMatch(/red/i)
      expect(spoken).toMatch(/circle|disc|disk|dot|ball|round/i)
      expect(spoken).not.toMatch(/[*#`]/) // spoken replies carry no markdown
    } finally {
      jam.stop()
    }
  }, 120_000)
})
