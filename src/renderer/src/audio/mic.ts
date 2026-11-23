import type { NoteEvent } from '@shared/music/types'
import { detectPitch, hzToMidi } from '@shared/music/pitch'
import { AudioRing, Resampler, SlowPass, rms, type Correction, type SlowPassStatus } from '@shared/music/slowpass'
import { LevelSummary } from '@shared/log'
import { log, send } from '../log'
import tapWorkletUrl from '../tap.worklet.js?url&no-inline'
import type { TranscribeRequest, TranscribeResponse } from '../transcriber.worker'
import { audioContext, publishMicBlock } from './context'

export interface MicHandle {
  stop(): void
}

/**
 * Open the mic once and split it two ways:
 *  - speech path: echo-cancelled, downsampled to 16 kHz PCM16 for speech-to-text
 *  - music path, fast: a monophonic pitch tracker puts single notes on screen
 *    within tens of milliseconds.
 *  - music path, slow: every few seconds a polyphonic model in a worker
 *    re-hears the same audio (chords included) and its notes replace the fast
 *    pass's guesses for that stretch.
 */
export async function startMic(opts: {
  onSpeechPcm(pcm16: ArrayBuffer): void
  onNotes(notes: NoteEvent[]): void
  onCorrection(correction: Correction): void
  /** Reports which engine the slow pass is running on, and how long a run takes. */
  onEngine?(description: string): void
  /** About once a second: whether the slow pass is keeping up, for `listen` to report. */
  onSlowPassStatus?(status: SlowPassStatus): void
  /** Mic loudness, 0-1, a few times a second: drives the on-screen presence. */
  onLevel?(level: number): void
  now(): number
}): Promise<MicHandle> {
  const audio = audioContext()
  await audio.resume()
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    })
  } catch (error) {
    log.error('mic', 'could not open the mic', error)
    throw error
  }
  const track = stream.getAudioTracks()[0]
  const settings = track?.getSettings() ?? {}
  // The device's name is left out: it can carry the player's name ("Sam's AirPods").
  log.info('mic', 'mic started', {
    contextRate: audio.sampleRate,
    contextState: audio.state,
    deviceRate: settings.sampleRate,
    channels: settings.channelCount,
    echoCancellation: settings.echoCancellation,
    defaultDevice: settings.deviceId === 'default' || settings.deviceId === undefined,
    baseLatencyMs: Math.round((audio.baseLatency ?? 0) * 1000),
  })
  track?.addEventListener('ended', () => log.warn('mic', 'mic track ended (device unplugged or permission revoked)'))
  track?.addEventListener('mute', () => log.warn('mic', 'mic track muted by the system'))
  track?.addEventListener('unmute', () => log.info('mic', 'mic track unmuted'))
  audio.onstatechange = () => log.info('mic', `audio context ${audio.state}`)
  await audio.audioWorklet.addModule(tapWorkletUrl)
  const source = audio.createMediaStreamSource(stream)
  const tap = new AudioWorkletNode(audio, 'tap')
  source.connect(tap)

  // Slow pass: keep the last 30 s at the model's sample rate and let the
  // scheduler decide when a stretch is ready to be re-heard.
  const pending = new Map<number, { resolve(notes: NonNullable<TranscribeResponse['notes']>): void; reject(error: Error): void }>()
  let requestId = 0
  let onCpu = false
  let gpuFailures = 0
  const startWorker = (cpu: boolean): Worker => {
    log.info('slowpass', `starting transcriber worker (${cpu ? 'CPU only' : 'GPU if it works'})`)
    const created = new Worker(new URL('../transcriber.worker.ts', import.meta.url), { type: 'module', name: cpu ? 'cpu' : 'auto' })
    created.onmessage = (message: MessageEvent<TranscribeResponse>) => {
      const { id, notes, error, stack, backend, ms } = message.data
      if (message.data.log) return send(message.data.log)
      if (id === undefined) return
      const request = pending.get(id)
      pending.delete(id)
      if (!request) log.warn('slowpass', 'answer for a request nobody is waiting for (it timed out or the worker was replaced)', { id, ms, ok: !!notes })
      if (backend && backend !== slowPass.engine) {
        log.info('slowpass', `engine is now ${backend}`, { was: slowPass.engine })
        slowPass.engine = backend
      }
      if (notes) {
        gpuFailures = 0
        opts.onEngine?.(`polyphonic pass on ${backend}, ${ms} ms`)
        request?.resolve(notes)
      } else {
        log.error('worker', `transcription failed on ${backend}: ${error}`, undefined, { stack, ms })
        opts.onEngine?.(`polyphonic pass failed: ${error}`)
        request?.reject(new Error(error))
        // A GPU that keeps failing: start over on the CPU.
        if (!onCpu && ++gpuFailures >= 2) restartOnCpu(`${gpuFailures} failed runs on ${backend}: ${error}`)
      }
    }
    created.onerror = (event) => {
      event.preventDefault()
      const reason = `transcriber worker crashed: ${event.message || 'could not start'}`
      log.error('worker', reason, undefined, { source: event.filename?.split('/').pop(), line: event.lineno, pending: pending.size })
      for (const request of pending.values()) request.reject(new Error(reason))
      pending.clear()
      opts.onEngine?.(`polyphonic pass failed: ${reason}`)
      if (!onCpu) restartOnCpu(reason)
    }
    created.onmessageerror = () => log.error('worker', 'a message from the transcriber worker could not be read')
    return created
  }
  let worker = startWorker(false)
  const restartOnCpu = (reason: string) => {
    log.warn('slowpass', `falling back to the CPU: ${reason}`, { pending: pending.size })
    onCpu = true
    worker.terminate()
    for (const request of pending.values()) request.reject(new Error('restarting the model on the CPU'))
    pending.clear()
    worker = startWorker(true)
    slowPass.engine = 'cpu'
  }
  let levelTick = 0
  const modelRate = new Resampler(audio.sampleRate)
  const ring = new AudioRing(30)
  // Counters for the periodic summary; reset each period.
  const period = { silentRuns: 0, doneRuns: 0, failedRuns: 0, runMs: 0, busyTicks: 0, frames: 0, pitchedFrames: 0, notes: 0, speechChunks: 0 }
  const resetPeriod = () => Object.keys(period).forEach((k) => (period[k as keyof typeof period] = 0))
  const levels = new LevelSummary()
  const slowPass = new SlowPass(
    ring,
    (samples) =>
      new Promise((resolve, reject) => {
        const id = ++requestId
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, audio: samples } satisfies TranscribeRequest, [samples.buffer])
      }),
    opts.onCorrection,
    {
      // A hung GPU (seen on some Macs) never answers: drop it for the CPU. A hung CPU worker is restarted as is.
      onTimeout: () => {
        if (!onCpu) return restartOnCpu('a run on the GPU did not answer in time')
        log.warn('slowpass', 'restarting the CPU worker: a run did not answer in time', { pending: pending.size })
        worker.terminate()
        pending.clear()
        worker = startWorker(true)
      },
      onEvent: (event) => {
        const span = event.type === 'run' || event.type === 'done' || event.type === 'failed' ? { from: event.from, to: event.to, seconds: event.to - event.from } : {}
        switch (event.type) {
          case 'run':
            return log.debug('slowpass', 'run started', { ...span, windowSeconds: event.windowSeconds, rms: event.rms, timeoutSeconds: event.timeoutSeconds, engine: slowPass.engine })
          case 'silent':
            period.silentRuns += 1
            return
          case 'done':
            period.doneRuns += 1
            period.runMs += event.ms
            return log.info('slowpass', 'run done', { ...span, ms: event.ms, rawNotes: event.rawNotes, notes: event.notes, polyphony: event.polyphony, engine: slowPass.engine })
          case 'failed':
            period.failedRuns += 1
            return log.error('slowpass', `run ${event.timedOut ? 'timed out' : 'failed'}: ${event.error}`, undefined, { ...span, ms: event.ms, failures: event.failures, engine: slowPass.engine, stack: event.stack })
          case 'skipped-ahead':
            return log.warn('slowpass', 'fell behind; skipped audio the model will not re-hear', { lostSeconds: event.lostSeconds })
          case 'state':
            return log[event.to === 'failing' ? 'warn' : 'info']('slowpass', `state ${event.from} -> ${event.to}`)
        }
      },
    },
  )
  let lastStatus = -Infinity
  let lastSummary = opts.now()
  let lastBlock: number | null = null
  const SUMMARY_SECONDS = 30
  const summarize = (time: number) => {
    lastSummary = time
    const level = levels.take()
    if (level) log.info('mic', 'level summary', { periodSeconds: SUMMARY_SECONDS, ...level })
    log.info('fastpass', 'health', { frames: period.frames, pitchedPct: period.frames ? Math.round((100 * period.pitchedFrames) / period.frames) : 0, notes: period.notes, speechChunks: period.speechChunks })
    const status = slowPass.status()
    log.info('slowpass', 'summary', {
      state: status.state,
      engine: status.engine,
      runs: period.doneRuns,
      silentRuns: period.silentRuns,
      failedRuns: period.failedRuns,
      meanRunMs: period.doneRuns ? Math.round(period.runMs / period.doneRuns) : null,
      busyTicks: period.busyTicks,
      lagSeconds: status.correctedUntil === null ? null : status.heardUntil - status.correctedUntil,
      pendingRequests: pending.size,
      totalRuns: status.runs,
    })
    resetPeriod()
  }

  const ratio = audio.sampleRate / 16000
  let resamplePhase = 0
  let speech: number[] = []

  const frameSize = 2048
  let frame = new Float32Array(frameSize)
  let filled = 0
  let current: { pitch: number; start: number; frames: number } | null = null

  const closeNote = (end: number) => {
    if (current && current.frames >= 2) {
      period.notes += 1
      opts.onNotes([{ pitch: current.pitch, start: current.start, duration: Math.max(end - current.start, 0.05), velocity: 0.7, source: 'audio', confidence: 0.5 }])
    }
    current = null
  }

  tap.port.onmessage = (message: MessageEvent<Float32Array>) => {
    const block = message.data
    const now = opts.now()
    publishMicBlock(block, audio.sampleRate, now)

    // Health, not content: only loudness numbers and gaps are kept.
    if (lastBlock !== null && now - lastBlock > 0.5) log.warn('mic', 'audio blocks stopped arriving for a while', { gapSeconds: now - lastBlock })
    lastBlock = now
    const blockRms = rms(block)
    const change = levels.add(blockRms, now)
    if (change) log.info('mic', change === 'silent' ? 'input went silent' : 'hearing sound', { rms: blockRms })

    if (opts.onLevel && ++levelTick % 12 === 0) opts.onLevel(Math.min(1, blockRms * 8))

    ring.push(modelRate.process(block), now)
    if (!slowPass.tick() && slowPass.running) period.busyTicks += 1
    if (now - lastSummary >= SUMMARY_SECONDS) summarize(now)
    if (opts.onSlowPassStatus && ring.end - lastStatus >= 1) {
      lastStatus = ring.end
      opts.onSlowPassStatus(slowPass.status())
    }

    for (; resamplePhase < block.length; resamplePhase += ratio) {
      speech.push(Math.max(-1, Math.min(1, block[Math.floor(resamplePhase)]!)) * 32767)
    }
    resamplePhase -= block.length
    if (speech.length >= 1280) {
      period.speechChunks += 1
      opts.onSpeechPcm(Int16Array.from(speech).buffer) // 80 ms chunks
      speech = []
    }

    let offset = 0
    while (offset < block.length) {
      const take = Math.min(frameSize - filled, block.length - offset)
      frame.set(block.subarray(offset, offset + take), filled)
      filled += take
      offset += take
      if (filled < frameSize) break
      const hz = detectPitch(frame, audio.sampleRate)
      const time = opts.now()
      const pitch = hz ? Math.round(hzToMidi(hz)) : null
      period.frames += 1
      if (pitch !== null) period.pitchedFrames += 1
      if (pitch === null || (current && pitch !== current.pitch)) closeNote(time)
      if (pitch !== null) {
        if (!current) current = { pitch, start: time, frames: 1 }
        else current.frames += 1
      }
      // 50% overlap between analysis frames
      frame.copyWithin(0, frameSize / 2)
      filled = frameSize / 2
    }
  }

  return {
    stop() {
      summarize(opts.now())
      log.info('mic', 'mic stopped')
      tap.port.onmessage = null
      worker.terminate()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      frame = new Float32Array(0)
    },
  }
}
