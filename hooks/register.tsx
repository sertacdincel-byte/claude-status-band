import { atom, read, update } from 'claude-code'
import type { ConfigKind, ConfigValue, EngineInterface, Register, TurnStepServerToolUse, TurnUsage } from 'claude-code'

import type { Advisor, Ctx, Limit, Limits, Sample, Step, Totals, Ttl, Turn, Warm } from '../types'

const P = 'status-band'
const COMMAND = 'band'
const SEC = 1000
const MIN = 60 * SEC
const TTL_MS: Record<Ttl, number> = { '5m': 5 * MIN, '1h': 60 * MIN }
// A cache write over a cache read: 1h writes bill 2x base input, 5m 1.25x, reads 0.1x.
const WRITE_WEIGHT: Record<Ttl, number> = { '5m': 1.25, '1h': 2 }
const KEEP = 15 * MIN
// How long (seconds) the band says "Advisor consulted" after a call reaches it, unless the option says otherwise; and how many calls it remembers.
const ADVISOR_FLASH_SECONDS = 12
const ADVISOR_KEEP = 50
const ADVISOR_SPAN = 60 * MIN

const C = { ok: '#30A46C', warn: '#E09A1E', bad: '#E5484D', live: '#3B82F6', pro: '#8E4EC6', track: '#8080804D' }
type Level = 'ok' | 'warn' | 'bad'

const ZERO: Totals = { sent: 0, wrote: 0, reread: 0 }
const NO_LIMITS: Limits = { context: null, rateLimits: [], usd: null }
const NO_ADVISOR: Advisor = { calls: [], count: 0, firstAt: null }

const open = atom({ plugin: 'status-band', key: 'open' } as const, false)
const hidden = atom({ plugin: 'status-band', key: 'hidden' } as const, false)
const now = atom({ plugin: 'status-band', key: 'now' } as const, 0)
const limits = atom({ plugin: 'status-band', key: 'limits' } as const, NO_LIMITS)
const steps = atom({ plugin: 'status-band', key: 'steps' } as const, [])
const totals = atom({ plugin: 'status-band', key: 'totals' } as const, ZERO)
const turn = atom({ plugin: 'status-band', key: 'turn' } as const, null)
const warm = atom({ plugin: 'status-band', key: 'warm' } as const, null)
const ttlAtom = atom({ plugin: 'status-band', key: 'ttl' } as const, '1h')
const history = atom({ plugin: 'status-band', key: 'history' } as const, {})
const advisor = atom({ plugin: 'status-band', key: 'advisor' } as const, NO_ADVISOR)

// ---------- arithmetic ----------

export const level = (p: number | undefined): Level => (p === undefined ? 'ok' : p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok')

export const fmtTok = (n: number): string =>
  n >= 10_000_000
    ? `${Math.round(n / 1_000_000)}M`
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 10_000
        ? `${Math.round(n / 1000)}k`
        : n >= 1000
          ? `${(n / 1000).toFixed(1)}k`
          : String(Math.round(n))

export const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / SEC))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const clockText = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / SEC))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const usd = (n: number): string => `$${n.toFixed(2)}`

const newTokens = (u: TurnUsage): number => u.input_tokens + u.cache_creation_input_tokens + u.output_tokens

/** New tokens per minute, averaged over the last two minutes. */
export const rateAt = (list: Step[], t: number): number =>
  list.filter(s => s.at > t - 2 * MIN).reduce((a, s) => a + s.n, 0) / 2

/** Per-minute sums for the last `n` minutes, oldest first. */
export const buckets = (list: Step[], t: number, n: number): number[] => {
  const out = new Array<number>(n).fill(0)
  for (const s of list) {
    const ago = Math.floor((t - s.at) / MIN)
    if (ago >= 0 && ago < n) out[n - 1 - ago] = (out[n - 1 - ago] ?? 0) + s.n
  }
  return out
}

const SPARK = '▁▂▃▄▅▆▇█'
export const spark = (values: number[]): string => {
  const max = Math.max(1, ...values)
  return values.map(v => SPARK[Math.min(7, Math.round((v / max) * 7))]).join('')
}

