import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { settingsCommand } from './register'

const MIN = 60_000
const band = (isWorking = false) =>
  ({
    plugin: 'status-band',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking,
      maxRows: 30,
      bodyColumns: 140,
      scroll: { offset: 0, bodyRows: 29 },
      view: {},
    },
  }) as const

const USAGE = {
  model: 'claude-opus-5-5',
  input_tokens: 2_000,
  output_tokens: 1_000,
  cache_read_input_tokens: 180_000,
  cache_creation_input_tokens: 3_000,
}

const advisorUse = (id: string, startedAt = 0, endedAt: number | undefined = startedAt + 6_000) => ({
  id,
  name: 'advisor',
  input: {},
  startedAt,
  ...(endedAt === undefined ? {} : { endedAt }),
})

const engine = (on: On, serverToolUses?: readonly ReturnType<typeof advisorUse>[]) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      ...(serverToolUses ? { serverToolUses } : {}),
      stopReason: 'end_turn' as const,
      usage: USAGE,
    }
  })
}

const measure = (context: number, five: number, week: number, usd = 1.5) => ({
  context: { tokens: context * 10_000, window: 1_000_000, percent: context },
  rateLimits: [
    { kind: 'five_hour', percentUsed: five, resetsAt: new Date(4 * 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: week, resetsAt: new Date(3 * 86_400_000).toISOString() },
  ],
  cost: { usd },
  changed: ['context' as const, 'rateLimits' as const, 'cost' as const],
})

const step = async ($: any, agentId?: string) => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, ...(agentId ? { agentId } : {}) }));
}

test('idle band: three gauges and the cache countdown', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(21, 37, 42))
  await step($)
  await clock.advance(10 * MIN)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(), surface })
    expect(await ui.find({ text: /Context/ })).toBeDefined()
    expect(await ui.find({ text: /^21%$/ })).toBeDefined()
    expect(await ui.find({ text: /^37%$/ })).toBeDefined()
    expect(await ui.find({ text: /^50:00$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('working band shows the live new-token rate', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($)
  await step($, 'sub1')
  const ui = await $.ui.mount({ ...band(true), surface: 'terminal' })
  // two steps of 6k new tokens over a two-minute window
  expect(await ui.find({ text: /^6\.0k$/ })).toBeDefined()
  expect(await ui.find({ text: /new tok\/min/ })).toBeDefined()
  await ui.unmount()
})

test('only the problem speaks: context warning, then a red limit', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(84, 37, 42))
  let ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /Context filling up — run \/compact/ })).toBeDefined()
  await ui.unmount()

  await $.session.measure(measure(30, 96, 58))
  ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /5h limit 96% — resets in 4h 0m/ })).toBeDefined()
  await ui.unmount()
})

test('the cache warns in its last five minutes and then goes cold', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($)
  await clock.advance(57 * MIN)
  let ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /Cache expires in 3m — reply now/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(5 * MIN)
  ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /Cache cold · next step re-sends/ })).toBeDefined()
  expect(await ui.find({ text: /^186k$/ })).toBeDefined()
  await ui.unmount()
})

test('the toggle opens plain details: new tokens apart from re-reads', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(21, 37, 42))
  await step($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(), surface })
    expect(await ui.find({ text: /^New tokens$/ })).toBeUndefined()
    await ui.press({ key: 'sb-toggle' })
    await ui.unmount()
    const opened = await $.ui.mount({ ...band(), surface })
    expect(await opened.find({ text: /^New tokens$/ })).toBeDefined()
    expect(await opened.find({ text: /^5\.0k$/ })).toBeDefined()
    expect(await opened.find({ text: /180k · conversation re-sent each step/ })).toBeDefined()
    expect(await opened.find({ text: /resets in 4h 0m/ })).toBeDefined()
    await opened.press({ key: 'sb-toggle' })
    await opened.unmount()
  }
})

test('no advisor chip until the advisor has been called', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /Advisor/ })).toBeUndefined()
  await ui.unmount()
})

