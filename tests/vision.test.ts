import { describe, expect, it } from 'vitest'
import type { CameraStatus } from '@shared/features/camera'
import type { MainEvent } from '@shared/ipc'
import { Transcript } from '@shared/music/transcript'
import type { NoteEvent } from '@shared/music/types'
import { handActivity, isRaised } from '@shared/music/vision/gesture'
import { HintStore, fretHints } from '@shared/music/vision/hints'
import { keyboardHands, pitchAtPoint, splitByHands, type KeyboardCalibration, type KeyboardHandsHint } from '@shared/music/vision/keyboard'
import { LM, lerp, project, type HandFrame, type Landmark, type Point, type Side, type TrackedHand } from '@shared/music/vision/landmarks'
import { bridgePoint, fretAtPoint, fretFraction, fretPoint, fretReach, frettingHint, steadyHint, type HandPositionHint, type NeckCalibration } from '@shared/music/vision/neck'
import { describeCamera, vision } from '../src/main/agent/tools/vision'
import { FeatureBus } from '../src/main/bus'
import { TasteMemory } from '../src/main/memory/taste'

const ASPECT = 16 / 9

/**
 * A synthetic hand: 21 landmarks, all at the wrist except the points the
 * vision code reads. `tips` are index..little fingertips; the middle knuckle
 * sits `size` (in picture heights) above the wrist.
 */
function hand(side: Side, tips: Point[], opts: { wrist?: Point; size?: number; score?: number; thumb?: Point } = {}): TrackedHand {
  const wrist = opts.wrist ?? { x: tips[0]!.x, y: tips[0]!.y + 0.2 }
  const landmarks: Landmark[] = Array.from({ length: 21 }, () => ({ ...wrist, z: 0 }))
  landmarks[LM.middleMcp] = { x: wrist.x, y: wrist.y - (opts.size ?? 0.1), z: 0 }
  ;[LM.indexTip, LM.middleTip, LM.ringTip, LM.pinkyTip].forEach((lm, i) => (landmarks[lm] = { ...(tips[i] ?? tips[tips.length - 1]!), z: 0 }))
  landmarks[LM.thumbTip] = { ...(opts.thumb ?? tips[0]!), z: 0 }
  return { side, score: opts.score ?? 0.95, landmarks }
}

describe('geometry', () => {
  it('projects in a space where both axes have the same scale', () => {
    // A horizontal line; a point directly below its midpoint by the line's own length.
    const a = { x: 0.2, y: 0.5 }
    const b = { x: 0.4, y: 0.5 }
    const below = { x: 0.3, y: 0.5 + 0.2 * ASPECT }
    const { along, off } = project(below, a, b, ASPECT)
    expect(along).toBeCloseTo(0.5)
    expect(off).toBeCloseTo(1)
    expect(project(lerp(a, b, 0.25), a, b, ASPECT).off).toBeCloseTo(0)
  })
})

