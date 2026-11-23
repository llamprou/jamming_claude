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
  bus: new FeatureBus((e) => events.push(e)),
  saveMidi: async () => '/tmp/x.mid',
})

describe('tool modules', () => {
  it('assembles tools and prompt guidance from every module, skipping ones that opt out', () => {
    const toolbox = buildToolbox(context())
    expect(toolbox.allowedTools).toEqual(['listen', 'show', 'hide', 'play', 'stop', 'read_music', 'notate', 'export_notation', 'remember', 'recall', 'update_taste_profile'].map((n) => `mcp__jam__${n}`))
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
