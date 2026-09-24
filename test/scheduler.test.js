// Tests for scheduler.js, written blind from PLAN.md sections 3-5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, nowAndNext, checkHours, hoursOf } from '../scheduler.js';

// ---------- helpers ----------
// All dates are September 2026 (local time). 2026-09-21 is a Monday.
const at = (day, hh, mm = 0) => new Date(2026, 8, day, hh, mm);
const m = (day, hh, mm = 0) => Math.floor(at(day, hh, mm).getTime() / 60000);

const task = (id, priority, estimateMin, deadline, extra = {}) =>
  ({ id, name: extra.name ?? id.toUpperCase(), priority, estimateMin, deadline, done: false, ...extra });
// Most tests use the original 12:00-24:00 weekday window with weekends only when needed
const OLD_HOURS = { workStart: '12:00', workEnd: '24:00', weekends: 'needed' };
const data = ({ tasks = [], log = [], hours = OLD_HOURS } = {}) => ({ tasks, log, hours });
const H12 = hoursOf(data());

const taskItems = (plan) => plan.items.filter((i) => i.kind === 'task');
const spans = (plan, id) => taskItems(plan).filter((i) => i.id === id).map((i) => [i.start, i.end]);
// Order of tasks as placed (consecutive duplicates from multi-day splits collapsed).
const taskOrder = (plan) =>
  taskItems(plan).map((i) => i.id).filter((id, k, a) => k === 0 || a[k - 1] !== id);
const dayOf = (min) => new Date(min * 60000).getDay(); // 0 Sun .. 6 Sat

function assertSortedNonOverlapping(plan) {
  for (let k = 0; k < plan.items.length; k++) {
    const it = plan.items[k];
    assert.ok(it.start < it.end, `item ${k} (${it.id}) has start < end`);
    if (k > 0) {
      const prev = plan.items[k - 1];
      assert.ok(prev.start <= it.start, `items sorted by start at ${k}`);
      assert.ok(prev.end <= it.start, `items ${k - 1} (${prev.id}) and ${k} (${it.id}) do not overlap`);
    }
  }
}

// ---------- ordering ----------

test('priority ordering when there is no deadline pressure (max > med > low)', () => {
  const d = data({
    tasks: [
      task('low', 'low', 60, '2026-09-30'),
      task('med', 'med', 60, '2026-09-30'),
      task('max', 'max', 60, '2026-09-30'),
    ],
  });
  const plan = buildPlan(d, at(21, 12));
  assert.deepEqual(taskOrder(plan), ['max', 'med', 'low']);
  assert.deepEqual(spans(plan, 'max'), [[m(21, 12), m(21, 13)]]);
  assert.deepEqual(spans(plan, 'med'), [[m(21, 13), m(21, 14)]]);
  assert.deepEqual(spans(plan, 'low'), [[m(21, 14), m(21, 15)]]);
  assert.deepEqual(plan.atRisk, []);
});

test('PLAN section 3 example: Slides, then Pay bill, then Report, none late', () => {
  const d = data({
    tasks: [
      task('report', 'max', 16 * 60, '2026-09-25', { name: 'Report' }), // Fri
      task('slides', 'med', 10 * 60, '2026-09-22', { name: 'Slides' }), // Tue
      task('bill', 'low', 30, '2026-09-21', { name: 'Pay bill' }), // Mon
    ],
  });
  const plan = buildPlan(d, at(21, 12)); // Mon 12:00
  assert.deepEqual(taskOrder(plan), ['slides', 'bill', 'report']);
  assert.deepEqual(spans(plan, 'slides'), [[m(21, 12), m(21, 22)]]);
  assert.deepEqual(spans(plan, 'bill'), [[m(21, 22), m(21, 22, 30)]]);
  assert.deepEqual(spans(plan, 'report'), [
    [m(21, 22, 30), m(22, 0)],
    [m(22, 12), m(23, 0)],
    [m(23, 12), m(23, 14, 30)],
  ]);
  assert.ok(taskItems(plan).every((i) => !i.late), 'no item is late');
  assert.deepEqual(plan.atRisk, []);
  assertSortedNonOverlapping(plan);
});