describe('guitar neck', () => {
  // A neck running right to left and slightly uphill, as a right-handed player facing the camera shows it.
  const cal: NeckCalibration = { instrument: 'guitar', nut: { x: 0.85, y: 0.4 }, ref: { x: 0.5, y: 0.45 }, refFret: 12, aspect: ASPECT }
  /** A point mid-way between fret wires n-1 and n: where a finger playing fret n sits. */
  const on = (fret: number, lift = 0): Point => {
    const p = lerp(fretPoint(cal, fret - 1), fretPoint(cal, fret), 0.5)
    return { x: p.x, y: p.y + lift }
  }

  it('places fret wires by equal temperament', () => {
    expect(fretFraction(12)).toBeCloseTo(0.5)
    expect(fretPoint(cal, 12).x).toBeCloseTo(cal.ref.x)
    expect(fretPoint(cal, 0)).toEqual(cal.nut)
    // The bridge is as far beyond the twelfth fret as the nut is before it.
    expect(bridgePoint(cal).x).toBeCloseTo(0.15)
    for (const fret of [1, 3, 5, 7, 12, 17, 24]) expect(fretAtPoint(cal, fretPoint(cal, fret)).fret).toBeCloseTo(fret)
  })

  it('calibrates from any known fret, not only the twelfth', () => {
    const fromSeventh: NeckCalibration = { ...cal, ref: fretPoint(cal, 7), refFret: 7 }
    expect(bridgePoint(fromSeventh).x).toBeCloseTo(bridgePoint(cal).x)
    expect(fretAtPoint(fromSeventh, fretPoint(cal, 15)).fret).toBeCloseTo(15)
  })

  it('reads the frets a hand covers', () => {
    const hint = frettingHint(cal, hand('left', [on(5), on(6), on(7), on(8)]), 12.5)
    expect(hint).toMatchObject({ time: 12.5, instrument: 'guitar', lowFret: 5, highFret: 8 })
    expect(hint!.confidence).toBeGreaterThan(0.9)
    // An open-position chord: fingers on frets 1 to 3.
    expect(frettingHint(cal, hand('left', [on(1), on(2), on(3), on(3)]), 0)).toMatchObject({ lowFret: 1, highFret: 3 })
    // A barre: every fingertip at the same fret.
    expect(frettingHint(cal, hand('left', [on(7), on(7), on(7), on(7)]), 0)).toMatchObject({ lowFret: 7, highFret: 7 })
  })

  it('loses confidence as the hand leaves the neck line, and gives up when it is nowhere near', () => {
    const near = frettingHint(cal, hand('left', [on(5, 0.03), on(6, 0.03), on(7, 0.03), on(8, 0.03)]), 0)!
    const drifting = frettingHint(cal, hand('left', [on(5, 0.14), on(6, 0.14), on(7, 0.14), on(8, 0.14)]), 0)!
    expect(near.confidence).toBeGreaterThan(0.9)
    expect(drifting.confidence).toBeLessThan(near.confidence)
    expect(drifting.confidence).toBeGreaterThan(0)
    expect(frettingHint(cal, hand('left', [on(5, 0.4), on(6, 0.4), on(7, 0.4), on(8, 0.4)]), 0)).toBeNull()
  })

  it('ignores the picking hand over the body and a hand behind the nut', () => {
    const body = lerp(cal.nut, bridgePoint(cal), 0.9)
    expect(frettingHint(cal, hand('right', [body, body, body, body]), 0)).toBeNull()
    const headstock = lerp(cal.nut, bridgePoint(cal), -0.15)
    expect(frettingHint(cal, hand('left', [headstock, headstock, headstock, headstock]), 0)).toBeNull()
  })

  it('distrusts a span no hand could make and scales with the tracker score', () => {
    const impossible = frettingHint(cal, hand('left', [on(1), on(5), on(9), on(13)]), 0)!
    expect(impossible.confidence).toBe(0)
    const shaky = frettingHint(cal, hand('left', [on(5), on(6), on(7), on(8)], { score: 0.5 }), 0)!
    expect(shaky.confidence).toBeCloseTo(0.5)
  })

  it('steadies a jittery run of hints with a median', () => {
    const run: HandPositionHint[] = [5, 5, 9, 5, 4, 5].map((lowFret, i) => ({ time: i * 0.08, instrument: 'guitar', lowFret, highFret: lowFret + 3, confidence: 0.8 }))
    expect(steadyHint(run)).toMatchObject({ time: 0.4, instrument: 'guitar', lowFret: 5, highFret: 8 })
    expect(steadyHint(run)!.confidence).toBeCloseTo(0.8)
    expect(steadyHint([])).toBeNull()
  })

  it('scores candidate frets by how far they are from the hand', () => {
    const hint = { lowFret: 5, highFret: 8 }
    expect([0, 3, 5, 8, 10].map((fret) => fretReach(hint, fret))).toEqual([0, 2, 0, 0, 2])
    // The use tablature makes of it: E4 can be string 1 open, string 2 fret 5, string 3 fret 9...
    const candidates = [0, 5, 9, 14]
    const fretted = candidates.filter((f) => f > 0).sort((a, b) => fretReach(hint, a) - fretReach(hint, b))
    expect(fretted[0]).toBe(5)
  })
})

