// Tests for stats.js habitsByDay, written blind from PLAN.md section 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { habitsByDay, habitStreak } from '../stats.js';

// ---------- helpers ----------
const today = new Date(2026, 8, 24, 15, 0); // Thu 2026-09-24, local
const habits = (...ids) => ids.map((id) => ({ id, name: id }));
const done = (date, itemId) => ({ date, itemId, start: '06:00', end: '06:10' });
const running = (date, itemId) => ({ date, itemId, start: '06:00' });
const data = (r, log) => ({ habits: r, tasks: [{ id: 't1', name: 'T', priority: 'max', estimateMin: 60, deadline: '2026-09-30', done: false }], log });

test('pct = distinct current habit ids with an ended session that day / habit length', () => {
  const d = data(habits('r1', 'r2', 'r3', 'r4'), [
    done('2026-09-21', 'r1'),
    done('2026-09-21', 'r2'),
    done('2026-09-21', 'r1'), // duplicate session: counts once
    done('2026-09-21', 'zzz'), // unknown id: ignored
    running('2026-09-21', 'r3'), // no end: ignored
    // 2026-09-22: nothing
    done('2026-09-23', 'r1'),
    done('2026-09-23', 'r2'),
    done('2026-09-23', 'r3'),
    done('2026-09-23', 'r4'),
    done('2026-09-24', 'r3'),
    done('2026-09-24', 't1'), // task session: not a habit id
  ]);
  assert.deepEqual(habitsByDay(d, today, 5), [
    { date: '2026-09-21', pct: 50 },
    { date: '2026-09-22', pct: 0 },
    { date: '2026-09-23', pct: 100 },
    { date: '2026-09-24', pct: 25 },
  ]);
});

test('pct is rounded to the nearest integer', () => {
  const d = data(habits('a', 'b', 'c'), [
    done('2026-09-23', 'a'),
    done('2026-09-24', 'a'),
    done('2026-09-24', 'b'),
  ]);
  assert.deepEqual(habitsByDay(d, today, 2), [
    { date: '2026-09-23', pct: 33 },
    { date: '2026-09-24', pct: 67 },
  ]);
});

test('days before the earliest log date are omitted', () => {
  const d = data(habits('a'), [done('2026-09-22', 'a')]);
  const series = habitsByDay(d, today, 30);
  assert.deepEqual(series.map((s) => s.date), ['2026-09-22', '2026-09-23', '2026-09-24']);
  assert.deepEqual(series.map((s) => s.pct), [100, 0, 0]);
});

test('default window is 30 days ending today, oldest first', () => {
  const d = data(habits('a'), [done('2026-09-01', 'a'), done('2026-08-01', 'a')]);
  const series = habitsByDay(d, today);
  assert.equal(series.length, 30);
  assert.equal(series[0].date, '2026-08-26');
  assert.equal(series[29].date, '2026-09-24');
  for (let k = 1; k < series.length; k++) assert.ok(series[k - 1].date < series[k].date, 'oldest first');
  assert.equal(series.find((s) => s.date === '2026-09-01').pct, 100);
  assert.equal(series.find((s) => s.date === '2026-09-02').pct, 0);
});

test('custom window length', () => {
  const d = data(habits('a'), [done('2026-08-01', 'a')]);
  const series = habitsByDay(d, today, 7);
  assert.deepEqual(series.map((s) => s.date), [
    '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24',
  ]);
  assert.ok(series.every((s) => s.pct === 0));
});

test('sessions for removed habit items do not count (only current habit ids)', () => {
  const d = data(habits('a', 'b'), [done('2026-09-24', 'a'), done('2026-09-24', 'old')]);
  assert.deepEqual(habitsByDay(d, today, 1), [{ date: '2026-09-24', pct: 50 }]);
});

test('a running (no end) habit session does not count', () => {
  const d = data(habits('a', 'b'), [done('2026-09-24', 'a'), running('2026-09-24', 'b')]);
  assert.deepEqual(habitsByDay(d, today, 1), [{ date: '2026-09-24', pct: 50 }]);
});

test('empty habit returns []', () => {
  const d = data([], [done('2026-09-24', 'a')]);
  assert.deepEqual(habitsByDay(d, today, 30), []);
});

test('habitStreak counts consecutive checked-off days ending today', () => {
  const d = data(habits('a'), [done('2026-09-22', 'a'), done('2026-09-23', 'a'), done('2026-09-24', 'a'), done('2026-09-20', 'a')]);
  assert.equal(habitStreak(d, 'a', today), 3);
});

test('habitStreak keeps yesterday\'s streak alive until today is checked off', () => {
  const d = data(habits('a'), [done('2026-09-22', 'a'), done('2026-09-23', 'a')]);
  assert.equal(habitStreak(d, 'a', today), 2);
  assert.equal(habitStreak(data(habits('a'), [done('2026-09-22', 'a')]), 'a', today), 0);
});
