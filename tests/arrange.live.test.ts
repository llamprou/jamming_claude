import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MainEvent } from '@shared/ipc'
import { Transcript } from '@shared/music/transcript'
import { JamSession } from '../src/main/agent/session'
import { FeatureBus } from '../src/main/bus'
import { TasteMemory } from '../src/main/memory/taste'

/** Opt-in (JAM_LIVE=1): does the real agent reach for the arrangement tools when asked in plain speech? */
describe.skipIf(!process.env.JAM_LIVE)('live agent: arranging', () => {
  it('builds a layered arrangement and reharmonizes it by voice', async () => {
    const events: MainEvent[] = []
    let spoken = ''
    const turn = () =>
      new Promise<void>((resolve, reject) => {
        events.push({ type: 'status', agent: 'thinking' })
        const timer = setInterval(() => {
          const status = events.findLast((e) => e.type === 'status')
          if (status?.type !== 'status' || status.agent === 'thinking' || status.agent === 'speaking') return
          clearInterval(timer)
          if (status.agent === 'error') reject(new Error(status.detail))
          else resolve()
        }, 100)
      })
    const jam = new JamSession(
      { transcript: new Transcript(), memory: new TasteMemory(await mkdtemp(join(tmpdir(), 'jam-live-'))), now: () => 0, emit: (e) => events.push(e), bus: new FeatureBus((e) => events.push(e)), saveMidi: async (name) => `/tmp/${name}.mid` },
      { model: process.env.JAM_AGENT_MODEL ?? 'claude-opus-5-5', voice: false, onSpeech: (chunk) => (spoken += chunk), onSpeechEnd: () => undefined },
    )
    await jam.start()
    try {
      jam.say('Give me a two five one in C with a walking bass and swing drums.')
      await turn()
      const first = events.findLast((e) => e.type === 'play-clip')
      expect(first?.type === 'play-clip' && first.clip.tracks.map((t) => t.role).sort(), spoken).toEqual(expect.arrayContaining(['bass', 'drums']))

      jam.say('Nice. Now reharmonize it with tritone substitutions.')
      await turn()
      const clips = events.filter((e) => e.type === 'play-clip')
      expect(clips.length, spoken).toBeGreaterThanOrEqual(2)
      console.log(spoken)
    } finally {
      jam.stop()
    }
  }, 180_000)
})