describe('piano keyboard', () => {
  // An 88-key keyboard seen from the front: low keys on the right of the picture.
  const cal: KeyboardCalibration = { low: { x: 0.9, y: 0.6 }, lowPitch: 21, high: { x: 0.1, y: 0.6 }, highPitch: 108, aspect: ASPECT }
  const key = (pitch: number, lift = 0): Point => ({ x: 0.9 - ((pitch - 21) / 87) * 0.8, y: 0.6 + lift })
  const over = (side: Side, low: number, high: number, score = 0.95) =>
    hand(side, [key(low + 1), key((low + high) / 2), key(high - 1), key(side === 'left' ? low : high)], { thumb: key(side === 'left' ? high : low), score })

  it('maps a point to the pitch under it', () => {
    expect(pitchAtPoint(cal, key(60)).pitch).toBeCloseTo(60)
    expect(pitchAtPoint(cal, key(21)).pitch).toBeCloseTo(21)
    expect(pitchAtPoint(cal, key(60, 0.1)).off).toBeGreaterThan(0)
  })

  it('finds each hand and the split between them', () => {
    const hint = keyboardHands(cal, [over('right', 64, 76), over('left', 40, 52)], 3)
    expect(hint).toMatchObject({ time: 3, left: { low: 40, high: 52 }, right: { low: 64, high: 76 }, split: 58 })
    expect(hint.confidence).toBeGreaterThan(0.8)
  })

  it('decides left and right by position when both hands are on the keys, whatever the tracker called them', () => {
    const hint = keyboardHands(cal, [over('left', 64, 76), over('left', 40, 52)], 0)
    expect(hint.left).toEqual({ low: 40, high: 52 })
    expect(hint.right).toEqual({ low: 64, high: 76 })
  })

  it('reports one hand without inventing a split', () => {
    const hint = keyboardHands(cal, [over('right', 60, 72)], 0)
    expect(hint).toMatchObject({ left: null, right: { low: 60, high: 72 }, split: null })
    expect(hint.confidence).toBeLessThanOrEqual(0.5)
  })

  it('ignores hands that are not over the keys and trusts overlapping hands less', () => {
    const lap = hand('left', [key(50, 0.3), key(52, 0.3), key(54, 0.3), key(56, 0.3)], { thumb: key(58, 0.3) })
    expect(keyboardHands(cal, [lap], 0)).toMatchObject({ left: null, right: null, split: null, confidence: 0 })
    const apart = keyboardHands(cal, [over('left', 40, 52), over('right', 64, 76)], 0)
    const crossed = keyboardHands(cal, [over('left', 50, 62), over('right', 56, 68)], 0)
    expect(crossed.confidence).toBeLessThan(apart.confidence)
  })

  it('splits notes between the staves by the hint nearest each note', () => {
    const note = (pitch: number, start: number): NoteEvent => ({ pitch, start, duration: 0.5, velocity: 0.8, source: 'audio', confidence: 1 })
    const hints: KeyboardHandsHint[] = [
      { time: 1, left: { low: 40, high: 52 }, right: { low: 64, high: 76 }, split: 58, confidence: 0.9 },
      // The left hand has moved up: middle C and the E above it are now its notes.
      { time: 5, left: { low: 55, high: 66 }, right: { low: 72, high: 84 }, split: 69, confidence: 0.9 },
      { time: 9, left: null, right: null, split: 30, confidence: 0.1 }, // too unsure to use
    ]
    const notes = [note(57, 1.1), note(64, 1.2), note(64, 5.1), note(72, 5.2), note(57, 9), note(64, 9), note(48, 30)]
    const { left, right } = splitByHands(notes, hints)
    expect(left.map((n) => [n.pitch, n.start])).toEqual([[57, 1.1], [64, 5.1], [57, 9], [48, 30]])
    expect(right.map((n) => [n.pitch, n.start])).toEqual([[64, 1.2], [72, 5.2], [64, 9]])
  })
})

