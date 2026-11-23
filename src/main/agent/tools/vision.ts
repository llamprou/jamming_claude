import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { CAMERA, type CameraEvent, type CameraFrame, type CameraRequest, type CameraStatus, type MarkReply } from '@shared/features/camera'
import { noteName } from '@shared/music/analysis'
import { fretHints, keyboardHints } from '@shared/music/vision/hints'
import { text, type ToolModuleFactory } from '../toolkit'

/** How the tracker's state reads to the model. One line per fact, nothing it cannot act on. */
export function describeCamera(status: CameraStatus): string {
  if (!status.on) return `Camera: off.${status.trackingDetail ? ` ${status.trackingDetail}` : ''}`
  const lines = [`Camera: on (${status.camera ?? 'camera'}, ${status.width}x${status.height}).${status.cameras.length > 1 ? ` Others available: ${status.cameras.filter((c) => c !== status.camera).join(', ')}.` : ''}`]
  if (status.tracking !== 'on') lines.push(`Hand tracking: ${status.tracking}${status.trackingDetail ? ` (${status.trackingDetail})` : ''}.`)
  else if (status.hands.length === 0) lines.push('Hand tracking: no hands in view.')
  else lines.push(`Hand tracking: ${status.hands.map((h) => `${h.side} hand ${h.raised ? 'raised' : h.motion === 'still' ? 'still' : 'moving'}`).join(', ')}.`)
  const fret = status.fretHint
  if (status.marked.neck) lines.push(fret && fret.confidence >= 0.3 ? `Fretting hand: frets ${fret.lowFret}-${fret.highFret} on the ${fret.instrument} (confidence ${fret.confidence.toFixed(1)}).` : `The ${status.marked.neck} neck is marked, but no hand is on it right now.`)
  else if (status.marked.neckPoints.length) lines.push(`Neck half marked (${status.marked.neckPoints.join(', ')} done).`)
  const keys = status.keyboardHint
  if (status.marked.keyboard) {
    const reach = (name: string, r: { low: number; high: number } | null) => (r ? `${name} hand over ${noteName(r.low)}-${noteName(r.high)}` : `${name} hand off the keys`)
    lines.push(keys && keys.confidence > 0 ? `Keyboard: ${reach('left', keys.left)}, ${reach('right', keys.right)}${keys.split !== null ? `, split at ${noteName(keys.split)}` : ''} (confidence ${keys.confidence.toFixed(1)}).` : 'The keyboard is marked, but no hands are on it right now.')
  } else if (status.marked.keyboardPoints.length) lines.push(`Keyboard half marked (${status.marked.keyboardPoints.join(', ')} done).`)
  return lines.join('\n')
}

