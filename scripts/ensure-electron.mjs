// Electron downloads its binary in an install script, which npm sometimes
// skips. Run after every install: fetch the binary if it is not there.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

if (!existsSync('node_modules/electron/path.txt')) {
  console.log('Fetching the Electron binary...')
  const result = spawnSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