describe('gestures', () => {
  const frames = (count: number, at: (i: number) => TrackedHand[]): HandFrame[] => Array.from({ length: count }, (_, i) => ({ time: i / 12, aspect: ASPECT, hands: at(i) }))
  const resting = (dx = 0) => hand('left', [{ x: 0.5 + dx, y: 0.5 }], { wrist: { x: 0.5 + dx, y: 0.7 } })

  it('tells a still hand from a moving one from no hand', () => {
    // Tracker jitter of a thousandth of the picture is still; sweeping across the picture is not.
    expect(handActivity(frames(12, (i) => [resting((i % 2) * 0.001)]), 'left').motion).toBe('still')
    const moving = handActivity(frames(12, (i) => [resting(i * 0.03)]), 'left')
    expect(moving.motion).toBe('moving')
    expect(moving.speed).toBeGreaterThan(1)
    expect(handActivity(frames(12, () => []), 'left').motion).toBe('absent')
    expect(handActivity(frames(12, (i) => [resting(i * 0.03)]), 'right').motion).toBe('absent')
    // One stray detection in a second is not a hand.
    expect(handActivity(frames(12, (i) => (i === 4 ? [resting()] : [])), 'left').motion).toBe('absent')
  })

  it('notices an open hand held up', () => {
    const up = hand('right', [{ x: 0.5, y: 0.2 }], { wrist: { x: 0.5, y: 0.5 }, size: 0.12 })
    const playing = hand('right', [{ x: 0.5, y: 0.45 }], { wrist: { x: 0.5, y: 0.5 }, size: 0.12 })
    expect(isRaised(up, ASPECT)).toBe(true)
    expect(isRaised(playing, ASPECT)).toBe(false)
    expect(handActivity(frames(6, () => [up]), 'right')).toMatchObject({ motion: 'still', raised: true })
  })
})

describe('hint store', () => {
  const hint = (time: number, confidence = 0.8): HandPositionHint => ({ time, instrument: 'guitar', lowFret: Math.round(time), highFret: Math.round(time) + 3, confidence })

  it('answers with the nearest trustworthy hint in reach, and forgets the oldest', () => {
    const store = new HintStore<HandPositionHint>(4)
    for (const h of [hint(1), hint(2), hint(3, 0.1), hint(10)]) store.add(h)
    expect(store.at(1.4)?.time).toBe(1)
    expect(store.at(3)?.time).toBe(2) // the hint at 3 is too unsure
    expect(store.at(6)).toBeNull() // nothing within reach
    expect(store.between(2, 10).map((h) => h.time)).toEqual([2, 3])
    store.add(hint(11))
    expect(store.at(1)?.time).toBe(2)
    expect(store.latest()?.time).toBe(11)
    store.clear()
    expect(store.latest()).toBeNull()
  })
})

