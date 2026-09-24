import type { GoalControllerApi } from '../../shared/types'

declare module '*.css'

declare global {
  interface Window {
    goalController: GoalControllerApi
  }
}

export {}
