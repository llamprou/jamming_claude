# Jamming Claude

A live music jamming buddy for macOS, powered by Claude. Play something on a MIDI keyboard or into the mic; it tells you what it heard, shows it as chords, rhythm, sheet music, tab or on a piano, guitar or bass, talks with you by voice, and plays its own ideas back: continuations, melodies, bass lines, grooves. It remembers what you keep and what you skip, and its ideas drift toward your taste.

## Run it (macOS)

```sh
npm install
cp .env.example .env   # add your keys
npm run dev
```

There is nothing to click. The app starts listening when it opens and the buddy greets you; talk to it and play. Ask it to show things ("show me the chords", "put that on a guitar neck", "clear the screen") and to play ideas, which are also saved as MIDI files in `~/Music/Jamming Claude`. Escape silences it.

You need an Anthropic API key, a Deepgram key, a Cartesia key and a Cartesia voice ID. Without the voice keys a text box appears as a fallback.

## How it fits together

```
 MIDI ─┐                                     ┌─ chords / rhythm / sheet / tab / diagrams
 mic ──┼─> notes ─> Transcript ─> listen ─┐  ├─ playback + MIDI file
 video ┘   (fast, lossy; slow pass revises)│  │
                                           ▼  │
 mic ─> Deepgram Flux ─> turn ─> Claude (Agent SDK) ─> text ─> Cartesia Sonic ─> speakers
        barge-in <──────────────  tools: listen show play stop
                                         remember recall update_taste_profile
                                         extend_self ─> Claude Code session on this repo
```

- **Agent**: the Claude Agent SDK runs one long-lived session; the tools above are its hands.
- **Voice**: Deepgram Flux does speech recognition and end-of-turn detection in one model (so it knows when you have finished a thought, and when you interrupt); Cartesia Sonic speaks the reply as it streams.
- **Transcription**: two speeds. A fast pass puts notes on screen immediately; a slower, more accurate pass corrects them a moment later.
- **Memory**: plain files (`events.jsonl`, `profile.md`) in the app's data folder. Read them, edit them, delete them.
- **Self-extension**: when you ask for something it cannot do, it starts a Claude Code session that builds the feature on a `self/...` branch for you to review.

## Status

Working and tested: MIDI input, chord/key/tempo analysis, all seven views, clip playback and MIDI export, the agent loop with its tools, taste memory, and two-speed audio transcription (a fast single-note tracker, corrected every few seconds by a polyphonic model that hears chords).

Audio transcription has only been tested with synthesized tones, not a real instrument through a real microphone. In the cloud test machine the polyphonic model runs on the CPU, slower than real time; on a Mac it should use the GPU, which has not been measured.

Written but not yet run against the real services: the voice pipeline (needs keys and a microphone).

Not built yet: video input, sampled instrument sounds (playback is a simple built-in synth), MIDI output to external gear, and the packaged `.app`.

See `CLAUDE.md` for the code layout.