describe('vision tools', () => {
  const off: CameraStatus = { on: false, cameras: [], tracking: 'off', hands: [], marked: { neck: null, neckPoints: [], keyboard: false, keyboardPoints: [] }, fretHint: null, keyboardHint: null }
  const on: CameraStatus = { ...off, on: true, camera: 'FaceTime HD', cameras: ['FaceTime HD', 'Desk cam'], width: 1280, height: 720, tracking: 'on' }

  /** A tool context whose window is `answer`. */
  function setup(answer: (request: { type: string; [key: string]: unknown }) => unknown) {
    const requests: Array<{ type: string; [key: string]: unknown }> = []
    const bus: FeatureBus = new FeatureBus((event: MainEvent) => {
      if (event.type !== 'feature-request') return
      const request = event.message as { type: string }
      requests.push(request)
      queueMicrotask(() => {
        try {
          bus.settle(event.id, answer(request))
        } catch (error) {
          bus.settle(event.id, null, (error as Error).message)
        }
      })
    })
    const module = vision({ transcript: new Transcript(), memory: new TasteMemory('/tmp/jam-vision-test'), now: () => 100, emit: () => undefined, bus, saveMidi: async () => '' })!
    const call = (name: string, args: Record<string, unknown> = {}) => module.tools.find((t) => t.name === name)!.handler(args, undefined)
    return { bus, module, call, requests }
  }

  it('describes what the tracker sees in words the model can use', () => {
    expect(describeCamera(off)).toBe('Camera: off.')
    const text = describeCamera({
      ...on,
      hands: [{ side: 'left', score: 0.9, motion: 'moving', raised: false }, { side: 'right', score: 0.9, motion: 'still', raised: false }],
      marked: { neck: 'guitar', neckPoints: ['nut', 'fret'], keyboard: true, keyboardPoints: ['low_key', 'high_key'] },
      fretHint: { time: 1, instrument: 'guitar', lowFret: 5, highFret: 8, confidence: 0.82 },
      keyboardHint: { time: 1, left: { low: 40, high: 52 }, right: null, split: null, confidence: 0.4 },
    })
    expect(text).toContain('FaceTime HD, 1280x720')
    expect(text).toContain('Others available: Desk cam')
    expect(text).toContain('left hand moving, right hand still')
    expect(text).toContain('frets 5-8 on the guitar')
    expect(text).toContain('left hand over E2-E3, right hand off the keys')
  })

  it('look returns the picture as an image block, turning the camera on first if it was off', async () => {
    let cameraOn = false
    const { call, requests } = setup((request) => {
      if (request.type === 'start') cameraOn = true
      if (request.type === 'frame') return { data: 'QUJD', mimeType: 'image/jpeg', width: 768, height: 432, time: 100, status: on }
      return cameraOn ? on : off
    })
    const first = await call('look', { seconds_ago: 0 })
    expect(requests.map((r) => r.type)).toEqual(['status', 'start', 'frame'])
    expect(first.content[0]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' })
    expect(first.content[1]).toMatchObject({ type: 'text' })
    expect((first.content[1] as { text: string }).text).toContain('tell the player')

    const second = await call('look', { seconds_ago: 5 })
    expect(requests.slice(3)).toEqual([{ type: 'status' }, { type: 'frame', secondsAgo: 5 }])
    expect((second.content[1] as { text: string }).text).not.toContain('tell the player')
  })

  it('reports a camera that cannot be opened as text, not a crash', async () => {
    const { call } = setup(() => {
      throw new Error('The camera could not be opened: Permission denied')
    })
    expect(await call('camera_on', {})).toEqual({ content: [{ type: 'text', text: 'The camera could not be opened: Permission denied' }] })
    expect((await call('look', { seconds_ago: 0 })).content[0]).toMatchObject({ type: 'text' })
  })

  it('passes marks to the window and mirrors the hints it sends back', async () => {
    const { call, requests, bus, module } = setup((request) => (request.type === 'mark' ? { ok: true, message: 'Marked the nut. Now mark the twelfth fret.', status: on } : on))
    expect(await call('mark_position', { point: 'nut', instrument: 'bass' })).toEqual({ content: [{ type: 'text', text: 'Marked the nut. Now mark the twelfth fret.' }] })
    expect(requests[0]).toEqual({ type: 'mark', point: 'nut', instrument: 'bass' })
    await call('mark_position', { point: 'clear' })
    expect(requests[1]).toEqual({ type: 'unmark', target: 'all' })

    fretHints.clear()
    bus.deliver('camera', { type: 'fret-hint', hint: { time: 42, instrument: 'bass', lowFret: 3, highFret: 6, confidence: 0.7 } })
    expect(fretHints.at(42.5)).toMatchObject({ lowFret: 3, highFret: 6 })
    fretHints.clear()

    expect(module.guide).toMatch(/- look:/)
    expect(module.guide).not.toMatch(/[*#`]/)
  })
})
