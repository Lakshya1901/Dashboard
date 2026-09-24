// Pure scheduling logic. See PLAN.md sections 3 and 5.

const RANK = { max: 0, med: 1, low: 2 };
const toMin = (date) => Math.floor(date.getTime() / 60000);
const at = (day, h, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
const addDays = (day, n) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + n);
const dayOf = (min) => at(new Date(min * 60000), 0);
const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const hhmm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isWeekend = (day) => day.getDay() === 0 || day.getDay() === 6;

export const DEFAULT_HOURS = { workStart: "12:00", workEnd: "24:00" };

// Returns an error message for invalid hours ("HH:MM" strings), or "" if they're fine.
export function checkHours(h) {
  const ok = (s, max) => /^\d\d:\d\d$/.test(s || "") && +s.slice(3) < 60 && hhmm(s) <= max;
  if (!ok(h.workStart, 1439) || !ok(h.workEnd, 1440)) return "Times must be HH:MM.";
  if (hhmm(h.workStart) >= hhmm(h.workEnd)) return "Work hours must end after they start.";
  return "";
}

// The data's hours in minutes after midnight, falling back to the defaults if missing or invalid.
export function hoursOf(data) {
  const h = { ...DEFAULT_HOURS, ...(data.hours || {}) };
  const v = checkHours(h) ? DEFAULT_HOURS : h;
  return { workStart: hhmm(v.workStart), workEnd: hhmm(v.workEnd) };
}

// First usable slot [start, end) at or after `cursor` in the daily work windows.
function nextSlot(cursor, weekendOk, h) {
  for (let day = dayOf(cursor); ; day = addDays(day, 1)) {
    if (isWeekend(day) && !weekendOk) continue;
    const end = toMin(at(day, 0, h.workEnd));
    if (end > cursor) return [Math.max(toMin(at(day, 0, h.workStart)), cursor), end];
  }
}

// Places tasks in order from `startMin`. Returns [{ task, segs: [[s, e]], late }].
function simulate(order, startMin, weekendOk, h) {
  let cursor = startMin;
  return order.map((task) => {
    const segs = [];
    for (let need = task.remaining; need > 0; ) {
      const [s, e] = nextSlot(cursor, weekendOk(task), h);
      const take = Math.min(need, e - s);
      segs.push([s, s + take]);
      cursor = s + take;
      need -= take;
    }
    return { task, segs, late: segs.length > 0 && segs[segs.length - 1][1] > task.deadlineMin };
  });
}

const byDeadline = (a, b) => a.deadlineMin - b.deadlineMin || a.rank - b.rank || a.index - b.index;
const deadlineOrder = (tasks) => [...tasks].sort(byDeadline);

export function buildPlan(data, now) {
  const nowMin = toMin(now);
  const today = at(now, 0);
  const todayKey = ymd(today);
  const log = data.log || [];
  const h = hoursOf(data);

  const logged = {};
  for (const e of log) {
    if (e.end) logged[e.itemId] = (logged[e.itemId] || 0) + hhmm(e.end) - hhmm(e.start);
  }

  const open = [];
  (data.tasks || []).forEach((t, index) => {
    if (t.done) return;
    open.push({
      ...t, index,
      rank: RANK[t.priority] ?? 2,
      deadlineMin: toMin(addDays(parseDate(t.deadline), 1)),
      remaining: Math.max(t.estimateMin - (logged[t.id] || 0), 15),
    });
  });

  const taskItem = (task, s, e, late, running) => ({
    kind: "task", id: task.id, name: task.name, start: s, end: e,
    priority: task.priority, deadline: task.deadline, late, running,
  });

  // Running task: placed first, contiguous from its session start.
  const items = [];
  let startMin = nowMin;
  // An open session from yesterday means work carried on past midnight
  const yesterdayKey = ymd(addDays(today, -1));
  const session = log.find((e) => (e.date === todayKey || e.date === yesterdayKey) && !e.end);
  const running = session && open.find((t) => t.id === session.itemId);
  if (running) {
    const s = toMin(at(parseDate(session.date), 0, hhmm(session.start)));
    let e = s + running.remaining;
    if (e <= nowMin) e = nowMin + 1;
    items.push(taskItem(running, s, e, e > running.deadlineMin, true));
    startMin = Math.max(e, nowMin);
  }
  const rest = open.filter((t) => t !== running);

  // Weekend eligibility: max always; others if late using weekday windows only.
  const eligible = new Set(rest.filter((t) => t.rank === 0));
  for (const r of simulate(deadlineOrder(rest), startMin, () => false, h)) {
    if (r.late) eligible.add(r.task);
  }
  const sim = (order) => simulate(order, startMin, (t) => eligible.has(t), h);

  // Check what's achievable: drop worst tasks until the deadline order has no late task.
  let feasible = rest;
  const atRisk = [];
  for (;;) {
    const res = sim(deadlineOrder(feasible));
    const k = res.findIndex((r) => r.late);
    if (k < 0) break;
    const worst = res.slice(0, k + 1).map((r) => r.task).reduce((w, t) =>
      t.rank > w.rank || (t.rank === w.rank &&
        (t.remaining > w.remaining || (t.remaining === w.remaining && t.index > w.index))) ? t : w);
    feasible = feasible.filter((t) => t !== worst);
    atRisk.push(worst);
  }

  // Greedy order: best-ranked candidate that keeps the rest on time.
  const chosen = [];
  let left = feasible;
  while (left.length) {
    const candidates = [...left].sort((a, b) =>
      a.rank - b.rank || a.deadlineMin - b.deadlineMin || a.remaining - b.remaining || a.index - b.index);
    const pick = candidates.find((c) =>
      !sim([...chosen, c, ...deadlineOrder(left.filter((t) => t !== c))]).some((r) => r.late))
      || deadlineOrder(left)[0];
    chosen.push(pick);
    left = left.filter((t) => t !== pick);
  }
  atRisk.sort((a, b) => a.rank - b.rank || a.deadlineMin - b.deadlineMin || a.index - b.index);

  for (const r of sim([...chosen, ...atRisk])) {
    for (const [s, e] of r.segs) items.push(taskItem(r.task, s, e, r.late, false));
  }

  items.sort((a, b) => a.start - b.start);
  return { items, atRisk: atRisk.map((t) => ({ id: t.id, name: t.name, deadline: t.deadline })) };
}

export function nowAndNext(plan, now, h = hoursOf({})) {
  const nowMin = toMin(now);
  const cur = plan.items.find((it) => it.start <= nowMin && nowMin < it.end) || null;
  const from = cur ? cur.end : nowMin;
  const next = plan.items.find((it) => it !== cur && it.start >= from) || null;
  return {
    now: cur,
    next,
    mode: cur ? "tasks" : now.getHours() * 60 + now.getMinutes() >= h.workStart ? "free" : "off",
    minutesLeft: cur ? cur.end - nowMin : null,
    progress: cur ? (nowMin - cur.start) / (cur.end - cur.start) : null,
  };
}
