# Design notes

## Goals
1. Make it nearly effortless to have the *right* timer running.
2. Make missed time visible and easy to recover the same day.
3. Produce billing-ready entries (0.1 hr increments, CSV) without retyping.
4. Keep confidential client data on the attorney's own machine.

## Decisions
- **Desktop app (Electron).** Gives a menu bar or tray presence, a global
  hotkey, OS idle and lock detection, and notifications on Mac and Windows from
  one codebase.
- **One running timer at a time.** Starting a matter stops the current one, and
  overlapping entries are rejected. This matches how time is billed and keeps
  entries honest.
- **Local JSON storage.** One file with atomic writes and daily backups. The
  data volume (a few thousand entries a year) doesn't justify a database.
  Everything goes through `src/core/store.js`, so swapping storage later is
  contained.
- **Activity log, not surveillance.** The app records only *when* the computer
  was in use (start/end intervals from the OS idle timer), never which apps,
  windows, or documents. That's enough to find untracked gaps. Intervals older
  than 90 days are pruned.
- **Round after combining.** Day totals and exports sum a matter's time per day
  before rounding up, so interruptions don't inflate bills. Per-entry rounding
  is available.

## How "away" detection works
`src/core/activity.js` runs every 15 seconds with the OS idle time:
- Idle past the threshold, or screen locked → mark the user as away (backdated
  to when input stopped).
- A gap between ticks (sleep, or the app was closed) → away from the last tick.
- On return, if a timer was running for the whole away period → `pendingAway`
  is set and the window asks how to record it.
- Otherwise the elapsed time is added to the activity log, which feeds the
  untracked-gap view, the "no timer running" nudge, and the backdate hint.

## Possible next steps
- Packaged installers (`.dmg` / `.exe`) via electron-builder and a GitHub
  Actions build, so it can be installed without Node.
- Import matters from a CSV or from practice-management software.
- Direct export to Clio, PracticePanther, etc.
- Calendar import (Outlook/Google) to pre-fill meetings and hearings.
- Weekly summary and targets (e.g. billable-hour goal progress).
- Optional AI help turning terse notes into polished billing narratives.
