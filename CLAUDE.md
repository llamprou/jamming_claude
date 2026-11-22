# Jamming Claude

A macOS app: a live music jamming buddy whose brain is Claude. It listens (MIDI, audio, video), shows what it hears (chords, rhythm, sheet, tab, instrument diagrams), talks by voice, plays its own ideas, and learns the player's taste.

Design stance: the agent is the product. Code here is a library of fast, dependable abstractions the agent drives through tools. When the player wants something the agent has no tool for, the agent can start a Claude Code session on this repo (`extend_self`) to build it.

## Layout

- `src/shared/music/` Pure TypeScript, no DOM or Node APIs, fully unit-tested. `NoteEvent` is the common currency: every input becomes notes, every output is derived from notes.
  - `transcript.ts` rolling note buffer. Fast lossy notes are appended live; the slow pass calls `revise()` to replace a window.
  - `analysis.ts` chords, key, tempo/groove. `pitch.ts` fast monophonic pitch (YIN).
  - `render.ts` tab, ABC (sheet), piano/fretboard SVG, chord voicing. `clip.ts` playable clips and MIDI files.
- `src/main/` Electron main process.
  - `agent/session.ts` the live agent: one long-running Claude Agent SDK `query()` with streaming input. It has only the jam tools, no file or shell tools. Also hosts `extend`, the separate coding session.
  - `agent/tools.ts` the jam tools (in-process MCP server). `agent/prompt.ts` system prompts.
  - `memory/taste.ts` taste memory: `events.jsonl` (reactions) and `profile.md` (distilled, loaded into the system prompt).
  - `voice/voice.ts` Deepgram Flux (speech-to-text and turn detection) and Cartesia Sonic (text-to-speech).
- `src/renderer/` React UI. `audio.ts` owns the single AudioContext: mic capture, clip playback, voice playback, Web MIDI.
- `src/shared/ipc.ts` the typed contract between main and renderer.

## Commands

- `npm run check` typecheck, unit tests, build. Run before finishing any change.
- `xvfb-run -a npm run smoke` (Linux) or `npm run smoke` (macOS, needs `playwright` installed) launches the built app and checks MIDI in to chord on screen.
- `JAM_LIVE=1 npm test` also runs the test that talks to the real model.
- `npm run dev` runs the app with hot reload (macOS; needs a display, mic and the keys in `.env`).

## Conventions

- New capability = a pure function in `src/shared/music/` with a test, then a tool in `agent/tools.ts` that exposes it, then a line in the system prompt saying when to use it.
- Tool results are written for the model to read; tool descriptions say what the tool is for. Keep both short.
- Everything the live agent writes is spoken aloud. Keep the system prompt's voice rules intact.
- All audio in and out goes through the renderer's AudioContext so echo cancellation can work. Do not play sound from the main process.
- Keys come from the environment (`.env` in development). Never commit them or log them.
- Voice, real audio input and macOS packaging cannot be exercised in a Linux cloud session. Say so when a change touches them instead of claiming it was tested.