/** Which of `cells` equal slices of the last `span` ms hold at least one of `times`. */
export const marks = (times: number[], t: number, cells: number, span: number): boolean[] => {
  const out = new Array<boolean>(cells).fill(false)
  for (const x of times) {
    const ago = t - x
    if (ago < 0 || ago >= span) continue
    out[cells - 1 - Math.floor((ago / span) * cells)] = true
  }
  return out
}

const advisorShare = (waitedMs: number, sinceMs: number): string => {
  if (sinceMs <= 0 || waitedMs <= 0) return ''
  const p = (100 * waitedMs) / sinceMs
  return `≈ ${p < 1 ? '<1' : Math.min(100, Math.round(p))}% of session`
}

const findLimit = (l: Limits, kind: string): Limit | undefined => l.rateLimits.find(r => r.kind === kind)
const resetIn = (l: Limit | undefined, t: number): number | null =>
  l?.resetsAt ? Date.parse(l.resetsAt) - t : null

/** When a window reaches 100% at the pace of the last half hour; null when it isn't climbing. */
export const etaFull = (samples: Sample[] | undefined, p: number, t: number): number | null => {
  const s0 = (samples ?? []).find(s => s.t > t - 30 * MIN)
  if (!s0 || t - s0.t < 3 * MIN || p <= s0.p) return null
  return (100 - p) / ((p - s0.p) / (t - s0.t))
}

const limitName = (kind: string): string => (kind === 'five_hour' ? '5h' : 'Week')

/** The one thing worth saying on the band right now, if anything. */
export function alertFor(
  l: Limits,
  hist: Record<string, Sample[]>,
  w: Warm | null,
  ttl: Ttl,
  t: number,
  working: boolean,
): { level: Level; text: string } | null {
  const tracked = ['five_hour', 'seven_day']
    .map(k => findLimit(l, k))
    .filter((x): x is Limit => x !== undefined)
    .sort((a, b) => b.percentUsed - a.percentUsed)
  const ctx = l.context?.percent

  for (const lim of tracked) {
    if (level(lim.percentUsed) !== 'bad') continue
    const eta = etaFull(hist[lim.kind], lim.percentUsed, t)
    const reset = resetIn(lim, t)
    if (eta !== null && (reset === null || eta < reset))
      return { level: 'bad', text: `${limitName(lim.kind)} limit runs out in ~${fmtDur(eta)} at this rate` }
    return {
      level: 'bad',
      text: `${limitName(lim.kind)} limit ${Math.round(lim.percentUsed)}%${reset !== null ? ` — resets in ${fmtDur(reset)}` : ''}`,
    }
  }
  if (level(ctx) === 'bad') return { level: 'bad', text: 'Context almost full — run /compact' }
  if (level(ctx) === 'warn') return { level: 'warn', text: 'Context filling up — run /compact' }
  for (const lim of tracked) {
    if (level(lim.percentUsed) !== 'warn') continue
    const reset = resetIn(lim, t)
    return {
      level: 'warn',
      text: `${limitName(lim.kind)} limit ${Math.round(lim.percentUsed)}%${reset !== null ? ` — resets in ${fmtDur(reset)}` : ''}`,
    }
  }
  if (!working && w !== null) {
    const left = w.at + TTL_MS[ttl] - t
    const warnAt = ttl === '1h' ? 5 * MIN : MIN
    if (left > 0 && left <= warnAt)
      return { level: 'warn', text: `Cache expires in ${fmtDur(left)} — reply now to keep it cheap` }
  }
  return null
}

// ---------- state ----------

async function refreshUsage($: EngineInterface) {
  try {
    const u = await $.session.usage()
    await noteLimits($, u.context, u.rateLimits, u.cost?.usd)
  } catch {
    // figures are a nicety; keep the last ones
  }
}

