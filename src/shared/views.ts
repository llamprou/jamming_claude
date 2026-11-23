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
  { kind: 'chords', description: 'chord names as they go by, spelled for the key' },
  { kind: 'rhythm', description: 'time signature, tempo, swing and the rhythm on its beats' },
  { kind: 'sheet', description: 'sheet music with key and time signature' },
  { kind: 'tab', description: 'guitar or bass tablature with rhythm' },
  { kind: 'piano', description: 'piano keys lighting as notes sound (yours, the player\'s, or given notes stepped in time)' },
  { kind: 'guitar', description: 'guitar neck lighting as notes sound' },
  { kind: 'bass', description: 'bass neck lighting as notes sound' },
  { kind: 'transport', description: 'tempo, the beat of the bar and which parts are looping' },
  { kind: 'camera', description: 'the live camera picture with tracked hands; needs camera_on' },
]

export const viewKinds = (): [string, ...string[]] => VIEWS.map((v) => v.kind) as [string, ...string[]]
