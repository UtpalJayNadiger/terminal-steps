import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fmt, paceAt, parsePhoneFile, parseSteps } from '../hooks/lib'

const HOME = '/home/t'
const PHONE = `${HOME}/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Steps`
const LOCAL = `${HOME}/.claude/steps`
const MONDAY_9AM = new Date(2026, 9, 5, 9).getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE

// What the Shortcut writes: steps, then when it ran.
const phoneFile = (steps: number, at: number) => `${steps}\n${new Date(at).toISOString()}`

// Files in memory, a held clock, and the engine calls answered quietly.
const world = (
  on: On,
  files = new Map<string, string>(),
  { store = { introduced: true } as Record<string, unknown>, now = MONDAY_9AM } = {},
) => {
  const clock = mock.clock(on, { now })
  mock.store(on, store)
  mock.env(on, { HOME })
  const toasts: string[] = []
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const config = new Map<string, unknown>()
  on('config.set', ($, e) => {
    config.set(e.key, e.value)
    return { value: e.value }
  })
  const open = new Set<string>()
  on('ui.open', ($, e) => {
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, files, toasts, open, config }
}

const steps = ($: Engine, args: string) =>
  $.command.run({
    command: 'steps',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

const send = ($: Engine, text = 'go') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const start = ($: Engine) => $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'steps-week',
  props: {
    title: 'TERMINAL STEPS',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

describe('lib', () => {
  test('reads whatever the Shortcut writes', async () => {
    expect(parsePhoneFile('6240\n2026-10-05T08:30:00-07:00')).toEqual({ steps: 6240, at: Date.parse('2026-10-05T08:30:00-07:00') })
    expect(parsePhoneFile('6,240.0')).toEqual({ steps: 6240, at: null })
    expect(parsePhoneFile('6 240\r\nnot a date')).toEqual({ steps: 6240, at: null })
    expect(parsePhoneFile('')).toBeUndefined()
    expect(parsePhoneFile('oops')).toBeUndefined()
  })

  test('parses /steps arguments', async () => {
    expect(parseSteps('')).toEqual({ kind: 'status' })
    expect(parseSteps('add 2,000')).toEqual({ kind: 'add', n: 2000 })
    expect(parseSteps('1500')).toEqual({ kind: 'add', n: 1500 })
    expect(parseSteps('goal 8000')).toEqual({ kind: 'goal', n: 8000 })
    expect(parseSteps('goal 0').kind).toBe('error')
    expect(parseSteps('rest off')).toEqual({ kind: 'unskip' })
    expect(parseSteps('Strict')).toEqual({ kind: 'strict', isOn: true })
    expect(parseSteps('dance').kind).toBe('error')
  })

  test('pace starts at zero and builds through the window', async () => {
    const p = (now: number, count = 0) => paceAt(10_000, count, 1000, 0, now, 10 * HOUR)
    expect(p(0)).toEqual({ required: 0, behind: 0, nextDueAt: HOUR })
    expect(p(HOUR)).toEqual({ required: 1000, behind: 1000, nextDueAt: 2 * HOUR })
    expect(p(5.5 * HOUR, 4200)).toEqual({ required: 5000, behind: 800, nextDueAt: 6 * HOUR })
    expect(p(11 * HOUR, 10_000)).toEqual({ required: 10_000, behind: 0, nextDueAt: null })
    expect(fmt(10_000)).toBe('10,000')
  })
})

describe('syncing', () => {
  test("today's phone file shows up in /steps", async ($, on) => {
    world(on, new Map([[`${PHONE}/2026-10-05.txt`, phoneFile(6240, MONDAY_9AM - 12 * MINUTE)]]))
    await start($)
    const ran = await steps($, '')
    expect(ran.text).toContain('6,240/10,000 steps')
    expect(ran.text).toContain('synced 12m ago')
  })

  test('no file yet says how to connect', async ($, on) => {
    world(on)
    await start($)
    expect((await steps($, 'sync')).text).toContain('/steps connect')
  })

  test('added steps sit on top of the phone count', async ($, on) => {
    const { files } = world(on, new Map([[`${PHONE}/2026-10-05.txt`, phoneFile(3000, MONDAY_9AM)]]))
    await start($)
    expect((await steps($, 'add 2000')).text).toContain('5,000/10,000 steps (+2,000 added)')
    expect(files.get(`${LOCAL}/2026-10-05.extra`)).toBe('2000\n')
    expect((await steps($, 'clear')).text).toContain('3,000/10,000')
  })

  test('the background poll picks up a new file and celebrates the goal', async ($, on) => {
    const { clock, files, toasts } = world(on, new Map([[`${PHONE}/2026-10-05.txt`, phoneFile(9000, MONDAY_9AM)]]))
    await start($)
    files.set(`${PHONE}/2026-10-05.txt`, phoneFile(10_400, MONDAY_9AM + MINUTE))
    await clock.advance(2 * MINUTE + 1000)
    expect(toasts.some(t => t.includes('Goal done'))).toBe(true)
  })

  test('/steps goal saves the setting and remembers it for the day', async ($, on) => {
    const { config, files } = world(on)
    await start($)
    expect((await steps($, 'goal 8000')).text).toContain('0/8,000 steps')
    expect(config.get('terminal-steps.goal')).toBe(8000)
    expect(files.get(`${LOCAL}/2026-10-05.goal`)).toBe('8000\n')
  })
})

describe('strict', () => {
  const STRICT = { options: { strict: true } }
  const dayStart = { date: '2026-10-05', at: MONDAY_9AM - 4 * HOUR }

  test('far behind with a fresh sync holds the prompt', STRICT, async ($, on) => {
    world(on, new Map([[`${PHONE}/2026-10-05.txt`, phoneFile(1200, MONDAY_9AM - 10 * MINUTE)]]), {
      store: { introduced: true, connected: true, dayStart },
    })
    await start($)
    const held = await send($)
    expect(held.drop).toContain('2,800 steps to catch up')
  })

  test('a stale phone never holds you', STRICT, async ($, on) => {
    world(on, new Map([[`${PHONE}/2026-10-05.txt`, phoneFile(1200, MONDAY_9AM - 3 * HOUR)]]), {
      store: { introduced: true, connected: true, dayStart },
    })
    await start($)
    expect((await send($)).drop).toBeUndefined()
  })

  test('within the grace, nothing waits', STRICT, async ($, on) => {
    world(on, new Map([[`${PHONE}/2026-10-05.txt`, phoneFile(3200, MONDAY_9AM - 5 * MINUTE)]]), {
      store: { introduced: true, connected: true, dayStart },
    })
    await start($)
    expect((await send($)).drop).toBeUndefined()
  })

  test('/steps pass lets prompts through for 20 minutes, three a day', STRICT, async ($, on) => {
    const { clock } = world(on, new Map([[`${PHONE}/2026-10-05.txt`, phoneFile(0, MONDAY_9AM - MINUTE)]]), {
      store: { introduced: true, connected: true, dayStart },
    })
    await start($)
    expect((await steps($, 'pass')).text).toContain('Pass until 09:20')
    expect((await send($)).drop).toBeUndefined()
    await clock.advance(21 * MINUTE)
    expect((await send($)).drop).toBeDefined()
    await steps($, 'pass')
    await clock.advance(21 * MINUTE)
    await steps($, 'pass')
    await clock.advance(21 * MINUTE)
    expect((await steps($, 'pass')).text).toContain('No passes left')
  })

  test('slash commands and rest days always pass', STRICT, async ($, on) => {
    world(on, new Map([[`${PHONE}/2026-10-05.txt`, phoneFile(0, MONDAY_9AM - MINUTE)]]), {
      store: { introduced: true, connected: true, dayStart },
    })
    await start($)
    expect((await send($, '/steps sync')).drop).toBeUndefined()
    await steps($, 'rest')
    expect((await send($)).drop).toBeUndefined()
  })
})

describe('drawing', () => {
  test('first run welcomes and opens the connect pane', async ($, on) => {
    const { open } = world(on, new Map(), { store: {} })
    await start($)
    const ui = await $.ui.mount({ plugin: 'terminal-steps', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /TERMINAL-STEPS/ })).toBeDefined()
    await ui.press({ key: 'connect' })
    expect(open.has('steps-connect')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /phone not connected/ })).toBeDefined()
    await ui.unmount()

    const pane = await $.ui.mount({
      plugin: 'terminal-steps',
      surface: 'terminal',
      ...PANE,
      requestId: 'steps-connect',
    })
    expect(await pane.find({ type: 'Markdown', text: /Find Health Samples/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Waiting for the first file/ })).toBeDefined()
    await pane.unmount()
  })

  test('the band shows steps and Sync re-reads the phone', async ($, on) => {
    const { files } = world(on, new Map([[`${PHONE}/2026-10-05.txt`, phoneFile(4000, MONDAY_9AM)]]))
    await start($)
    const ui = await $.ui.mount({ plugin: 'terminal-steps', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /4,000\/10,000 steps/ })).toBeDefined()
    files.set(`${PHONE}/2026-10-05.txt`, phoneFile(5500, MONDAY_9AM))
    await ui.press({ key: 'sync' })
    expect(await ui.find({ type: 'Text', text: /5,500\/10,000 steps/ })).toBeDefined()
    await ui.unmount()
  })

  test('the scoreboard counts a streak from phone files', async ($, on) => {
    world(
      on,
      new Map([
        [`${PHONE}/2026-10-03.txt`, '12000'],
        [`${PHONE}/2026-10-04.txt`, '10050'],
        [`${PHONE}/2026-10-05.txt`, phoneFile(2000, MONDAY_9AM)],
      ]),
    )
    await start($)
    await steps($, 'score')
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'terminal-steps', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: /2-day streak/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a long turn suggests a walk on the spinner', async ($, on) => {
    const { clock, toasts } = world(on)
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>{e.props.message ?? e.props.word}</Text>
    })
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(46_000)
    expect(toasts.some(t => t.includes('Take a lap'))).toBe(true)
    const spinner = {
      component: 'Spinner',
      props: { word: 'Sauteing', message: null, suffix: '…', mode: 'responding' },
    } as const
    const ui = await $.ui.mount({ plugin: 'terminal-steps', surface: 'terminal', ...spinner })
    expect(await ui.find({ type: 'Text', text: /walk 500 steps while Claude works/ })).toBeDefined()
    await ui.unmount()
  })
})