test('the advisor chip counts each call once, even when its step is seen twice', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on, [advisorUse('srv_1'), advisorUse('srv_2')])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($)
  await step($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(), surface })
    expect(await ui.find({ text: /^Advisor $/ })).toBeDefined()
    expect(await ui.find({ text: /^2$/ })).toBeDefined()
    expect(await ui.find({ text: /^4$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a server tool that is not the advisor is ignored', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on, [{ ...advisorUse('srv_1'), name: 'web_search' }])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /Advisor/ })).toBeUndefined()
  await ui.unmount()
})

test('"Advisor consulted" speaks for a few seconds, even while working, then steps aside', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on, [advisorUse('srv_1')])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($)
  let ui = await $.ui.mount({ ...band(true), surface: 'terminal' })
  expect(await ui.find({ text: /Advisor consulted/ })).toBeDefined()
  expect(await ui.find({ text: /#1 · 6s · Ctrl\+O to read/ })).toBeDefined()
  expect(await ui.find({ text: /new tok\/min/ })).toBeUndefined()
  await ui.unmount()

  await clock.advance(20_000)
  ui = await $.ui.mount({ ...band(true), surface: 'terminal' })
  expect(await ui.find({ text: /Advisor consulted/ })).toBeUndefined()
  expect(await ui.find({ text: /new tok\/min/ })).toBeDefined()
  await ui.unmount()
})

test('the details list the advisor calls, with the Ctrl+O hint on terminal only', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on, [advisorUse('srv_1', 0, 6_000), advisorUse('srv_2', 0, 8_000)])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(), surface })
    expect(await ui.find({ text: /^Time waiting$/ })).toBeUndefined()
    await ui.press({ key: 'sb-toggle' })
    await ui.unmount()
    const opened = await $.ui.mount({ ...band(), surface })
    expect(await opened.find({ text: /^Advisor$/ })).toBeDefined()
    expect(await opened.find({ text: /^Time waiting$/ })).toBeDefined()
    expect(await opened.find({ text: /^14s$/ })).toBeDefined()
    expect(await opened.find({ text: /avg 7s/ })).toBeDefined()
    expect(await opened.find({ text: /^#2$/ })).toBeDefined()
    expect(await opened.find({ text: /^#1$/ })).toBeDefined()
    expect(await opened.find({ text: /its tokens aren't broken out/ })).toBeDefined()
    const hint = await opened.find({ text: /Ctrl\+O to read/ })
    if (surface === 'terminal') expect(hint).toBeDefined()
    else expect(hint).toBeUndefined()
    await opened.press({ key: 'sb-toggle' })
    await opened.unmount()
  }
})

// ---------- settings ----------

const open = async ($: any, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await $.ui.mount({ ...band(), surface })
  await ui.press({ key: 'sb-toggle' })
  await ui.unmount()
  return $.ui.mount({ ...band(), surface })
}

test('hiding gauges leaves no stray separator', { options: { showContext: false, show5h: false } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(21, 37, 42))
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /Context/ })).toBeUndefined()
  expect(await ui.find({ text: /^5h$|^5h /, })).toBeUndefined()
  expect(await ui.find({ text: /^42%$/ })).toBeDefined()
  expect(await ui.find({ text: /│/ })).toBeUndefined()
  await ui.unmount()
})

test('showAdvisor off hides the chip, the note and the details section', { options: { showAdvisor: false } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on, [advisorUse('srv_1')])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($)
  let ui = await $.ui.mount({ ...band(true), surface: 'terminal' })
  expect(await ui.find({ text: /Advisor/ })).toBeUndefined()
  expect(await ui.find({ text: /new tok\/min/ })).toBeDefined()
  await ui.unmount()
  ui = await open($)
  expect(await ui.find({ text: /^Advisor$/ })).toBeUndefined()
  expect(await ui.find({ text: /^Time waiting$/ })).toBeUndefined()
  await ui.unmount()
})

test('advisorFlashSeconds 0 turns the note off but keeps the chip', { options: { advisorFlashSeconds: 0 } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on, [advisorUse('srv_1')])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($)
  const ui = await $.ui.mount({ ...band(true), surface: 'terminal' })
  expect(await ui.find({ text: /Advisor consulted/ })).toBeUndefined()
  expect(await ui.find({ text: /^Advisor $/ })).toBeDefined()
  await ui.unmount()
})

test('showCost off removes every dollar figure', { options: { showCost: false } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(21, 37, 42, 1.5))
  await step($)
  let ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /Cache warm/ })).toBeDefined()
  expect(await ui.find({ text: /≈/ })).toBeUndefined()
  await ui.unmount()
  ui = await open($)
  expect(await ui.find({ text: /^Cost$/ })).toBeUndefined()
  expect(await ui.find({ text: /≈/ })).toBeUndefined()
  await ui.unmount()
})

