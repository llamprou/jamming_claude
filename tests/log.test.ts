import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LevelSummary, entry, errorData, filterEntries, formatEntry, maxPolyphony, parseLine, safeJson } from '@shared/log'
import { AudioRing, SlowPass, type SlowPassEvent } from '@shared/music/slowpass'
import { FileLog } from '../src/main/log'
import { logsWith } from '../src/main/agent/tools/logs'
import type { ToolContext } from '../src/main/agent/toolkit'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('log entries', () => {
  it('formats a line and parses it back, data included', () => {
    const e = entry('warn', 'slowpass', 'run timed out\nretrying', { ms: 20000.12345, engine: 'webgl' }, new Date('2026-11-23T10:00:00Z'))
    const line = formatEntry(e)
    expect(line).toBe('2026-11-23T10:00:00.000Z WARN  [slowpass] run timed out retrying {"ms":20000.123,"engine":"webgl"}')
    expect(parseLine(line)).toEqual({ ...e, message: 'run timed out retrying', data: { ms: 20000.123, engine: 'webgl' } })
    expect(parseLine(formatEntry(entry('info', 'mic', 'a {weird} message')))).toMatchObject({ message: 'a {weird} message' })
    expect(parseLine('garbage')).toBeNull()
  })

  it('filters by component, level, time, text and count', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 23, 10, 0, s))
    const entries = [entry('info', 'mic', 'mic started', undefined, at(0)), entry('debug', 'slowpass', 'run started', undefined, at(1)), entry('error', 'worker:auto', 'boom', { error: 'x' }, at(2)), entry('warn', 'slowpass', 'fell behind', undefined, at(3))]
    expect(filterEntries(entries, { minLevel: 'warn' }).map((e) => e.message)).toEqual(['boom', 'fell behind'])
    expect(filterEntries(entries, { components: ['WORKER', 'mic'] }).map((e) => e.message)).toEqual(['mic started', 'boom'])
    expect(filterEntries(entries, { since: at(2) })).toHaveLength(2)
    expect(filterEntries(entries, { contains: 'BEHIND' })).toHaveLength(1)
    expect(filterEntries(entries, { last: 1 })[0]!.message).toBe('fell behind')
  })

  it('keeps data safe to write', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => JSON.parse(safeJson(cyclic))).not.toThrow()
    expect(safeJson({ big: 'x'.repeat(5000) }).length).toBeLessThan(2100)
    expect(errorData(new Error('nope'))).toMatchObject({ error: 'nope', stack: expect.stringContaining('nope') })
    expect(errorData('plain')).toEqual({ error: 'plain' })
  })
})

describe('summaries', () => {
  it('reports the mic going quiet and coming back once each, and summarizes a period', () => {
    const levels = new LevelSummary(0.004, 5)
    const changes: Array<string | null> = []
    for (let t = 0; t < 2; t += 0.1) changes.push(levels.add(0.05, t))
    for (let t = 2; t < 10; t += 0.1) changes.push(levels.add(0.0001, t))
    changes.push(levels.add(0.1, 10))
    expect(changes.filter(Boolean)).toEqual(['sound', 'silent', 'sound'])
    const summary = levels.take()!
    expect(summary.peakRms).toBe(0.1)
    expect(summary.silentPct).toBeGreaterThan(70)
    expect(levels.take()).toBeNull()
  })

  it('counts how many notes sound at once', () => {
    expect(maxPolyphony([])).toBe(0)
    expect(maxPolyphony([{ start: 0, duration: 1 }, { start: 1, duration: 1 }])).toBe(1) // touching, not overlapping
    expect(maxPolyphony([{ start: 0, duration: 2 }, { start: 0.1, duration: 1 }, { start: 0.2, duration: 1 }])).toBe(3)
  })
})

