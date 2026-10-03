export type Today = {
  date: string
  // Steps from the phone file, plus any added by hand with /steps add.
  phone: number
  extra: number
  count: number
  goal: number
  // When the phone last wrote today's file; null when it hasn't today.
  syncedAt: number | null
  isRest: boolean
}

export type Day = {
  date: string
  count: number
  goal: number
  isSkipped: boolean
}

// Where today stands against the steps due by now.
export type Pace = {
  required: number
  behind: number
  nextDueAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'terminal-steps': {
      today: Today | null
      pace: Pace | null
      isWaiting: boolean
      isConnected: boolean
      isIntroduced: boolean
      history: Day[]
      olderStreak: number
    }
  }
}
