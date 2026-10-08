# 🚶 Terminal Steps

**Your agent's doing the legwork. You do the footwork.**

A Claude Code mod for a daily step goal, synced from Apple Health. A band above your prompt shows today's steps, long turns nudge you to walk, streaks keep you honest, and strict mode holds your prompts when you fall behind.

Forked from [terminal-gym](https://github.com/DrumAndCode/terminal-gym) (reps → steps).

```sh
claude plugin marketplace add utpaljaynadiger/claudesteptracker && claude plugin install terminal-steps@terminal-steps
```

Needs Claude Code 2.1.288 or newer.

To remove it:

```sh
claude plugin uninstall terminal-steps@terminal-steps
```

## How steps get to your Mac

Apple Health has no Mac or web API, so an iPhone Shortcut reads today's total and saves it to iCloud Drive. The mod reads that file:

```
iPhone Health → Shortcut → iCloud Drive/Shortcuts/Steps/2026-10-03.txt → ~/Library/Mobile Documents/… → band
```

The file is two lines: the step count, then when the Shortcut ran (ISO 8601). Run `/steps connect` in Claude Code for the setup walkthrough.

### Build the Shortcut (once)

1. **Find Health Samples**: Type *Steps*, Start Date *is today*, **Group By *Day*** (de-duplicates iPhone + Watch).
2. **Calculate Statistics**: *Sum*.
3. **Round Number**: ones place.
4. **Format Date**: Current Date, custom `yyyy-MM-dd`.
5. **Text**: Rounded Number, newline, Current Date (ISO 8601, include time).
6. **Save File**: Ask Where to Save **off**, Shortcuts folder, subpath `Steps/<Formatted Date>.txt`, Overwrite **on**.

Then **Automation → App → Is Opened** (Messages, Slack, Safari…) → **Run Immediately**. App triggers beat time-of-day ones because Health data is locked while your phone is.

Once you've built it, share it (⋯ → Share → Copy iCloud Link) and put the link in the **Shortcut link** setting: `/steps connect` then shows it as a one-tap install for anyone else.

## Commands

| Command | Does |
|---|---|
| `/steps` | today's steps, sync time, pace and streak |
| `/steps sync` | re-read the phone file now (it's also polled every 2 min) |
| `/steps add 2000` | add steps the phone missed |
| `/steps clear` | drop today's added steps |
| `/steps goal 8000` | daily goal |
| `/steps score` | streak, 28-day grid, last week |
| `/steps connect` | Shortcut setup + connection status |
| `/steps pass` | 20 min of prompts while the phone catches up (3/day) |
| `/steps rest` / `rest off` | rest day (breaks streak) / undo |
| `/steps strict` / `easy` | strict mode on / off |
| `/steps rules` / `hide` | help / close panels |

## Strict mode

Your goal is spread over a window (10h by default) from your first prompt, in 1,000-step checkpoints. Nothing is due at the start. Fall more than the **grace** (1,000 steps) behind and typed prompts wait until you walk it off.

Phone data lags, so strict mode **fails open**: if the phone hasn't synced in 90 minutes, nothing is held. `/steps pass` covers the gap between walking and the next sync.

## Data

- Read: `~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Steps/YYYY-MM-DD.txt` (override with the **Steps folder** setting)
- Written: `~/.claude/steps/YYYY-MM-DD.{extra,goal,skip}`

No network calls.

## Develop

```sh
claude plugin test .
claude plugin validate .claude-plugin/plugin.json
```