/** Sight: the camera, still pictures for the model to look at, and the hand tracker's readout. */
export const vision: ToolModuleFactory = (ctx) => {
  const ask = <T>(request: CameraRequest, timeoutMs?: number) => ctx.bus.request<T>(CAMERA, request, timeoutMs)
  const failed = (error: unknown) => text(error instanceof Error ? error.message : String(error))

  // The window's hints, mirrored here so anything in the main process that renders tab or sheet can use them.
  ctx.bus.on(CAMERA, (message) => {
    const event = message as CameraEvent
    if (event.type === 'fret-hint') fretHints.add(event.hint)
    else if (event.type === 'keyboard-hint') keyboardHints.add(event.hint)
  })

  const cameraOn = tool(
    'camera_on',
    'Turn the camera on so you can look at the player and their hands can be tracked. Does nothing if it is already on.',
    { camera: z.string().optional().describe('Part of a camera name, to pick one when there are several') },
    async ({ camera }) => {
      try {
        // Generous: the first time, the system may ask the player for permission.
        return text(describeCamera(await ask<CameraStatus>({ type: 'start', camera }, 30_000)))
      } catch (error) {
        return failed(error)
      }
    },
  )

  const cameraOff = tool('camera_off', 'Turn the camera off.', {}, async () => {
    try {
      await ask<CameraStatus>({ type: 'stop' })
      return text('Camera off.')
    } catch (error) {
      return failed(error)
    }
  })

  const look = tool(
    'look',
    'Take a still picture from the camera and see it. Turns the camera on if it is off.',
    { seconds_ago: z.number().min(0).max(20).default(0).describe('Look at a moment that has just passed instead of now (one picture a second is kept for 20 seconds)') },
    async ({ seconds_ago }) => {
      try {
        const before = await ask<CameraStatus>({ type: 'status' })
        if (!before.on) {
          await ask<CameraStatus>({ type: 'start' }, 30_000)
          // A camera's first frames are often black while exposure settles.
          await new Promise((resolve) => setTimeout(resolve, 700))
        }
        const frame = await ask<CameraFrame>({ type: 'frame', secondsAgo: before.on ? seconds_ago : 0 })
        const age = ctx.now() - frame.time
        const notes = [
          before.on ? null : 'The camera was off, so you have just turned it on: tell the player.',
          age > 0.75 ? `This picture is from ${age.toFixed(0)} seconds ago.` : null,
          'The picture is as the camera sees it, not mirrored: their right hand is on your left if they face the camera.',
          describeCamera(frame.status),
        ]
        return { content: [{ type: 'image' as const, data: frame.data, mimeType: frame.mimeType }, { type: 'text' as const, text: notes.filter(Boolean).join('\n') }] }
      } catch (error) {
        return failed(error)
      }
    },
  )

  const markPosition = tool(
    'mark_position',
    "Record where the instrument is in the camera picture, so the hand tracker can tell which frets or keys the player's hands are over. Guitar or bass: mark `nut`, then `fret` (the twelfth unless you say otherwise). Piano: mark `low_key`, then `high_key`. Each point is read from where the player is holding an index fingertip, so ask them to touch the spot and hold still before each call; or look first and pass x and y yourself.",
    {
      point: z.enum(['nut', 'fret', 'low_key', 'high_key', 'clear']).describe('`clear` forgets every marked point'),
      instrument: z.enum(['guitar', 'bass']).optional().describe('For nut and fret'),
      fret: z.number().int().min(3).max(24).optional().describe('Which fret wire is being marked; default 12'),
      pitch: z.number().int().min(0).max(127).optional().describe('MIDI number of the key being marked; default 21 (lowest A) for low_key and 108 (top C) for high_key'),
      hand: z.enum(['left', 'right']).optional().describe("Which of the player's hands is pointing, if both are in view"),
      x: z.number().min(0).max(1).optional().describe('With y: the point as a fraction across the picture from `look`, instead of a touch'),
      y: z.number().min(0).max(1).optional().describe('Fraction down the picture'),
    },
    async ({ point, ...rest }) => {
      try {
        if (point === 'clear') return text(`Marks cleared.\n${describeCamera(await ask<CameraStatus>({ type: 'unmark', target: 'all' }))}`)
        const reply = await ask<MarkReply>({ type: 'mark', point, ...rest })
        return text(reply.message)
      } catch (error) {
        return failed(error)
      }
    },
  )

  const hands = tool('hands', "Read the hand tracker without taking a picture: which hands are in view, whether they are moving, and, once the instrument's position is marked, which frets or keys they are over.", {}, async () => {
    try {
      return text(describeCamera(await ask<CameraStatus>({ type: 'status' })))
    } catch (error) {
      return failed(error)
    }
  })

  return {
    name: 'vision',
    guide: `- camera_on / camera_off: you can see the player through their camera. It is off until you turn it on. Turn it on when they ask you to watch or look, and say that you are doing it. Turn it off when they ask, or when you no longer need it. While it is on, a red camera light shows on their screen.
- look: take a still picture and see it. Use it whenever the answer depends on seeing: what chord shape a hand is making, whether a wrist or posture looks right, what instrument they are holding, where they are on the neck. Look rather than guess, and describe what you see in plain words; if the picture is too dark, blurred or cropped to tell, say so and ask them to move. If the camera was off, look turns it on: tell them. To let them see the picture too, show the camera view.
- hands / mark_position: on their own computer, a tracker follows their hands a few times a second. It is coarse: it knows roughly which frets or which stretch of keys a hand is over, not which finger plays which note. It needs to know where the instrument is first: for guitar or bass, ask them to touch the nut with a fingertip and hold still, call mark_position, then the same at the twelfth fret; for piano, the lowest key then the highest. After that, tablature and the split between staves follow their hands, and hands tells you where they are without a picture. Mark again if they or the camera move.
- Privacy, if they ask: video is never recorded and never leaves their computer. Only the single still pictures you take with look are sent, to Anthropic, as part of this conversation.`,
    tools: [cameraOn, cameraOff, look, markPosition, hands],
  }
}
