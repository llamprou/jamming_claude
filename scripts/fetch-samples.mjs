// Downloads a compact set of real instrument samples for the buddy's playback
// into src/renderer/src/features/sampler/stock/ (gitignored). The app bundles
// whatever is in that folder at build time and loads it from its own files, so
// nothing is fetched at run time. Without this step the app still plays, on
// synthesized stand-ins.
//
//   node scripts/fetch-samples.mjs
//
// Needs one host: registry.npmjs.org (it uses `npm pack`, so npm's own proxy
// and certificate settings apply, and tarball integrity is checked by npm).
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'src/renderer/src/features/sampler/stock')

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
/** "Fs4" or "F#4" -> MIDI number (C4 = 60). */
const midi = (name) => {
  const [, letter, sharp, octave] = /^([A-G])(s|#)?(-?\d)$/.exec(name)
  return NOTE[letter] + (sharp ? 1 : 0) + (Number(octave) + 1) * 12
}
const pitched = (names, source) => names.map((name) => ({ name, pitch: midi(name), source: source(name) }))

const SETS = [
  {
    name: 'piano',
    label: 'Grand piano (Salamander Grand Piano, sampled)',
    kind: 'pitched',
    release: 0.35,
    maxSeconds: 8,
    package: '@audio-samples/piano-mp3-velocity8@1.0.5',
    credit: 'Salamander Grand Piano V3 by Alexander Holm, licensed CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). MP3 conversion from the npm package @audio-samples/piano-mp3-velocity8; shortened and mixed to mono by this app.',
    // Every six semitones across the keyboard, every three in the middle where most playing sits.
    zones: pitched(
      ['C1', 'Fs1', 'C2', 'Fs2', 'A2', 'C3', 'Ds3', 'Fs3', 'A3', 'C4', 'Ds4', 'Fs4', 'A4', 'C5', 'Ds5', 'Fs5', 'A5', 'C6', 'Fs6', 'C7'],
      (name) => `audio/${name.replace('s', '#')}v8.mp3`,
    ),
  },
  {
    name: 'guitar',
    label: 'Acoustic guitar (sampled)',
    kind: 'pitched',
    release: 0.25,
    maxSeconds: 6,
    package: 'tonejs-instrument-guitar-acoustic-mp3@1.1.2',
    credit: 'Acoustic guitar from the tonejs-instruments sample library by Nicholaus Brosowsky (https://github.com/nbrosowsky/tonejs-instruments); samples licensed CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). From the npm package tonejs-instrument-guitar-acoustic-mp3; shortened by this app.',
    zones: pitched(['D2', 'F2', 'Gs2', 'B2', 'D3', 'F3', 'Gs3', 'B3', 'D4', 'F4', 'Gs4', 'B4', 'D5'], (name) => `${name}.mp3`),
  },
  {
    name: 'bass',
    label: 'Electric bass (sampled)',
    kind: 'pitched',
    release: 0.15,
    maxSeconds: 6,
    package: 'tonejs-instrument-bass-electric-mp3@1.1.2',
    credit: 'Electric bass from the tonejs-instruments sample library by Nicholaus Brosowsky (https://github.com/nbrosowsky/tonejs-instruments); samples licensed CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). From the npm package tonejs-instrument-bass-electric-mp3; shortened by this app.',
    zones: pitched(['E1', 'As1', 'E2', 'As2', 'E3', 'As3', 'E4', 'As4'], (name) => `${name}.mp3`),
  },
  {
    name: 'drums',
    label: 'Drum kit (sampled, electronic-style hits)',
    kind: 'drums',
    package: '@teropa/drumkit@1.1.0',
    credit: "Drum hits from the npm package @teropa/drumkit by Tero Parviainen, which takes them from freesound.org: DWSD's Deep House Drum Kit (Creative Commons Attribution, https://freesound.org/people/DWSD/packs/11575/), stomachache's Analog Cymbal (CC0, https://freesound.org/people/stomachache/sounds/140153/) and Karman_Lyne's 808 toms (CC0, https://freesound.org/people/Karman_Lyne/sounds/520168/).",
    zones: [
      ['kick', 'kick'], ['snare', 'snare'], ['hatClosed', 'hatClosed'], ['hatPedal', 'hatClosed2'], ['hatOpen', 'hatOpen'],
      ['tomLow', 'tomLow'], ['tomMid', 'tomMid'], ['tomHigh', 'tomHigh'], ['ride', 'ride'], ['crash', 'crash'],
    ].map(([drum, file]) => ({ name: drum, pitch: 0, drum, source: `dist/assets/${file}.mp3` })),
  },
]

const work = mkdtempSync(join(tmpdir(), 'jam-samples-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const manifest = { fetchedAt: new Date().toISOString(), instruments: [] }
let total = 0
try {
  for (const set of SETS) {
    const tarball = execFileSync(npm, ['pack', set.package, '--pack-destination', work, '--silent'], { encoding: 'utf8', cwd: work }).trim().split('\n').pop()
    const unpacked = join(work, set.name)
    mkdirSync(unpacked)
    execFileSync('tar', ['-xzf', join(work, tarball), '-C', unpacked])
    mkdirSync(join(out, set.name))
    const zones = set.zones.map((zone) => {
      const sample = `${set.name}/${zone.name}.mp3`
      copyFileSync(join(unpacked, 'package', zone.source), join(out, sample))
      total += statSync(join(out, sample)).size
      return { sample, pitch: zone.pitch, ...(zone.drum ? { drum: zone.drum } : {}) }
    })
    manifest.instruments.push({ name: set.name, label: set.label, kind: set.kind, release: set.release, maxSeconds: set.maxSeconds, credit: set.credit, package: set.package, zones })
    console.log(`${set.name}: ${zones.length} samples from ${set.package}`)
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(
    join(out, 'LICENSES.md'),
    `# Stock instrument samples\n\nDownloaded by scripts/fetch-samples.mjs on ${manifest.fetchedAt.slice(0, 10)}. These files are not part of this repository; they are redistributed with the built app under the licences below, which require the credits to be kept.\n\n${SETS.map((s) => `## ${s.name}\n\n${s.label}. npm package: ${s.package}.\n\n${s.credit}\n`).join('\n')}`,
  )
  console.log(`Wrote ${(total / 1e6).toFixed(1)} MB of samples to ${out}`)
} catch (error) {
  // Leave nothing half-fetched behind: the app falls back to its stand-ins.
  rmSync(out, { recursive: true, force: true })
  console.error(`Could not fetch samples: ${error.message}`)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