describe('slow pass events', () => {
  it('reports each run, silence, failures, timeouts and state changes', async () => {
    const ring = new AudioRing(30, 100)
    const events: SlowPassEvent[] = []
    let mode: 'ok' | 'fail' | 'hang' = 'hang'
    const pass = new SlowPass(
      ring,
      () =>
        mode === 'hang'
          ? new Promise(() => undefined)
          : mode === 'fail'
            ? Promise.reject(new Error('WebGL context lost'))
            : Promise.resolve([60, 64, 67].map((pitch) => ({ pitch, start: 0.5, duration: 0.5, amplitude: 0.9 }))),
      () => undefined,
      { hopSeconds: 2, marginSeconds: 0, contextSeconds: 0, firstRunTimeoutSeconds: 0.02, retrySeconds: 0, onEvent: (e) => events.push(e) },
    )
    ring.push(new Float32Array(300).fill(0.1), 3)
    pass.tick()
    await new Promise((r) => setTimeout(r, 40))
    expect(events.map((e) => e.type)).toEqual(['run', 'failed', 'state'])
    expect(events[1]).toMatchObject({ type: 'failed', timedOut: true, failures: 1, from: 0, to: 3 })
    expect(events[2]).toEqual({ type: 'state', from: 'loading', to: 'failing' })

    events.length = 0
    mode = 'fail'
    pass.tick()
    await tick()
    expect(events).toEqual([expect.objectContaining({ type: 'run' }), expect.objectContaining({ type: 'failed', timedOut: false, error: 'WebGL context lost', stack: expect.stringContaining('WebGL') })])

    events.length = 0
    mode = 'ok'
    pass.tick()
    await tick()
    expect(events.map((e) => e.type)).toEqual(['run', 'done', 'state'])
    expect(events[1]).toMatchObject({ rawNotes: 3, notes: 3, polyphony: 3 })
    expect(events[2]).toEqual({ type: 'state', from: 'failing', to: 'running' })

    events.length = 0
    ring.push(new Float32Array(300), 6) // silence: the model is skipped
    pass.tick()
    await tick()
    expect(events.map((e) => e.type)).toEqual(['silent'])
  })

  it('says when it skips audio after falling behind', () => {
    const ring = new AudioRing(30, 100)
    const events: SlowPassEvent[] = []
    const pass = new SlowPass(ring, async () => [], () => undefined, { hopSeconds: 2, marginSeconds: 0, maxStretchSeconds: 4, onEvent: (e) => events.push(e) })
    ring.push(new Float32Array(1000).fill(0.1), 10)
    pass.tick()
    expect(events[0]).toEqual({ type: 'skipped-ahead', lostSeconds: 6 })
  })
})

describe('log file', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'jam-log-'))

  it('holds entries until opened, then writes and reads them back', () => {
    const log = new FileLog()
    log.info('main', 'before open')
    expect(log.read()).toHaveLength(1)
    const where = dir()
    log.open(where)
    log.error('worker', 'model load failed', new Error('weights 404'), { backend: 'webgl' })
    expect(log.path).toBe(join(where, 'jamming-claude.log'))
    const read = log.read()
    expect(read.map((e) => e.message)).toEqual(['before open', 'model load failed'])
    expect(read[1]!.data).toMatchObject({ backend: 'webgl', error: 'weights 404' })
    expect(log.read({ minLevel: 'error' })).toHaveLength(1)
  })

  it('rotates, keeps a bounded number of files, and reads across them', () => {
    const where = dir()
    const log = new FileLog(1000, 2)
    log.open(where)
    for (let i = 0; i < 60; i++) log.info('slowpass', `run ${i}`, { i })
    expect(readdirSync(where).sort()).toEqual(['jamming-claude.log', 'jamming-claude.log.1', 'jamming-claude.log.2'])
    const read = log.read()
    expect(read.at(-1)!.message).toBe('run 59')
    expect(read.length).toBeLessThan(60) // the oldest were dropped
    const numbers = read.map((e) => e.data!.i as number)
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b)) // oldest first across files
    // Reopening continues the same file.
    const again = new FileLog(1000, 2)
    again.open(where)
    expect(again.read().at(-1)!.message).toBe('run 59')
  })
})

describe('read_logs tool', () => {
  it('filters the log and says where the file is', async () => {
    const where = dir2()
    const log = new FileLog()
    log.open(where)
    log.info('mic', 'mic started', { contextRate: 48000 })
    log.warn('slowpass', 'falling back to the CPU: a run on the GPU did not answer in time')
    log.info('slowpass', 'run done', { notes: 4 })
    const module = logsWith(log)({} as ToolContext)!
    const read = module.tools[0]!
    const call = async (args: Record<string, unknown>) => ((await read.handler(z.object(read.inputSchema).parse(args), {})).content[0] as { text: string }).text
    const warnings = await call({ level: 'warn' })
    expect(warnings).toMatch(/WARN +\[slowpass\] falling back to the CPU/)
    expect(warnings).not.toMatch(/run done/)
    expect(warnings).toContain(join(where, 'jamming-claude.log'))
    expect(await call({ component: 'mic, worker' })).toMatch(/mic started.*48000/)
    expect(await call({ component: 'camera' })).toMatch(/No info\+ log lines from camera/)
    expect(module.guide).toContain('read_logs')
  })
})

function dir2(): string {
  return mkdtempSync(join(tmpdir(), 'jam-log-tool-'))
}
