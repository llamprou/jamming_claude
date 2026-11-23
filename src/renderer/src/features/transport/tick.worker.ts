/// <reference lib="webworker" />
// A metronome for the scheduler. Timers in a worker keep firing when the
// window is in the background, where the page's own timers are slowed to one
// a second, which would starve the lookahead scheduler.
let timer: ReturnType<typeof setInterval> | undefined

self.onmessage = (message: MessageEvent<number | null>) => {
  clearInterval(timer)
  timer = undefined
  if (message.data !== null) timer = setInterval(() => self.postMessage(0), message.data)
}
