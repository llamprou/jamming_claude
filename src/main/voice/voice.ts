import { randomUUID } from 'node:crypto'
import Cartesia from '@cartesia/cartesia-js'
import { DeepgramClient } from '@deepgram/sdk'

/**
 * The voice loop, composed from two streaming services around our own agent:
 *
 *   mic (16 kHz PCM) -> Deepgram Flux -> turn events -> JamSession
 *   JamSession text  -> Cartesia Sonic -> PCM chunks  -> speakers
 *
 * Flux does speech recognition and end-of-turn detection in one model, which
 * is what makes turn-taking feel natural:
 *   StartOfTurn    the player started speaking  -> barge in (stop talking)
 *   EagerEndOfTurn they have probably finished  -> (hook for speculative replies)
 *   TurnResumed    they kept going              -> discard the speculation
 *   EndOfTurn      they have finished           -> hand the turn to the agent
 */

export interface VoiceConfig {
  deepgramKey: string
  cartesiaKey: string
  sttModel: string
  ttsModel: string
  ttsVoiceId: string
  /** Higher = wait longer before deciding the player has finished. Raised from Flux's 0.7 default because an instrument is usually sounding. */
  eotThreshold?: number
}

export interface VoiceHandlers {
  onPartial(text: string): void
  onTurn(text: string): void
  onBargeIn(): void
  onAudio(pcm16: Buffer, sampleRate: number): void
  onError(error: unknown): void
}

type FluxSocket = Awaited<ReturnType<DeepgramClient['listen']['v2']['connect']>>
type TtsSocket = Awaited<ReturnType<Cartesia['tts']['websocket']>>
type TtsContext = ReturnType<TtsSocket['context']>

const TTS_SAMPLE_RATE = 24000

export class Voice {
  private flux: FluxSocket | null = null
  private tts: TtsSocket | null = null
  private utterance: TtsContext | null = null
  private pendingText = ''

  constructor(
    private readonly config: VoiceConfig,
    private readonly handlers: VoiceHandlers,
  ) {}

  async start(): Promise<void> {
    const deepgram = new DeepgramClient({ apiKey: this.config.deepgramKey })
    const flux = await deepgram.listen.v2.connect({
      model: this.config.sttModel,
      encoding: 'linear16',
      sample_rate: 16000,
      eot_threshold: this.config.eotThreshold ?? 0.8,
      eager_eot_threshold: 0.5,
      Authorization: `Token ${this.config.deepgramKey}`,
    })
    flux.on('message', (message) => {
      if (message.type !== 'TurnInfo') return
      if (message.event === 'StartOfTurn') this.handlers.onBargeIn()
      else if (message.event === 'Update') this.handlers.onPartial(message.transcript)
      else if (message.event === 'EndOfTurn' && message.transcript.trim()) this.handlers.onTurn(message.transcript)
    })
    flux.on('error', (error) => this.handlers.onError(error))
    flux.connect()
    await flux.waitForOpen()
    this.flux = flux

    const cartesia = new Cartesia({ apiKey: this.config.cartesiaKey })
    this.tts = await cartesia.tts.websocket()
  }

  /** 16 kHz mono PCM16 from the microphone. */
  micAudio(pcm16: ArrayBuffer): void {
    this.flux?.sendMedia(pcm16)
  }

  /** Streamed text from the agent. Sent to TTS a sentence at a time so prosody stays natural. */
  speak(chunk: string): void {
    if (!this.tts) return
    this.pendingText += chunk
    const cut = Math.max(this.pendingText.lastIndexOf('. '), this.pendingText.lastIndexOf('? '), this.pendingText.lastIndexOf('! '), this.pendingText.lastIndexOf('\n'))
    if (cut < 0) return
    const ready = this.pendingText.slice(0, cut + 1)
    this.pendingText = this.pendingText.slice(cut + 1)
    void this.send(ready)
  }

  /** The agent's turn is over: flush whatever text is left and close the utterance. */
  endUtterance(): void {
    const rest = this.pendingText
    this.pendingText = ''
    const utterance = this.utterance
    this.utterance = null
    void (async () => {
      try {
        if (rest.trim() && utterance) await utterance.push({ transcript: rest })
        else if (rest.trim()) return void (await this.send(rest, true))
        await utterance?.no_more_inputs()
      } catch (error) {
        this.handlers.onError(error)
      }
    })()
  }

  /** Stop speaking immediately (barge-in). */
  cancel(): void {
    this.pendingText = ''
    const utterance = this.utterance
    this.utterance = null
    void utterance?.cancel().catch(() => undefined)
  }

  stop(): void {
    this.cancel()
    this.flux?.close()
    this.tts?.close()
    this.flux = null
    this.tts = null
  }

  private async send(text: string, last = false): Promise<void> {
    if (!this.tts || !text.trim()) return
    try {
      if (!this.utterance) {
        const utterance = this.tts.context({
          contextId: randomUUID(),
          model_id: this.config.ttsModel,
          voice: { mode: 'id', id: this.config.ttsVoiceId },
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: TTS_SAMPLE_RATE },
        })
        this.utterance = utterance
        void this.receive(utterance)
      }
      const utterance = this.utterance
      await utterance.push({ transcript: text })
      if (last) {
        this.utterance = null
        await utterance.no_more_inputs()
      }
    } catch (error) {
      this.handlers.onError(error)
    }
  }

  private async receive(utterance: TtsContext): Promise<void> {
    try {
      for await (const event of utterance.receive()) {
        if (event.type === 'chunk' && event.audio) {
          // Drop audio that arrives after a barge-in cancelled this utterance.
          if (this.utterance === utterance || this.utterance === null) this.handlers.onAudio(typeof event.audio === 'string' ? Buffer.from(event.audio, 'base64') : Buffer.from(event.audio), TTS_SAMPLE_RATE)
        }
      }
    } catch (error) {
      this.handlers.onError(error)
    }
  }
}