test('showRate off: a working band shows the cache countdown instead', { options: { showRate: false } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($)
  const ui = await $.ui.mount({ ...band(true), surface: 'terminal' })
  expect(await ui.find({ text: /new tok\/min/ })).toBeUndefined()
  expect(await ui.find({ text: /Cache warm/ })).toBeDefined()
  await ui.unmount()
})

test('showCache off: no countdown on the band', { options: { showCache: false } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /Cache warm/ })).toBeUndefined()
  await ui.unmount()
})

test('showAlerts off: a full context stays quiet', { options: { showAlerts: false } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(84, 37, 42))
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /Context filling up/ })).toBeUndefined()
  expect(await ui.find({ text: /^84%$/ })).toBeDefined()
  await ui.unmount()
})

test(
  'every details section off draws no box, and the sections turn off one by one',
  { options: { detailsNow: false, detailsLimits: false, detailsCache: false, detailsSession: false, showAdvisor: false } },
  async ($, on) => {
    mock.clock(on, { now: 0 })
    mock.store(on)
    engine(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.session.measure(measure(21, 37, 42))
    await step($)
    const ui = await open($)
    for (const label of ['Limits', 'Cache', 'This session', 'Right now', 'Advisor'])
      expect(await ui.find({ text: new RegExp(`^${label}$`) })).toBeUndefined()
    expect(await ui.find({ text: /^Status$/ })).toBeUndefined()
    expect(await ui.find({ text: /Context/ })).toBeDefined()
    await ui.unmount()
  },
)

test('one details section off leaves the others', { options: { detailsCache: false } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure(measure(21, 37, 42))
  await step($)
  const ui = await open($)
  expect(await ui.find({ text: /^Cache$/ })).toBeUndefined()
  expect(await ui.find({ text: /^Limits$/ })).toBeDefined()
  expect(await ui.find({ text: /^This session$/ })).toBeDefined()
  await ui.unmount()
})

test('everything off on the band: no row at all, and no crash', {
  options: { showContext: false, show5h: false, showWeek: false, showCache: false, showCost: false, showRate: false, showAdvisor: false },
}, async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /Context|Cache|Week|5h/ })).toBeUndefined()
  await ui.unmount()
})

const rows = [
  { key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', options: ['dark', 'light'], provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
  { key: 'status-band.showCost', label: 'Cost', kind: 'boolean', value: true, provider: { plugin: 'status-band', tier: 'user' }, isLocked: false },
  { key: 'status-band.advisorFlashSeconds', label: 'Advisor note seconds', kind: 'number', value: 12, provider: { plugin: 'status-band', tier: 'user' }, isLocked: false },
]

// The engine won't run a command from inside a command hook and the test kit has no `$.config`,
// so the reply logic is called directly with a stand-in for the two calls it makes.
test('/band settings lists the options and /band set changes one', async () => {
  const written: unknown[] = []
  const stub = {
    config: {
      list: async () => rows,
      set: async (a: { key: string; value: unknown }) => {
        written.push([a.key, a.value])
        return { value: a.value }
      },
    },
  }
  const run = (args: string) => {
    const [sub = '', ...rest] = args.split(/\s+/)
    return settingsCommand(stub as never, sub as 'settings' | 'set', rest)
  }

  const listed = await run('settings')
  expect(listed).toMatch(/showCost: on/)
  expect(listed).toMatch(/advisorFlashSeconds: 12/)
  expect(listed).not.toMatch(/theme/)

  expect(await run('set showCost off')).toMatch(/showCost is now off/)
  expect(written).toEqual([['status-band.showCost', false]])
  expect(await run('set SHOWCOST maybe')).toMatch(/doesn't fit showCost; it takes on or off/)
  expect(await run('set advisorFlashSeconds 30')).toMatch(/advisorFlashSeconds is now 30/)
  expect(await run('set advisorFlashSeconds soon')).toMatch(/it takes a number/)
  expect(await run('set nothing on')).toMatch(/No setting called "nothing"/)
  expect(await run('set showCost')).toMatch(/Usage: \/band set/)
  expect(written.length).toBe(2)
})
