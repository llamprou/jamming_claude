import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MainEvent } from '@shared/ipc'
import { Transcript } from '@shared/music/transcript'
import { JamSession } from '../src/main/agent/session'
import { FeatureBus } from '../src/main/bus'
import { TasteMemory } from '../src/main/memory/taste'

/**
 * Talks to the real model, so it is opt-in: JAM_LIVE=1 npm test
 * (needs ANTHROPIC_API_KEY). Checks the whole loop: the agent listens to what
 * was played, plays an idea back, and logs a taste reaction.
 */
describe.skipIf(!process.env.JAM_LIVE)('live agent', () => {
  it('hears a progression, plays a continuation and remembers a reaction', async () => {
    const transcript = new Transcript()
    const chords = [[62, 65, 69, 72], [55, 59, 62, 65], [60, 64, 67, 71]]
    chords.forEach((pitches, i) => transcript.add(pitches.map((pitch) => ({ pitch, start: i * 2, duration: 2, velocity: 0.8, source: 'midi' as const, confidence: 1 }))))
    const memory = new TasteMemory(await mkdtemp(join(tmpdir(), 'jam-live-')))
    const events: MainEvent[] = []
    let spoken = ''

    const turn = () =>
      new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
          const status = events.findLast((e) => e.type === 'status')
          if (status?.type !== 'status' || status.agent === 'thinking' || status.agent === 'speaking') return
          clearInterval(timer)
          events.push({ type: 'status', agent: 'thinking' })
          if (status.agent === 'error') reject(new Error(status.detail))
          else resolve()
        }, 100)
      })

    const jam = new JamSession(
      { transcript, memory, now: () => 6, emit: (e) => events.push(e), bus: new FeatureBus((e) => events.push(e)), saveMidi: async (name) => `/tmp/${name}.mid` },
      { model: process.env.JAM_AGENT_MODEL ?? 'claude-opus-5-5', voice: true, onSpeech: (chunk) => (spoken += chunk), onSpeechEnd: () => undefined },
    )
    await jam.start()
    try {
      // With voice on, the buddy speaks first.
      events.push({ type: 'status', agent: 'thinking' })
      await turn()
      expect(spoken.length, 'no greeting').toBeGreaterThan(0)
      jam.say('What was that I just played? Play me four bars that could come next.')
      await turn()
      const played = events.find((e) => e.type === 'play-clip')
      expect(played, `no clip played; buddy said: ${spoken}`).toBeDefined()
      expect(spoken.length).toBeGreaterThan(0)
      expect(spoken).not.toMatch(/[*#`]/) // spoken replies carry no markdown

      jam.say("Love that, that's exactly my thing. Keep it that mellow.")
      await turn()
      expect((await memory.events()).some((e) => ['loved', 'liked', 'kept'].includes(e.reaction))).toBe(true)
      console.log({ spoken, played: played?.type === 'play-clip' ? played.clip : null, memory: await memory.events() })
    } finally {
      jam.stop()
    }
  }, 180_000)
})
