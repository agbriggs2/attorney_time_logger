# Design notes

## Goals
1. Make it nearly effortless to have the *right* timer running.
2. Make missed time visible and easy to recover the same day.
3. Produce billing-ready entries (0.1 hr increments, CSV) without retyping.
4. Keep confidential client data on the attorney's own machine.

## Decisions
- **Web app hosted on GitHub Pages, data in the browser.** The firm blocks
  installing software, but nothing in its Edge policies blocks a website's
  JavaScript, notifications, idle detection, site storage, file pickers, or
  "Install as app". (An earlier Electron version was replaced for this reason.)
  The page is static; GitHub only serves code.
- **One running timer at a time.** Starting a matter stops the current one, and
  overlapping entries are rejected. This matches how time is billed and keeps
  entries honest.
- **IndexedDB storage plus folder backups.** The whole state is one IndexedDB
  record. It is small: a few thousand entries a year. Because browser data can
  be cleared, the File System Access API writes a daily copy to a folder the
  user picks, keeping 30 days. Manual download and restore cover moving PCs.
  All changes go through `app/core/store.js`.
- **One owner at a time.** A Web Lock makes a single tab or window the owner,
  so two copies can't overwrite each other. A second tab can take over.
- **Activity log, not surveillance.** The app records only *when* the computer
  was in use (start/end intervals from the OS idle timer), never which apps,
  windows, or documents. That's enough to find untracked gaps. Intervals older
  than 90 days are pruned.
- **Round after combining.** Day totals and exports sum a matter's time per day
  before rounding up, so interruptions don't inflate bills. Per-entry rounding
  is available.

## Reminders in a browser
- Windows notifications come from the page (Notification API), so they need the
  app open in a tab or as an installed-app window.
- When no timer is running: a red tab icon, a "Not timing" title, a taskbar
  badge (installed app only), and a red state in the pop-out mini timer
  (Document Picture-in-Picture).
- No global hotkey is possible from a web page. <kbd>/</kbd> focuses the
  switcher, and the pinned taskbar icon brings the window forward.

## How "away" detection works
`app/core/activity.js` runs every 15 seconds. It uses Edge's Idle Detection
API, when permitted, to learn whether the keyboard and mouse are in use and
whether the screen is locked:
- Idle past the threshold, or screen locked → mark the user as away (backdated
  to when input stopped).
- A gap of more than 3 minutes between ticks (PC asleep, browser closed, or tab
  put to sleep) → away from the last tick. Edge slows background tabs to about
  one tick per minute, so the threshold allows for that.
- On return, if a timer was running for the whole away period → `pendingAway`
  is set and the window asks how to record it.
- Otherwise the elapsed time is added to the activity log, which feeds the
  untracked-gap view, the "no timer running" nudge, and the backdate hint.

## Possible next steps
- Import matters from a CSV or from practice-management software.
- Direct export to Clio, PracticePanther, etc.
- Calendar import (Outlook/Google) to pre-fill meetings and hearings.
- Weekly summary and targets (e.g. billable-hour goal progress).
- Optional AI help turning terse notes into polished billing narratives.