test('task items carry priority and deadline', () => {
  const plan = buildPlan(data({ tasks: [task('a', 'med', 60, '2026-09-30')] }), at(21, 12));
  const [it] = taskItems(plan);
  assert.equal(it.kind, 'task');
  assert.equal(it.id, 'a');
  assert.equal(it.name, 'A');
  assert.equal(it.priority, 'med');
  assert.equal(it.deadline, '2026-09-30');
});

// ---------- at-risk ----------

test('at-risk: infeasible set drops the lowest priority task, appends it at the end marked late', () => {
  const d = data({
    tasks: [task('a', 'max', 600, '2026-09-21'), task('b', 'low', 600, '2026-09-21', { name: 'B' })],
  });
  const plan = buildPlan(d, at(21, 12));
  assert.deepEqual(taskOrder(plan), ['a', 'b']);
  assert.deepEqual(spans(plan, 'a'), [[m(21, 12), m(21, 22)]]);
  assert.deepEqual(spans(plan, 'b'), [
    [m(21, 22), m(22, 0)],
    [m(22, 12), m(22, 20)],
  ]);
  assert.ok(taskItems(plan).filter((i) => i.id === 'a').every((i) => !i.late), 'a is on time');
  assert.ok(taskItems(plan).filter((i) => i.id === 'b').every((i) => i.late === true), 'every b item is late');
  assert.deepEqual(plan.atRisk, [{ id: 'b', name: 'B', deadline: '2026-09-21' }]);
});

test('at-risk: removes worst priority among tasks up to the first late one, even if it is not the late one', () => {
  // Deadline order L(Mon), M(Tue), N(Tue). N comes out late; L (low) is removed.
  const d = data({
    tasks: [
      task('l', 'low', 60, '2026-09-21'),
      task('m', 'max', 700, '2026-09-22'),
      task('n', 'max', 720, '2026-09-22'),
    ],
  });
  const plan = buildPlan(d, at(21, 12));
  assert.deepEqual(taskOrder(plan), ['m', 'n', 'l']);
  assert.deepEqual(spans(plan, 'm'), [[m(21, 12), m(21, 23, 40)]]);
  assert.deepEqual(spans(plan, 'n'), [
    [m(21, 23, 40), m(22, 0)],
    [m(22, 12), m(22, 23, 40)],
  ]);
  assert.deepEqual(spans(plan, 'l'), [
    [m(22, 23, 40), m(23, 0)],
    [m(23, 12), m(23, 12, 40)],
  ]);
  assert.deepEqual(plan.atRisk.map((r) => r.id), ['l']);
  assert.ok(taskItems(plan).filter((i) => i.id !== 'l').every((i) => !i.late));
  assert.ok(taskItems(plan).filter((i) => i.id === 'l').every((i) => i.late === true));
});

test('at-risk removal tie-break: same priority -> largest remaining is removed', () => {
  const d = data({
    tasks: [task('p', 'low', 500, '2026-09-21'), task('q', 'low', 400, '2026-09-21')],
  });
  const plan = buildPlan(d, at(21, 12));
  assert.deepEqual(plan.atRisk.map((r) => r.id), ['p']);
  assert.deepEqual(spans(plan, 'q'), [[m(21, 12), m(21, 18, 40)]]);
  assert.deepEqual(spans(plan, 'p'), [
    [m(21, 18, 40), m(22, 0)],
    [m(22, 12), m(22, 15)],
  ]);
});

test('at-risk removal tie-break: same priority and remaining -> highest list index is removed', () => {
  const d = data({
    tasks: [task('p', 'low', 400, '2026-09-21'), task('q', 'low', 400, '2026-09-21')],
  });
  const plan = buildPlan(d, at(21, 12));
  assert.deepEqual(plan.atRisk.map((r) => r.id), ['q']);
  assert.deepEqual(spans(plan, 'p'), [[m(21, 12), m(21, 18, 40)]]);
  assert.deepEqual(spans(plan, 'q'), [
    [m(21, 18, 40), m(22, 0)],
    [m(22, 12), m(22, 13, 20)],
  ]);
});

