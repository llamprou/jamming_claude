import { describe, expect, it } from 'vitest'
import type { MainEvent } from '@shared/ipc'
import type { TransportRequest, TransportState } from '@shared/features/transport'
import { cutTake, fadeOutFor, planPass, rms, RollingAudio, SampleClock } from '@shared/music/transport/audioloop'
import { extractLoop, lastBars } from '@shared/music/transport/extract'
import { barPosition, beatAt, ceilToStep, followStep, loopPosition, makeGrid, nextDownbeat, quantizeStart, rebar, retune, timeAt, wholeBars, wrapBeats, type BeatGrid } from '@shared/music/transport/grid'
import { layerEvents, Scheduler, type Layer, type NoteLayer, type Scheduled } from '@shared/music/transport/scheduler'
import { BeatTracker, clusterOnsets } from '@shared/music/transport/tracker'
import { Transcript } from '@shared/music/transcript'
import type { Clip, NoteEvent } from '@shared/music/types'
import type { ToolContext } from '../src/main/agent/toolkit'
import { transport } from '../src/main/agent/tools/transport'
import { FeatureBus } from '../src/main/bus'
import { TasteMemory } from '../src/main/memory/taste'

/** Deterministic random numbers, so the simulated players are the same every run. */
function random(seed: number) {
  let a = seed >>> 0
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gauss = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform())
  return { uniform, gauss }
}

const note = (pitch: number, start: number, duration = 0.2, velocity = 0.8): NoteEvent => ({ pitch, start, duration, velocity, source: 'midi', confidence: 1 })

/* ------------------------------------------------------------------ */

describe('beat grid', () => {
  const grid = makeGrid(120, 10)

  it('maps beats to session time and back', () => {
    expect(timeAt(grid, 0)).toBe(10)
    expect(timeAt(grid, 4)).toBe(12)
    expect(beatAt(grid, 11)).toBe(2)
    for (const beat of [-3.5, 0, 1.25, 17]) expect(beatAt(grid, timeAt(grid, beat))).toBeCloseTo(beat, 9)
    expect(barPosition(grid, 9.5)).toEqual({ bar: 2, beatInBar: 1.5 })
    expect(barPosition(grid, -1)).toEqual({ bar: -1, beatInBar: 3 })
  })

  it('quantises a start to the next bar or beat, never the past', () => {
    expect(quantizeStart(grid, 4.01, 'bar')).toBe(8)
    expect(quantizeStart(grid, 4, 'bar')).toBe(4)
    expect(quantizeStart(grid, 4.01, 'beat')).toBe(5)
    expect(quantizeStart(grid, 4.01, 'now')).toBe(4.01)
    expect(ceilToStep(7.9999999999, 4)).toBe(8)
    expect(nextDownbeat(grid, 12.1)).toBe(8)
    expect(timeAt(grid, nextDownbeat(grid, 12.1))).toBe(14)
  })

  it('changes tempo without moving anything already played', () => {
    const faster = retune(grid, 6, 150)
    expect(timeAt(faster, 6)).toBeCloseTo(timeAt(grid, 6), 12)
    expect(timeAt(faster, 7) - timeAt(faster, 6)).toBeCloseTo(0.4, 12)
    expect(beatAt(faster, timeAt(grid, 6))).toBeCloseTo(6, 12)
  })

  it('moves the bar line without moving the beats', () => {
    const shifted = rebar(grid, 6)
    expect(beatAt(shifted, timeAt(grid, 6))).toBeCloseTo(4, 12)
    expect(barPosition(shifted, beatAt(shifted, timeAt(grid, 6))).beatInBar).toBeCloseTo(0, 12)
    expect(rebar(grid, 8)).toEqual(grid)
  })

  it('does loop arithmetic', () => {
    const region = { startBeat: 8, lengthBeats: 8 }
    expect(loopPosition(region, 8)).toEqual({ pass: 0, offset: 0 })
    expect(loopPosition(region, 27)).toEqual({ pass: 2, offset: 3 })
    expect(loopPosition(region, 7)).toEqual({ pass: -1, offset: 7 })
    expect(wholeBars(7.5, 4)).toBe(8)
    expect(wholeBars(8, 4)).toBe(8)
    expect(wholeBars(8.5, 4)).toBe(12)
    expect(wholeBars(0, 3)).toBe(3)
    expect(wrapBeats(0.7)).toBeCloseTo(-0.3)
    expect(wrapBeats(-0.2)).toBeCloseTo(-0.2)
    expect(wrapBeats(0.3, 0.5)).toBeCloseTo(-0.2)
  })
})

