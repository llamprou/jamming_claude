import { LOG_FEATURE, entry, errorData, type LogEntry, type LogLevel } from '@shared/log'

/**
 * Diagnostic logging from the window: entries go to main over the feature bus
 * and land in the same log file (see src/main/log.ts). Keep it to events and
 * periodic summaries, never per audio block, and never audio or speech.
 */
export function send(e: LogEntry): void {
  try {
    window.jam.feature(LOG_FEATURE, e)
  } catch {
    // The bridge is gone (window closing): nothing to do.
  }
}

const at =
  (level: LogLevel) =>
  (component: string, message: string, data?: Record<string, unknown>): void =>
    send(entry(level, component, message, data))

export const log = {
  debug: at('debug'),
  info: at('info'),
  warn: at('warn'),
  error: (component: string, message: string, error?: unknown, data?: Record<string, unknown>): void =>
    send(entry('error', component, message, { ...data, ...(error === undefined ? {} : errorData(error)) })),
}
