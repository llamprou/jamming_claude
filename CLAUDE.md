# Jamming Claude

A macOS app: a live music jamming buddy whose brain is Claude. It listens (MIDI, audio, video), shows what it hears (chords, rhythm, sheet, tab, instrument diagrams), talks by voice, plays its own ideas, and learns the player's taste.

Design stance: the agent is the product. Code here is a library of fast, dependable abstractions the agent drives through tools. When the player wants something the agent has no tool for, the agent can start a Claude Code session on this repo (`extend_self`) to build it.

## Layout

- `src/shared/music/` Pure TypeScript, no DOM or Node APIs, fully unit-tested. `NoteEvent` is the common currency: every input becomes notes, every output is derived from notes.
  - `transcript.ts` rolling note buffer. Fast lossy notes are appended live; the slow pass calls `revise()` to replace a window.
  - `analysis.ts` chords, key, tempo/groove. `pitch.ts` fast monophonic pitch (YIN).
  - `polyphonic.ts` the slow pass's model (Spotify Basic Pitch on tfjs) plus ghost-note cleanup. `slowpass.ts` audio ring buffer, resampler, and the scheduler that decides which stretch each model run may overwrite.
  - `render.ts` tab, ABC (sheet), piano/fretboard SVG, chord voicing. `clip.ts` playable clips and MIDI files.
  - `arrange/` reharmonization strategies (one file each under `reharm/`), bass lines, drum patterns, comping, and the `Arrangement` model.
  - `transport/` beat grid, beat tracker (tempo and phase over time), lookahead scheduler core, loop extraction, audio-loop maths.
  - `sampler.ts`, `capture.ts`, `wav.ts`, `synthkit.ts` sample zones and envelopes, building an instrument from recorded notes, WAV I/O, synthesized stand-in sounds.
  - `vision/` hand landmarks to musical signals: fret-region and keyboard-hand hints, gestures.
