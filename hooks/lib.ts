import type { Day, Pace } from '../types'

const DAY_MS = 86_400_000

const pad = (n: number) => String(n).padStart(2, '0')

export const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Noon anchors keep day arithmetic clear of DST shifts.
export const lastDays = (ms: number, n: number) => {
  const d = new Date(ms)
  const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime()
  return Array.from({ length: n }, (_, i) => noon - (n - 1 - i) * DAY_MS)
}

export const bar = (count: number, goal: number, width = 10) => {
  const filled = goal > 0 ? Math.min(width, Math.floor((count / goal) * width)) : 0
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

// 10000 → "10,000", whatever the locale.
export const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

// What the Shortcut writes: the step total on the first line, the time it ran
// on the second. Shortcuts may format the number ("6,240", "6 240.0"), and an
// older Shortcut may write the number alone.
export const parsePhoneFile = (text: string): { steps: number; at: number | null } | undefined => {
  const [first = '', second = ''] = text.split(/\r?\n/)
  const digits = first.split(/[.]/)[0]?.replace(/[^\d]/g, '') ?? ''
  if (digits === '') return undefined
  const at = Date.parse(second.trim())
  return { steps: Number(digits), at: Number.isFinite(at) ? at : null }
}

export type StepsCommand =
  | { kind: 'status' }
  | { kind: 'sync' }
  | { kind: 'week' }
  | { kind: 'connect' }
  | { kind: 'skip' }
  | { kind: 'unskip' }
  | { kind: 'help' }
  | { kind: 'hide' }
  | { kind: 'pass' }
  | { kind: 'clear' }
  | { kind: 'strict'; isOn: boolean }
  | { kind: 'goal'; n: number }
  | { kind: 'add'; n: number }
  | { kind: 'error'; text: string }

const USAGE =
  'usage: /steps [sync | add <n> | clear | goal <n> | score | connect | pass | rest [off] | strict | easy | rules | hide]'

const count = (value: string | undefined) => {
  const text = (value ?? '').replace(/[,_]/g, '')
  return /^\d+$/.test(text) ? Number(text) : undefined
}

export const parseSteps = (args: string): StepsCommand => {
  const [head = '', value] = args.trim().toLowerCase().split(/\s+/)
  if (head === '' || head === 'status') return { kind: 'status' }
  if (head === 'sync') return { kind: 'sync' }
  if (head === 'score') return { kind: 'week' }
  if (head === 'connect' || head === 'setup') return { kind: 'connect' }
  if (head === 'rest') return value === 'off' ? { kind: 'unskip' } : { kind: 'skip' }
  if (head === 'rules' || head === 'help') return { kind: 'help' }
  if (head === 'hide') return { kind: 'hide' }
  if (head === 'pass') return { kind: 'pass' }
  if (head === 'clear') return { kind: 'clear' }
  if (head === 'strict') return { kind: 'strict', isOn: true }
  if (head === 'easy') return { kind: 'strict', isOn: false }
  if (head === 'goal') {
    const n = count(value)
    return n !== undefined && n > 0 ? { kind: 'goal', n } : { kind: 'error', text: 'steps: goal needs a number, like /steps goal 8000' }
  }
  if (head === 'add') {
    const n = count(value)
    return n !== undefined ? { kind: 'add', n } : { kind: 'error', text: 'steps: add needs a number, like /steps add 2000' }
  }
  const n = count(head)
  if (n !== undefined) return { kind: 'add', n }
  return { kind: 'error', text: USAGE }
}

export const isDone = (day: Day) => !day.isSkipped && day.goal > 0 && day.count >= day.goal

// Today counts once done; an unfinished today does not break the run yet.
export const streak = (history: readonly Day[]) => {
  let run = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const day = history[i]
    if (day === undefined) break
    if (isDone(day)) run++
    else if (i !== history.length - 1) break
  }
  return run
}

// The streak, counting days older than the window when the window is all done.
export const fullStreak = (history: readonly Day[], older: number) => {
  const run = streak(history)
  const last = history[history.length - 1]
  const coversWindow = run === history.length || (run === history.length - 1 && last !== undefined && !isDone(last))
  return coversWindow ? run + older : run
}

// The engine environment has Uint8Array#toBase64; es2023 typings do not.
type Base64Bytes = Uint8Array & { toBase64: () => string }

const ACCENT = 0x6bb8c8
const PARTIAL = 0x3f5f6b
const EMPTY = 0x343434
const DEFAULT = 0x01000000

// One row per week, seven 2-cell days with a gap: 20 columns.
export const heatCells = (history: readonly Day[]) => {
  const weeks = Math.ceil(history.length / 7)
  const columns = 20
  const words = new Uint32Array(columns * weeks * 3)
  for (let row = 0; row < weeks; row++) {
    for (let col = 0; col < columns; col++) {
      const day = history[row * 7 + Math.floor(col / 3)]
      const isGap = col % 3 === 2 || day === undefined
      const color = isGap ? DEFAULT : isDone(day) ? ACCENT : day.count > 0 ? PARTIAL : EMPTY
      const at = (row * columns + col) * 3
      // Today, the last day, is drawn shaded so it stands out from finished days.
      const isToday = row * 7 + Math.floor(col / 3) === history.length - 1
      words[at] = isGap ? 0x20 : isToday ? 0x2592 : 0x2588
      words[at + 1] = color
      words[at + 2] = DEFAULT
    }
  }
  return { columns, rows: weeks, cells: (new Uint8Array(words.buffer) as Base64Bytes).toBase64() }
}

