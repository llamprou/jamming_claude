import { log } from '../../log'

/** Log the window's uncaught errors and rejected promises, which otherwise only reach the devtools console. */
export function start(): void {
  window.addEventListener('error', (event) =>
    log.error('window', `uncaught error: ${event.message}`, event.error, { source: event.filename?.split('/').pop(), line: event.lineno }),
  )
  window.addEventListener('unhandledrejection', (event) => log.error('window', 'unhandled promise rejection', event.reason))
  log.info('window', 'window started', { userAgent: navigator.userAgent.replace(/^.*?(Chrome\/\S+).*$/, '$1') })
}