- `src/shared/views.ts` the list of views the agent can open. `src/shared/ipc.ts` the typed core contract between main and window. `src/shared/features/<name>.ts` message types for one feature's bus traffic.
- `src/main/` Electron main process.
  - `agent/session.ts` the live agent: one long-running Claude Agent SDK `query()` with streaming input. It has only the jam tools, no file or shell tools. Also hosts `extend`, the separate coding session.
  - `agent/toolkit.ts` `ToolContext`, `ToolModule`, shared schemas. `agent/tools/` one file per tool module; `agent/tools/index.ts` lists them. `agent/prompt.ts` the system prompt frame (tool guidance comes from the modules).
  - `playback.ts` how tools make sound: one-shot by default, handed to the transport when looping or when layers are running.
  - `instruments/store.ts` captured instruments and recordings on disk.
  - `bus.ts` the feature bus: `send`, `request` (awaits the window's answer), `on`.
  - `memory/taste.ts` taste memory: `events.jsonl` (reactions) and `profile.md` (distilled, loaded into the system prompt).
  - `voice/voice.ts` Deepgram Flux (speech-to-text and turn detection) and Cartesia Sonic (text-to-speech).
- `src/renderer/src/` the window (React).
  - `audio/context.ts` the single AudioContext, `musicOutput()`, the session clock (`sessionNow`, `toAudioTime`) and `onMicBlock` for raw mic samples. `audio/voices.ts` the voice registry and built-in synth. `audio/player.ts` one-shot clip playback. `audio/mic.ts` mic capture and both transcription passes. `audio/speech.ts` the buddy's voice. `audio/midi.ts` Web MIDI. `audio.ts` re-exports them.
  - `views/registry.ts` `registerView`; `views/core.tsx` the original seven; `views/index.ts` lists view modules.
  - `features/bus.ts` the window end of the feature bus; `features/index.ts` lists window features. `features/sampler/` sampler voices (stock samples are fetched into `features/sampler/stock/`, gitignored), `features/transport/` the musical clock and looping layers, `features/camera/` camera and hand tracking (model in `assets/vision/`, gitignored).
  - `transcriber.worker.ts` runs the polyphonic model off the UI thread; `tap.worklet.js` taps mic samples on the audio thread.

## Adding a capability without touching the others

Each capability is a module that plugs into registries. Existing modules are not edited to add a new one; the only shared edits are one-line entries in the lists named below.

- **Music logic**: a new file (or folder) in `src/shared/music/`, pure functions, with its own test file. Do not grow `analysis.ts` or `render.ts`; import from them.
- **Agent tools**: a new file in `src/main/agent/tools/` exporting a `ToolModuleFactory` (tools plus the `guide` paragraph that tells the agent when to use them), and one line in `tools/index.ts`. Tool names must be unique across modules.
- **A view**: a component registered with `registerView(kind, Component)` in a new file under `views/`, one import line in `views/index.ts`, and one entry in `src/shared/views.ts`. Registering an existing kind replaces its renderer; do that deliberately, in the module that supersedes it. Extra payload travels in `Panel.data`.
- **Window-side behaviour** (camera, looping, sampling): a folder under `features/` exporting `start()`, one line in `features/index.ts`. Talk to main over the feature bus under your feature's own name, with message types in `src/shared/features/<name>.ts`. Do not add cases to `MainEvent` or methods to `RendererApi` for a feature.
- **Playing a clip from a tool**: call `ctx.playback.play(clip, { loop, id })` and `ctx.playback.stop()`. Do not emit `play-clip` yourself, or the clip will ignore the transport.
- **Sound**: a new instrument registers a chooser with `registerVoice`; it returns null for tracks it does not handle. Play through `musicOutput()`. Mic samples come from `onMicBlock`; never call `getUserMedia` for audio again.
- **Time**: everything is stamped on the session clock (`ctx.now()` in main, `sessionNow()` in the window). Use `toAudioTime` to schedule sound.

## Commands

- `npm run check` typecheck, unit tests, build. Run before finishing any change.
- `xvfb-run -a npm run smoke` (Linux) or `npm run smoke` (macOS, needs `playwright` installed) launches the built app and checks MIDI in to chord on screen, then plays a synthesized chord progression into Chromium's fake microphone and checks the polyphonic pass names the chords.
- `xvfb-run -a npm run smoke:all` also runs the sampler, transport and vision checks against the built app (`smoke:sampler`, `smoke:transport`, `smoke:vision` individually). The transport check is timing-sensitive; rerun once before believing a failure on a loaded machine.
- `npm run assets` re-fetches instrument samples (npm registry) and the hand-tracking model (storage.googleapis.com). `npm install` does this automatically; without them the app uses stand-in sounds and reports hand tracking as unavailable.
- `JAM_LIVE=1 npm test` also runs the test that talks to the real model.
- `npm run dev` runs the app with hot reload (macOS; needs a display, mic and the keys in `.env`).

## Conventions

- The interface is voice-first. The window has no buttons, menus or required typing: the mic and MIDI start on their own, and only the agent opens, updates and closes views (`show` / `hide`) and plays ideas. Do not add controls; add a tool the agent can call. A text box appears only as a fallback when voice keys are missing.
- New capability = a pure function in `src/shared/music/` with a test, then a tool in `agent/tools.ts` that exposes it, then a line in the system prompt saying when to use it.
- Tool results are written for the model to read; tool descriptions say what the tool is for. Keep both short.
- Everything the live agent writes is spoken aloud. Keep the system prompt's voice rules intact.
- All audio in and out goes through the renderer's AudioContext so echo cancellation can work. Do not play sound from the main process.
- The page's Content-Security-Policy allows scripts from the app's own files only. Workers and worklets must be real files (`?url&no-inline`), not blob or data URLs.
- Keys come from the environment (`.env` in development). Never commit them or log them.
- Voice, real audio input and macOS packaging cannot be exercised in a Linux cloud session. Say so when a change touches them instead of claiming it was tested.