test('multiple at-risk tasks go at the end ordered by priority', () => {
  // All due Mon. F (max) fills Mon; H (med) and G (low) are both at risk.
  const d = data({
    tasks: [
      task('g', 'low', 60, '2026-09-21'),
      task('h', 'med', 60, '2026-09-21'),
      task('f', 'max', 720, '2026-09-21'),
    ],
  });
  const plan = buildPlan(d, at(21, 12));
  assert.deepEqual(taskOrder(plan), ['f', 'h', 'g']);
  assert.deepEqual(plan.atRisk.map((r) => r.id).sort(), ['g', 'h']);
  assert.deepEqual(spans(plan, 'f'), [[m(21, 12), m(22, 0)]]);
  assert.deepEqual(spans(plan, 'h'), [[m(22, 12), m(22, 13)]]);
  assert.deepEqual(spans(plan, 'g'), [[m(22, 13), m(22, 14)]]);
});

// ---------- tie-breaks in greedy ordering ----------

test('tie-break: same priority -> earliest deadline first', () => {
  const d = data({
    tasks: [task('later', 'med', 60, '2026-09-30'), task('sooner', 'med', 60, '2026-09-29')],
  });
  assert.deepEqual(taskOrder(buildPlan(d, at(21, 12))), ['sooner', 'later']);
});

test('tie-break: same priority and deadline -> shortest remaining first', () => {
  const d = data({
    tasks: [task('long', 'med', 120, '2026-09-30'), task('short', 'med', 60, '2026-09-30')],
  });
  assert.deepEqual(taskOrder(buildPlan(d, at(21, 12))), ['short', 'long']);
});

test('tie-break uses remaining (estimate minus logged), not raw estimate', () => {
  const d = data({
    tasks: [task('b', 'med', 60, '2026-09-30'), task('a', 'med', 120, '2026-09-30')],
    log: [{ date: '2026-09-18', itemId: 'a', start: '13:00', end: '14:30' }], // a: 30 left
  });
  const plan = buildPlan(d, at(21, 12));
  assert.deepEqual(taskOrder(plan), ['a', 'b']);
  assert.deepEqual(spans(plan, 'a'), [[m(21, 12), m(21, 12, 30)]]);
});

test('tie-break: everything equal -> list order', () => {
  const d = data({
    tasks: [
      task('first', 'low', 60, '2026-09-30'),
      task('second', 'low', 60, '2026-09-30'),
      task('third', 'low', 60, '2026-09-30'),
    ],
  });
  assert.deepEqual(taskOrder(buildPlan(d, at(21, 12))), ['first', 'second', 'third']);
});

// ---------- placement ----------

test('multi-day carry-over: a long task splits into same-id items on consecutive days', () => {
  const d = data({ tasks: [task('big', 'max', 1500, '2026-09-30')] });
  const plan = buildPlan(d, at(21, 12));
  const items = taskItems(plan);
  assert.ok(items.every((i) => i.id === 'big'));
  assert.deepEqual(spans(plan, 'big'), [
    [m(21, 12), m(22, 0)],
    [m(22, 12), m(23, 0)],
    [m(23, 12), m(23, 13)],
  ]);
});

test('carry-over from mid-window continues at next day 12:00', () => {
  const d = data({ tasks: [task('t', 'med', 300, '2026-09-30')] });
  const plan = buildPlan(d, at(21, 20));
  assert.deepEqual(spans(plan, 't'), [
    [m(21, 20), m(22, 0)],
    [m(22, 12), m(22, 13)],
  ]);
});

test('nothing is placed before now (mid-window)', () => {
  const d = data({ tasks: [task('t', 'med', 60, '2026-09-30')] });
  const plan = buildPlan(d, at(21, 15, 30));
  assert.deepEqual(spans(plan, 't'), [[m(21, 15, 30), m(21, 16, 30)]]);
});

test('before 12:00 tasks wait for the 12:00 window', () => {
  const d = data({ tasks: [task('t', 'med', 60, '2026-09-30')] });
  const plan = buildPlan(d, at(21, 9));
  assert.deepEqual(spans(plan, 't'), [[m(21, 12), m(21, 13)]]);
});

