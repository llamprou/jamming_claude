import { mkdtemp, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TasteMemory } from '../src/main/memory/taste'

describe('taste memory', () => {
  it('logs reactions, filters by tag, and tracks what is not yet distilled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jam-taste-'))
    const memory = new TasteMemory(join(dir, 'nested'))
    expect(await memory.events()).toEqual([])
    expect(await memory.profile()).toContain('Nothing learned yet')

    await memory.record({ reaction: 'loved', subject: 'tritone sub into the I', tags: ['jazz', 'harmony'] }, new Date('2026-01-01'))
    await memory.record({ reaction: 'skipped', subject: 'busy 16th hi-hats', tags: ['groove'] }, new Date('2026-01-02'))
    await appendFile(join(dir, 'nested', 'events.jsonl'), '{"half-written\n')

    expect((await memory.events()).map((e) => e.reaction)).toEqual(['loved', 'skipped'])
    expect(await memory.events(10, 'jazz')).toHaveLength(1)
    expect(await memory.undistilledCount()).toBe(2)

    await memory.writeProfile('# Taste\nLikes tritone subs; keep drums sparse.')
    expect(await memory.profile()).toContain('tritone')
    expect(await memory.undistilledCount()).toBe(0)
  })
})
