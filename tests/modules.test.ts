import { Playback } from '../src/main/playback'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import type { MainEvent } from '@shared/ipc'
import { Transcript } from '@shared/music/transcript'
import { VIEWS } from '@shared/views'
import { text, type ToolContext, type ToolModuleFactory } from '../src/main/agent/toolkit'
import { MODULES, buildToolbox } from '../src/main/agent/tools'
import { FeatureBus } from '../src/main/bus'
import { TasteMemory } from '../src/main/memory/taste'

const context = (events: MainEvent[] = []): ToolContext => ({
  transcript: new Transcript(),
  memory: new TasteMemory('/tmp/jam-modules-test'),
  now: () => 0,
  emit: (e) => events.push(e),
  bus: new FeatureBus((e) => events.push(e)), playback: new Playback((e) => events.push(e)),
  saveMidi: async () => '/tmp/x.mid',
})

describe('tool modules', () => {
  it('assembles tools and prompt guidance from every module, skipping ones that opt out', () => {
    const toolbox = buildToolbox(context())
    // The core set must always be there; other modules add their own.
    expect(toolbox.allowedTools).toEqual(expect.arrayContaining(['listen', 'show', 'hide', 'play', 'stop', 'remember', 'recall', 'update_taste_profile'].map((n) => `mcp__jam__${n}`)))
    expect(new Set(toolbox.allowedTools).size).toBe(toolbox.allowedTools.length)
    expect(toolbox.guide).toContain('- listen:')
    expect(toolbox.guide).not.toContain('extend_self') // no source checkout in this context
    for (const view of VIEWS) expect(toolbox.guide).toContain(view.kind)
    expect(buildToolbox({ ...context(), extend: async () => 'ok' }).allowedTools).toContain('mcp__jam__extend_self')
  })

  it('refuses two modules that claim the same tool name', () => {
    const clash: ToolModuleFactory = () => ({ name: 'clash', guide: '', tools: [tool('listen', 'again', {}, async () => text('x'))] })
    expect(() => buildToolbox(context(), [...MODULES, clash])).toThrow(/"listen"/)
  })
})

describe('feature bus', () => {
  it('sends, routes replies to the right request, and times out', async () => {
    const events: MainEvent[] = []
    const bus = new FeatureBus((e) => events.push(e))
    bus.send('camera', { on: true })
    expect(events[0]).toEqual({ type: 'feature', feature: 'camera', message: { on: true } })

    const first = bus.request<string>('camera', 'frame')
    const second = bus.request<string>('looper', 'take')
    const ids = events.filter((e) => e.type === 'feature-request').map((e) => (e.type === 'feature-request' ? e.id : -1))
    bus.settle(ids[1]!, 'take-1')
    bus.settle(ids[0]!, null, 'no camera')
    await expect(second).resolves.toBe('take-1')
    await expect(first).rejects.toThrow('no camera')
    await expect(bus.request('camera', 'frame', 10)).rejects.toThrow(/did not answer/)

    const heard: unknown[] = []
    const off = bus.on('looper', (m) => heard.push(m))
    bus.deliver('looper', 1)
    bus.deliver('camera', 2)
    off()
    bus.deliver('looper', 3)
    expect(heard).toEqual([1])
  })
})

describe('playback', () => {
  const clip = { name: 'idea', bpm: 100, tracks: [] }

  it('plays once by default, and lets a provider take looping or in-time clips', async () => {
    const events: MainEvent[] = []
    const playback = new Playback((e) => events.push(e))
    expect(await playback.play(clip, { loop: true })).toMatch(/once/)
    expect(events).toEqual([{ type: 'play-clip', clip, savedTo: undefined }])

    const taken: string[] = []
    let stopped = 0
    playback.provide({ play: async (c, o) => (o.loop ? (taken.push(`${o.id}:${c.name}`), 'Looping in time.') : null), stop: () => void stopped++ })
    expect(await playback.play(clip, { loop: true, id: 'arrangement' })).toBe('Looping in time.')
    expect(await playback.play(clip)).toMatch(/once/) // provider declined
    expect(taken).toEqual(['arrangement:idea'])
    expect(events.filter((e) => e.type === 'play-clip')).toHaveLength(2)

    playback.stop()
    expect(stopped).toBe(1)
    expect(events.at(-1)).toEqual({ type: 'stop-playback' })
  })

  it('falls back to playing once if the provider fails', async () => {
    const events: MainEvent[] = []
    const playback = new Playback((e) => events.push(e))
    playback.provide({ play: async () => Promise.reject(new Error('window gone')), stop: () => undefined })
    expect(await playback.play(clip, { loop: true })).toMatch(/once/)
    expect(events).toHaveLength(1)
  })
})
