import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SLOW_PASS } from '@shared/features/slowpass'
import { AudioRing, SlowPass, describeSlowPass, type Correction, type SlowPassStatus } from '@shared/music/slowpass'
import { Transcript } from '@shared/music/transcript'
import { Playback } from '../src/main/playback'
import { core } from '../src/main/agent/tools/core'
import { notation } from '../src/main/agent/tools/notation'
import { FeatureBus } from '../src/main/bus'
import { TasteMemory } from '../src/main/memory/taste'

const tick = () => new Promise((r) => setTimeout(r, 0))
const status = (over: Partial<SlowPassStatus>): SlowPassStatus => ({
  state: 'running',
  correctedUntil: 98,
  heardUntil: 100,
  startedAt: 50,
  runs: 10,
  failures: 0,
  lastError: null,
  lastRunMs: 900,
  engine: 'webgl',
  at: 100,
  ...over,
})

describe('slow pass failures and status', () => {
  it('gives up on a run that never answers, reports it, and recovers', async () => {
    const ring = new AudioRing(30, 100)
    const corrections: Correction[] = []
    let timeouts = 0
    let hang = true
    const pass = new SlowPass(
      ring,
      () => (hang ? new Promise(() => undefined) : Promise.resolve([{ pitch: 60, start: 0.5, duration: 0.5, amplitude: 0.9 }])),
      (c) => corrections.push(c),
      { hopSeconds: 2, marginSeconds: 0, firstRunTimeoutSeconds: 0.02, retrySeconds: 1, onTimeout: () => timeouts++ },
    )
    ring.push(new Float32Array(300).fill(0.1), 3)
    expect(pass.tick()).toBe(true)
    expect(pass.status().state).toBe('loading')
    await new Promise((r) => setTimeout(r, 50))
    expect(pass.running).toBe(false) // not stuck busy forever
    expect(timeouts).toBe(1)
    expect(pass.status()).toMatchObject({ state: 'failing', failures: 1, correctedUntil: null })
    expect(pass.status().lastError).toMatch(/did not answer/)

    hang = false
    expect(pass.tick()).toBe(false) // waits before retrying
    ring.push(new Float32Array(100).fill(0.1), 4)
    expect(pass.tick()).toBe(true)
    await tick()
    expect(corrections.map((c) => [c.from, c.to])).toEqual([[0, 4]])
    expect(pass.status()).toMatchObject({ state: 'running', failures: 0, correctedUntil: 4, lastError: null })
  })

  it('records a model error and does not hammer the model', async () => {
    const ring = new AudioRing(30, 100)
    let calls = 0
    const pass = new SlowPass(ring, async () => (calls++, Promise.reject(new Error('WebGL context lost'))), () => undefined, { hopSeconds: 2, marginSeconds: 0, retrySeconds: 2 })
    ring.push(new Float32Array(300).fill(0.1), 3)
    pass.tick()
    await tick()
    for (let i = 0; i < 50; i++) pass.tick()
    expect(calls).toBe(1)
    expect(pass.status()).toMatchObject({ state: 'failing', lastError: 'WebGL context lost' })
  })

  it('describes the pass so the agent can explain it', () => {
    expect(describeSlowPass(null, 100)).toMatch(/not started/)
    expect(describeSlowPass(status({}), 100)).toBe('second pass: running on webgl, 0.9s per run; corrected up to 2s ago')
    expect(describeSlowPass(status({ correctedUntil: 70 }), 100)).toMatch(/lagging 30s behind/)
    expect(describeSlowPass(status({ state: 'loading', correctedUntil: null, runs: 0, startedAt: 94 }), 100)).toMatch(/starting up.*6s so far/)
    const failing = describeSlowPass(status({ state: 'failing', failures: 3, lastError: 'the model did not answer within 20 s', correctedUntil: null }), 100)
    expect(failing).toMatch(/FAILING on webgl \(3 failed runs in a row: the model did not answer within 20 s\); it has never succeeded/)
    expect(describeSlowPass(status({ at: 80 }), 100)).toMatch(/no audio from the mic for 20s/)
  })
})

describe('listen and read_music report the slow pass', () => {
  const setup = () => {
    const transcript = new Transcript()
    const bus = new FeatureBus(() => undefined)
    const ctx = { transcript, memory: new TasteMemory('/tmp/jam-slowpass-test'), now: () => 100, emit: () => undefined, bus, playback: new Playback(() => undefined), saveMidi: async () => '' }
    const modules = [core(ctx)!, notation(ctx)!]
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const found = modules.flatMap((m) => m.tools).find((t) => t.name === name)!
      const result = await found.handler(z.object(found.inputSchema).parse(args), {})
      return (result.content[0] as { text: string }).text
    }
    transcript.add([60, 62, 64, 65, 67].map((pitch, i) => ({ pitch, start: 90 + i, duration: 0.8, velocity: 0.7, source: 'audio' as const, confidence: 0.5 })))
    return { transcript, bus, call }
  }

  it('says why chords are missing when the pass is failing', async () => {
    const { bus, call } = setup()
    expect(await call('listen', { seconds: 20 })).toMatch(/fast pass only.*not started/)
    bus.deliver(SLOW_PASS, status({ state: 'failing', failures: 4, lastError: 'model weights not found (404)', correctedUntil: null }))
    expect(await call('listen', { seconds: 20 })).toMatch(/FAILING on webgl \(4 failed runs in a row: model weights not found \(404\)\)/)
    expect(await call('read_music', { seconds: 20 })).toMatch(/Audio transcription: none of this audio is corrected yet.*FAILING/)
  })

  it('says how far behind a working pass is', async () => {
    const { transcript, bus, call } = setup()
    transcript.revise(80, 97, 'audio', [{ pitch: 60, start: 91, duration: 1, velocity: 0.8, source: 'audio', confidence: 0.9 }])
    bus.deliver(SLOW_PASS, status({ correctedUntil: 97 }))
    expect(await call('listen', { seconds: 20 })).toMatch(/corrected by the polyphonic pass except the most recent 3s.*second pass: running on webgl/)
  })
})