test('at 23:30 a task gets 30 min today and the rest tomorrow', () => {
  const d = data({ tasks: [task('t', 'max', 60, '2026-09-30')] });
  const plan = buildPlan(d, at(21, 23, 30));
  assert.deepEqual(spans(plan, 't'), [
    [m(21, 23, 30), m(22, 0)],
    [m(22, 12), m(22, 12, 30)],
  ]);
});

// ---------- weekend rule (Fri 2026-09-25, Sat 26, Sun 27, Mon 28) ----------

test('weekend: low task that can finish on weekdays is not placed on Sat/Sun', () => {
  const d = data({ tasks: [task('low', 'low', 120, '2026-09-29')] });
  const plan = buildPlan(d, at(25, 23));
  assert.deepEqual(spans(plan, 'low'), [
    [m(25, 23), m(26, 0)],
    [m(28, 12), m(28, 13)],
  ]);
  assert.ok(taskItems(plan).every((i) => dayOf(i.start) !== 0 && dayOf(i.start) !== 6));
});

test('weekend: max task always uses Saturday', () => {
  const d = data({ tasks: [task('max', 'max', 120, '2026-09-29')] });
  const plan = buildPlan(d, at(25, 23));
  assert.deepEqual(spans(plan, 'max'), [
    [m(25, 23), m(26, 0)],
    [m(26, 12), m(26, 13)],
  ]);
});

test('weekend: non-max task that cannot finish on weekdays alone is weekend-eligible', () => {
  const d = data({ tasks: [task('med', 'med', 120, '2026-09-27')] }); // due Sunday
  const plan = buildPlan(d, at(25, 23));
  assert.deepEqual(spans(plan, 'med'), [
    [m(25, 23), m(26, 0)],
    [m(26, 12), m(26, 13)],
  ]);
  assert.ok(taskItems(plan).every((i) => !i.late));
  assert.deepEqual(plan.atRisk, []);
});

test('weekend: ineligible task after a weekend task skips to Monday (cursor never goes back)', () => {
  const d = data({
    tasks: [task('max', 'max', 120, '2026-10-02'), task('low', 'low', 60, '2026-10-02')],
  });
  const plan = buildPlan(d, at(25, 23));
  assert.deepEqual(taskOrder(plan), ['max', 'low']);
  assert.deepEqual(spans(plan, 'max'), [
    [m(25, 23), m(26, 0)],
    [m(26, 12), m(26, 13)],
  ]);
  assert.deepEqual(spans(plan, 'low'), [[m(28, 12), m(28, 13)]]);
});

// ---------- remaining / done ----------

test('done tasks are ignored', () => {
  const d = data({
    tasks: [
      task('done', 'max', 60, '2026-09-30', { done: true }),
      task('open', 'low', 60, '2026-09-30'),
    ],
    log: [{ date: '2026-09-21', itemId: 'done', start: '12:00', end: '12:30' }],
  });
  const plan = buildPlan(d, at(21, 14));
  assert.deepEqual(taskOrder(plan), ['open']);
  assert.ok(plan.items.every((i) => i.id !== 'done'));
  assert.deepEqual(plan.atRisk, []);
});

test('remaining = estimate minus ended sessions across all dates (after Pause)', () => {
  const d = data({
    tasks: [task('t', 'med', 120, '2026-09-30')],
    log: [
      { date: '2026-09-18', itemId: 't', start: '13:00', end: '13:30' }, // 30
      { date: '2026-09-21', itemId: 't', start: '12:00', end: '12:45' }, // 45
    ],
  });
  const plan = buildPlan(d, at(21, 14));
  assert.deepEqual(spans(plan, 't'), [[m(21, 14), m(21, 14, 45)]]);
  assert.ok(taskItems(plan).every((i) => !i.running));
});