describe('following the player', () => {
  /** Run the transport's grid against a player's, one follow step per beat, and report what happened. */
  function chase(own: BeatGrid, player: BeatGrid, steps: number, confidence = 0.9) {
    let base = own.bpm
    let cursor = 0
    let worstJump = 0
    let worstRate = 0
    let error = 0
    for (let i = 0; i < steps; i++) {
      cursor += 1
      const before = timeAt(own, cursor)
      const step = followStep(own, base, player, confidence, cursor)
      worstJump = Math.max(worstJump, Math.abs(timeAt(step.grid, cursor) - before))
      worstRate = Math.max(worstRate, Math.abs(step.grid.bpm / step.baseBpm - 1))
      own = step.grid
      base = step.baseBpm
      error = step.phaseError
    }
    return { own, base, worstJump, worstRate, error }
  }

  it('pulls tempo and beat phase onto the player without a jump', () => {
    // We are at 100 bpm; the player is at 104 and 120 ms off our beat.
    const result = chase(makeGrid(100, 0), makeGrid(104, 0.12), 40)
    expect(result.base).toBeCloseTo(104, 1)
    expect(Math.abs(result.error)).toBeLessThan(0.03)
    expect(result.worstJump).toBeLessThan(1e-9) // continuous at every change
    expect(result.worstRate).toBeLessThanOrEqual(0.06 + 1e-9) // never more than a 6% push
    // Our beats now fall on theirs.
    const t = timeAt(result.own, 60)
    expect(Math.abs(wrapBeats(beatAt(makeGrid(104, 0.12), t)))).toBeLessThan(0.03)
  })

  it('ignores an unsure tracker and a wildly different tempo', () => {
    const own = makeGrid(100, 0)
    expect(followStep(own, 100, makeGrid(104, 0.1), 0.2, 8).followed).toBe(false)
    expect(followStep(own, 100, makeGrid(140, 0.1), 0.9, 8)).toMatchObject({ followed: false, baseBpm: 100 })
  })

  it('treats a half-time or double-time reading as the same pulse', () => {
    const half = chase(makeGrid(100, 0), makeGrid(51, 0.05), 40)
    expect(half.base).toBeCloseTo(102, 1)
    const double = chase(makeGrid(100, 0), makeGrid(198, 0.05), 40)
    expect(double.base).toBeCloseTo(99, 1)
    expect(Math.abs(double.error)).toBeLessThan(0.03)
  })

  it('drops the phase correction when the tracker goes quiet', () => {
    const own = retune(makeGrid(100, 0), 4, 104) // mid-correction
    const held = followStep(own, 100, makeGrid(100, 0), 0, 8)
    expect(held.grid.bpm).toBe(100)
    expect(timeAt(held.grid, 8)).toBeCloseTo(timeAt(own, 8), 12)
  })
})

/* ------------------------------------------------------------------ */

interface Player {
  notes: NoteEvent[]
  /** True time of every beat. */
  beats: number[]
}

/** A player whose tempo glides from one value to another, with timing jitter, dropped notes and stray ones. */
function simulatePlayer(opts: { seed: number; seconds: number; fromBpm: number; toBpm: number; jitter: number; drop: number; extra: number; start?: number }): Player {
  const { uniform, gauss } = random(opts.seed)
  const beats: number[] = []
  const notes: NoteEvent[] = []
  let time = opts.start ?? 2
  const end = time + opts.seconds
  for (let beat = 0; time < end; beat++) {
    const bpm = opts.fromBpm + ((opts.toBpm - opts.fromBpm) * (time - (opts.start ?? 2))) / opts.seconds
    const period = 60 / bpm
    beats.push(time)
    const downbeat = beat % 4 === 0
    // On the beat: usually there, louder and fuller on the downbeat.
    if (uniform() >= opts.drop) {
      const at = time + gauss() * opts.jitter
      notes.push(note(downbeat ? 43 : 55, at, period * 0.8, downbeat ? 0.95 : 0.7))
      if (downbeat) notes.push(note(59, at + 0.004, period * 0.8, 0.9), note(62, at + 0.008, period * 0.8, 0.9))
    }
    // The off-beat eighth, about half the time.
    if (uniform() < 0.5) notes.push(note(67, time + period / 2 + gauss() * opts.jitter, period * 0.4, 0.55))
    // A stray note anywhere in the beat.
    if (uniform() < opts.extra) notes.push(note(72, time + uniform() * period, 0.1, 0.4))
    time += period
  }
  return { notes: notes.sort((a, b) => a.start - b.start), beats }
}

/** Follow a simulated player in real time and measure how well each update predicts the beats to come. */
function trackPlayer(player: Player, warmup = 8) {
  const tracker = new BeatTracker()
  const errors: number[] = []
  const tempoErrors: number[] = []
  const confidences: number[] = []
  const first = player.beats[0]!
  const last = player.beats[player.beats.length - 1]!
  for (let now = first + 1; now < last - 1.5; now += 0.4) {
    const estimate = tracker.update(
      player.notes.filter((n) => n.start <= now),
      now,
    )
    if (!estimate || now < first + warmup) continue
    confidences.push(estimate.confidence)
    // Predict the next two beats and compare with where the player really puts them.
    const nextBeat = Math.ceil(beatAt(estimate.grid, now))
    for (const beat of [nextBeat, nextBeat + 1]) {
      const predicted = timeAt(estimate.grid, beat)
      errors.push(Math.min(...player.beats.map((b) => Math.abs(b - predicted))))
    }
    const index = player.beats.findIndex((b) => b > now)
    const truePeriod = player.beats[index]! - player.beats[index - 1]!
    tempoErrors.push(Math.abs(estimate.grid.bpm / (60 / truePeriod) - 1))
  }
  const sorted = [...errors].sort((a, b) => a - b)
  return {
    tracker,
    median: sorted[Math.floor(sorted.length / 2)]!,
    p95: sorted[Math.floor(sorted.length * 0.95)]!,
    worst: sorted[sorted.length - 1]!,
    worstTempo: Math.max(...tempoErrors),
    meanConfidence: confidences.reduce((a, b) => a + b, 0) / confidences.length,
    updates: confidences.length,
  }
}

