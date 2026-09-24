# Implementation plan: Dashboard

Status: **approved. Building.**

## Scope

**In:**
- Priority and deadline task scheduling (strategy 3)
- Morning routine
- Now / Next card
- Start / Pause / Done buttons
- Multi-day Gantt chart
- Editor
- Gist sync with offline cache
- Stats page for daily routine %
- Fake clock (`?now=`)
- README

**Out:**
- iPhone widget
- 90-minute blocks, breaks, and the Admin batch
- New-tab page and extension
- Add to Home Screen (manifest and icons)

**Theme:** the tokens and components from `mockup.html`, reused as they are.

---

## 1. Decisions (recommended defaults, accepted 2026-09-24)

1. Light and dark follow the system, using the mockup's palettes.
2. Weekend rule: a non-max task is weekend-eligible only if weekday hours alone can't finish it by its deadline.
3. Pause button: ends a session without marking the task done. Remaining = estimate − logged minutes.
4. Routine starts at 06:00 every day, including weekends.

---

## 2. Assumptions (veto any)

1. **Deadlines** are dates only and mean the end of that day (24:00). A deadline is required.
2. **Task hours:** Mon–Fri 12:00–24:00. On Sat and Sun, the same hours, but only for tasks that pass
   the weekend rule. Routine: 06:00 onward, back to back, in the order you set, every day.
3. **Planning starts from now.** Every render plans the remaining work from the current time:
   - A started task keeps its actual start time.
   - Everything else follows it. Finishing early pulls later tasks forward. Running over pushes them back.
   - Until you press Start, the top task shows as "Now" with its full estimate. The countdown begins
     at Start.
4. **Tie-breaks,** in order: priority (max > med > low), earliest deadline, shortest estimate, list order.
5. **At-risk tasks** are ones that can't meet their deadline even with the best ordering. They're
   still scheduled at the end, and marked "late" in the Gantt and in an At-risk list.
6. **Routine %** for a day = routine items logged Done that day ÷ current number of routine items.
   Days before the first log entry are not shown.
7. **Sync:** one `schedule.json` in a secret Gist. The web app reads and writes it with a token that
   has only the gist scope, stored in localStorage on that device only.
   - The page renders from cache immediately.
   - It refetches on load and when the tab regains focus (at most once a minute).
   - It re-renders every 30 s.
   - Writes fetch fresh data, apply the change, then save. Between devices, the last write wins.
8. **Offline:** a service worker caches the page files, the data comes from the localStorage cache,
   and the page shows "Offline · last synced HH:MM". Start, Pause, Done, and Save are disabled while
   offline.
9. **Times:** 24-hour format, device's local time zone.
10. **Fake clock:** `?now=` freezes time.
11. **Reordering** uses up/down buttons.
12. **Git:** local repo, one commit per wave, no push without your go-ahead.
13. **Token entry:** you paste the token into settings yourself. I'm not allowed to type tokens.

---

## 3. Scheduling algorithm (strategy 3: priority with a deadline check)

1. **Available time:** build a calendar of free work time from now onward, using the task hours in
   assumption 2. Weekend time only counts for tasks allowed on weekends.
2. **Check what's achievable:** order the tasks by deadline and simulate them on that calendar. While
   some task would be late, remove the lowest-priority task that is due by the first late deadline
   (ties: the longest). Removed tasks become **at-risk**.
3. **Build the order:** at each step, try the remaining tasks from highest priority down (tie-breaks
   from assumption 2.4). Pick the first one where, after doing it, the rest still meets all deadlines
   in deadline order.
4. **At-risk tasks** go at the end, ordered by priority, then deadline.
5. **Calendar placement:** place the tasks into the available time in that order. A task that doesn't
   fit in one day continues at the next allowed slot.

Once a task starts, the algorithm doesn't interrupt it for another task. The whole thing is roughly
60 lines, and n < 100 tasks, so performance doesn't matter.

**Example:** it's Mon 12:00.

| Task | Estimate | Priority | Due |
|---|---|---|---|
| Report | 16h | max | Fri |
| Slides | 10h | med | Tue |
| Pay bill | 0.5h | low | Mon |

- Report can't go first, because Pay bill would be late.
- Slides can go first safely, and it outranks Pay bill.
- Result: Slides, then Pay bill, then Report. All on time.

---

## 4. Data schema (`schedule.json`)

