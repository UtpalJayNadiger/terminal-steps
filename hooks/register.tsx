import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Day, Pace, Today } from '../types'
import {
  DEFAULT_DIR,
  HELP,
  SHORTCUT,
  ago,
  bar,
  buttonsWidth,
  cells,
  clockTime,
  dayKey,
  fmt,
  fullStreak,
  heatCells,
  isDone,
  lastDays,
  paceAt,
  parsePhoneFile,
  parseSteps,
  progressColor,
  reportUsage,
} from './lib'

type Engine = EngineInterface

const PANE = 'steps-week'
const HELP_PANE = 'steps-help'
const CONNECT_PANE = 'steps-connect'
const HISTORY_DAYS = 28
const TOAST_MS = 10_000
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 86_400_000
const PASS_MS = 20 * MINUTE_MS
const PASSES_PER_DAY = 3
// The phone file is re-read this often in the background.
const POLL_MS = 2 * MINUTE_MS
// Prompts before this hour belong to the night before: they never start the day.
const DAY_BEGINS_HOUR = 5

const toast = ($: Engine, text: string) => $.ui.toast(text, { timeoutMs: TOAST_MS })

// Settings, refreshed from the options each time the module registers.
const settings = {
  goal: 10_000,
  isStrict: false,
  windowMs: 10 * HOUR_MS,
  checkpoint: 1000,
  grace: 1000,
  staleMs: 90 * MINUTE_MS,
  stepsDir: '',
  shortcutUrl: '',
}
let dueTimer: { cancel: () => void } | undefined
let pollTimer: { cancel: () => void } | undefined

const today = atom({ plugin: 'terminal-steps', key: 'today' } as const, null)
const olderStreak = atom({ plugin: 'terminal-steps', key: 'olderStreak' } as const, 0)
const pace = atom({ plugin: 'terminal-steps', key: 'pace' } as const, null)
const isWaiting = atom({ plugin: 'terminal-steps', key: 'isWaiting' } as const, false)
const isConnected = atom({ plugin: 'terminal-steps', key: 'isConnected' } as const, false)
const isIntroduced = atom({ plugin: 'terminal-steps', key: 'isIntroduced' } as const, false)
const history = atom({ plugin: 'terminal-steps', key: 'history' } as const, [])

// The phone's files in iCloud Drive (read only), and this mod's own beside ~/.claude.
const files = async ($: Engine) => {
  const home = (await $.env.get('HOME')) ?? ''
  const phone = settings.stepsDir !== '' ? settings.stepsDir.replace(/^~(?=\/)/, home) : `${home}/${DEFAULT_DIR}`
  return { phone, local: `${home}/.claude/steps` }
}

const readText = async ($: Engine, path: string) => ((await $.fs.exists(path)) ? await $.fs.read(path) : undefined)