describe('beat tracker', () => {
  it('merges notes struck together into one onset', () => {
    const onsets = clusterOnsets([note(60, 1), note(64, 1.01), note(67, 1.02), note(60, 1.5)])
    expect(onsets).toHaveLength(2)
    expect(onsets[0]!.time).toBeCloseTo(1.01, 5)
    expect(onsets[0]!.accent).toBeGreaterThan(onsets[1]!.accent)
  })

  it('needs a few onsets before it says anything', () => {
    const tracker = new BeatTracker()
    expect(tracker.update([note(60, 1), note(60, 1.5)], 2)).toBeNull()
    expect(tracker.beatTime(0)).toBeNull()
  })

  it('finds tempo and beat phase of a steady player', () => {
    const notes = Array.from({ length: 16 }, (_, i) => note(60, 3 + i * 0.5))
    const tracker = new BeatTracker()
    const estimate = tracker.update(notes, 11)!
    expect(estimate.grid.bpm).toBeCloseTo(120, 0)
    expect(estimate.confidence).toBeGreaterThan(0.8)
    const beat = beatAt(estimate.grid, 11.5) // the player's next beats are at 11.0, 11.5...
    expect(Math.abs(beat - Math.round(beat)) * 0.5).toBeLessThan(0.01)
    expect(tracker.nextDownbeatTime(11)).not.toBeNull()
  })

  it('stays on a player whose tempo drifts, through jitter, dropped notes and stray ones', () => {
    // 96 -> 110 bpm over 45 s, 12 ms timing jitter, 15% of beats missing, strays on 15% of beats.
    const result = trackPlayer(simulatePlayer({ seed: 7, seconds: 45, fromBpm: 96, toBpm: 110, jitter: 0.012, drop: 0.15, extra: 0.15 }))
    expect(result.updates).toBeGreaterThan(60)
    expect(result.median).toBeLessThan(0.015)
    expect(result.p95).toBeLessThan(0.04)
    expect(result.worst).toBeLessThan(0.08)
    expect(result.worstTempo).toBeLessThan(0.05)
    expect(result.meanConfidence).toBeGreaterThan(0.6)
  })

  it('holds up across players and tempi', () => {
    const cases = [
      { seed: 1, seconds: 40, fromBpm: 120, toBpm: 112, jitter: 0.015, drop: 0.2, extra: 0.1 },
      { seed: 2, seconds: 40, fromBpm: 76, toBpm: 84, jitter: 0.02, drop: 0.1, extra: 0.2 },
      { seed: 3, seconds: 40, fromBpm: 140, toBpm: 150, jitter: 0.01, drop: 0.25, extra: 0.1 },
      { seed: 4, seconds: 40, fromBpm: 100, toBpm: 100, jitter: 0.025, drop: 0.3, extra: 0.3 },
    ]
    for (const options of cases) {
      const result = trackPlayer(simulatePlayer(options))
      expect(result.p95, `seed ${options.seed} p95`).toBeLessThan(0.055)
      // The last player is the sloppiest (25 ms jitter, a third of beats missing, strays on a third).
      expect(result.median, `seed ${options.seed} median`).toBeLessThan(options.jitter > 0.02 ? 0.025 : 0.02)
    }
  })

  it('keeps counting through a gap and loses confidence in a long silence', () => {
    const notes = Array.from({ length: 20 }, (_, i) => note(60, 2 + i * 0.6))
    const tracker = new BeatTracker()
    for (let now = 6; now <= 14; now += 0.4) tracker.update(notes, now)
    const playing = tracker.estimate!
    expect(playing.grid.bpm).toBeCloseTo(100, 0)
    // They stop at 13.4 s. Twenty seconds on, the grid still extrapolates but is not trusted.
    let later = playing
    for (let now = 14.4; now <= 34; now += 0.4) later = tracker.update(notes, now)!
    expect(later.confidence).toBeLessThan(0.3)
    const beat = beatAt(later.grid, 26)
    expect(Math.abs(beat - Math.round(beat))).toBeLessThan(0.1) // 26 s is a beat of the old pulse (2 + 40 * 0.6)
  })

  it('numbers beats continuously from one update to the next', () => {
    const player = simulatePlayer({ seed: 11, seconds: 30, fromBpm: 104, toBpm: 104, jitter: 0.008, drop: 0.1, extra: 0.05 })
    const tracker = new BeatTracker()
    let previous: number | null = null
    let shifts = 0
    for (let now = 8; now < 30; now += 0.4) {
      const estimate = tracker.update(player.notes.filter((n) => n.start <= now), now)!
      const beat = beatAt(estimate.grid, now)
      // 0.4 s at 104 bpm is 0.69 beats; anything else means the count slipped (a downbeat change moves it by whole beats).
      if (previous !== null && Math.abs(beat - previous - 0.693) > 0.12) shifts++
      previous = beat
    }
    expect(shifts).toBeLessThanOrEqual(1)
  })

  it('puts the downbeat where the accents and phrase starts are', () => {
    const player = simulatePlayer({ seed: 5, seconds: 30, fromBpm: 100, toBpm: 100, jitter: 0.008, drop: 0.05, extra: 0.05 })
    const { tracker } = trackPlayer(player)
    const grid = tracker.estimate!.grid
    // Every fourth true beat, starting with the first, is a downbeat.
    for (const index of [20, 24, 28]) {
      const position = barPosition(grid, beatAt(grid, player.beats[index]!))
      expect(Math.min(position.beatInBar, 4 - position.beatInBar)).toBeLessThan(0.15)
    }
  })

  it('applies a per-source onset offset', () => {
    const late = Array.from({ length: 16 }, (_, i) => ({ ...note(60, 3.05 + i * 0.5), source: 'audio' as const }))
    const tracker = new BeatTracker({ onsetOffset: (n) => (n.source === 'audio' ? -0.05 : 0) })
    const estimate = tracker.update(late, 11.02)!
    const next = timeAt(estimate.grid, Math.ceil(beatAt(estimate.grid, 10.9)))
    expect(Math.abs(next - 11)).toBeLessThan(0.012)
  })
})

