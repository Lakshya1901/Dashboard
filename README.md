# Dashboard

A priority-and-deadline task scheduler with a daily habit tracker, a Now/Next
card, a multi-day Gantt chart, and habit-completion stats. It plans your day around a
work window you set and tells you what to do right now and what's next. Data is
synced across your devices through a secret GitHub Gist, so there's no account
or server to run. It's plain HTML, CSS, and JavaScript with no build step and
no dependencies — open `index.html` (or a hosted copy of it) and it works.

## How scheduling works

- **Work hours:** weekdays 12:00-24:00 by default; change them under
  **Hours** in settings. Weekend hours (the same times) are only used for
  max-priority tasks, or for other tasks that can't be finished by their
  deadline using weekday hours alone.
- **Habits:** daily habits (workout, reading, etc.) aren't scheduled. Tick
  each one off whenever you do it that day; tick it again to undo. Each habit
  shows its last 7 days and its current streak (consecutive days done; today
  keeps yesterday's streak alive until the day is over).
- **Priority with a deadline check:** the app always tries to work on your
  highest-priority task first, but only if doing so doesn't cause a
  lower-priority task to miss its deadline. If it would, the app slots in
  whatever lower-priority, sooner-due task is needed to keep everything on
  time, then returns to the higher-priority task. For example: it's Monday
  noon, and you have "Report" (max priority, 16h, due Friday), "Slides" (med
  priority, 10h, due Tuesday), and "Pay bill" (low priority, 30 min, due
  today). Report can't go first, because that would make Pay bill late. So
  the app schedules Slides first (it fits safely and outranks Pay bill), then
  Pay bill, then Report — everything finishes on time.
- **At-risk tasks:** if a task can't meet its deadline no matter how the
  schedule is arranged, it's marked at-risk. At-risk tasks are still
  scheduled (at the end, so the work isn't lost), and they show up in an
  "At risk" list and as "late" segments in the Gantt chart.
- **Plan from now:** every time the screen refreshes, the remaining schedule
  is rebuilt from the current time. A task you've started keeps its actual
  start time; everything after it shifts earlier if you finish early, or
  later if you run over. The top task shows as "Now" with its full estimate
  until you press **Start** — then the countdown begins.
- **Start / Pause / Done:**
  - **Start** begins a timed session on the current item.
  - **Pause** ends the session without marking the task done; your progress
    is saved.
  - **Done** ends the session and marks the task finished.
  - **Remaining time** for a task = its estimate minus the minutes already
    logged against it, with a 15-minute floor (a task never shows less than
    15 minutes remaining).

## Setup

### a. Create the data Gist

1. Go to [gist.github.com](https://gist.github.com).
2. Name the file exactly `schedule.json`.
3. Paste in the sample `schedule.json` from this repo as a starting point.
4. Click **Create secret gist**.
5. Copy the Gist ID — it's the last part of the URL
   (`https://gist.github.com/<username>/<gist-id>`).

Note: "secret" only means unlisted — anyone who has the link can read it. Don't
put sensitive information in it.

### b. Create an access token

Gists are accessed with a classic personal access token (fine-grained tokens
don't support Gists):

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens).
2. Click **Generate new token (classic)**.
3. Select only the **gist** scope.
4. Generate the token and copy it. Never commit it to a repo.

### c. Deploy to GitHub Pages

1. Create a new **public** repo named `dashboard` under your GitHub account
   (`<username>`).
2. Push this project to it:

   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<username>/dashboard.git
   git push -u origin main
   ```

3. In the repo, go to **Settings → Pages**, and under "Build and deployment"
   choose **Deploy from a branch**, branch `main`, folder `/ (root)`.
4. Your site will be live at `https://<username>.github.io/dashboard/`.

### d. Connect the app

1. Open the deployed site.
2. Click the **gear icon** (top right).
3. Paste in your Gist ID and token, then click **Save**.
4. Repeat this on each device you use — the token is stored only in that
   browser's `localStorage` and never leaves the device except in requests to
   GitHub's API. On iPhone, just open the site URL in Safari and do the same.

## Using it

- **One page:** the Now/Next card, habits, habit stats, Gantt chart, and
  at-risk list. Tasks are coloured by priority (red max, amber med, green low)
  on a black-and-white page.
- **Habit chart:** the share of habits done, on green graph paper. Pick
  **1M** (daily bars), **3M** or **6M** (weekly averages), or **1Y** (monthly
  averages); the choice is remembered on that device. Fuller bars are more
  solid. The layout and text scale with the window; on wide screens
  the stats sit beside the Now card, on phones everything stacks.
- **Settings (gear icon):** add, edit, delete, and reorder (with the up/down buttons)
  tasks and habits, set your work hours, and change your Gist ID and token, all from one
  dialog with an explicit **Save** button. Clicking outside the dialog closes it without saving.
  **Appearance** (System, Light, or Dark) applies right away and is remembered
  on that device only.
- **Start / Pause / Done:** act on whichever item is current, or the next
  task if nothing is running yet.
- **Offline:** the status line reads "Offline · last synced HH:MM", and the
  Start, Pause, Done, and Save buttons are disabled while offline. The app
  still works for viewing, using data cached from the last successful sync.
- **Sync:** data is refetched when the page loads and whenever the tab
  regains focus (at most once a minute), and writes always fetch the latest
  data first, apply your change, then save — so if two devices edit while
  offline, the last one to save wins.
- **Updates:** a service worker keeps a copy of the app for offline use. It
  always tries the network first, so a new deploy shows on the next load.

## Data schema (`schedule.json`)

```json
{
  "habits": [
    { "id": "r1", "name": "Workout" }
  ],
  "tasks": [
    { "id": "t1", "name": "Write report", "priority": "max",
      "estimateMin": 360, "deadline": "2026-09-30", "done": false }
  ],
  "log": [
    { "date": "2026-09-24", "itemId": "t1", "start": "14:05", "end": "16:10" },
    { "date": "2026-09-24", "itemId": "r1", "start": "07:30", "end": "07:30" }
  ],
  "hours": { "workStart": "12:00", "workEnd": "24:00" }
}
```

| Field | Where | Meaning |
|---|---|---|
| `id` | habits, tasks | Short unique identifier |
| `name` | habits, tasks | Display name |
| `priority` | tasks | `max`, `med`, or `low` |
| `estimateMin` | tasks | Estimated total time to complete, in minutes |
| `deadline` | tasks | Required, `YYYY-MM-DD`; the task is due by the end of that day |
| `done` | tasks | Whether the task is finished |
| `date` | log | The local date, `YYYY-MM-DD`, the session happened on |
| `itemId` | log | The task or habit's `id` |
| `start` | log | Session start time, `HH:MM`, local |
| `end` | log | Session end time, `HH:MM`; omitted while the session is still running |
| `workStart`, `workEnd` | hours | Daily work window, `HH:MM`; `workEnd` may be `24:00`. Optional; defaults 12:00-24:00 |

Each `log` entry is one work session or habit check-off. A task's logged time is
the sum of its ended sessions; a habit counts as done for a day once it has an
ended entry that day (a check-off is a zero-length entry). Older data with a
`routine` list instead of `habits` still loads: its items become habits, keeping
their history, and the next save writes them as `habits`.

## Development

- Run the tests: `npm test` (or `node --test`).
- Serve locally: `python3 -m http.server`, then open `http://localhost:8000/`.
- `?sample` loads the sample `schedule.json` from this repo directly,
  read-only, with no Gist needed — useful for trying the app or taking
  screenshots.
- `?now=2026-09-24T15:00` freezes the clock at that local date and time,
  instead of using the real current time.

## Files

- `index.html` - page structure: Now/Next card, habit tracker, Gantt chart, at-risk list, stats section, and the settings dialog.
- `app.js` - app logic: state, rendering, the Start/Pause/Done actions, the editor, and wiring for sync.
- `scheduler.js` - the pure scheduling algorithm: builds the plan and picks the current/next item.
- `sync.js` - reads and writes `schedule.json` via the GitHub Gist API, with a localStorage cache and offline fallback.
- `stats.js` - computes daily habit-completion percentages and streaks, and draws the stats chart.
- `sw.js` - service worker that caches the app's files for offline use.
- `style.css` - main styling and theme tokens (light/dark).
- `stats.css` - styling for the Stats view.
- `schedule.json` - sample data, also used by `?sample`.
- `mockup.html` - the original visual mockup the app's styling is based on.
- `PLAN.md` - the implementation plan and design decisions behind this app.
- `package.json` - project metadata and the `npm test` script.
- `test/` - automated tests (`node --test`) for the scheduler, stats, and sync modules.
