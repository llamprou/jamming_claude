import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type MainEvent, type RendererApi } from '@shared/ipc'

const api: RendererApi = {
  onEvent(handler) {
    const listener = (_e: unknown, event: MainEvent) => handler(event)
    ipcRenderer.on(CHANNELS.event, listener)
    return () => ipcRenderer.off(CHANNELS.event, listener)
  },
  say: (text) => ipcRenderer.invoke(CHANNELS.say, text),
  midi: (kind, pitch, velocity, time) => ipcRenderer.send(CHANNELS.midi, kind, pitch, velocity, time),
  notes: (notes) => ipcRenderer.send(CHANNELS.notes, notes),
  micAudio: (pcm16) => ipcRenderer.send(CHANNELS.micAudio, pcm16),
  snapshot: (windowSeconds) => ipcRenderer.invoke(CHANNELS.snapshot, windowSeconds),
  interrupt: () => ipcRenderer.send(CHANNELS.interrupt),
}

contextBridge.exposeInMainWorld('jam', api)