/* ------------------------------------------------------------------ */

const clip = (notes: Array<[pitch: number, startBeat: number, durationBeats?: number]>, name = 'c'): Clip => ({
  name,
  bpm: 120,
  tracks: [{ role: 'melody', program: 0, notes: notes.map(([pitch, startBeat, durationBeats = 0.5]) => ({ pitch, startBeat, durationBeats, velocity: 0.8 })) }],
})

const notesLayer = (id: string, c: Clip, startBeat: number, lengthBeats: number, loop = true): NoteLayer => ({ kind: 'notes', id, clip: c, startBeat, lengthBeats, loop })

/** What a layer should play in [from, to), worked out the slow, obvious way. */
function expected(layer: NoteLayer, from: number, to: number): string[] {
  const out: string[] = []
  const end = Math.min(layer.stopBeat ?? Infinity, layer.loop ? Infinity : layer.startBeat + layer.lengthBeats)
  for (let pass = 0; layer.startBeat + pass * layer.lengthBeats < to; pass++) {
    if (pass > 0 && !layer.loop) break
    for (const n of layer.clip.tracks[0]!.notes) {
      const beat = layer.startBeat + pass * layer.lengthBeats + n.startBeat
      if (beat >= from && beat < to && beat < end) out.push(`${layer.id}:${n.pitch}@${beat.toFixed(6)}`)
    }
  }
  return out.sort()
}

const keys = (events: Scheduled[]) => events.flatMap((e) => (e.kind === 'note' ? [`${e.layerId}:${e.pitch}@${e.beat.toFixed(6)}`] : [])).sort()