test('remaining has a 15 minute floor', () => {
  const d = data({
    tasks: [task('t', 'med', 60, '2026-09-30')],
    log: [{ date: '2026-09-21', itemId: 't', start: '12:00', end: '13:30' }], // 90 > 60
  });
  const plan = buildPlan(d, at(21, 14));
  assert.deepEqual(spans(plan, 't'), [[m(21, 14), m(21, 14, 15)]]);
});

test('remaining floor applies when logged equals estimate exactly', () => {
  const d = data({
    tasks: [task('t', 'med', 60, '2026-09-30')],
    log: [{ date: '2026-09-21', itemId: 't', start: '12:00', end: '13:00' }],
  });
  const plan = buildPlan(d, at(21, 14));
  assert.deepEqual(spans(plan, 't'), [[m(21, 14), m(21, 14, 15)]]);
});

// ---------- running task ----------

test('running task is placed first from its session start, marked running, others follow', () => {
  const d = data({
    tasks: [task('x', 'max', 60, '2026-09-30'), task('run', 'low', 120, '2026-09-30')],
    log: [{ date: '2026-09-21', itemId: 'run', start: '13:30' }],
  });
  const plan = buildPlan(d, at(21, 14));
  const items = taskItems(plan);
  assert.equal(items[0].id, 'run');
  assert.equal(items[0].running, true);
  assert.deepEqual(spans(plan, 'run'), [[m(21, 13, 30), m(21, 15, 30)]]);
  assert.deepEqual(spans(plan, 'x'), [[m(21, 15, 30), m(21, 16, 30)]]);
  assert.ok(items.filter((i) => i.id === 'x').every((i) => !i.running));
  assertSortedNonOverlapping(plan);
});

test('running task duration is its remaining time (prior ended sessions subtracted)', () => {
  const d = data({
    tasks: [task('run', 'med', 120, '2026-09-30')],
    log: [
      { date: '2026-09-21', itemId: 'run', start: '12:00', end: '12:30' },
      { date: '2026-09-21', itemId: 'run', start: '13:00' },
    ],
  });
  const plan = buildPlan(d, at(21, 14));
  assert.deepEqual(spans(plan, 'run'), [[m(21, 13), m(21, 14, 30)]]);
});

test('overrunning running task ends at nowMin + 1 and the next task starts there', () => {
  const d = data({
    tasks: [task('x', 'max', 60, '2026-09-30'), task('run', 'low', 60, '2026-09-30')],
    log: [{ date: '2026-09-21', itemId: 'run', start: '12:30' }], // would end 13:30 < now
  });
  const plan = buildPlan(d, at(21, 14));
  assert.deepEqual(spans(plan, 'run'), [[m(21, 12, 30), m(21, 14) + 1]]);
  assert.equal(taskItems(plan)[0].running, true);
  assert.deepEqual(spans(plan, 'x'), [[m(21, 14) + 1, m(21, 15) + 1]]);
});

test('running task that would end exactly at now also ends at nowMin + 1', () => {
  const d = data({
    tasks: [task('run', 'low', 60, '2026-09-30')],
    log: [{ date: '2026-09-21', itemId: 'run', start: '13:00' }],
  });
  const plan = buildPlan(d, at(21, 14));
  assert.deepEqual(spans(plan, 'run'), [[m(21, 13), m(21, 14) + 1]]);
});

test('running task never goes to at-risk', () => {
  const d = data({
    tasks: [task('run', 'low', 60, '2026-09-20')], // deadline already passed
    log: [{ date: '2026-09-21', itemId: 'run', start: '13:30' }],
  });
  const plan = buildPlan(d, at(21, 14));
  assert.deepEqual(plan.atRisk, []);
  assert.deepEqual(spans(plan, 'run'), [[m(21, 13, 30), m(21, 14, 30)]]);
  assert.equal(taskItems(plan)[0].running, true);
});

test('habits never appear in the plan and their check-offs do not affect tasks', () => {
  const d = { ...data({
    tasks: [task('t', 'med', 60, '2026-09-30')],
    log: [{ date: '2026-09-21', itemId: 'h1', start: '08:00', end: '08:00' }],
  }), habits: [{ id: 'h1', name: 'Read' }] };
  const plan = buildPlan(d, at(21, 8));
  assert.deepEqual(plan.items.map((i) => i.kind), ['task']);
  assert.deepEqual(spans(plan, 't'), [[m(21, 12), m(21, 13)]]);
});

