# Time Logger

A desktop time tracker built for attorneys who are bad at tracking time. It
lives in your menu bar (Mac) or system tray (Windows), keeps one timer running
on whatever matter you're working on, and catches the time that usually slips
through the cracks.

All data stays on your computer. Nothing is sent anywhere.

![Day view](docs/screenshot-day.png)

## What it does

| Problem | How the app handles it |
| --- | --- |
| **Forgetting to start a timer** | If you're at your computer during work hours with no timer running, you get a reminder notification. When you do start one, it offers to backdate it to when you actually sat down ("Count it from 9:12"). |
| **Forgetting to stop a timer** | If you walk away (no keyboard or mouse for 5 min, screen locked, laptop asleep) while a timer runs, it asks when you return: remove the away time, stop the timer as of when you left, keep it (you were on a call), or log it to a different matter. |
| **Reconstructing the day** | The Day view shows a timeline with **untracked gaps**, the stretches when you were using the computer with no timer running. Click **Log this time** on a gap to assign it. At the end of the workday you get a "Review your day" prompt. |
| **Interruptions** | **Interrupt** (or <kbd>Shift</kbd>+<kbd>Enter</kbd>) pauses the current matter and times the interruption; **Back to it** resumes the original matter with its description. |
| **Switching fast** | A global hotkey (default <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>) opens the switcher from any app. Type a few letters of the client, matter, or matter number and press <kbd>Enter</kbd>. Recent matters are also in the tray menu. |

### Billing rules
- Time is rounded **up** to the billing increment (0.1 hr by default; 0.25 available).
- By default, a day's time on the same matter is **added up before rounding**, so
  three 4-minute fragments bill as 0.2, not 0.3. You can turn this off in Settings
  or per export.
- Accidental blips (under one minute with no description) are discarded when
  you switch away.
- Non-client time (Administrative, Business Development, CLE & Training, Pro
  Bono) is built in and tracked as non-billable. Add your own on the Matters tab.

### Export
The Export tab produces a CSV (Date, Client, Matter, Matter Number, Billable,
Hours, Minutes, Description) for any date range. Open it in Excel or import it
into your billing software. A running timer isn't exported until you stop it.

## Running it

You need [Node.js](https://nodejs.org) 20 or later.

```sh
npm install
npm start
```

Closing the window keeps the app running in the tray so the timer continues.
Use **Quit Time Logger** from the tray menu to exit; a running timer survives a
quit or restart, and you'll be asked about the time the app was closed.

Run the tests with `npm test`.

### Where your data lives
A single `timelog.json` file in the app's data folder (shown in Settings, with
an **Open folder** button), plus a `backups/` folder with one copy per day for
the last 30 days. On a Mac that's `~/Library/Application Support/Time Logger`;
on Windows, `%APPDATA%\Time Logger`.

## Project layout

```
src/core/       Pure logic, unit-tested: timer operations, rounding, gap detection, CSV
src/main/       Electron main process: tray, global hotkey, idle polling, notifications
src/renderer/   The window UI (plain HTML/CSS/JS, no build step)
test/           node:test unit tests
docs/DESIGN.md  Design notes and roadmap
```