describe('lookahead scheduler', () => {
  it('yields each note exactly once across loop boundaries, whatever the window sizes', () => {
    const { uniform } = random(42)
    // Notes on the first beat, the last sixteenth, and awkward fractions; loops of 4 and 3 beats.
    const a = notesLayer('a', clip([[60, 0], [62, 1.5], [64, 3.75], [65, 1 / 3], [67, 2.999]]), 4, 4)
    const b = notesLayer('b', clip([[40, 0], [43, 2.25], [45, 2.9]]), 8, 3)
    const scheduler = new Scheduler(0)
    scheduler.add(a)
    scheduler.add(b)
    const seen: Scheduled[] = []
    let to = 0
    while (to < 400) {
      // Mostly small steps like a 25 ms timer, sometimes a stall of several bars.
      to += uniform() < 0.02 ? 5 + uniform() * 9 : uniform() * 0.11
      const events = scheduler.advance(to)
      for (const e of events) expect(e.beat).toBeLessThan(to)
      seen.push(...events)
    }
    const want = [...expected(a, 0, to), ...expected(b, 0, to)].sort()
    expect(want.length).toBeGreaterThan(800)
    const got = keys(seen)
    expect(new Set(got).size).toBe(got.length) // nothing twice
    expect(got).toEqual(want) // nothing dropped, nothing invented
    expect(scheduler.cursor).toBe(to)
  })

  it('stays exact when the tempo changes between ticks', () => {
    // Drive it the way the window does: a clock, a grid that keeps being retuned at the cursor.
    const { uniform } = random(9)
    const layer = notesLayer('a', clip([[60, 0], [61, 0.5], [62, 1], [63, 3.5]]), 0, 4)
    const scheduler = new Scheduler(0)
    scheduler.add(layer)
    let grid = makeGrid(100, 0)
    const times: number[] = []
    const seen: Scheduled[] = []
    for (let now = 0; now < 120; now += 0.025) {
      if (uniform() < 0.05) grid = retune(grid, scheduler.cursor, 80 + uniform() * 60)
      for (const e of scheduler.advance(beatAt(grid, now + 0.12))) {
        seen.push(e)
        times.push(timeAt(grid, e.beat))
        if (now > 1) expect(timeAt(grid, e.beat)).toBeGreaterThanOrEqual(now + 0.12 - 0.025 * 2.2 - 1e-6) // always scheduled ahead of time
      }
    }
    expect(keys(seen)).toEqual(expected(layer, 0, scheduler.cursor))
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]! - 1e-9) // time never runs backwards
  })

  it('starts in the future, plays once, and reports the end', () => {
    const scheduler = new Scheduler(10)
    scheduler.add(notesLayer('once', clip([[60, 0], [62, 3.5, 2]]), 12, 4, false))
    expect(scheduler.advance(12)).toEqual([])
    const first = scheduler.advance(13)
    expect(keys(first)).toEqual(['once:60@12.000000'])
    const rest = scheduler.advance(40)
    expect(rest.map((e) => e.kind)).toEqual(['note', 'end'])
    expect(rest[0]).toMatchObject({ beat: 15.5, durationBeats: 0.5 }) // cut at the end of the clip
    expect(rest[1]).toMatchObject({ kind: 'end', layerId: 'once', beat: 16 })
    expect(scheduler.all).toEqual([])
    expect(scheduler.advance(80)).toEqual([])
  })

  it('stops a layer at a bar line and lets another carry on', () => {
    const scheduler = new Scheduler(0)
    scheduler.add(notesLayer('a', clip([[60, 0], [61, 2]]), 0, 4))
    scheduler.add(notesLayer('b', clip([[40, 0]]), 0, 4))
    scheduler.advance(5)
    expect(scheduler.stopAt('a', 8)).toBe(true)
    expect(scheduler.stopAt('nope', 8)).toBe(false)
    const events = scheduler.advance(13)
    expect(keys(events)).toEqual(['a:61@6.000000', 'b:40@12.000000', 'b:40@8.000000'])
    expect(events.filter((e) => e.kind === 'end')).toEqual([{ kind: 'end', layerId: 'a', beat: 8 }])
    expect(scheduler.all.map((l) => l.id)).toEqual(['b'])
  })

  it('swaps a part at a bar line with no gap and no overlap', () => {
    const scheduler = new Scheduler(0)
    const old = notesLayer('bass', clip([[40, 0], [40, 1], [40, 2], [40, 3]]), 0, 4)
    scheduler.add(old)
    scheduler.advance(5.2)
    // What the engine does to replace a layer of the same name at the next bar.
    scheduler.remove('bass')
    scheduler.add({ ...old, id: 'bass~1', stopBeat: 8 })
    scheduler.add(notesLayer('bass', clip([[45, 0], [45, 2]]), 8, 4))
    const beats = scheduler.advance(12).flatMap((e) => (e.kind === 'note' ? [`${e.pitch}@${e.beat}`] : []))
    expect(beats).toEqual(['40@6', '40@7', '45@8', '45@10'])
  })

  it('retriggers an audio layer once per pass', () => {
    const scheduler = new Scheduler(0)
    scheduler.add({ kind: 'audio', id: 'take', startBeat: 4, lengthBeats: 8, loop: true })
    const passes: number[] = []
    for (let to = 0.3; to < 50; to += 0.3) for (const e of scheduler.advance(to)) if (e.kind === 'audio') passes.push(e.beat)
    expect(passes).toEqual([4, 12, 20, 28, 36, 44])
  })

  it('clicks on every beat, accents the downbeat, and counts in', () => {
    const scheduler = new Scheduler(6.5, 3)
    scheduler.click = { on: false, untilBeat: 12 }
    const clicks: Scheduled[] = []
    for (let to = 6.6; to < 20; to += 0.37) clicks.push(...scheduler.advance(to))
    expect(clicks).toEqual([7, 8, 9, 10, 11].map((beat) => ({ kind: 'click', beat, accent: beat % 3 === 0 })))
    scheduler.click = { on: true, untilBeat: -Infinity }
    expect(scheduler.advance(scheduler.cursor + 2).filter((e) => e.kind === 'click')).toHaveLength(2)
  })

  it('layerEvents ignores notes written past the loop length', () => {
    const layer: Layer = notesLayer('a', clip([[60, 0], [61, 4.5]]), 0, 4)
    expect(keys(layerEvents(layer, 0, 8))).toEqual(['a:60@0.000000', 'a:60@4.000000'])
  })
})

/* ------------------------------------------------------------------ */