test('mixed plan is sorted by start and never overlaps', () => {
  const d = data({
    tasks: [
      task('report', 'max', 960, '2026-09-25'),
      task('slides', 'med', 600, '2026-09-22'),
      task('bill', 'low', 30, '2026-09-21'),
    ],
  });
  const plan = buildPlan(d, at(21, 5));
  assertSortedNonOverlapping(plan);
  assert.ok(taskItems(plan).every((i) => i.start >= m(21, 12)));
});

// ---------- nowAndNext (hand-built plan) ----------

const item = (kind, id, start, end, extra = {}) => ({ kind, id, name: id, start, end, ...extra });
const handPlan = {
  items: [
    item('task', 't1', m(21, 12), m(21, 14), { priority: 'max', deadline: '2026-09-30' }),
    item('task', 't2', m(21, 14), m(21, 15), { priority: 'med', deadline: '2026-09-30' }),
    item('task', 't3', m(22, 12), m(22, 13), { priority: 'low', deadline: '2026-09-30' }),
  ],
  atRisk: [],
};
const [T1, T2, T3] = handPlan.items;

test('nowAndNext at 12:00: task is now, mode tasks', () => {
  const r = nowAndNext(handPlan, at(21, 12));
  assert.deepEqual(r, { now: T1, next: T2, mode: 'tasks', minutesLeft: 120, progress: 0 });
  const mid = nowAndNext(handPlan, at(21, 13, 30));
  assert.equal(mid.minutesLeft, 30);
  assert.equal(mid.progress, 0.75);
});

test('nowAndNext at an item end: now is the next item (end is exclusive)', () => {
  const r = nowAndNext(handPlan, at(21, 14));
  assert.deepEqual(r, { now: T2, next: T3, mode: 'tasks', minutesLeft: 60, progress: 0 });
});

test('nowAndNext before work starts is off with next = first task', () => {
  const r = nowAndNext(handPlan, at(21, 11, 59), H12);
  assert.deepEqual(r, { now: null, next: T1, mode: 'off', minutesLeft: null, progress: null });
});

test('nowAndNext at midnight (24:00) is off', () => {
  const r = nowAndNext(handPlan, at(22, 0), H12);
  assert.deepEqual(r, { now: null, next: T3, mode: 'off', minutesLeft: null, progress: null });
});

test('nowAndNext after the last item of the day is free; next skips to tomorrow', () => {
  const atEnd = nowAndNext(handPlan, at(21, 15));
  assert.deepEqual(atEnd, { now: null, next: T3, mode: 'free', minutesLeft: null, progress: null });
  const late = nowAndNext(handPlan, at(21, 23, 30));
  assert.deepEqual(late, { now: null, next: T3, mode: 'free', minutesLeft: null, progress: null });
});

test('nowAndNext after every item: free with next null', () => {
  const r = nowAndNext(handPlan, at(22, 14));
  assert.deepEqual(r, { now: null, next: null, mode: 'free', minutesLeft: null, progress: null });
});

test('nowAndNext with an empty plan', () => {
  assert.deepEqual(nowAndNext({ items: [], atRisk: [] }, at(21, 15)), {
    now: null, next: null, mode: 'free', minutesLeft: null, progress: null,
  });
  assert.equal(nowAndNext({ items: [], atRisk: [] }, at(21, 3), H12).mode, 'off');
  assert.equal(nowAndNext({ items: [], atRisk: [] }, at(21, 3)).mode, 'free'); // default hours are 24/7
});

// ---------- buildPlan + nowAndNext together ----------

test('section 3 plan at Mon 12:00: now is Slides, next is Pay bill', () => {
  const d = data({
    tasks: [
      task('report', 'max', 960, '2026-09-25'),
      task('slides', 'med', 600, '2026-09-22'),
      task('bill', 'low', 30, '2026-09-21'),
    ],
  });
  const now = at(21, 12);
  const r = nowAndNext(buildPlan(d, now), now);
  assert.equal(r.mode, 'tasks');
  assert.equal(r.now.id, 'slides');
  assert.equal(r.next.id, 'bill');
  assert.equal(r.minutesLeft, 600);
  assert.equal(r.progress, 0);
});

