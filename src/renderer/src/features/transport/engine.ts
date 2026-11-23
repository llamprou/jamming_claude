import { INPUT_LATENCY_SECONDS, type LayerState, type LogEntry, type PlayerBeat, type TransportRequest, type TransportState } from '@shared/features/transport'
import { cutTake, fadeOutFor, planPass, rms, RollingAudio, type AudioTake } from '@shared/music/transport/audioloop'
import { barPosition, beatAt, followStep, makeGrid, quantizeStart, rebar, retune, timeAt, wholeBars, type BeatGrid, type StartQuantize } from '@shared/music/transport/grid'
import { Scheduler, type Scheduled } from '@shared/music/transport/scheduler'
import { clipLengthBeats } from '@shared/music/clip'
import type { ClipTrack } from '@shared/music/types'
import { audioContext, musicOutput, onMicBlock, sessionNow, toAudioTime } from '../../audio/context'
import { playedNotes } from '../../audio/sounding'
import { voiceFor } from '../../audio/voices'

/**
 * The WebAudio shell around the pure transport core (src/shared/music/transport).
 *
 * A timer fires every TICK ms; each tick asks the scheduler for everything
 * that starts within the next LOOKAHEAD seconds and hands it to WebAudio with
 * exact start times. The timer only has to be roughly on time: accuracy comes
 * from WebAudio's clock, and the lookahead is the slack. If ticks arrive late
 * (a busy page) the lookahead stretches to cover it.
 */

const TICK_MS = 25
const LOOKAHEAD = 0.12
const MAX_LOOKAHEAD = 1.5
/** Crossfade at an audio loop's seam. */
const SEAM = 0.02
/** How much mic audio is kept for audio loops. */
const KEEP_SECONDS = 90
/** Stop following a reading of the player this old. */
const STALE_PLAYER = 3

interface Sounding {
  output: GainNode
  nodes: Set<AudioScheduledSourceNode>
  tracks: ClipTrack[]
  take?: { buffer: AudioBuffer; plan: AudioTake }
  pass?: { source: AudioBufferSourceNode; gain: GainNode }
}

export class TransportEngine {
  private scheduler = new Scheduler()
  private grid: BeatGrid = makeGrid(100, 0)
  private baseBpm = 100
  private running = false
  private follow = true
  private nudge = 0
  private player: (PlayerBeat & { receivedAt: number; fresh: boolean }) | null = null
  private lastFollow: { playerBpm: number | null; phaseError: number } = { playerBpm: null, phaseError: 0 }
  private sounding = new Map<string, Sounding>()
  private mic: RollingAudio | null = null
  private worker: Worker | null = null
  private lastTick = 0
  private worstTick = 0
  private late = 0
  private log: LogEntry[] = []
  private retired = 0

  /** Start keeping mic audio. Called once when the window opens. */
  listen(): void {
    onMicBlock((block, sampleRate, time) => {
      if (!this.mic || this.mic.sampleRate !== sampleRate) this.mic = new RollingAudio(KEEP_SECONDS, sampleRate)
      this.mic.push(block, time)
    })
  }

