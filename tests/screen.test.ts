import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MainEvent } from '@shared/ipc'
import { Transcript } from '@shared/music/transcript'
import { SnapshotBuffer, fitWithin, permissionMessage, type ScreenCapturer, type ScreenShot, type ScreenTarget } from '@shared/screen'
import { buildToolbox } from '../src/main/agent/tools'
import { WATCH_EVERY_MS, WATCH_LIMIT_MS, screen } from '../src/main/agent/tools/screen'
import { FeatureBus } from '../src/main/bus'
import { TasteMemory } from '../src/main/memory/taste'
import { Playback } from '../src/main/playback'

const shot = (time: number, target: ScreenTarget = 'app'): ScreenShot => ({ data: `img@${time}`, mimeType: 'image/jpeg', width: 100, height: 50, time, target })

describe('screen helpers', () => {
  it('fits sizes within the longest edge without upscaling', () => {
    expect(fitWithin(3024, 1964, 1568)).toEqual({ width: 1568, height: 1018 })
    expect(fitWithin(1000, 2000, 1000)).toEqual({ width: 500, height: 1000 })
    expect(fitWithin(800, 600, 1568)).toEqual({ width: 800, height: 600 })
  })

  it('keeps recent snapshots and picks the nearest', () => {
    const buffer = new SnapshotBuffer(10)
    expect(buffer.pick(5, 0)).toBeNull()
    for (const t of [0, 2, 4, 6, 8, 10, 12]) buffer.add(shot(t))
    expect(buffer.size).toBe(6) // time 0 dropped
    expect(buffer.pick(12, 5)!.time).toBe(6)
    expect(buffer.pick(12, 30)!.time).toBe(2)
    buffer.clear()
    expect(buffer.size).toBe(0)
  })

  it('explains missing permission and where to grant it', () => {
    expect(permissionMessage('denied', 'Jamming Claude')).toMatch(/Screen & System Audio Recording, switch on Jamming Claude, then quit and reopen/)
    expect(permissionMessage('not-determined', 'X')).toMatch(/just asked/)
    expect(permissionMessage('restricted', 'X')).not.toMatch(/System Settings/)
    for (const s of ['denied', 'not-determined', 'restricted']) expect(permissionMessage(s, 'X')).toMatch(/target "app"/)
  })
})

describe('screen tools', () => {
  afterEach(() => vi.useRealTimers())

  function setup(capture: ScreenCapturer['capture'] | null) {
    const events: MainEvent[] = []
    let clock = 100
    const calls: Array<{ target: ScreenTarget; maxEdge?: number }> = []
    const capturer: ScreenCapturer | undefined = capture
      ? { capture: async (target, options) => (calls.push({ target, maxEdge: options?.maxEdge }), capture(target, options)) }
      : undefined
    const ctx = {
      transcript: new Transcript(),
      memory: new TasteMemory('/tmp/jam-screen-test'),
      now: () => clock,
      emit: (e: MainEvent) => events.push(e),
      bus: new FeatureBus((e) => events.push(e)),
      playback: new Playback(() => undefined),
      saveMidi: async () => '',
      screen: capturer,
    }
    const module = screen(ctx)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (name: string, args: Record<string, unknown>) => module!.tools.find((t) => t.name === name)!.handler(args as any, undefined)
    const lights = () => events.flatMap((e) => (e.type === 'feature' && e.feature === 'screen' ? [(e.message as { state: string }).state] : []))
    return { module, call, calls, lights, tick: (s: number) => (clock += s), ctx }
  }

  it('is left out where capture is unavailable, and in the toolbox when present', () => {
    expect(setup(null).module).toBeNull()
    const { ctx } = setup(async (target) => shot(0, target))
    expect(buildToolbox(ctx).allowedTools).toEqual(expect.arrayContaining(['mcp__jam__look_screen', 'mcp__jam__watch_screen']))
    expect(buildToolbox(ctx).guide).toMatch(/look_screen: .*after show or notate/)
  })

  it('looks at the app window by default, lights the indicator, and returns the image', async () => {
    const { call, calls, lights } = setup(async (target) => shot(100, target))
    const result = await call('look_screen', { target: 'app', seconds_ago: 0 })
    expect(calls).toEqual([{ target: 'app', maxEdge: undefined }])
    expect(result.content[0]).toEqual({ type: 'image', data: 'img@100', mimeType: 'image/jpeg' })
    expect(result.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining("This app's own window") })
    expect(lights()).toEqual(['still'])
  })

  it('passes a missing-permission message on as words', async () => {
    const { call } = setup(async () => {
      throw new Error(permissionMessage('denied', 'Electron'))
    })
    const result = await call('look_screen', { target: 'screen', seconds_ago: 0 })
    expect(result.content).toEqual([{ type: 'text', text: expect.stringMatching(/Screen Recording permission/) }])
    expect((await call('watch_screen', { on: true, target: 'screen' })).content[0]).toMatchObject({ text: expect.stringMatching(/permission/) })
  })

  it('keeps snapshots only while watching, and stops by itself', async () => {
    vi.useFakeTimers()
    const { call, calls, lights, tick } = setup(async (target) => shot(clockNow(), target))
    let now = 100
    const clockNow = () => now
    expect((await call('look_screen', { target: 'app', seconds_ago: 5 })).content[0]).toMatchObject({ text: expect.stringMatching(/watch_screen/) })
    expect(calls).toHaveLength(0) // nothing captured without a reason

    await call('watch_screen', { on: true, target: 'app' })
    expect(lights()).toEqual(['watching'])
    for (let i = 0; i < 5; i++) {
      now += WATCH_EVERY_MS / 1000
      tick(WATCH_EVERY_MS / 1000)
      await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS)
    }
    expect(calls.length).toBe(6)
    expect(calls[1]!.maxEdge).toBe(1280)
    const past = await call('look_screen', { target: 'app', seconds_ago: 6 })
    expect(past.content[0]).toMatchObject({ data: 'img@104' })
    expect(past.content[1]).toMatchObject({ text: expect.stringContaining('6 seconds ago') })

    await vi.advanceTimersByTimeAsync(WATCH_LIMIT_MS)
    expect(lights().at(-1)).toBe('off')
    const after = calls.length
    await vi.advanceTimersByTimeAsync(WATCH_EVERY_MS * 3)
    expect(calls.length).toBe(after)
  })
})
