import { type BrowserWindow, type NativeImage, app, desktopCapturer, screen, systemPreferences } from 'electron'
import { MAX_EDGE, fitWithin, permissionMessage, type ScreenCapturer, type ScreenShot, type ScreenTarget } from '@shared/screen'

/** Whether macOS lets this app record the screen. Other platforms do not ask. */
function screenAccess(): string {
  return process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
}

/** What the player will find in System Settings: in development the process is Electron itself. */
const appName = () => (app.isPackaged ? app.getName() : 'Electron (this app in development)')

/**
 * Stills of the app window (no permission needed) or of the display the app
 * is on (macOS Screen Recording permission). Nothing runs until capture() is called.
 */
export function createScreenCapturer(getWindow: () => BrowserWindow | null, now: () => number): ScreenCapturer {
  const encode = (image: NativeImage, target: ScreenTarget, maxEdge: number, quality: number): ScreenShot => {
    const size = image.getSize()
    const fit = fitWithin(size.width, size.height, maxEdge)
    const scaled = fit.width < size.width ? image.resize({ width: fit.width, height: fit.height, quality: 'best' }) : image
    const out = scaled.getSize()
    return { data: scaled.toJPEG(quality).toString('base64'), mimeType: 'image/jpeg', width: out.width, height: out.height, time: now(), target }
  }

  return {
    async capture(target, { maxEdge = MAX_EDGE, quality = 85 } = {}) {
      const window = getWindow()
      if (target === 'app') {
        if (!window || window.isDestroyed()) throw new Error('The app window is not open, so there is nothing to capture.')
        const image = await window.webContents.capturePage()
        if (image.isEmpty()) throw new Error('The app window is minimised or hidden, so the capture came back empty. Ask the player to bring it back on screen.')
        return encode(image, target, maxEdge, quality)
      }

      const display = window && !window.isDestroyed() ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay()
      const pixels = fitWithin(display.size.width * display.scaleFactor, display.size.height * display.scaleFactor, maxEdge)
      // The first call is what makes macOS show its permission prompt, so call before judging the status.
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: pixels })
      const access = screenAccess()
      if (access !== 'granted') throw new Error(permissionMessage(access, appName()))
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
      if (!source || source.thumbnail.isEmpty()) throw new Error('The screen capture came back empty. The player may need to allow Screen Recording for this app and reopen it.')
      return encode(source.thumbnail, target, maxEdge, quality)
    },
  }
}