async function noteLimits($: EngineInterface, context: Ctx | undefined, rateLimits: Limit[], cost: number | undefined) {
  const t = await $.clock.now()
  await update($, limits, prev => ({
    context: context ? { tokens: context.tokens, window: context.window, percent: context.percent } : prev.context,
    rateLimits: rateLimits.length ? rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })) : prev.rateLimits,
    usd: typeof cost === 'number' ? cost : prev.usd,
  }))
  if (rateLimits.length)
    await update($, history, h => {
      const out: Record<string, Sample[]> = {}
      for (const r of rateLimits) {
        const kept = (h[r.kind] ?? []).filter(s => s.t > t - 30 * MIN && s.p <= r.percentUsed)
        out[r.kind] = [...kept, { t, p: r.percentUsed }].slice(-60)
      }
      return out
    })
}

async function noteStep($: EngineInterface, at: number, u: TurnUsage) {
  const n = newTokens(u)
  await update($, steps, list => [...list.filter(s => s.at > at - KEEP), { at, n }])
  await update($, totals, x => ({
    sent: x.sent + u.input_tokens + u.cache_creation_input_tokens,
    wrote: x.wrote + u.output_tokens,
    reread: x.reread + u.cache_read_input_tokens,
  }))
  await update($, turn, x => (x === null || x.endedAt !== null ? x : { ...x, tokens: x.tokens + n }))
}

/**
 * The API runs the advisor inside the request, so a step's result is where it shows up.
 * Counted once per call id, stamped with when the step arrived, not when the advisor ended.
 */
async function noteAdvisor(
  $: EngineInterface,
  started: number,
  arrived: number,
  uses: readonly TurnStepServerToolUse[] | undefined,
) {
  const prev = await read($, advisor)
  const known = new Set(prev.calls.map(c => c.id))
  const fresh = (uses ?? []).filter(u => u.name === 'advisor' && !known.has(u.id))
  if (fresh.length === 0 && prev.firstAt !== null) return
  await update($, advisor, a => {
    const seen = new Set(a.calls.map(c => c.id))
    const add = fresh.filter(u => !seen.has(u.id))
    return {
      firstAt: a.firstAt ?? started,
      count: a.count + add.length,
      calls: [
        ...a.calls,
        ...add.map((u, i) => ({
          id: u.id,
          n: a.count + i + 1,
          at: arrived,
          ms: u.endedAt === undefined ? null : Math.max(0, u.endedAt - u.startedAt),
        })),
      ].slice(-ADVISOR_KEEP),
    }
  })
}

// A main-thread request refreshes the cache and starts its TTL over.
async function noteMain($: EngineInterface, sentAt: number, u: TurnUsage) {
  const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  if (prompt === 0) return
  const prev = await read($, warm)
  // Learn the TTL from a request after a gap only a 1h cache survives.
  if (prev !== null && prev.model === u.model && prev.tokens > 2000) {
    const gap = sentAt - prev.at
    if (gap > 6 * MIN && gap < 55 * MIN) {
      const served = u.cache_read_input_tokens / prev.tokens
      if (served >= 0.5) await update($, ttlAtom, () => '1h')
      else if (served < 0.1) await update($, ttlAtom, () => '5m')
    }
  }
  await update($, warm, () => ({
    at: sentAt,
    tokens: prompt + u.output_tokens,
    hitPct: Math.round((100 * u.cache_read_input_tokens) / prompt),
    model: u.model,
  }))
}

async function resetAll($: EngineInterface) {
  await update($, steps, () => [])
  await update($, totals, () => ZERO)
  await update($, turn, () => null)
  await update($, warm, () => null)
  await update($, advisor, () => NO_ADVISOR)
}

// ---------- settings ----------

const FIELD_PREFIX = 'status-band.'
const ON_WORDS = ['on', 'true', 'yes', '1', 'show']
const OFF_WORDS = ['off', 'false', 'no', '0', 'hide']

const fmtValue = (v: ConfigValue): string => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v))

/** What a `/band set` argument means for a row of this kind; undefined when it doesn't fit. */
export const parseValue = (kind: ConfigKind, text: string, choices?: readonly string[]): ConfigValue | undefined => {
  const x = text.trim().toLowerCase()
  if (kind === 'boolean') return ON_WORDS.includes(x) ? true : OFF_WORDS.includes(x) ? false : undefined
  if (kind === 'number') return x !== '' && Number.isFinite(Number(x)) ? Number(x) : undefined
  if (kind === 'choice') return choices?.find(c => c.toLowerCase() === x)
  return text.trim()
}