```json
{
  "routine": [{ "id": "r1", "name": "Workout", "durationMin": 45 }],
  "tasks": [{ "id": "t1", "name": "Write report", "priority": "max",
              "estimateMin": 360, "deadline": "2026-09-30", "done": false }],
  "log": [{ "date": "2026-09-24", "itemId": "t1", "start": "14:05", "end": "16:10" }]
}
```

- Each log entry is one work session. `end` is missing while the session is running.
- A routine item counts as done when it has a session that ended that day.

---

## 5. Module contract (exact; the parallel agents build against this)

### Conventions
- A "min" is epoch minutes: `Math.floor(date.getTime() / 60000)`. Plans use epoch minutes for `start`/`end`.
- Local time zone throughout. Date strings are `YYYY-MM-DD` (local). Log times are `HH:MM` (local, on the log's date).
- A deadline `D` ends at local midnight at the start of the day after `D`. A task is late if its last item ends after that.
- Priority rank: max = 0, med = 1, low = 2 (lower goes first).

### `scheduler.js` (ES module, pure: no DOM, no storage, no fetch, no dependencies)

```js
export function buildPlan(data, now /* Date */) → {
  items: Item[],     // sorted by start, never overlapping
  atRisk: [{ id, name, deadline }]
}
// Item = { kind: "routine"|"task", id, name, start, end,          // epoch min, [start, end)
//          priority?, deadline?, late?: boolean, running?: boolean } // task-only fields
export function nowAndNext(plan, now /* Date */) → {
  now: Item|null, next: Item|null,
  mode: "routine"|"tasks"|"free"|"off",
  minutesLeft: number|null, progress: number|null   // 0..1
}
```

**Horizon:** from today through the later of tomorrow and the last day that has a task item.

**Routine items:**
- On every horizon day, routine items run back to back from 06:00 in list order, at fixed times.
- Past routine items stay in the plan.
- A routine item that would end after 12:00 is dropped.

**Task time:**
- Windows are [12:00, 24:00) on every day.
- Sat and Sun windows are usable only by weekend-eligible tasks.
- Nothing is placed before `now`.

**Remaining time:**
- Logged minutes = the sum of ended sessions (`end` − `start`) for that task, across all dates.
- `remaining = max(estimateMin − logged, 15)`.
- Tasks with `done: true` are ignored.

**Running task:**
- A running task has a log entry dated today with no `end`. At most one entry is running.
- It is placed first, starting at its session start, with duration = its remaining time.
- If that would end at or before `now`, it ends at `nowMin + 1` instead (so it stays "now"). It is marked `running: true`.
- It is not subject to the ordering below and never goes to at-risk.
- If it's a routine item, the routine item's time is left as is. Running only matters for tasks.
- The next task starts at the later of the running task's end and `now`.

**Weekend eligibility:**
- Max-priority tasks are always eligible.
- Otherwise: simulate all open tasks in deadline order using weekday windows only. Any task that
  comes out late is eligible.

**Simulation `simulate(order)`:**
- Walk a cursor through the windows the task may use, placing each task's remaining minutes.
- Tasks split across windows or days as needed. A task never interrupts another.
- The cursor never goes backward. An ineligible task skips weekend time; that time is lost to it.

**Ordering:**
1. The deadline order sorts by deadline, then priority rank, then list index.
2. Check what's achievable. While `simulate(deadline order of the feasible set)` has a late task:
   - Among the tasks up to and including the first late one, remove the one with the worst priority
     (ties: largest remaining, then highest list index).
   - Mark it at-risk.
3. Build the order greedily. Candidates are sorted by priority rank, then deadline, then remaining,
   then list index.
   - Pick the first candidate `c` where `simulate([...chosen, c, ...deadlineOrder(rest)])` has no
     late task among the feasible set.
   - If none qualifies, take the first in deadline order.
4. At-risk tasks go at the end, sorted by priority rank, then deadline.
5. Place the final order with `simulate`. Set `late` on every item of a task whose last item ends
   after its deadline.

**`nowAndNext`:**
- `now` = the item with `start ≤ nowMin < end`.
- `mode`:
  - `"routine"` or `"tasks"` from the kind of `now`.
  - Otherwise `"free"` if the local hour is ≥ 6.
  - Else `"off"`.
- `next` = the first item whose start is ≥ (`now ? now.end : nowMin`) and which isn't `now`.
- `minutesLeft = now.end − nowMin` and `progress = (nowMin − now.start)/(now.end − now.start)`.
  Both are null when there's no `now`.

### `stats.js`

```js
export function routineByDay(data, today /* Date */, days = 30) → [{ date: "YYYY-MM-DD", pct }]
// Oldest first. Covers the `days` days ending at today. Days before the earliest log date are omitted.
// pct = Math.round(100 × (number of distinct current routine ids with an ended session on that date)
//                  ÷ routine.length).
// Returns [] if the routine is empty.
export function renderStats(el, series)   // DOM-only. Draws an SVG bar chart (0–100%, one bar per day)
                                           // plus 7-day and 30-day averages. Uses the mockup tokens.
```

### `sync.js` (browser)

```js
export function getSettings() → { gistId, token }          // localStorage "tasks.gistId", "tasks.token"
export function setSettings({ gistId, token })
export async function loadData() → { data, syncedAt: Date|null, offline: boolean }
export async function saveData(mutate) → { data, syncedAt }
```

**`loadData`:**
- GET `https://api.github.com/gists/{gistId}` with `cache: "no-store"`. Send `Authorization: Bearer`
  only if there's a token.
- Parse `files["schedule.json"].content`.
- On success, cache `{ data, syncedAt }` under the localStorage key `tasks.cache`.
- On a network error (`fetch` rejects), return the cache with `offline: true`. If there's no cache,
  rethrow.
- On an HTTP error, throw an `Error` containing the status.

**`saveData`:**
- Fetch fresh data (as in `loadData`, but it must be online).
- `mutate(data)` changes the data in place.
- PATCH `{ files: { "schedule.json": { content: JSON.stringify(data, null, 2) } } }`.
- Update the cache.

### App hooks
- `?now=2026-09-24T15:00` freezes the clock.
- `?sample` loads `./schedule.json` read-only, with no Gist. This is used for local testing and screenshots.

## 6. UI (in the mockup's style)

- **Now card:**
  - A tag: "Morning routine", "Tasks", "Free time", or "Off".
  - Clock, task name, time slot, progress bar, and minutes left.
  - A mini strip of today's remaining items.
  - A "Next" row with the next item and its start time.
  - Start, Pause, and Done buttons.
- **Morning:** the routine checklist (done ✓, current ▶, pending ○) and "Routine · 3 of 5", as in
  the mockup.
- **Gantt:**
  - One row per day, from today until the last task, with hours 06–24 across.
  - Colors: routine segments in track gray, tasks in accent-bg, the current item in accent, and late
    tasks outlined.
  - A now-line on today's row.
- **At-risk list** below the Gantt.
- **Edit dialog:**
  - Tasks: name, estimate, priority, and deadline, with add, edit, delete, and up/down.
  - Routine items: same controls.
  - Settings: Gist ID and token.
  - An explicit Save button.
- **Stats view** (a tab next to Today):
  - A bar chart of daily routine % for the last 30 days.
  - 7-day and 30-day averages.
- **Layout:** works at 380 px and 1280 px wide. No emojis.

---

## 7. Execution waves

```
Wave 0  me       contract, package.json, sample data, git init
Wave 1  A scheduler │ B tests (blind) │ C sync + offline │ D UI │ E stats     (5 parallel)
Wave 2  me       integrate: node --test, resolve A/E vs B against the spec
                 (never by weakening tests), serve locally, smoke test
Wave 3  F README │ G spec reviewer (read-only) │ me: browser matrix          (parallel)
Wave 4  you + me live Gist round-trip, offline check, deploy to GitHub Pages
```

Models: A, B, D, and G on Opus. C, E, and F on Sonnet.

---

## 8. Verification

1. `node --test` passes, with no dependencies. It covers:
   - Priority ordering, and the deadline check overriding priority (the example in section 3).
   - At-risk detection.
   - Tie-breaks.
   - Multi-day carry-over.
   - The weekend rule.
   - Routine order.
   - Plan-from-now after Start, Pause, and Done.
   - `nowAndNext` at boundaries (06:00, 12:00, 24:00).
   - Routine % per day.
   - Sync load, save, and offline fallback (with a stubbed `fetch`).
2. Screenshots at `?now=` Thu 07:00, Thu 15:00, Sat 14:00, and Thu 23:30. Each one at 380 px and
   1280 px, in light and dark, plus the stats view.
3. Offline reload: the page files come from the service worker, and the data comes from the cache.
4. Live Gist round-trip with your test Gist and token: Start, Pause, Done, and an edit plus Save,
   confirmed by reading the Gist back.
5. Deploy: I prepare the repo. You create it on GitHub and push. Then we enable GitHub Pages.