describe('cutting a loop from what was played', () => {
  // 120 bpm, bars at 10, 12, 14, 16 s.
  const grid = makeGrid(120, 10)

  it('takes the bars that end after the last note, not the silence since', () => {
    const notes = [note(60, 10), note(62, 12), note(64, 13.5)]
    // They stopped at 13.5; it is now 19 s (they have been talking).
    expect(lastBars(notes, grid, 19, 2)).toEqual({ startBeat: 0, endBeat: 8, startTime: 10, endTime: 14 })
    // Still playing: the current bar is not over, so take the bars already complete.
    expect(lastBars(notes, grid, 13.6, 1)).toEqual({ startBeat: 0, endBeat: 4, startTime: 10, endTime: 12 })
    expect(lastBars([], grid, 19, 2)).toBeNull()
  })

  it('treats a note just before a bar line as the next bar', () => {
    // 13.97 is 30 ms before the bar line at 14: an early downbeat of bar 3.
    expect(lastBars([note(60, 10), note(64, 13.97)], grid, 19, 1)).toMatchObject({ startBeat: 8, endBeat: 12 })
  })

  it('handles notes that straddle either edge', () => {
    const window = lastBars([note(60, 13.9)], grid, 14.05, 2)!
    expect(window).toMatchObject({ startBeat: 0, endBeat: 8 })
    const notes = [
      note(48, 9.0, 3.0), // held from a bar earlier well into the loop: kept from beat 0
      note(50, 9.5, 0.6), // from before, gone almost at once: left out
      note(60, 9.97, 0.5), // 30 ms early: this bar's downbeat, full length
      note(62, 11.0, 0.5),
      note(64, 13.5, 2.0), // rings past the end: cut at the bar line
      note(65, 13.96, 0.5), // 40 ms before the end: next bar's downbeat, left out
      note(67, 14.5, 0.5), // after the loop
    ]
    const loop = extractLoop(notes, grid, window)
    expect(loop.bpm).toBe(120)
    expect(loop.tracks[0]!.notes.map((n) => [n.pitch, +n.startBeat.toFixed(3), +n.durationBeats.toFixed(3)])).toEqual([
      [48, 0, 4],
      [60, 0, 1],
      [62, 2, 1],
      [64, 7, 1],
    ])
  })

  it('quantises starts, keeps lengths, and merges duplicates', () => {
    const window = { startBeat: 0, endBeat: 4, startTime: 10, endTime: 12 }
    const notes = [note(60, 10.03, 0.25), note(60, 10.01, 0.4), note(62, 10.56, 0.25), note(64, 11.93, 0.3)]
    const tidy = extractLoop(notes, grid, window, { quantize: 0.25, role: 'bass', program: 32, name: 'riff' })
    expect(tidy).toMatchObject({ name: 'riff', tracks: [{ role: 'bass', program: 32 }] })
    expect(tidy.tracks[0]!.notes.map((n) => [n.pitch, n.startBeat, +n.durationBeats.toFixed(2)])).toEqual([
      [60, 0, 0.8],
      [62, 1, 0.5],
      [64, 3.75, 0.25],
    ])
    const raw = extractLoop(notes, grid, window)
    expect(raw.tracks[0]!.notes[0]!.startBeat).toBeCloseTo(0.02, 5)
  })

  it('makes a clip the scheduler loops seamlessly at the bar length', () => {
    const player = Array.from({ length: 16 }, (_, i) => note(60 + (i % 4), 10 + i * 0.5, 0.4))
    const window = lastBars(player, grid, 18.4, 2)!
    const loop = extractLoop(player, grid, window, { quantize: 0.25 })
    const scheduler = new Scheduler(0)
    scheduler.add(notesLayer('loop', loop, 0, 8))
    const beats = scheduler.advance(24).flatMap((e) => (e.kind === 'note' ? [e.beat] : []))
    expect(beats).toEqual(Array.from({ length: 24 }, (_, i) => i))
  })
})

/* ------------------------------------------------------------------ */

describe('audio loops', () => {
  it('recovers a steady sample clock from late, jittery block arrivals', () => {
    const { uniform } = random(3)
    const clock = new SampleClock(48000)
    // Samples really start at session time 5.0; each 128-sample block arrives 2-30 ms late.
    for (let block = 1; block <= 4000; block++) clock.observe(block * 128, 5 + (block * 128) / 48000 + 0.002 + uniform() * 0.028)
    expect(clock.timeOf(0)).toBeGreaterThan(5.002 - 1e-9)
    expect(clock.timeOf(0)).toBeLessThan(5.004)
    expect(clock.indexAt(clock.timeOf(96000))).toBe(96000)
  })

  it('returns exactly the samples for a stretch of session time, across the wrap', () => {
    const rate = 1000
    const audio = new RollingAudio(4, rate)
    // A ramp: sample n has value n, pushed in blocks of 50, starting at session time 100.
    for (let pushed = 0; pushed < 10000; pushed += 50) {
      audio.push(Float32Array.from({ length: 50 }, (_, i) => pushed + i), 100 + (pushed + 50) / rate)
    }
    expect(audio.end).toBeCloseTo(110, 6)
    expect(audio.start).toBeCloseTo(106, 6)
    const slice = audio.slice(107.5, 108.25)!
    expect(slice.length).toBe(750)
    expect(slice[0]).toBe(7500)
    expect(slice[749]).toBe(8249)
    expect(audio.slice(105, 107)).toBeNull() // too old
    expect(audio.slice(109, 111)).toBeNull() // not recorded yet
  })

  it('cuts a take with a lead-in and a tail, and plans a crossfaded pass', () => {
    const rate = 1000
    const audio = new RollingAudio(20, rate)
    for (let pushed = 0; pushed < 12000; pushed += 100) audio.push(Float32Array.from({ length: 100 }, (_, i) => pushed + i), (pushed + 100) / rate)
    const take = cutTake(audio, 4, 8, 0.02)!
    expect(take.lead).toBeCloseTo(0.02, 6)
    expect(take.length).toBe(4)
    expect(take.samples[Math.round(take.lead * rate)]).toBe(4000) // the first beat's sample
    expect(take.samples.length).toBe(20 + 4000 + 1000) // lead-in + loop + a quarter as tail
    expect(rms(take.samples)).toBeGreaterThan(0)
    expect(cutTake(audio, 10, 14, 0.02)).toBeNull() // runs past what is recorded

    // A pass whose downbeat is at audio time 50: it starts the lead-in early and reaches full gain on the beat.
    const plan = planPass(take, 50, 49.9)
    expect(plan.sourceStart).toBeCloseTo(49.98, 9)
    expect(plan.offset).toBeCloseTo(0, 9)
    expect(plan.fadeInTo).toBe(50)
    expect(plan.sourceStart + (take.lead - plan.offset)).toBeCloseTo(50, 9) // the first beat's sample plays at 50
    expect(fadeOutFor(plan)).toEqual({ from: plan.fadeInFrom, to: 50 }) // the old pass fades as the new one rises

    // Not enough time for the whole lead-in: shorten it, keep the beat where it is.
    const tight = planPass(take, 50, 49.99)
    expect(tight.sourceStart).toBeCloseTo(49.99, 9)
    expect(tight.sourceStart + (take.lead - tight.offset)).toBeCloseTo(50, 9)
    // Late: start now, further into the take, still aligned.
    const late = planPass(take, 50, 50.1)
    expect(late.sourceStart).toBe(50.1)
    expect(late.sourceStart - (late.offset - take.lead)).toBeCloseTo(50, 9)
  })
})