/** `/band settings` lists this mod's options; `/band set <option> <value>` changes one. Returns the reply text. */
export async function settingsCommand($: EngineInterface, sub: 'settings' | 'set', rest: string[]): Promise<string> {
  const rows = (await $.config.list()).filter(r => r.key.startsWith(FIELD_PREFIX))
  const nameOf = (key: string) => key.slice(FIELD_PREFIX.length)
  if (sub === 'settings') {
    const lines = rows.map(r => `  ${nameOf(r.key)}: ${fmtValue(r.value)}  (${r.label})`)
    return [`Status band settings. Change one with /${COMMAND} set <option> <value>`, ...lines].join('\n')
  }
  const [name = '', ...words] = rest
  const valueText = words.join(' ')
  if (name === '' || valueText === '') return `Usage: /${COMMAND} set <option> <value>. List the options with /${COMMAND} settings`
  const row = rows.find(r => nameOf(r.key).toLowerCase() === name.toLowerCase())
  if (!row) return `No setting called "${name}". List them with /${COMMAND} settings`
  const value = parseValue(row.kind, valueText, row.options)
  if (value === undefined) {
    const fits = row.kind === 'boolean' ? 'on or off' : row.kind === 'number' ? 'a number' : (row.options ?? []).join(', ')
    return `"${valueText}" doesn't fit ${nameOf(row.key)}; it takes ${fits}.`
  }
  const result = await $.config.set({ key: row.key, value })
  const denied = (result as { deny?: string }).deny
  return denied ? `Not changed: ${denied}` : `${nameOf(row.key)} is now ${fmtValue(value)}.`
}

// ---------- the band ----------

