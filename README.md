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

Built and passing automated checks, but never heard or seen by a person:

- MIDI input; two-speed audio transcription (fast single notes, corrected by a polyphonic model that hears chords).
- Views the agent opens by voice: chords, rhythm, sheet, tab, piano, guitar, bass, transport, camera.
- Arrangement: reharmonization (eleven strategies), bass lines, drum patterns and comping in several styles.
- Playing in time: a beat tracker follows your tempo; parts loop and come in on the bar line; your last bars can be looped as notes or as your recorded sound.
- Sampled piano, guitar, bass and drums (see `src/renderer/src/features/sampler/stock/LICENSES.md` after install), and instruments built from your own recorded notes.
- Camera on request: the buddy can look at a frame, and hand tracking gives a coarse fret or keyboard position.
- Taste memory, and self-extension through a separate coding session.

Everything involving sound, a microphone, a camera or a real instrument has only been exercised with synthesized input. The voice pipeline has not been run against the real services from here.

Not built yet: better notation (in progress), time-stretching of audio loops, a learned model of your instrument's timbre, MIDI output to external gear, and the packaged `.app`. The stock samples are Creative Commons Attribution; their credits are not yet shown in the app, which a distributed build must do.

See `CLAUDE.md` for the code layout.