test('running overrun task stays "now" with 1 minute left', () => {
  const d = data({
    tasks: [task('run', 'low', 60, '2026-09-30'), task('x', 'max', 60, '2026-09-30')],
    log: [{ date: '2026-09-21', itemId: 'run', start: '12:30' }],
  });
  const now = at(21, 14);
  const r = nowAndNext(buildPlan(d, now), now);
  assert.equal(r.now.id, 'run');
  assert.equal(r.now.running, true);
  assert.equal(r.minutesLeft, 1);
  assert.equal(r.next.id, 'x');
});

test('running session that started yesterday (worked past midnight) stays running', () => {
  const data = { routine: [], tasks: [{ id: 't', name: 'Late work', priority: 'med', estimateMin: 120, deadline: '2026-09-30', done: false }],
    log: [{ date: '2026-09-24', itemId: 't', start: '23:30' }] };
  const n = new Date(2026, 8, 25, 0, 10);
  const nn = nowAndNext(buildPlan(data, n), n);
  assert.equal(nn.now.id, 't');
  assert.equal(nn.now.running, true);
  assert.equal(nn.minutesLeft, 80);
});

// ---------- custom hours ----------

test('custom work hours: tasks only run inside the 09:00-17:00 window', () => {
  const d = { ...data({ tasks: [task('a', 'max', 600, '2026-09-30')] }), hours: { workStart: '09:00', workEnd: '17:00' } };
  const plan = buildPlan(d, at(21, 8));
  assertSortedNonOverlapping(plan);
  assert.deepEqual(spans(plan, 'a'), [[m(21, 9), m(21, 17)], [m(22, 9), m(22, 11)]]);
});

test('invalid hours fall back to the 24/7 defaults', () => {
  const d = data({ tasks: [task('a', 'max', 60, '2026-09-30')], hours: { workStart: '18:00', workEnd: '09:00' } });
  assert.deepEqual(spans(buildPlan(d, at(21, 8)), 'a'), [[m(21, 8), m(21, 9)]]);
});

test('default hours are 24/7: work runs through the night and the weekend', () => {
  const d = data({ tasks: [task('a', 'low', 2 * 1440, '2026-10-30')], hours: {} });
  const plan = buildPlan(d, at(25, 22)); // Friday 22:00
  assert.deepEqual(spans(plan, 'a'), [[m(25, 22), m(26, 0)], [m(26, 0), m(27, 0)], [m(27, 0), m(27, 22)]]);
});

test('weekends "always" uses Saturday for any task', () => {
  const d = data({ tasks: [task('a', 'low', 60, '2026-10-30')], hours: { ...OLD_HOURS, weekends: 'always' } });
  assert.deepEqual(spans(buildPlan(d, at(26, 13)), 'a'), [[m(26, 13), m(26, 14)]]);
});

test('checkHours rejects bad formats and reversed windows', () => {
  assert.equal(checkHours({ workStart: '12:00', workEnd: '24:00' }), '');
  assert.match(checkHours({ workStart: '9:00', workEnd: '17:00' }), /HH:MM/);
  assert.match(checkHours({ workStart: '12:00', workEnd: '24:01' }), /HH:MM/);
  assert.match(checkHours({ workStart: '17:00', workEnd: '09:00' }), /end after/);
  assert.match(checkHours({ workStart: '09:00', workEnd: '17:00', weekends: 'sometimes' }), /Weekends/);
});

test('nowAndNext with custom hours is off before work starts', () => {
  const h = hoursOf({ hours: { workStart: '09:00', workEnd: '17:00' } });
  const empty = { items: [], atRisk: [] };
  assert.equal(nowAndNext(empty, at(21, 8, 59), h).mode, 'off');
  assert.equal(nowAndNext(empty, at(21, 9), h).mode, 'free');
});