export const register: Register = (on, options) => {
  // Every field is on unless its option says off; the module reloads when one changes.
  const o = options ?? {}
  const flag = (k: string): boolean => o[k] !== false
  const opt = {
    context: flag('showContext'),
    fiveHour: flag('show5h'),
    week: flag('showWeek'),
    advisor: flag('showAdvisor'),
    cache: flag('showCache'),
    cost: flag('showCost'),
    rate: flag('showRate'),
    alerts: flag('showAlerts'),
    detNow: flag('detailsNow'),
    detLimits: flag('detailsLimits'),
    detCache: flag('detailsCache'),
    detSession: flag('detailsSession'),
  }
  const flashRaw = Number(o.advisorFlashSeconds)
  // 0 turns the "Advisor consulted" note off; anything unusable falls back to the default.
  const flashMs = (Number.isFinite(flashRaw) && flashRaw >= 0 ? flashRaw : ADVISOR_FLASH_SECONDS) * SEC

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Status band: open or close details; settings, set, hide, show',
      argumentHint: 'settings | set <option> <value> | hide | show',
    })
    await update($, now, () => 0)
    $.clock.every(SEC, async () => {
      if (await read($, hidden)) return
      const t = await $.clock.now()
      await update($, now, () => t)
    })
    const result = await next(e)
    await refreshUsage($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    await noteLimits($, e.context, e.rateLimits, e.cost?.usd)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const text = String((e as { text?: unknown }).text ?? '')
    if (!text.startsWith(`/${COMMAND}`)) {
      const startedAt = await $.clock.now()
      const l = await read($, limits)
      await update($, turn, () => ({ startedAt, endedAt: null, tokens: 0, usdAtStart: l.usd }))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const at = await $.clock.now()
    const result = yield* next(e)
    if (result.usage !== null) {
      await noteStep($, at, result.usage)
      if (e.agentId === undefined) await noteMain($, at, result.usage)
    }
    await noteAdvisor($, at, await $.clock.now(), result.serverToolUses)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const t = await $.clock.now()
      await update($, turn, x => (x === null ? x : { ...x, endedAt: t }))
      await refreshUsage($)
    }
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await resetAll($)
    else if (e.source === 'compact') await update($, warm, () => null)
    else if (e.seconds_since_last_response !== undefined && e.context_tokens) {
      const at = (await $.clock.now()) - e.seconds_since_last_response * SEC
      await update($, warm, () => ({ at, tokens: e.context_tokens ?? 0, hitPct: null, model: e.model ?? '' }))
    }
    return next(e)
  })

  on('classic.PostCompact', async ($, e, next) => {
    await update($, warm, () => null)
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, ttlAtom, () => e.cache_ttl)
    await update($, warm, () => null)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = sub.toLowerCase()
    if (arg === 'settings' || arg === 'set') return { text: await settingsCommand($, arg, rest) }
    if (arg === 'hide') {
      await update($, hidden, () => true)
      return { text: `Status band hidden. Bring it back with /${COMMAND} show` }
    }
    if (arg === 'show') {
      await update($, hidden, () => false)
      return { text: 'Status band shown.' }
    }
    await update($, open, v => !v)
    const isOpen = await read($, open)
    return { text: isOpen ? 'Details open.' : 'Details closed.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hidden))) return next(e)
    const below = await next(e)

    const kit = $.ui.resolve(e)
    const { Box, Text, Button } = kit
    const Svg = 'Svg' in kit ? kit.Svg : undefined
    const desktop = e.surface === 'desktop'
    const cols = Math.max(40, e.props.bodyColumns)
    const narrow = !desktop && cols < 80

    const t = Math.max(await read($, now), await $.clock.now())
    const l = await read($, limits)
    const list = await read($, steps)
    const tot = await read($, totals)
    const tr = await read($, turn)
    const w = await read($, warm)
    const ttl = await read($, ttlAtom)
    const hist = await read($, history)
    const adv = await read($, advisor)
    const isOpen = await read($, open)
    const working = e.props.isWorking

    const five = findLimit(l, 'five_hour')
    const week = findLimit(l, 'seven_day')
    const ctxPct = l.context?.percent
    const rate = rateAt(list, t)
    const alert = opt.alerts ? alertFor(l, hist, w, ttl, t, working) : null
    const cacheLeft = w === null ? null : w.at + TTL_MS[ttl] - t

    const pct = (p: number | undefined) => (p === undefined ? '–' : `${Math.round(p)}%`)
    const gauge = (key: string, label: string, short: string, p: number | undefined) => (
      <Text key={key} wrap="truncate">
        <Text color={C[level(p)]}>● </Text>
        <Text dimColor>{(narrow ? short : label) + ' '}</Text>
        <Text bold>{pct(p)}</Text>
      </Text>
    )
    const sep = (key: string) => (
      <Text key={key} dimColor>
        {' │ '}
      </Text>
    )

    const lastAdv = adv.calls[adv.calls.length - 1]
    const advFresh = opt.advisor && lastAdv !== undefined && t - lastAdv.at < flashMs ? lastAdv : undefined

    let right
    if (alert) {
      right = (
        <Text color={C[alert.level]} bold wrap="truncate">
          {(alert.level === 'bad' ? '▲ ' : '△ ') + alert.text}
        </Text>
      )
    } else if (advFresh) {
      // After the fact: the call is known once its step comes back, not while the advisor runs.
      right = (
        <Text wrap="truncate">
          <Text color={C.pro} bold>
            {'✦ Advisor consulted'}
          </Text>
          <Text dimColor>
            {` · #${advFresh.n}${advFresh.ms !== null ? ` · ${fmtDur(advFresh.ms)}` : ''}${e.surface === 'terminal' && !narrow ? ' · Ctrl+O to read' : ''}`}
          </Text>
        </Text>
      )
    } else if (working && opt.rate) {
      // With the rate off, a working band falls through to the cache countdown.
      right = (
        <Text wrap="truncate">
          <Text color={C.live}>● </Text>
          <Text bold>{fmtTok(rate)}</Text>
          <Text dimColor>{narrow ? '/min ' : ' new tok/min '}</Text>
          <Text color={C.live}>{spark(buckets(list, t, 8))}</Text>
          {tr && tr.endedAt === null ? <Text dimColor>{`  ⏱ ${fmtDur(t - tr.startedAt)}`}</Text> : null}
        </Text>
      )
    } else if (opt.cache && w !== null && cacheLeft !== null) {
      right = (
        <Text wrap="truncate">
          <Text color={cacheLeft > 0 ? C.ok : undefined} dimColor={cacheLeft <= 0}>
            {cacheLeft > 0 ? '◆ ' : '◇ '}
          </Text>
          <Text dimColor>{cacheLeft > 0 ? 'Cache warm ' : 'Cache cold · next step re-sends '}</Text>
          <Text bold>{cacheLeft > 0 ? clockText(cacheLeft) : fmtTok(w.tokens)}</Text>
          {opt.cost && l.usd !== null && !narrow ? <Text dimColor>{`  ·  ≈ ${usd(l.usd)}`}</Text> : null}
        </Text>
      )
    } else if (opt.cost && l.usd !== null) {
      right = <Text dimColor>{`Session ≈ ${usd(l.usd)}`}</Text>
    }

    // Only the visible items, with a separator between neighbours and never at an end.
    const left: unknown[] = []
    const add = (node: unknown) => {
      if (left.length) left.push(sep(`s${left.length}`))
      left.push(node)
    }
    if (opt.context) add(gauge('g-ctx', 'Context', 'Ctx', ctxPct))
    if (opt.fiveHour) add(gauge('g-5h', '5h', '5h', five?.percentUsed))
    if (opt.week) add(gauge('g-wk', 'Week', 'Wk', week?.percentUsed))
    if (opt.advisor && adv.count > 0)
      add(
        <Text key="g-adv" wrap="truncate">
          <Text color={C.pro}>✦ </Text>
          <Text dimColor>{narrow ? '' : 'Advisor '}</Text>
          <Text bold>{String(adv.count)}</Text>
        </Text>,
      )

    // Nothing left to say on the band itself: draw no row (the details can still open).
    const band =
      left.length === 0 && right === undefined ? null : (
        <Box key="sb-band" flexDirection="row" alignItems="center">
          {left as never}
          <Box flexGrow={1} minWidth={2} />
          {right ?? null}
          <Text> </Text>
          <Button
            key="sb-toggle"
            label={isOpen ? '▴' : '▾'}
            plain
            dimColor
            onPress={() => update($, open, v => !v)}
          />
        </Box>
      )

    if (!isOpen) {
      if (band === null) return below
      return (
        <Box flexDirection="column">
          {below}
          {band}
        </Box>
      )
    }

    // ---------- details ----------

    const labelW = desktop ? '18%' : 16
    const rightW = desktop ? '30%' : Math.min(30, Math.max(20, Math.floor(cols * 0.28)))
    const barCols = Math.max(10, cols - 16 - (typeof rightW === 'number' ? rightW : 0) - 4)

    const bar = (key: string, p: number | undefined, color: string) => {
      const f = Math.max(0, Math.min(100, p ?? 0)) / 100
      if (desktop && Svg) {
        const W = 220
        const fill = Math.max(f > 0 ? 4 : 0, Math.round(W * f))
        return (
          <Svg
            key={key}
            source={`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="8" viewBox="0 0 ${W} 8"><rect width="${W}" height="8" rx="4" fill="${C.track}"/><rect width="${fill}" height="8" rx="4" fill="${color}"/></svg>`}
            alt={`${Math.round(f * 100)}%`}
            width={W}
            height={8}
          />
        )
      }
      const filled = Math.round(barCols * f)
      return (
        <Text key={key}>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(barCols - filled)}</Text>
        </Text>
      )
    }

    const row = (key: string, label: string, middle: unknown, side: string) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        <Box width={labelW} flexShrink={0}>
          <Text wrap="truncate">{label}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {typeof middle === 'string' ? <Text dimColor wrap="truncate">{middle}</Text> : (middle as never)}
        </Box>
        <Box width={rightW} flexShrink={0} justifyContent="flex-end">
          <Text dimColor wrap="truncate">{side}</Text>
        </Box>
      </Box>
    )
    const section = (key: string, title: string) => (
      <Box key={key} marginTop={1}>
        <Text dimColor bold>{title}</Text>
      </Box>
    )

    const rows = []

    if (opt.detNow && (tr !== null || list.length)) {
      const b15 = buckets(list, t, 15)
      const peak = Math.max(0, ...b15)
      const sparkW = desktop ? 30 : Math.max(15, Math.min(60, barCols))
      const per = Math.max(1, Math.floor(sparkW / 15))
      const wide = spark(b15).split('').map(ch => ch.repeat(per)).join('')
      rows.push(section('h-now', 'Right now'))
      rows.push(
        row(
          'r-rate',
          'Live rate',
          <Text>
            <Text bold>{fmtTok(rate)}</Text>
            <Text dimColor> new tokens / min</Text>
          </Text>,
          `peak ${fmtTok(peak)}/min`,
        ),
      )
      rows.push(
        row(
          'r-spark',
          'Last 15 min',
          <Text color={C.live}>{wide}</Text>,
          tr === null ? '' : tr.endedAt === null ? `running ${fmtDur(t - tr.startedAt)}` : `finished ${fmtDur(t - tr.endedAt)} ago`,
        ),
      )
      if (tr !== null) {
        const spent = tr.usdAtStart !== null && l.usd !== null ? l.usd - tr.usdAtStart : null
        rows.push(
          row(
            'r-turn',
            'This turn',
            <Text>
              <Text bold>{fmtTok(tr.tokens)}</Text>
              <Text dimColor> new tokens</Text>
            </Text>,
            opt.cost && spent !== null && spent > 0 ? `≈ ${usd(spent)}` : '',
          ),
        )
      }
    }

    if (opt.detLimits) {
      rows.push(section('h-lim', 'Limits'))
      rows.push(
        row(
          'r-ctx',
          'Context',
          bar('b-ctx', ctxPct, C[level(ctxPct)]),
          l.context ? `${l.context.tokens !== undefined ? fmtTok(l.context.tokens) : '–'} / ${fmtTok(l.context.window)}` : 'no reading yet',
        ),
      )
      for (const [k, label, lim] of [
        ['five', '5-hour', five],
        ['week', 'Weekly', week],
      ] as const) {
        const reset = resetIn(lim, t)
        rows.push(
          row(
            `r-${k}`,
            label,
            bar(`b-${k}`, lim?.percentUsed, C[level(lim?.percentUsed)]),
            lim === undefined ? 'no reading yet' : reset !== null ? `resets in ${fmtDur(reset)}` : `${Math.round(lim.percentUsed)}% used`,
          ),
        )
      }
    }

    if (opt.detCache) {
      rows.push(section('h-cache', 'Cache'))
      if (w === null || cacheLeft === null) {
        rows.push(row('r-cache', 'Status', 'Not warm yet — fills on the next step', `TTL ${ttl}`))
      } else {
        const isWarm = cacheLeft > 0
        rows.push(
          row(
            'r-cache',
            'Status',
            <Text wrap="truncate">
              <Text color={isWarm ? C.ok : undefined} bold>{isWarm ? 'Warm' : 'Cold'}</Text>
              <Text dimColor>
                {` · ${fmtTok(w.tokens)} ${isWarm ? 'kept' : 'to re-send'}${w.hitPct !== null ? ` · ${w.hitPct}% hit` : ''}`}
              </Text>
            </Text>,
            `TTL ${ttl}`,
          ),
        )
        const leftPct = (100 * Math.max(0, cacheLeft)) / TTL_MS[ttl]
        const leftLevel: Level = !isWarm || cacheLeft <= (ttl === '1h' ? 5 * MIN : MIN) ? 'warn' : 'ok'
        rows.push(
          row(
            'r-left',
            'Time left',
            bar('b-left', leftPct, C[leftLevel]),
            isWarm ? `${fmtDur(cacheLeft)} · resets each step` : `cold for ${fmtDur(-cacheLeft)}`,
          ),
        )
        rows.push(
          row(
            'r-expire',
            isWarm ? 'If it expires' : 'Next step',
            `Re-sends ${fmtTok(w.tokens)} at full price`,
            `~${Math.round(WRITE_WEIGHT[ttl] / 0.1)}× a cached read`,
          ),
        )
      }
    }

    if (opt.detSession) {
      rows.push(section('h-sess', 'This session'))
      rows.push(
        row(
          'r-new',
          'New tokens',
          <Text wrap="truncate">
            <Text bold>{fmtTok(tot.sent)}</Text>
            <Text dimColor> you sent + </Text>
            <Text bold>{fmtTok(tot.wrote)}</Text>
            <Text dimColor> Claude wrote</Text>
          </Text>,
          'real work',
        ),
      )
      rows.push(row('r-reread', 'Re-reads', `${fmtTok(tot.reread)} · conversation re-sent each step`, 'cheap, from cache'))
      if (opt.cost && l.usd !== null) {
        // Share of cost from re-reads, by relative price per token.
        const weight = tot.sent + 0.1 * tot.reread + 5 * tot.wrote
        const share = weight > 0 ? (0.1 * tot.reread) / weight : 0
        rows.push(
          row(
            'r-cost',
            'Cost',
            <Text>
              <Text dimColor>≈ </Text>
              <Text bold>{usd(l.usd)}</Text>
              <Text dimColor> total</Text>
            </Text>,
            share > 0.05 ? `re-reads ≈ ${usd(l.usd * share)}` : '',
          ),
        )
      }
    }

    if (opt.advisor && adv.count > 0 && lastAdv !== undefined) {
      const timed = adv.calls.filter(c => c.ms !== null).map(c => c.ms as number)
      const waited = timed.reduce((a, b) => a + b, 0)
      const W = desktop ? 30 : Math.max(15, Math.min(40, barCols))
      const hit = marks(adv.calls.map(c => c.at), t, W, ADVISOR_SPAN)
      rows.push(section('h-adv', 'Advisor'))
      rows.push(
        row(
          'r-adv-calls',
          'Calls',
          <Text wrap="truncate">
            <Text bold color={C.pro}>
              {String(adv.count)}
            </Text>
            <Text dimColor>{` this session · last ${fmtDur(t - lastAdv.at)} ago`}</Text>
          </Text>,
          timed.length ? `avg ${fmtDur(waited / timed.length)}` : '',
        ),
      )
      if (timed.length)
        rows.push(
          row(
            'r-adv-time',
            'Time waiting',
            <Text wrap="truncate">
              <Text bold>{fmtDur(waited)}</Text>
              <Text dimColor> total in the advisor</Text>
            </Text>,
            adv.firstAt === null ? '' : advisorShare(waited, t - adv.firstAt),
          ),
        )
      rows.push(
        row(
          'r-adv-track',
          'Last 60 min',
          <Text>
            {hit.map((called, i) =>
              called ? (
                <Text key={i} color={C.pro}>
                  ✦
                </Text>
              ) : (
                <Text key={i} dimColor>
                  ▁
                </Text>
              ),
            )}
          </Text>,
          `first ${fmtDur(t - (adv.calls[0]?.at ?? t))} ago`,
        ),
      )
      adv.calls
        .slice(-3)
        .reverse()
        .forEach((c, i) =>
          rows.push(
            row(
              `r-adv-${c.id}`,
              `#${c.n}`,
              `${fmtDur(t - c.at)} ago${c.ms !== null ? ` · ran ${fmtDur(c.ms)}` : ''}`,
              i === 0 && e.surface === 'terminal' ? 'Ctrl+O to read' : '',
            ),
          ),
        )
      rows.push(
        <Box key="r-adv-note">
          <Text dimColor>
            {opt.cost
              ? "The advisor's cost is in the ≈ $ total; its tokens aren't broken out."
              : "The advisor's tokens aren't broken out."}
          </Text>
        </Box>,
      )
    }

    // Every section switched off: no empty box.
    if (rows.length === 0) {
      if (band === null) return below
      return (
        <Box flexDirection="column">
          {below}
          {band}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {below}
        {band}
        <Box
          key="sb-detail"
          flexDirection="column"
          borderStyle="round"
          borderDimColor
          paddingX={1}
        >
          {rows}
        </Box>
      </Box>
    )
  })
}