// Grey until the first step, then red under a third of the goal, yellow on the
// way, green for the last fifth. No goal: undefined draws dim.
export const progressColor = (count: number, goal: number) => {
  if (goal <= 0 || count <= 0) return undefined
  const share = count / goal
  return share >= 0.8 ? '#87af87' : share >= 1 / 3 ? '#d7af5f' : '#d75f5f'
}

// Terminal cells a string takes: emoji draw two cells wide.
export const cells = (text: string) =>
  [...text].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) >= 0x1f000 || ch === '✅' ? 2 : 1), 0)

// The terminal draws a Button as `[ label ]`, and a row puts one cell between buttons.
export const buttonsWidth = (labels: readonly string[]) =>
  labels.reduce((w, label) => w + cells(label) + 4, 0) + labels.length - 1

// The goal as checkpoints of `chunk` steps spread evenly over the window. Unlike
// reps, nothing is due at the start: steps build up as the day goes.
export const paceAt = (goal: number, count: number, chunk: number, startedAt: number, now: number, windowMs: number): Pace => {
  if (goal <= 0 || chunk <= 0) return { required: 0, behind: 0, nextDueAt: null }
  const checkpoints = Math.ceil(goal / chunk)
  const gap = windowMs / checkpoints
  const due = Math.min(checkpoints, Math.floor(Math.max(0, now - startedAt) / gap))
  const required = Math.min(goal, due * chunk)
  return {
    required,
    behind: Math.max(0, required - count),
    nextDueAt: due < checkpoints ? startedAt + (due + 1) * gap : null,
  }
}

export const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const ago = (ms: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
}

// Where the Shortcut's "Save File" lands: the Shortcuts folder in iCloud Drive.
export const DEFAULT_DIR = 'Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Steps'

export const SHORTCUT = `## Connect Apple Health

Steps live on your iPhone, so a Shortcut there writes today's total to iCloud Drive, and this mod reads it on your Mac. Same Apple ID on both, iCloud Drive on.

### 1. Build the Shortcut (once, ~2 min)
In the **Shortcuts** app, new Shortcut named **Terminal Steps**:

1. **Find Health Samples** where *Type* is *Steps* and *Start Date* is *today*. Tap *Group By* and pick **Day** (this de-duplicates iPhone + Watch).
2. **Calculate Statistics**: *Sum* of Health Samples.
3. **Round Number**: Statistics Result, to *Ones Place*.
4. **Format Date**: *Current Date*, Date Format *Custom*, \`yyyy-MM-dd\`.
5. **Text**: the *Rounded Number*, a new line, then *Current Date* (tap it, set Date Format to *ISO 8601*, Include ISO 8601 Time on).
6. **Save File**: the Text. Turn *Ask Where to Save* **off**, Destination *Shortcuts*, Subpath \`Steps/\` + *Formatted Date* + \`.txt\`. Turn *Overwrite If File Exists* **on**.

Run it once and allow Health access. Check the number matches the Health app.

### 2. Make it run on its own
**Automation** tab → **+** → **App** → pick apps you open all day (Messages, Slack, Safari) → *Is Opened* → **Run Immediately** → Terminal Steps.

Health data is locked while your phone is, so app triggers (you're holding an unlocked phone) sync more reliably than time-of-day ones.

### 3. Done
The band picks it up within a couple of minutes. \`/steps sync\` checks now.`

export const HELP = `## House rules

**Your agent's doing the legwork. You do the footwork.**
When a turn runs long, get up and walk.

Steps come from your iPhone via a Shortcut (\`/steps connect\`), so they lag by however long since it last ran.

### Commands
| Command | Does |
|---|---|
| \`/steps\` | today's steps, pace and streak |
| \`/steps sync\` | re-read the phone file now |
| \`/steps add 2000\` | add steps the phone missed (treadmill, phone on the desk) |
| \`/steps clear\` | drop today's added steps |
| \`/steps goal 8000\` | set the daily goal |
| \`/steps score\` | streak + 28-day grid |
| \`/steps connect\` | set up the iPhone Shortcut |
| \`/steps pass\` | 20 minutes of prompts while your phone catches up (3 a day) |
| \`/steps rest\` / \`/steps rest off\` | rest day (breaks streak) / undo |
| \`/steps strict\` / \`/steps easy\` | strict mode on / off |
| \`/steps hide\` | close panels |

### Strict mode
Off by default. When it's on, today's goal is spread over your training window from your first prompt. Fall more than the grace allowance behind and typed prompts wait until you walk it off.

It fails open: if your phone hasn't synced in a while, nothing is held, so a broken Shortcut never locks you out.

### Your data
Read from your iCloud Drive, kept on this machine. No network calls.`
