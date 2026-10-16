export type Ttl = '5m' | '1h'

/** New tokens one model request added (sent uncached + written to cache + output). */
export type Step = { at: number; n: number }

/** Session totals across the main thread and subagents. */
export type Totals = {
  /** Uncached input plus cache writes: what was newly sent. */
  sent: number
  /** Output tokens. */
  wrote: number
  /** Cache reads: the conversation re-sent each step. */
  reread: number
}

/** The current or last prompt's turn. */
export type Turn = {
  startedAt: number
  endedAt: number | null
  /** New tokens this turn. */
  tokens: number
  /** Session cost when the turn began; null when the host keeps no ledger. */
  usdAtStart: number | null
}

/** The main thread's prompt cache as of its last model request. */
export type Warm = {
  at: number
  /** Prompt tokens the next request re-sends. */
  tokens: number
  /** Share of the last prompt served from cache, 0-100; null when unknown. */
  hitPct: number | null
  model: string
}

/** One advisor consultation, noted when the step that carried it came back. */
export type AdvisorCall = {
  /** The API's id for the call, kept to count it once. */
  id: string
  /** 1-based position in the session. */
  n: number
  /** When the step carrying it arrived. */
  at: number
  /** How long the advisor ran; null when its result never arrived. */
  ms: number | null
}

/** Advisor consultations this session (the newest 50 are kept). */
export type Advisor = {
  calls: AdvisorCall[]
  /** All calls so far, including ones no longer in `calls`. */
  count: number
  /** When the first model step of the session arrived. */
  firstAt: number | null
}

export type Ctx ={ tokens?: number; window: number; percent?: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Limits = { context: Ctx | null; rateLimits: Limit[]; usd: number | null }

/** What the band shows; saved in the mod's own store, edited from the Settings section of the details. */
export type Prefs = {
  showContext: boolean
  show5h: boolean
  showWeek: boolean
  showAdvisor: boolean
  showCache: boolean
  showCost: boolean
  /** Live new-token rate while Claude works; off shows the cache countdown instead. */
  showRate: boolean
  showAlerts: boolean
  detailsNow: boolean
  detailsLimits: boolean
  detailsCache: boolean
  detailsSession: boolean
  /** Seconds the band says "Advisor consulted" after a call; 0 turns the note off. */
  advisorFlashSeconds: number
}

/** A rate-limit reading, kept to estimate when a window runs out. */
export type Sample = { t: number; p: number }

declare module 'claude-code' {
  interface PluginState {
    'status-band': {
      open: boolean
      hidden: boolean
      now: number
      limits: Limits
      steps: Step[]
      totals: Totals
      turn: Turn | null
      warm: Warm | null
      ttl: Ttl
      history: Record<string, Sample[]>
      advisor: Advisor
      prefs: Prefs
      settingsOpen: boolean
    }
  }
}
