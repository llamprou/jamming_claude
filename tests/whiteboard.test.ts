import { describe, expect, it } from 'vitest'
import type { MainEvent } from '@shared/ipc'
import type { WhiteboardContent } from '@shared/features/whiteboard'
import { Transcript } from '@shared/music/transcript'
import { VIEWS } from '@shared/views'
import { BOARD_WIDTH, Board, describeBoard, strokeWidth } from '@shared/whiteboard'
import { whiteboard } from '../src/main/agent/tools/whiteboard'
import { FeatureBus } from '../src/main/bus'
import { TasteMemory } from '../src/main/memory/taste'
import { Playback } from '../src/main/playback'

describe('whiteboard board', () => {
  it('records strokes, clamps them to the board, and undoes strokes and clears', () => {
    const board = new Board()
    expect(board.isEmpty()).toBe(true)
    board.begin({ x: 100, y: 100, pressure: 0 })
    board.extend({ x: BOARD_WIDTH + 500, y: -20, pressure: 0.9 })
    board.end()
    board.extend({ x: 1, y: 1, pressure: 1 }) // not drawing: ignored
    expect(board.strokes[0]!.points).toEqual([
      { x: 100, y: 100, pressure: 0.5 },
      { x: BOARD_WIDTH, y: 0, pressure: 0.9 },
    ])
    board.setText('Am F C G')
    board.begin({ x: 300, y: 300, pressure: 0.5 })
    board.end()
    expect(board.inkStrokes()).toBe(2)

    board.clear()
    expect(board.isEmpty()).toBe(true)
    expect(board.undo()).toBe(true) // brings back drawing and text
    expect(board.inkStrokes()).toBe(2)
    expect(board.text).toBe('Am F C G')
    expect(board.undo()).toBe(true)
    expect(board.undo()).toBe(true)
    expect(board.strokes).toEqual([])
    expect(board.undo()).toBe(false)
    expect(board.isEmpty()).toBe(false) // the text was typed, not undone
  })

  it('does not count eraser strokes as ink, and bounds only what is drawn', () => {
    const board = new Board()
    board.begin({ x: 500, y: 400, pressure: 0.5 }, { erase: true })
    board.end()
    expect(board.isEmpty()).toBe(true)
    expect(board.bounds()).toBeNull()
    board.begin({ x: 200, y: 300, pressure: 0.5 })
    board.extend({ x: 400, y: 350, pressure: 0.5 })
    expect(board.bounds(10)).toEqual({ x: 190, y: 290, width: 220, height: 70 })
    expect(board.bounds(1000)!.x).toBe(0)
  })

  it('thickens lines with pressure and treats missing pressure as medium', () => {
    expect(strokeWidth(10, 0)).toBe(strokeWidth(10, 0.5))
    expect(strokeWidth(10, 1)).toBeGreaterThan(strokeWidth(10, 0.5))
    expect(strokeWidth(10, 0.1)).toBeLessThan(strokeWidth(10, 0.5))
  })

  it('describes the content for the model', () => {
    expect(describeBoard({ text: '  ', strokes: 0 })).toBe('The whiteboard is empty.')
    expect(describeBoard({ text: 'Dm7 G7', strokes: 3 })).toBe('Typed text:\nDm7 G7\nDrawing: 3 strokes; the picture shows it.')
    expect(describeBoard({ text: '', strokes: 1 })).toContain('No typed text.')
  })
})

describe('whiteboard tools', () => {
  function setup(content: WhiteboardContent) {
    const requests: unknown[] = []
    const notes: string[] = []
    const bus: FeatureBus = new FeatureBus((event: MainEvent) => {
      if (event.type !== 'feature-request') return
      requests.push(event.message)
      queueMicrotask(() => bus.settle(event.id, content))
    })
    const module = whiteboard({ transcript: new Transcript(), memory: new TasteMemory('/tmp/jam-wb-test'), now: () => 0, emit: () => undefined, bus, playback: new Playback(() => undefined), saveMidi: async () => '', notify: (n) => notes.push(n) })!
    const call = (name: string) => module.tools.find((t) => t.name === name)!.handler({}, undefined)
    return { bus, module, call, requests, notes }
  }

  it('is a view the agent can open, and its guide says when', () => {
    expect(VIEWS.map((v) => v.kind)).toContain('whiteboard')
    const { module } = setup({ text: '', strokes: 0 })
    expect(module.guide).toMatch(/pull up the whiteboard/)
  })

  it('returns the picture and typed text, or just words when nothing is drawn', async () => {
    const drawn = setup({ text: 'swing it', strokes: 2, image: 'iVBOR', mimeType: 'image/png' })
    const result = await drawn.call('read_whiteboard')
    expect(result.content[0]).toEqual({ type: 'image', data: 'iVBOR', mimeType: 'image/png' })
    expect(result.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('swing it') })
    expect(drawn.requests).toEqual([{ type: 'read' }])

    const empty = setup({ text: '', strokes: 0 })
    expect((await empty.call('read_whiteboard')).content).toEqual([{ type: 'text', text: 'The whiteboard is empty.' }])
    await empty.call('clear_whiteboard')
    expect(empty.requests).toEqual([{ type: 'read' }, { type: 'clear' }])
  })

  it('tells the agent when the player presses Done', () => {
    const { bus, notes } = setup({ text: '', strokes: 0 })
    bus.deliver('whiteboard', { type: 'other' })
    expect(notes).toEqual([])
    bus.deliver('whiteboard', { type: 'done' })
    expect(notes[0]).toMatch(/read_whiteboard/)
  })
})
