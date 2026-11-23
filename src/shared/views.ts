/**
 * Every view the agent can open with `show`. A feature that adds a view adds
 * one line here and registers a component for it in the window
 * (src/renderer/src/views/). The description is read by the model.
 */
export interface ViewSpec {
  kind: string
  description: string
}

export const VIEWS: ViewSpec[] = [
  { kind: 'chords', description: 'chord names as they go by' },
  { kind: 'rhythm', description: 'one-bar rhythm grid and tempo' },
  { kind: 'sheet', description: 'sheet music' },
  { kind: 'tab', description: 'guitar or bass tablature' },
  { kind: 'piano', description: 'notes lit on a piano keyboard' },
  { kind: 'guitar', description: 'notes on a guitar neck' },
  { kind: 'bass', description: 'notes on a bass neck' },
  { kind: 'transport', description: 'tempo, the beat of the bar and which parts are looping' },
  { kind: 'camera', description: 'the live camera picture with tracked hands; needs camera_on' },
]

export const viewKinds = (): [string, ...string[]] => VIEWS.map((v) => v.kind) as [string, ...string[]]
