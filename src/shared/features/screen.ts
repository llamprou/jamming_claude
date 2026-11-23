/** Bus traffic for the screen-capture light. Main captures; the window only shows that it is happening. */
export const SCREEN = 'screen'

/** main -> window, with bus.send(SCREEN, ...). */
export type ScreenEvent =
  /**
   * `still`: a single screenshot is being taken (the light shows briefly).
   * `watching`: low-rate snapshots are being kept (the light stays on).
   * `off`: nothing is being captured.
   */
  { type: 'light'; state: 'still' | 'watching' | 'off' }
