// Changes as plain objects ("ops"), so they can be queued in localStorage while offline and replayed onto the
// latest Gist data when back online. Every op is safe to apply twice (e.g. after a save landed but the page
// closed before the queue was cleared).

const yesterday = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  const p = new Date(y, m - 1, d - 1);
  return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, "0")}-${String(p.getDate()).padStart(2, "0")}`;
};
// Open session from today, or from yesterday if work ran past midnight
const runningEntry = (d, date) => d.log.find((e) => (e.date === date || e.date === yesterday(date)) && !e.end);

// Brings older data up to the current shape: a timed "routine" became habits
function normalize(d) {
  d.habits ||= (d.routine || []).map(({ id, name }) => ({ id, name }));
  delete d.routine;
  d.tasks ||= [];
  d.log ||= [];
}

export function applyOp(d, op) {
  normalize(d);
  if (op.type === "act") return applyAct(d, op);
  if (op.type === "habit") {
    const has = d.log.some((e) => e.date === op.date && e.itemId === op.id && e.end);
    if (op.done && !has) d.log.push({ date: op.date, itemId: op.id, start: op.time, end: op.time });
    if (!op.done) d.log = d.log.filter((e) => !(e.date === op.date && e.itemId === op.id));
  } else if (op.type === "addTask") {
    if (!d.tasks.some((t) => t.id === op.task.id)) d.tasks.push(op.task);
  } else if (op.type === "edit") {
    d.habits = op.habits;
    d.tasks = op.tasks;
    d.hours = op.hours;
  } else if (op.type === "taskbox") {
    const t = d.tasks.find((x) => x.id === op.id);
    if (!t) return;
    if (op.subtasks.length) t.subtasks = op.subtasks; else delete t.subtasks;
    if (op.notes) t.notes = op.notes; else delete t.notes;
  }
}

export function applyOps(d, ops) {
  normalize(d);
  for (const op of ops) applyOp(d, op);
  return d;
}

// Start / Pause / Done on an item at op.date, op.time
function applyAct(d, { kind, id, itemKind, date, time }) {
  let run = runningEntry(d, date);
  // Close sessions left open on earlier days at that day's end
  for (const e of d.log) if (!e.end && e.date < date && e !== run) e.end = "24:00";
  if (run && run.date !== date && kind !== "start") {
    // Split a session that ran past midnight into one entry per day
    run.end = "24:00";
    run = { date, itemId: run.itemId, start: "00:00" };
    d.log.push(run);
  }
  if (kind === "start") {
    if (!run && !d.log.some((e) => e.date === date && e.itemId === id && e.start === time)) d.log.push({ date, itemId: id, start: time });
    return;
  }
  const mine = run && run.itemId === id ? run : null;
  if (mine) mine.end = time;
  else if (kind === "done" && !d.log.some((e) => e.date === date && e.itemId === id && e.end === time)) {
    d.log.push({ date, itemId: id, start: time, end: time });
  }
  if (kind === "done" && itemKind === "task") {
    const task = d.tasks.find((x) => x.id === id);
    if (task && !task.done) { task.done = true; task.doneDate = date; }
  }
}