/* ------------------------------------------------------------------ */

describe('transport tools', () => {
  const idle: TransportState = {
    running: false, bpm: 100, follow: true, click: false, beatsPerBar: 4, grid: makeGrid(100, 0), now: 0, beat: 0, bar: 0, beatInBar: 0,
    layers: [], playerBpm: null, phaseErrorMs: null, nudgeMs: 0, outputLatencyMs: 10, late: 0, worstTickMs: 25,
  }

  /** A tool context whose window is a stub that records requests and answers with `reply`. */
  function setup(now: number, reply: (request: TransportRequest) => TransportState | null = () => idle) {
    const requests: TransportRequest[] = []
    const events: MainEvent[] = []
    const bus: FeatureBus = new FeatureBus((event) => {
      events.push(event)
      if (event.type !== 'feature-request') return
      requests.push(event.message as TransportRequest)
      queueMicrotask(() => bus.settle(event.id, reply(event.message as TransportRequest)))
    })
    const ctx: ToolContext = { transcript: new Transcript(), memory: new TasteMemory('/tmp/jam-transport-test'), now: () => now, emit: (e) => events.push(e), bus, saveMidi: async () => '/tmp/x.mid' }
    const module = transport(ctx)!
    const call = async (name: string, args: Record<string, unknown>) => {
      const found = module.tools.find((t) => t.name === name)!
      const result = await found.handler(args as never, {})
      return (result.content[0] as { text: string }).text
    }
    return { ctx, module, call, requests, events }
  }

  /** Two bars of a four-note riff at 120 bpm, bars starting at 10 s, repeated. */
  const riff = (bars: number) =>
    Array.from({ length: bars * 4 }, (_, i) => ({ ...note([48, 55, 60, 55][i % 4]!, 10 + i * 0.5, 0.4, i % 4 === 0 ? 0.95 : 0.7), source: 'midi' as const }))

  it('exposes five uniquely named tools and a guide line for each', () => {
    const { module } = setup(0)
    const names = module.tools.map((t) => t.name)
    expect(names).toEqual(['jam_along', 'loop_that', 'transport_stop', 'transport_state', 'transport_set'])
    for (const name of names) expect(module.guide).toContain(`- ${name}:`)
  })

  it('jam_along sends the clip with the tracked beat of the player', async () => {
    const { ctx, call, requests } = setup(18.2, (request) => ({ ...idle, running: true, bpm: 120, startsAtBeat: 20, startsInSeconds: 1.8, layers: request.type === 'play' ? [{ id: request.id, kind: 'notes', loop: true, lengthBeats: 8, startBeat: 20, startsIn: 3.6 }] : [] }))
    ctx.transcript.add(riff(4))
    const result = await call('jam_along', { name: 'bass', chords: ['Dm7', 'G7'], beats_per_chord: 4, loop: true, start: 'bar', count_in_bars: 0 })
    const request = requests[0]!
    if (request.type !== 'play') throw new Error('expected a play request')
    expect(request).toMatchObject({ id: 'bass', loop: true, start: 'bar' })
    expect(request.clip.tracks[0]!.notes.length).toBeGreaterThan(4)
    expect(request.player!.grid.bpm).toBeCloseTo(120, 0)
    expect(request.player!.confidence).toBeGreaterThan(0.6)
    // The tracked grid has a beat where the player's next one would fall (18.0 s was the last note's slot + 1).
    const beat = beatAt(request.player!.grid, 18.5)
    expect(Math.abs(beat - Math.round(beat))).toBeLessThan(0.04)
    expect(result).toContain('"bass" comes in in 1.8s on the bar line: 2 bars, looping, at 120.0 bpm')
    expect(result).toContain('Layers: "bass"')
  })

  it('jam_along rejects unknown chords and empty parts without calling the window', async () => {
    const { call, requests } = setup(5)
    expect(await call('jam_along', { name: 'x', chords: ['Hq9'], beats_per_chord: 4, loop: true, start: 'bar', count_in_bars: 0 })).toContain("couldn't voice")
    expect(await call('jam_along', { name: 'x', loop: true, start: 'bar', count_in_bars: 0, beats_per_chord: 4 })).toContain('Nothing to play')
    expect(requests).toEqual([])
  })

  it('loop_that cuts the bars just played, on the player’s own grid, and asks for them looped', async () => {
    const { ctx, call, requests } = setup(21, (request) => (request.type === 'play' ? { ...idle, running: true, bpm: 120, startsAtBeat: 0, startsInSeconds: 1 } : idle))
    ctx.transcript.add(riff(4)) // played from 10 s to 18 s; now it is 21 s
    const result = await call('loop_that', { bars: 2, as: 'notes', name: 'riff', quantize: '16th', role: 'bass', program: 32 })
    expect(requests.map((r) => r.type)).toEqual(['state', 'play'])
    const play = requests[1]!
    if (play.type !== 'play') throw new Error('expected a play request')
    expect(play).toMatchObject({ id: 'riff', loop: true, start: 'bar', lengthBeats: 8 })
    expect(play.clip.tracks[0]).toMatchObject({ role: 'bass', program: 32 })
    // The last two bars of the riff, bar-aligned: C2 on each downbeat.
    expect(play.clip.tracks[0]!.notes.map((n) => [n.pitch, n.startBeat])).toEqual([[48, 0], [55, 1], [60, 2], [55, 3], [48, 4], [55, 5], [60, 6], [55, 7]])
    expect(result).toContain('Looping 8 notes (C3 to C4) from the 2 bars that ended 3.0s ago as "riff"')
  })

  it('loop_that as audio sends the session times of those bars', async () => {
    const { ctx, call, requests } = setup(21, (request) => (request.type === 'loop-audio' ? { ...idle, running: true, bpm: 120, startsAtBeat: 0, startsInSeconds: 0.9, level: 0.1 } : idle))
    ctx.transcript.add(riff(4))
    const result = await call('loop_that', { bars: 2, as: 'audio', name: 'take', quantize: 'off', role: 'melody', program: 0 })
    const request = requests[1]!
    if (request.type !== 'loop-audio') throw new Error('expected a loop-audio request')
    expect(request.startTime).toBeCloseTo(14, 1)
    expect(request.endTime).toBeCloseTo(18, 1)
    expect(request.lengthBeats).toBe(8)
    expect(result).toContain('Looping their recorded sound')
  })

  it('loop_that uses the transport’s grid when it is already running', async () => {
    // The transport runs at 90 bpm with a bar line at 9 s; the player's notes are placed on that grid.
    const running = { ...idle, running: true, bpm: 90, grid: makeGrid(90, 9) }
    const { ctx, call, requests } = setup(21, (request) => (request.type === 'play' ? { ...running, startsAtBeat: 20, startsInSeconds: 1.3 } : running))
    ctx.transcript.add([note(60, 9 + 8 / 1.5), note(64, 9 + 10 / 1.5), note(67, 9 + 11 / 1.5)])
    await call('loop_that', { bars: 1, as: 'notes', name: 'loop', quantize: '16th', role: 'melody', program: 0 })
    const play = requests[1]!
    if (play.type !== 'play') throw new Error('expected a play request')
    expect(play.clip.tracks[0]!.notes.map((n) => [n.pitch, n.startBeat])).toEqual([[60, 0], [64, 2], [67, 3]])
  })

  it('loop_that says so when there is no beat to cut on', async () => {
    const { ctx, call, requests } = setup(21)
    ctx.transcript.add([note(60, 19), note(62, 20.3)])
    const result = await call('loop_that', { bars: 2, as: 'notes', name: 'loop', quantize: '16th', role: 'melody', program: 0 })
    expect(result).toContain('no steady beat')
    expect(requests.map((r) => r.type)).toEqual(['state'])
  })

  it('transport_set with a tempo turns following off; stop and state report plainly', async () => {
    const { call, requests } = setup(5, (request) => ({ ...idle, note: request.type === 'stop' ? 'Stopped everything.' : undefined }))
    await call('transport_set', { bpm: 96 })
    expect(requests[0]).toMatchObject({ type: 'set', bpm: 96, follow: false })
    await call('transport_set', { bpm: 96, follow: true, nudge_ms: 20 })
    expect(requests[1]).toMatchObject({ type: 'set', bpm: 96, follow: true, nudgeMs: 20 })
    expect(await call('transport_stop', { at: 'now' })).toContain('Stopped everything.')
    expect(await call('transport_state', {})).toContain('Transport: stopped')
    expect(await call('transport_state', {})).toContain("Player's beat: not found yet")
  })

  it('reports a window that does not answer instead of throwing', async () => {
    const { call } = setup(5, () => null)
    expect(await call('transport_state', {})).toContain('did not respond')
  })

  it('keeps the window posted on the player’s beat while layers are playing', async () => {
    const { ctx, call, events } = setup(18.2, () => ({ ...idle, running: true }))
    await call('transport_state', {})
    ctx.transcript.add(riff(4))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const pushes = events.filter((e) => e.type === 'feature' && e.feature === 'transport')
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ message: { type: 'beat', player: { grid: { beatsPerBar: 4 } } } })
  })
})