  handle(request: TransportRequest): TransportState | LogEntry[] {
    switch (request.type) {
      case 'play': {
        this.heard(request.player)
        this.ensureRunning(request.bpm)
        const lengthBeats = request.lengthBeats ?? wholeBars(clipLengthBeats(request.clip), this.grid.beatsPerBar)
        const startBeat = this.claim(request.id, request.start, request.countInBars ?? 0)
        this.scheduler.add({ kind: 'notes', id: request.id, clip: request.clip, startBeat, lengthBeats, loop: request.loop })
        this.sounding.set(request.id, this.newSounding(request.clip.tracks))
        return this.state({ startsAtBeat: startBeat, note: `Layer "${request.id}" comes in ${this.describeStart(startBeat)}.` })
      }
      case 'loop-audio': {
        const shift = INPUT_LATENCY_SECONDS
        const plan = this.mic ? cutTake(this.mic, request.startTime + shift, request.endTime + shift, SEAM) : null
        if (!plan) return this.state({ note: 'No audio loop: the mic buffer does not hold that stretch (the mic may be off, or the stretch is older than the buffer).' })
        const audio = audioContext()
        const buffer = audio.createBuffer(1, plan.samples.length, plan.sampleRate)
        buffer.getChannelData(0).set(plan.samples)
        this.heard(request.player)
        this.ensureRunning(request.bpm)
        const startBeat = this.claim(request.id, request.start, 0)
        this.scheduler.add({ kind: 'audio', id: request.id, startBeat, lengthBeats: request.lengthBeats, loop: true })
        this.sounding.set(request.id, { ...this.newSounding([]), take: { buffer, plan } })
        return this.state({ startsAtBeat: startBeat, level: rms(plan.samples), note: `Audio layer "${request.id}" comes in ${this.describeStart(startBeat)}.` })
      }
      case 'stop': {
        const ids = request.id ? [request.id] : this.scheduler.all.map((l) => l.id)
        if (request.id && !this.scheduler.get(request.id)) return this.state({ note: `There is no layer called "${request.id}".` })
        if (!request.id) this.scheduler.click = { on: false, untilBeat: -Infinity }
        if (request.at === 'bar' && this.running) {
          const bar = quantizeStart(this.grid, this.scheduler.cursor, 'bar')
          for (const id of ids) this.scheduler.stopAt(id, bar)
          return this.state({ note: `${ids.length} layer(s) stop at the next bar line.` })
        }
        for (const id of ids) {
          this.scheduler.remove(id)
          this.silence(id, 0.03)
        }
        this.stopIfIdle()
        return this.state({ note: request.id ? `Stopped "${request.id}".` : 'Stopped everything.' })
      }
      case 'set': {
        this.heard(request.player)
        if (request.follow !== undefined) this.follow = request.follow
        if (request.nudgeMs !== undefined) this.nudge = Math.max(-0.2, Math.min(0.2, request.nudgeMs / 1000))
        if (request.beatsPerBar !== undefined && request.beatsPerBar !== this.grid.beatsPerBar) {
          this.grid = rebar({ ...this.grid, beatsPerBar: request.beatsPerBar }, Math.ceil(this.scheduler.cursor))
          this.scheduler.beatsPerBar = request.beatsPerBar
        }
        if (request.bpm !== undefined) {
          this.baseBpm = request.bpm
          if (this.running) this.grid = retune(this.grid, this.scheduler.cursor, request.bpm)
          else this.grid = { ...this.grid, bpm: request.bpm }
        }
        if (request.click !== undefined) {
          if (request.click) this.ensureRunning(request.bpm)
          this.scheduler.click = { on: request.click, untilBeat: -Infinity }
          this.stopIfIdle()
        }
        return this.state()
      }
      case 'state':
        return this.state()
      case 'log':
        return this.log.slice()
    }
  }

  /** A fresh reading of the player's beat from the tracker. */
  heard(player: PlayerBeat | null | undefined): void {
    if (player === undefined) return
    this.player = player ? { ...player, receivedAt: sessionNow(), fresh: true } : null
  }

  state(extra: Partial<TransportState> = {}): TransportState {
    const now = sessionNow()
    const beat = beatAt(this.grid, now)
    const position = barPosition(this.grid, beat)
    const layers: LayerState[] = this.scheduler.all.map((layer) => ({
      id: layer.id,
      kind: layer.kind,
      loop: layer.loop,
      lengthBeats: layer.lengthBeats,
      startBeat: layer.startBeat,
      stopBeat: layer.stopBeat,
      startsIn: Math.max(0, layer.startBeat - beat),
    }))
    return {
      running: this.running,
      bpm: this.baseBpm,
      follow: this.follow,
      click: this.scheduler.click.on,
      beatsPerBar: this.grid.beatsPerBar,
      grid: this.grid,
      now,
      beat,
      bar: position.bar,
      beatInBar: position.beatInBar,
      layers,
      playerBpm: this.lastFollow.playerBpm,
      phaseErrorMs: this.lastFollow.playerBpm === null ? null : (this.lastFollow.phaseError * 60000) / this.baseBpm,
      nudgeMs: this.nudge * 1000,
      outputLatencyMs: this.outputLatency() * 1000,
      late: this.late,
      worstTickMs: this.worstTick,
      ...extra,
      ...(extra.startsAtBeat !== undefined ? { startsInSeconds: timeAt(this.grid, extra.startsAtBeat) - now } : {}),
    }
  }

  /* ---------- clock ---------- */

