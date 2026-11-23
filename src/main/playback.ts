import type { MainEvent } from '@shared/ipc'
import type { Clip } from '@shared/music/types'

/**
 * The one way tool modules make sound. By default a clip plays once, right
 * away. A module that can do better (the transport: in time with the player,
 * looping) offers itself as the provider and takes the clips it wants, so the
 * modules that produce clips never need to know it exists.
 */
export interface PlaybackProvider {
  /** Return a sentence for the tool result, or null to leave this clip to the default one-shot player. */
  play(clip: Clip, opts: { loop: boolean; id: string }): Promise<string | null>
  stop(): void
}

export interface PlayOptions {
  /** Keep repeating until stopped. Needs a provider; without one the clip plays once. */
  loop?: boolean
  /** A stable name for this part, so playing it again replaces it rather than stacking. Defaults to the clip's name. */
  id?: string
  /** Where the MIDI file was saved, for the on-screen note. */
  savedTo?: string
}

export class Playback {
  private provider: PlaybackProvider | null = null

  constructor(private readonly emit: (event: MainEvent) => void) {}

  provide(provider: PlaybackProvider): void {
    this.provider = provider
  }

  /** Returns a sentence describing how it is being played, written for the model. */
  async play(clip: Clip, opts: PlayOptions = {}): Promise<string> {
    const taken = await this.provider?.play(clip, { loop: opts.loop ?? false, id: opts.id ?? clip.name }).catch(() => null)
    if (taken) return taken
    this.emit({ type: 'play-clip', clip, savedTo: opts.savedTo })
    return opts.loop ? 'Playing once, now (looping is not available).' : 'Playing once, now.'
  }

  /** Silence everything this app is playing. */
  stop(): void {
    this.emit({ type: 'stop-playback' })
    this.provider?.stop()
  }
}
