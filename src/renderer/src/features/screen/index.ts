import { SCREEN, type ScreenEvent } from '@shared/features/screen'
import { onFeature } from '../bus'
import './screen.css'

/** The "screen capture" light. Main does the capturing; this only shows the player that it is happening. */
export function start(): void {
  const light = document.createElement('div')
  light.className = 'screen-light'
  light.setAttribute('role', 'status')
  light.hidden = true
  document.body.appendChild(light)

  let watching = false
  let flash: ReturnType<typeof setTimeout> | undefined
  const show = () => {
    light.textContent = watching ? 'screen watch on' : 'screenshot'
    light.hidden = !watching && flash === undefined
  }

  onFeature(SCREEN, (message) => {
    const event = message as ScreenEvent
    if (event.type !== 'light') return
    if (event.state === 'still') {
      clearTimeout(flash)
      flash = setTimeout(() => {
        flash = undefined
        show()
      }, 2000)
    } else {
      watching = event.state === 'watching'
    }
    show()
  })
}
