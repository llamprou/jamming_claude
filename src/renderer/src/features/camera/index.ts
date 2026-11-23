import { CAMERA } from '@shared/features/camera'
import { answerFeature } from '../bus'
import { answer } from './camera'

/** The camera stays off here: it starts only when main asks (the agent's camera_on or look). */
export function start(): void {
  answerFeature(CAMERA, answer)
}