const readNumber = async ($: Engine, path: string) => {
  const n = parseInt((await readText($, path)) ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

// `/steps rest` leaves `<date>.skip`; `/steps rest off` writes "off" into it to undo.
const readRest = async ($: Engine, path: string) => ((await readText($, path)) ?? 'off').trim() !== 'off'

const readPhone = async ($: Engine, phoneDir: string, date: string) => {
  const text = await readText($, `${phoneDir}/${date}.txt`)
  return text === undefined ? undefined : parsePhoneFile(text)
}

// Each day remembers the goal it had, so changing the goal never rewrites history.
const readGoal = async ($: Engine, localDir: string, date: string) => {
  const n = await readNumber($, `${localDir}/${date}.goal`)
  return n > 0 ? n : settings.goal
}

const readDay = async ($: Engine, ms: number): Promise<Day> => {
  const { phone, local } = await files($)
  const date = dayKey(ms)
  const steps = (await readPhone($, phone, date))?.steps ?? 0
  return {
    date,
    count: steps + (await readNumber($, `${local}/${date}.extra`)),
    goal: await readGoal($, local, date),
    isSkipped: await readRest($, `${local}/${date}.skip`),
  }
}

const refreshToday = async ($: Engine): Promise<Today> => {
  const { phone: phoneDir, local } = await files($)
  const date = dayKey(await $.clock.now())
  const phone = await readPhone($, phoneDir, date)
  // Today always takes the current goal; past days keep theirs.
  if ((await readNumber($, `${local}/${date}.goal`)) !== settings.goal) {
    await $.fs.write(`${local}/${date}.goal`, `${settings.goal}\n`)
  }
  const extra = await readNumber($, `${local}/${date}.extra`)
  const next: Today = {
    date,
    phone: phone?.steps ?? 0,
    extra,
    count: (phone?.steps ?? 0) + extra,
    goal: settings.goal,
    syncedAt: phone === undefined ? null : phone.at,
    isRest: await readRest($, `${local}/${date}.skip`),
  }
  await update($, today, () => next)
  if (phone !== undefined && !(await read($, isConnected))) {
    await $.store.set('connected', true)
    await update($, isConnected, () => true)
  }
  return next
}

// Finished days in a row just before the window, so a streak can outlast it.
// Cached per window: a full walk once, then one day's step as the window slides.
const olderRun = async ($: Engine, days: readonly Day[]) => {
  const first = days[0]
  if (first === undefined || !isDone(first)) {
    await $.store.delete('streakCache')
    return 0
  }
  const oldest = lastDays(await $.clock.now(), HISTORY_DAYS)[0] ?? 0
  const asOf = dayKey(oldest)
  const cache = (await $.store.get('streakCache')) as { asOf?: string; older?: number } | undefined
  let older: number
  if (cache?.asOf === asOf && typeof cache.older === 'number') {
    older = cache.older
  } else if (cache?.asOf === dayKey(oldest - DAY_MS) && typeof cache.older === 'number') {
    older = isDone(await readDay($, oldest - DAY_MS)) ? cache.older + 1 : 0
  } else {
    older = 0
    for (let back = 1; back <= 366; back++) {
      if (!isDone(await readDay($, oldest - back * DAY_MS))) break
      older++
    }
  }
  await $.store.set('streakCache', { asOf, older })
  return older
}

const refreshHistory = async ($: Engine) => {
  const days = await Promise.all(lastDays(await $.clock.now(), HISTORY_DAYS).map(ms => readDay($, ms)))
  await update($, history, () => days)
  const older = await olderRun($, days)
  await update($, olderStreak, () => older)
  return days
}

// The day starts at the person's first prompt; the goal is spread from there.
const dayStart = async ($: Engine, date: string) => {
  const stored = (await $.store.get('dayStart')) as { date?: string; at?: number } | undefined
  return stored?.date === date && typeof stored.at === 'number' ? stored.at : undefined
}

const startDay = async ($: Engine) => {
  const now = await $.clock.now()
  if (new Date(now).getHours() < DAY_BEGINS_HOUR) return
  const date = dayKey(now)
  if ((await dayStart($, date)) === undefined) await $.store.set('dayStart', { date, at: now })
}

// Recomputes the pace and arms a timer for the next checkpoint.
const refreshPace = async ($: Engine): Promise<Pace | null> => {
  dueTimer?.cancel()
  dueTimer = undefined
  const t = await read($, today)
  const at = t === null ? undefined : await dayStart($, t.date)
  const now = await $.clock.now()
  const next: Pace | null =
    t === null || t.isRest || at === undefined
      ? null
      : paceAt(t.goal, t.count, settings.checkpoint, at, now, settings.windowMs)
  await update($, pace, () => next)
  if (next?.nextDueAt != null && t !== null && t.count < t.goal) {
    dueTimer = $.clock.after(Math.max(1, next.nextDueAt - now), () => void checkpointDue($))
  }
  return next
}

// Re-reads the phone file and everything that hangs off it.
const sync = async ($: Engine) => {
  const before = await read($, today)
  const t = await refreshToday($)
  reportUsage(t.goal, t.count)
  await update($, history, days => days.map(day => (day.date === t.date ? { ...day, count: t.count, goal: t.goal } : day)))
  await refreshPace($)
  if (before !== null && before.date === t.date && t.goal > 0 && before.count < t.goal && t.count >= t.goal) {
    toast($, `✅ ${fmt(t.count)} steps. Goal done. That's the work.`)
    await refreshHistory($)
  }
  return t
}

const isStale = (t: Today, now: number) => t.syncedAt === null || now - t.syncedAt > settings.staleMs

const checkpointDue = async ($: Engine) => {
  await sync($)
  const p = await read($, pace)
  const t = await read($, today)
  if (p === null || t === null || p.behind <= settings.grace) return
  toast($, `⏱ ${fmt(p.behind)} steps behind (${fmt(p.required)}/${fmt(t.goal)} by now). Go for a walk.`)
}

const passUntil = async ($: Engine, date: string) => {
  const stored = (await $.store.get('pass')) as { date?: string; used?: number; until?: number } | undefined
  return stored?.date === date ? { used: stored.used ?? 0, until: stored.until ?? 0 } : { used: 0, until: 0 }
}

// Why a typed prompt waits right now, or undefined to let it through. Anything
// uncertain lets it through: a phone that hasn't synced lately can't hold you.
const holdReason = async ($: Engine) => {
  if (!settings.isStrict) return undefined
  const t = await read($, today)
  const p = await read($, pace)
  const now = await $.clock.now()
  if (t === null || p === null || t.isRest || t.count >= t.goal) return undefined
  if (!(await read($, isConnected)) || isStale(t, now)) return undefined
  if ((await passUntil($, t.date)).until > now) return undefined
  if (p.behind <= settings.grace) return undefined
  return `Behind pace: ${fmt(p.behind)} steps to catch up (${fmt(p.required)}/${fmt(t.goal)} due by now, synced ${ago(t.syncedAt ?? now, now)}). Walk it off, then /steps sync. /steps pass if your phone just hasn't caught up.`
}

const closePane = async ($: Engine, id: string) => {
  try {
    await $.ui.close({ id })
  } catch (err) {
    toast($, `Couldn't close the panel (${err instanceof Error ? err.message : String(err)}). Try Esc or /steps hide.`)
  }
}

const syncText = (t: Today, now: number, connected: boolean) => {
  if (!connected) return 'phone not connected'
  return t.syncedAt === null ? (t.phone > 0 ? 'synced' : 'no sync yet today') : `synced ${ago(t.syncedAt, now)}`
}

const paceText = (p: Pace | null, isHeld: boolean) => {
  if (p === null || p.required === 0) return ''
  if (p.behind > 0) return `  behind ${fmt(p.behind)}${isHeld ? ' · prompts wait' : ''}`
  return '  on pace'
}

const line = (t: Today) => {
  const done = t.goal > 0 && t.count >= t.goal
  return `${done ? '✅' : '🚶'} ${bar(t.count, t.goal)} ${fmt(t.count)}/${fmt(t.goal)} steps`
}

const status = async ($: Engine, t: Today) => {
  const now = await $.clock.now()
  const run = fullStreak(await read($, history), await read($, olderStreak))
  const held = (await holdReason($)) !== undefined
  const extra = t.extra > 0 ? ` (+${fmt(t.extra)} added)` : ''
  return `${line(t)}${extra}  ${syncText(t, now, await read($, isConnected))}${paceText(await read($, pace), held)}${run > 0 ? `  🔥${run}d` : ''}`
}

const markIntroduced = async ($: Engine) => {
  await $.store.set('introduced', true)
  await update($, isIntroduced, () => true)
}

const openConnect = async ($: Engine) => {
  // Open first: a pane counts as asked for only while the press or command that
  // asked is still being answered.
  const opened = await $.ui.open({ id: CONNECT_PANE, title: 'CONNECT APPLE HEALTH', focus: true, closeOnEscape: true })
  if (!opened.isPlaced) toast($, 'Widen the terminal to see the setup, or read the README.')
  await markIntroduced($)
}

const setRest = async ($: Engine, isRest: boolean) => {
  const t = await refreshToday($)
  if (t.isRest === isRest) return isRest ? 'Already a rest day. /steps rest off to walk.' : `Today isn't a rest day. ${line(t)}`
  await $.fs.write(`${(await files($)).local}/${t.date}.skip`, isRest ? '\n' : 'off\n')
  await refreshToday($)
  await refreshHistory($)
  await refreshPace($)
  return isRest
    ? 'Rest day logged. Streak resets, nothing held today. (/steps rest off to undo)'
    : `Rest day undone. ${line((await read($, today)) ?? t)}`
}

const boot = async ($: Engine) => {
  const introduced = (await $.store.get('introduced')) === true
  const connected = (await $.store.get('connected')) === true
  await update($, isIntroduced, () => introduced)
  await update($, isConnected, () => connected)
  await refreshToday($)
  await refreshHistory($)
  await refreshPace($)
  pollTimer?.cancel()
  pollTimer = $.clock.every(POLL_MS, () => void sync($))
  await $.command.register({
    name: 'steps',
    description: "Today's steps from Apple Health",
    argumentHint: '[sync | add n | clear | goal n | score | connect | pass | rest [off] | strict | easy | rules | hide]',
    immediate: true,
  })
}

export const register: Register = (on, options) => {
  settings.goal = Math.max(1, Number(options.goal ?? 10_000))
  settings.isStrict = options.strict === true
  settings.windowMs = Math.max(1, Number(options.windowHours ?? 10)) * HOUR_MS
  settings.checkpoint = Math.max(100, Number(options.checkpoint ?? 1000))
  settings.grace = Math.max(0, Number(options.grace ?? 1000))
  settings.staleMs = Math.max(5, Number(options.staleMinutes ?? 90)) * MINUTE_MS
  settings.stepsDir = typeof options.stepsDir === 'string' ? options.stepsDir.trim() : ''
  settings.shortcutUrl = typeof options.shortcutUrl === 'string' ? options.shortcutUrl.trim() : ''
  const nudgeMs = Number(options.nudgeSeconds ?? 45) * 1000
  const nudgeSteps = Number(options.nudgeSteps ?? 500)
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await boot($)
    return next(e)
  })

  // /clear and an in-session /resume switch conversations without another session.start.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'resume') await boot($)
    return next(e)
  })

  on('command.run', { command: 'steps' }, async ($, e) => {
    const cmd = parseSteps(e.args)
    switch (cmd.kind) {
      case 'error':
        return { text: cmd.text }
      case 'status':
        await refreshHistory($)
        return { text: await status($, await sync($)) }
      case 'sync': {
        const t = await sync($)
        if (!(await read($, isConnected))) {
          const { phone } = await files($)
          return { text: `No phone file yet at ${phone}/${t.date}.txt. /steps connect to set up the Shortcut.` }
        }
        return { text: await status($, t) }
      }
      case 'add': {
        const { local } = await files($)
        const before = await refreshToday($)
        await $.fs.write(`${local}/${before.date}.extra`, `${before.extra + cmd.n}\n`)
        const t = await sync($)
        return { text: `Added ${fmt(cmd.n)}. ${await status($, t)}` }
      }
      case 'clear': {
        const { local } = await files($)
        const before = await refreshToday($)
        await $.fs.write(`${local}/${before.date}.extra`, '0\n')
        return { text: `Added steps cleared. ${await status($, await sync($))}` }
      }
      case 'goal': {
        const { deny } = await $.config.set({ key: 'terminal-steps.goal', value: cmd.n })
        if (deny !== undefined) return { text: `Couldn't change the goal: ${deny}` }
        settings.goal = cmd.n
        const t = await sync($)
        await refreshHistory($)
        return { text: `Goal set to ${fmt(cmd.n)} steps a day. ${line(t)}` }
      }
      case 'week': {
        if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
          await $.ui.close({ id: PANE })
          return { text: 'Scoreboard closed.' }
        }
        const days = await refreshHistory($)
        await $.ui.open({ id: PANE, title: 'TERMINAL STEPS', focus: true, closeOnEscape: true })
        return { text: `🔥 ${fullStreak(days, await read($, olderStreak))}-day streak · Esc or /steps score to close` }
      }
      case 'connect':
        await openConnect($)
        return { text: 'Shortcut setup opened. /steps sync once it has run.' }
      case 'pass': {
        const now = await $.clock.now()
        const date = dayKey(now)
        const { used, until } = await passUntil($, date)
        if (until > now) return { text: `Pass already running until ${clockTime(until)}.` }
        if (used >= PASSES_PER_DAY) return { text: `No passes left today (${PASSES_PER_DAY} a day). Time to walk.` }
        await $.store.set('pass', { date, used: used + 1, until: now + PASS_MS })
        return { text: `Pass until ${clockTime(now + PASS_MS)} (${PASSES_PER_DAY - used - 1} left today). Open your phone so the Shortcut runs.` }
      }
      case 'skip':
        return { text: await setRest($, true) }
      case 'unskip':
        return { text: await setRest($, false) }
      case 'help':
        await markIntroduced($)
        await $.ui.open({ id: HELP_PANE, title: 'HOUSE RULES' })
        return { text: 'House rules opened · /steps hide to close' }
      case 'strict': {
        const { deny } = await $.config.set({ key: 'terminal-steps.strict', value: cmd.isOn })
        if (deny !== undefined) return { text: `Couldn't change strict mode: ${deny}` }
        return {
          text: cmd.isOn
            ? `Coach is strict. Your goal is spread over ${settings.windowMs / HOUR_MS}h from your first prompt; fall more than ${fmt(settings.grace)} steps behind and prompts wait until you walk it off.`
            : 'Coach is easy. Same pace on the band, nudges only, nothing held.',
        }
      }
      case 'hide':
        await $.ui.close({ id: PANE })
        await $.ui.close({ id: HELP_PANE })
        await $.ui.close({ id: CONNECT_PANE })
        return { text: 'Terminal Steps panels closed.' }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    // Only prompts the person typed count: background tasks, loops and slash
    // commands (like /steps sync) always pass.
    const isTyped = e.origin.kind === 'composer' && !e.text.trimStart().startsWith('/')
    if (!isTyped) return next(e)
    await startDay($)
    await sync($)
    const reason = await holdReason($)
    if (reason !== undefined) {
      void $.prompt.fill({ text: e.text })
      return { drop: reason }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    timer?.cancel()
    if (!settings.isStrict && options.nudges !== false) {
      timer = $.clock.after(nudgeMs, () => {
        void (async () => {
          const t = await read($, today)
          if (t === null || t.isRest || t.count >= t.goal) return
          await update($, isWaiting, () => true)
          toast($, `Claude's on it. Take a lap: ${fmt(nudgeSteps)} steps.`)
        })()
      })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      timer?.cancel()
      timer = undefined
      await update($, isWaiting, () => false)
      await sync($)
    }
    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (options.spinner === false || !(await read($, isWaiting))) return next(e)
    return next({ ...e, props: { ...e.props, message: `walk ${fmt(nudgeSteps)} steps while Claude works` } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const t = await read($, today)
    if (options.band === false || e.props.hasSurvey || t === null) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    const connected = await read($, isConnected)

    if (!(await read($, isIntroduced)) && !connected) {
      const HEADER = "🚶 TERMINAL-STEPS  Your agent's doing the legwork. You do the footwork."
      const LABELS = ['Connect iPhone', 'House rules', 'Later']
      return (
        <Box key="welcome" flexDirection={cols >= cells(HEADER) + 2 + buttonsWidth(LABELS) ? 'row' : 'column'}>
          <Text bold wrap="truncate-end">
            {HEADER}
            {'  '}
          </Text>
          <Box flexDirection={cols >= buttonsWidth(LABELS) ? 'row' : 'column'}>
            <Button key="connect" label="Connect iPhone" variant="primary" onPress={() => openConnect($)} />
            <Text> </Text>
            <Button key="help" label="House rules" onPress={() => $.ui.open({ id: HELP_PANE, title: 'HOUSE RULES' })} />
            <Text> </Text>
            <Button key="dismiss" label="Later" onPress={() => markIntroduced($)} />
          </Box>
        </Box>
      )
    }

    if (t.isRest) {
      const REST = '😴 Rest day · back on your feet tomorrow'
      return (
        <Box key="rest" flexDirection={cols >= cells(REST) + 2 + buttonsWidth(['Walk today']) ? 'row' : 'column'}>
          <Text dimColor wrap="truncate-end">
            {REST}
            {'  '}
          </Text>
          <Button key="train" label="Walk today" onPress={() => setRest($, false)} />
        </Box>
      )
    }

    const now = await $.clock.now()
    const held = (await holdReason($)) !== undefined
    const run = fullStreak(await read($, history), await read($, olderStreak))
    const progress = `${line(t)}${paceText(await read($, pace), held)}`
    const meta = `  ${syncText(t, now, connected)}${run > 0 ? `  🔥${run}d` : ''}  `
    const color = progressColor(t.count, t.goal)
    const action = connected ? 'Sync' : 'Connect iPhone'
    const isOneLine = cols >= cells(progress) + cells(meta) + buttonsWidth([action])

    return (
      <Box key="tracker" flexDirection={isOneLine ? 'row' : 'column'}>
        <Text color={color} dimColor={color === undefined} wrap="truncate-end">
          {progress}
        </Text>
        <Box>
          <Text dimColor>{meta}</Text>
          {connected ? (
            <Button key="sync" label="Sync" onPress={() => void sync($)} />
          ) : (
            <Button key="connect" label="Connect iPhone" onPress={() => openConnect($)} />
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const days = await read($, history)
    const t = await read($, today)
    const run = fullStreak(days, await read($, olderStreak))
    const week = days.slice(-7)
    const { Box, Button, Text } = $.ui.resolve(e)

    const counts = week.map(day => `${fmt(day.count)}/${fmt(day.goal)}`)
    const width = Math.max(0, ...counts.map(c => c.length))
    const summary = week.map((day, i) => {
      const mark = day.isSkipped ? '–' : isDone(day) ? '✓' : '·'
      return `${mark} ${day.date.slice(5)}  ${(counts[i] ?? '').padStart(width)}${i === week.length - 1 ? '  ◀ today' : ''}`
    })
    const grid =
      e.surface === 'terminal'
        ? (() => {
            const { Raster } = $.ui.resolve(e)
            return (
              <Box flexDirection="column">
                <Text dimColor>last {HISTORY_DAYS} days · ▒ today</Text>
                <Raster key="heat" {...heatCells(days)} />
                <Text> </Text>
              </Box>
            )
          })()
        : null

    return (
      <Box flexDirection="column">
        <Text bold>🚶 TERMINAL STEPS</Text>
        <Text bold>🔥 {run}-day streak</Text>
        {t !== null && <Text dimColor>{line(t)}</Text>}
        <Text> </Text>
        {grid}
        {summary.map((row, i) => (
          <Text dimColor={i !== summary.length - 1} bold={i === summary.length - 1}>
            {row}
          </Text>
        ))}
        <Text> </Text>
        <Button key="close" label="Close" onPress={() => closePane($, PANE)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: HELP_PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Markdown text={HELP} />
        <Text> </Text>
        <Box>
          <Button key="connect" label="Connect iPhone" variant="primary" onPress={() => openConnect($)} />
          <Text> </Text>
          <Button key="close" label="Close" onPress={() => closePane($, HELP_PANE)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CONNECT_PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const t = await read($, today)
    const { phone } = await files($)
    const now = await $.clock.now()
    const connected = await read($, isConnected)
    const state =
      t !== null && (t.syncedAt !== null || t.phone > 0)
        ? `✓ Connected · ${fmt(t.phone)} steps from your phone, ${syncText(t, now, true)}`
        : connected
          ? '✓ Connected before · waiting for today’s first sync'
          : '… Waiting for the first file from your phone'
    return (
      <Box flexDirection="column">
        {settings.shortcutUrl !== '' && (
          <Box flexDirection="column">
            <Text bold>Quick install: open this on your iPhone</Text>
            <Text color="#6bb8c8">{settings.shortcutUrl}</Text>
            <Text dimColor>then do step 2 below.</Text>
            <Text> </Text>
          </Box>
        )}
        <Markdown text={SHORTCUT} />
        <Text> </Text>
        <Text bold color={state.startsWith('✓') ? '#87af87' : undefined}>
          {state}
        </Text>
        <Text dimColor wrap="truncate-start">
          Watching {phone}/{t?.date ?? 'YYYY-MM-DD'}.txt
        </Text>
        <Text> </Text>
        <Box>
          <Button key="check" label="Check now" variant="primary" onPress={() => void sync($)} />
          <Text> </Text>
          <Button key="close" label="Close" onPress={() => closePane($, CONNECT_PANE)} />
        </Box>
      </Box>
    )
  })
}
