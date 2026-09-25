// Tests for ops.js (queued changes) and quickadd.js (quick-add parsing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, applyOps } from '../ops.js';
import { parseQuickAdd } from '../quickadd.js';

const base = () => ({ habits: [{ id: 'h', name: 'Read' }], tasks: [{ id: 't', name: 'T', priority: 'med', estimateMin: 60, deadline: '2026-09-30', done: false }], log: [] });
const twice = (op) => { const a = applyOps(base(), [op]); const b = applyOps(base(), [op, op]); return [a, b]; };

test('every op is safe to apply twice', () => {
  for (const op of [
    { type: 'habit', id: 'h', date: '2026-09-25', time: '08:00', done: true },
    { type: 'addTask', task: { id: 'n', name: 'New', priority: 'low', estimateMin: 30, deadline: '2026-10-01', done: false } },
    { type: 'act', kind: 'start', id: 't', itemKind: 'task', date: '2026-09-25', time: '09:00' },
    { type: 'act', kind: 'done', id: 't', itemKind: 'task', date: '2026-09-25', time: '09:00' },
    { type: 'taskbox', id: 't', subtasks: [{ id: 's', name: 'Step', done: false }], notes: 'n' },
  ]) {
    const [a, b] = twice(op);
    assert.deepEqual(b, a, op.type);
  }
});

test('habit op sets the day to done or not done', () => {
  const d = applyOps(base(), [{ type: 'habit', id: 'h', date: '2026-09-25', time: '08:00', done: true }]);
  assert.equal(d.log.length, 1);
  applyOp(d, { type: 'habit', id: 'h', date: '2026-09-25', time: '09:00', done: false });
  assert.equal(d.log.length, 0);
});

test('start then done logs a session and marks the task done with its date', () => {
  const d = applyOps(base(), [
    { type: 'act', kind: 'start', id: 't', itemKind: 'task', date: '2026-09-25', time: '09:00' },
    { type: 'act', kind: 'done', id: 't', itemKind: 'task', date: '2026-09-25', time: '10:30' },
  ]);
  assert.deepEqual(d.log, [{ date: '2026-09-25', itemId: 't', start: '09:00', end: '10:30' }]);
  assert.equal(d.tasks[0].done, true);
  assert.equal(d.tasks[0].doneDate, '2026-09-25');
});

test('ops migrate older routine data to habits', () => {
  const d = applyOps({ routine: [{ id: 'r', name: 'Run', durationMin: 30 }] }, []);
  assert.deepEqual(d.habits, [{ id: 'r', name: 'Run' }]);
  assert.equal('routine' in d, false);
});

const fri = new Date(2026, 8, 25); // Friday

test('quick add reads time, priority and day anywhere in the text', () => {
  assert.deepEqual(parseQuickAdd('Essay 2.5h max mon', fri), { name: 'Essay', estimateMin: 150, priority: 'max', deadline: '2026-09-28' });
  assert.deepEqual(parseQuickAdd('low tomorrow Call mum 30m', fri), { name: 'Call mum', estimateMin: 30, priority: 'low', deadline: '2026-09-26' });
  assert.equal(parseQuickAdd('Report 1h30m', fri).estimateMin, 90);
  assert.equal(parseQuickAdd('Report friday', fri).deadline, '2026-09-25'); // today counts
  assert.equal(parseQuickAdd('Report 2026-10-03', fri).deadline, '2026-10-03');
});

test('quick add defaults: 1h, med, due in a week; only the first of each kind is read', () => {
  assert.deepEqual(parseQuickAdd('Plan the max project', fri), { name: 'Plan the project', estimateMin: 60, priority: 'max', deadline: '2026-10-02' });
  assert.deepEqual(parseQuickAdd('Fix low low', fri), { name: 'Fix low', estimateMin: 60, priority: 'low', deadline: '2026-10-02' });
});
