import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, app, ipcMain, session as electronSession } from 'electron'
import { CHANNELS, type MainEvent } from '@shared/ipc'
import { Transcript } from '@shared/music/transcript'
import type { NoteEvent } from '@shared/music/types'
import { JamSession } from './agent/session'
import { FeatureBus } from './bus'
import { Playback } from './playback'
import { TasteMemory } from './memory/taste'
import { createScreenCapturer } from './screen/capture'
import { Voice } from './voice/voice'

/** Minimal .env loader for development; real environment variables win. */
function loadDotEnv(): void {
  const path = join(app.getAppPath(), '.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (match && match[2] && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2].replace(/^["']|["']$/g, '')
  }
}

let window: BrowserWindow | null = null
const emit = (event: MainEvent) => window?.webContents.send(CHANNELS.event, event)

// The app talks and plays as soon as it opens; no click should be needed to unlock audio.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

async function main(): Promise<void> {
  await app.whenReady()
  loadDotEnv()

  const startedAt = performance.now()
  const now = () => (performance.now() - startedAt) / 1000
  const transcript = new Transcript()
  const bus = new FeatureBus(emit)
  const playback = new Playback(emit)
  const memory = new TasteMemory(process.env.JAM_DATA_DIR ?? join(app.getPath('userData'), 'taste'))

  const missing = ['ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY', 'CARTESIA_API_KEY', 'JAM_TTS_VOICE_ID'].filter((name) => !process.env[name])
  const voiceEnabled = !missing.some((name) => name !== 'ANTHROPIC_API_KEY')

  let voice: Voice | null = null
  const jam = new JamSession(
    {
      transcript,
      memory,
      now,
      emit,
      bus,
      playback,
      screen: createScreenCapturer(() => window, now),
      saveMidi: async (name, midi) => {
        const dir = process.env.JAM_DATA_DIR ? join(process.env.JAM_DATA_DIR, 'ideas') : join(app.getPath('music'), 'Jamming Claude')
        await mkdir(dir, { recursive: true })
        const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
        const path = join(dir, `${stamp} ${name.replace(/[^\w .-]+/g, '').trim() || 'idea'}.mid`)
        await writeFile(path, midi)
        return path
      },
    },
    {
      model: process.env.JAM_AGENT_MODEL ?? 'claude-opus-5-5',
      voice: voiceEnabled,
      // Self-extension needs the source tree, so it is on in development only.
      sourceDir: app.isPackaged ? undefined : app.getAppPath(),
      onSpeech: (chunk) => voice?.speak(chunk),
      onSpeechEnd: () => voice?.endUtterance(),
    },
  )

  if (voiceEnabled) {
    voice = new Voice(
      {
        deepgramKey: process.env.DEEPGRAM_API_KEY!,
        cartesiaKey: process.env.CARTESIA_API_KEY!,
        sttModel: process.env.JAM_STT_MODEL ?? 'flux-general-en',
        ttsModel: process.env.JAM_TTS_MODEL ?? 'sonic-3.5',
        ttsVoiceId: process.env.JAM_TTS_VOICE_ID!,
      },
      {
        onPartial: (text) => emit({ type: 'transcript', role: 'user', text, final: false }),
        onTurn: (text) => jam.say(text),
        onBargeIn: () => {
          voice?.cancel()
          emit({ type: 'tts-flush' })
          void jam.interrupt()
        },
        onAudio: (pcm, sampleRate) => emit({ type: 'tts-audio', pcm16Base64: pcm.toString('base64'), sampleRate }),
        onError: (error) => emit({ type: 'status', agent: 'error', detail: `voice: ${error instanceof Error ? error.message : String(error)}` }),
      },
    )
  }

  ipcMain.handle(CHANNELS.say, (_e, text: string) => jam.say(text))
  ipcMain.handle(CHANNELS.snapshot, (_e, windowSeconds?: number) => transcript.snapshot(now(), windowSeconds))
  ipcMain.on(CHANNELS.midi, (_e, kind: 'on' | 'off', pitch: number, velocity: number) => {
    if (kind === 'on') transcript.noteOn(pitch, now(), velocity, 'midi')
    else transcript.noteOff(pitch, now(), 'midi')
  })
  ipcMain.handle(CHANNELS.clock, () => now())
  ipcMain.on(CHANNELS.feature, (_e, feature: string, message: unknown) => bus.deliver(feature, message))
  ipcMain.on(CHANNELS.featureReply, (_e, id: number, result: unknown, error?: string) => bus.settle(id, result, error))
  ipcMain.on(CHANNELS.notes, (_e, notes: NoteEvent[]) => transcript.add(notes))
  ipcMain.on(CHANNELS.revise, (_e, from: number, to: number, notes: NoteEvent[]) => transcript.revise(from, to, 'audio', notes))
  ipcMain.on(CHANNELS.micAudio, (_e, pcm: ArrayBuffer) => voice?.micAudio(pcm))
  ipcMain.on(CHANNELS.interrupt, () => {
    voice?.cancel()
    emit({ type: 'tts-flush' })
    playback.stop()
    void jam.interrupt()
  })

  // The window needs the mic, camera and MIDI devices; nothing else.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'midi', 'midiSysex'].includes(permission))
  })

  window = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Jamming Claude',
    // Keep timers running at full rate when the window is hidden: the transport schedules sound from them.
    webPreferences: { backgroundThrottling: false, preload: join(import.meta.dirname, '../preload/index.mjs'), sandbox: false },
  })
  window.webContents.on('did-finish-load', () => emit({ type: 'config', voice: voiceEnabled, missing }))
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))

  if (process.env.ANTHROPIC_API_KEY) {
    await jam.start()
    await voice?.start().catch((error: unknown) => emit({ type: 'status', agent: 'error', detail: `voice: ${String(error)}` }))
  }

  app.on('window-all-closed', () => {
    jam.stop()
    voice?.stop()
    app.quit()
  })
}

void main()