  private ensureRunning(bpm?: number): void {
    if (this.running) return
    const now = sessionNow()
    const player = this.player
    if (player && player.confidence >= 0.5 && now - player.receivedAt < STALE_PLAYER) {
      // Join the player: their tempo, their beat, their best-guess bar line.
      this.grid = { ...player.grid, beatsPerBar: this.grid.beatsPerBar }
      this.baseBpm = player.grid.bpm
    } else {
      // Nothing to join: start our own count, with a downbeat a moment from now.
      this.baseBpm = bpm ?? this.baseBpm
      this.grid = makeGrid(this.baseBpm, now + 0.12 + Math.max(0, this.outputLatency() + this.nudge), this.grid.beatsPerBar)
    }
    this.scheduler.beatsPerBar = this.grid.beatsPerBar
    this.scheduler.seek(beatAt(this.grid, now + 0.03 + Math.max(0, this.outputLatency() + this.nudge)))
    this.running = true
    this.lastTick = performance.now()
    this.worstTick = 0
    this.lastFollow = { playerBpm: null, phaseError: 0 }
    void audioContext().resume()
    if (!this.worker) {
      this.worker = new Worker(new URL('./tick.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = () => this.tick()
    }
    this.worker.postMessage(TICK_MS)
  }

  private stopIfIdle(): void {
    if (!this.running || this.scheduler.all.length > 0 || this.scheduler.click.on || this.scheduler.click.untilBeat > this.scheduler.cursor) return
    this.running = false
    this.worker?.postMessage(null)
  }

  /** Where a new layer should start; an existing layer of the same name plays up to that point. */
  private claim(id: string, start: StartQuantize, countInBars: number): number {
    let startBeat = quantizeStart(this.grid, this.scheduler.cursor, start)
    if (countInBars > 0) {
      startBeat += countInBars * this.grid.beatsPerBar
      this.scheduler.click = { on: this.scheduler.click.on, untilBeat: startBeat }
    }
    const old = this.scheduler.get(id)
    const oldSound = this.sounding.get(id)
    if (old) {
      const retiredId = `${id}~${++this.retired}`
      this.scheduler.remove(id)
      this.scheduler.add({ ...old, id: retiredId, stopBeat: Math.min(startBeat, old.stopBeat ?? Infinity) })
      if (oldSound) this.sounding.set(retiredId, oldSound)
      this.sounding.delete(id)
    }
    return startBeat
  }

  private describeStart(startBeat: number): string {
    const seconds = timeAt(this.grid, startBeat) - sessionNow()
    return seconds < 0.25 ? 'now' : `in ${seconds.toFixed(1)}s, on a bar line`
  }

  tick(): void {
    if (!this.running) return
    const wall = performance.now()
    const gap = wall - this.lastTick
    this.lastTick = wall
    this.worstTick = Math.max(this.worstTick, gap)

    const now = sessionNow()
    this.followPlayer(now)
    // Enough lookahead to survive another gap like the last one.
    const lookahead = Math.min(MAX_LOOKAHEAD, Math.max(LOOKAHEAD, (gap / 1000) * 2.5))
    // Sound is handed over early by the output latency, so look that much further ahead too.
    const shift = this.outputLatency() + this.nudge
    const events = this.scheduler.advance(beatAt(this.grid, now + lookahead + Math.max(0, shift)))
    const audio = audioContext()
    for (const event of events) this.schedule(event, audio, now, shift)
    this.stopIfIdle()
  }

  private followPlayer(now: number): void {
    const player = this.player
    if (!this.follow || !player) {
      if (this.grid.bpm !== this.baseBpm) this.grid = retune(this.grid, this.scheduler.cursor, this.baseBpm)
      return
    }
    if (now - player.receivedAt > STALE_PLAYER) {
      // No news: stop correcting and hold our own tempo.
      if (this.grid.bpm !== this.baseBpm) this.grid = retune(this.grid, this.scheduler.cursor, this.baseBpm)
      return
    }
    if (!player.fresh) return
    player.fresh = false
    const step = followStep(this.grid, this.baseBpm, player.grid, player.confidence, this.scheduler.cursor)
    this.grid = step.grid
    this.baseBpm = step.baseBpm
    this.lastFollow = { playerBpm: step.targetBpm, phaseError: step.phaseError }
  }

  /* ---------- sound ---------- */

  private outputLatency(): number {
    const audio = audioContext()
    const latency = audio.outputLatency
    return Number.isFinite(latency) && latency > 0 ? Math.min(latency, 0.3) : (audio.baseLatency ?? 0)
  }

  private newSounding(tracks: ClipTrack[]): Sounding {
    const output = audioContext().createGain()
    output.connect(musicOutput())
    return { output, nodes: new Set(), tracks }
  }

  private schedule(event: Scheduled, audio: AudioContext, now: number, shift: number): void {
    const time = timeAt(this.grid, event.beat)
    const due = toAudioTime(time) - shift
    const when = Math.max(due, audio.currentTime)
    if (due < audio.currentTime - 0.005) this.late++
    const leadMs = (due - audio.currentTime) * 1000

    if (event.kind === 'click') {
      this.click(audio, when, event.accent)
      this.remember({ kind: 'click', layer: '', beat: event.beat, time, leadMs })
      return
    }
    const sound = this.sounding.get(event.layerId)
    if (!sound) return
    if (event.kind === 'end') {
      // Notes already started ring out; a recorded pass is faded at the stop point.
      if (sound.pass) {
        sound.pass.gain.gain.setValueAtTime(1, when)
        sound.pass.gain.gain.linearRampToValueAtTime(0, when + SEAM)
        sound.pass.source.stop(when + SEAM + 0.01)
      }
      this.sounding.delete(event.layerId)
      const release = (when - audio.currentTime + 3) * 1000
      setTimeout(() => sound.output.disconnect(), release)
      return
    }
    if (event.kind === 'audio') {
      if (!sound.take) return
      const plan = planPass(sound.take.plan, when, audio.currentTime + 0.003)
      const source = audio.createBufferSource()
      source.buffer = sound.take.buffer
      const gain = audio.createGain()
      gain.gain.setValueAtTime(0, plan.fadeInFrom)
      gain.gain.linearRampToValueAtTime(1, plan.fadeInTo)
      source.connect(gain).connect(sound.output)
      source.start(plan.sourceStart, plan.offset)
      if (sound.pass) {
        const out = fadeOutFor(plan)
        sound.pass.gain.gain.setValueAtTime(1, out.from)
        sound.pass.gain.gain.linearRampToValueAtTime(0, out.to)
        sound.pass.source.stop(out.to + 0.01)
      }
      this.track(sound, source)
      sound.pass = { source, gain }
      this.remember({ kind: 'audio', layer: event.layerId, beat: event.beat, time, leadMs })
      return
    }
    const track = sound.tracks[event.track]
    if (!track) return
    const duration = (event.durationBeats * 60) / this.grid.bpm
    for (const node of voiceFor(track).play({ pitch: event.pitch, velocity: event.velocity }, when, duration, sound.output, track)) this.track(sound, node)
    playedNotes.add({ pitch: event.pitch, start: time, end: time + duration, layer: event.layerId, role: track.role })
    this.remember({ kind: 'note', layer: event.layerId, pitch: event.pitch, beat: event.beat, time, leadMs })
  }

  private track(sound: Sounding, node: AudioScheduledSourceNode): void {
    sound.nodes.add(node)
    node.addEventListener('ended', () => sound.nodes.delete(node), { once: true })
  }

  private click(audio: AudioContext, when: number, accent: boolean): void {
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.frequency.value = accent ? 1568 : 1047
    gain.gain.setValueAtTime(0, when)
    gain.gain.linearRampToValueAtTime(accent ? 0.22 : 0.14, when + 0.001)
    gain.gain.exponentialRampToValueAtTime(0.0005, when + 0.05)
    osc.connect(gain).connect(musicOutput())
    osc.start(when)
    osc.stop(when + 0.06)
  }

  /** Fade a layer out and stop everything it has scheduled. */
  private silence(id: string, fade: number): void {
    const sound = this.sounding.get(id)
    playedNotes.cut(sessionNow(), id)
    if (!sound) return
    this.sounding.delete(id)
    const audio = audioContext()
    sound.output.gain.setValueAtTime(sound.output.gain.value, audio.currentTime)
    sound.output.gain.linearRampToValueAtTime(0, audio.currentTime + fade)
    setTimeout(
      () => {
        for (const node of sound.nodes) {
          try {
            node.stop()
          } catch {
            // already stopped
          }
        }
        sound.output.disconnect()
      },
      fade * 1000 + 20,
    )
  }

  stopAll(): void {
    this.handle({ type: 'stop', at: 'now' })
    // Layers that were being replaced are sounding under other names.
    for (const id of [...this.sounding.keys()]) this.silence(id, 0.03)
  }

  private remember(entry: LogEntry): void {
    this.log.push(entry)
    if (this.log.length > 600) this.log.splice(0, this.log.length - 600)
  }
}

export const engine = new TransportEngine()
