import { buildPlan, nowAndNext, hoursOf, checkHours, DEFAULT_HOURS } from './scheduler.js';
import { getSettings, setSettings, loadData, saveData } from './sync.js';
import { habitStreak, habitChecker, renderStats } from './stats.js';
import { applyOp, applyOps } from './ops.js';
import { parseQuickAdd } from './quickadd.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const SAMPLE = params.has('sample');
const FROZEN = parseLocal(params.get('now'));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PRI = ['max', 'med', 'low'];
const TAGS = { tasks: 'Tasks', free: 'Free time', off: 'Off' };

const state = { data: null, syncedAt: null, offline: false, error: '', loading: false, flushing: false, base: null, lastFetch: 0, target: null };

function parseLocal(s) {
  const m = s && /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?/.exec(s);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
}
const now = () => (FROZEN ? new Date(FROZEN) : new Date());
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toMin = (d) => Math.floor(d.getTime() / 60000);
const fromMin = (m) => new Date(m * 60000);
const hm = (m, end) => { const s = hhmm(fromMin(m)); return end && s === '00:00' ? '24:00' : s; };
const dayLabel = (d) => `${DAYS[d.getDay()]} ${d.getDate()}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const NOTE_MAX = 280, SUB_NAME_MAX = 60, SUB_LIMIT = 20;
// Older data kept habits as a timed "routine"; carry those over as habits
const habitsOf = (d) => d.habits || (d.routine || []).map(({ id, name }) => ({ id, name }));
// Times are entered in hours (decimals allowed) and stored in minutes
const toHours = (min) => (min > 0 ? String(Math.round((min / 60) * 100) / 100) : '');
const norm = (d) => ({ tasks: [], log: [], ...d, habits: habitsOf(d) });
const yesterday = (date) => { const d = parseLocal(date); d.setDate(d.getDate() - 1); return ymd(d); };
// Open session from today, or from yesterday if work ran past midnight
const runningEntry = (d, date) => d.log.find((e) => (e.date === date || e.date === yesterday(date)) && !e.end);
const doneOn = (d, date, id) => d.log.some((e) => e.date === date && e.itemId === id && e.end);
const nameOf = (d, id) => (d.tasks.find((t) => t.id === id) || d.habits.find((r) => r.id === id) || { name: id }).name;
const errMsg = (e) => (e && e.message) || String(e);
const isNet = (e) => (e && e.networkError) || e instanceof TypeError;
// Writes work offline too: they're queued on this device (the outbox) and synced when back online
const canWrite = () => !SAMPLE && !FROZEN && !!state.data && !!getSettings().gistId;

// ---------- Data ----------
// state.base is the last data seen from the Gist (or its cache); the screen shows it plus the queued outbox ops.
const outboxKey = () => `tasks.outbox.${getSettings().gistId}`;
const readOutbox = () => { try { return JSON.parse(localStorage.getItem(outboxKey())) || []; } catch { return []; } };
const saveOutbox = (ops) => { try { localStorage.setItem(outboxKey(), JSON.stringify(ops)); } catch { /* storage full or blocked */ } };
const showLocal = () => { state.data = norm(applyOps(structuredClone(state.base), readOutbox())); };

function fromCache() {
  try {
    const c = JSON.parse(localStorage.getItem('tasks.cache'));
    if (c && c.data) { state.base = c.data; state.syncedAt = new Date(c.syncedAt); showLocal(); }
  } catch { /* no cache */ }
}

async function refresh() {
  if (SAMPLE) {
    try { state.data = norm(await (await fetch('./schedule.json', { cache: 'no-store' })).json()); state.error = ''; }
    catch (e) { state.error = `Could not load sample data (${errMsg(e)})`; }
    return render();
  }
  if (!getSettings().gistId) return render();
  const started = state.lastFetch = Date.now(); state.loading = true; renderStatus();
  try {
    const r = await loadData();
    // Skip if a save landed or is in flight meanwhile; its data is newer
    if (started >= (state.lastWrite || 0) && !state.flushing) {
      state.base = r.data;
      Object.assign(state, { syncedAt: r.syncedAt, offline: r.offline, error: '' });
      showLocal();
    }
  } catch (e) {
    if (isNet(e)) { state.offline = true; state.error = ''; } else state.error = errMsg(e);
  }
  state.loading = false;
  render();
  flush();
}

// Applies a change right away and queues it; flush() sends the queue to the Gist when online
function write(op) {
  if (!canWrite()) return false;
  saveOutbox([...readOutbox(), op]);
  const d = structuredClone(state.data);
  applyOp(d, op);
  state.data = norm(d);
  render();
  flush();
  return true;
}

// Sends queued changes: fetches the latest Gist data, replays the ops on it, saves. On a network error they
// stay queued (offline); any other error is shown and they're retried on the next refresh.
async function flush() {
  const ops = readOutbox();
  if (state.flushing || !ops.length || SAMPLE || !navigator.onLine) return;
  state.flushing = true; renderStatus();
  try {
    const r = await saveData((d) => applyOps(d, ops));
    saveOutbox(readOutbox().slice(ops.length)); // keep anything queued while this save was in flight
    state.lastWrite = Date.now();
    state.base = r.data;
    Object.assign(state, { syncedAt: r.syncedAt, offline: false, error: '' });
    showLocal();
  } catch (e) {
    if (isNet(e)) state.offline = true; else state.error = errMsg(e);
  }
  state.flushing = false;
  render();
  if (!state.offline && !state.error && readOutbox().length) flush();
}

function act(kind) {
  const t = state.target;
  if (!t) return;
  const n = now();
  write({ type: 'act', kind, id: t.id, itemKind: t.kind, date: ymd(n), time: hhmm(n) });
}

// A habit counts as done for the day once it has an ended entry; ticking again clears the day
function toggleHabit(id) {
  const n = now(), date = ymd(n);
  write({ type: 'habit', id, date, time: hhmm(n), done: !doneOn(state.data, date, id) });
}

function renderQuickPreview() {
  const p = parseQuickAdd($('#qa-input').value, now());
  $('#qa-preview').textContent = p.name
    ? `${p.name} · ${fmtMin(p.estimateMin)} · ${p.priority} · due ${fmtDate(p.deadline)}`
    : 'Add a time (2h, 30m), priority (max, med, low) and day (today, tomorrow, fri). Defaults: 1h, med, due in a week.';
}

// ---------- Render ----------
function renderStatus() {
  const s = getSettings(), waiting = s.gistId ? readOutbox().length : 0;
  let t;
  if (SAMPLE) t = state.error || 'Sample data · read-only';
  else if (!s.gistId) t = 'Not connected';
  else if (state.flushing) t = 'Saving…';
  else if (state.error) t = `Sync error: ${state.error}${waiting ? ` · ${waiting} change${waiting > 1 ? 's' : ''} not synced yet` : ''}`;
  else if (state.offline || !navigator.onLine) t = waiting
    ? `Offline · ${waiting} change${waiting > 1 ? 's' : ''} saved on this device, will sync when online`
    : `Offline · last synced ${state.syncedAt ? hhmm(state.syncedAt) : 'never'}`;
  else t = state.syncedAt && !state.loading ? `Synced ${hhmm(state.syncedAt)}` : 'Syncing…';
  if (FROZEN) t += ` · clock frozen at ${hhmm(FROZEN)}`;
  $('#status').textContent = t;
  $('#status').classList.toggle('err', !!state.error);
}

function render() {
  renderStatus();
  const d = state.data, n = now();
  $('#setup').hidden = !!(SAMPLE || getSettings().gistId);
  $('#today-body').hidden = !d;
  if (!d) return;
  try {
    const h = hoursOf(d), plan = buildPlan(d, n), nn = nowAndNext(plan, n, h);
    renderNow(d, plan, nn, n);
    const check = habitChecker(d);
    renderReward(d, n, check);
    renderHabits(d, n, check);
    renderGantt(d, plan, nn, n, h);
    $('#risk-card').hidden = !plan.atRisk.length;
    $('#risk').innerHTML = plan.atRisk.map((r) => `<li><span>${esc(r.name)}</span><span class="muted">due ${esc(fmtDate(r.deadline))}</span></li>`).join('');
    renderStats($('#stats'), d, n);
  } catch (e) {
    console.error(e);
    $('#status').textContent = `Could not build the plan: ${errMsg(e)}`;
    $('#status').classList.add('err');
  }
}

const fmtDate = (s) => { const d = parseLocal(s); return d ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : s; };
const sameItem = (a, b) => a && b && a.id === b.id && a.start === b.start;

function renderNow(d, plan, nn, n) {
  const nowMin = toMin(n), today = ymd(n), run = runningEntry(d, today), cur = nn.now;
  $('#mode-tag').textContent = TAGS[nn.mode] || nn.mode;
  $('#clock').textContent = hhmm(n);
  const isRun = !!(cur && (cur.running || (run && run.itemId === cur.id)));
  $('#now-label').textContent = cur ? (isRun ? 'Now running' : 'Now') : 'Now';
  $('#now-title').textContent = cur ? cur.name : TAGS[nn.mode];
  $('#now-bar-wrap').hidden = $('#now-meta').hidden = !cur;
  $('#now-card').className = cur ? `p-${cur.priority}` : '';
  if (cur) {
    $('#now-bar').style.width = `${Math.round((nn.progress || 0) * 100)}%`;
    $('#now-slot').textContent = `${hm(cur.start)} – ${hm(cur.end, true)}`;
    $('#now-left').textContent = `${nn.minutesLeft} min left`;
  }
  const nx = nn.next;
  $('#next').innerHTML = nx
    ? `<span class="t2">Next</span> · ${esc(nx.name)} <span class="muted">${ymd(fromMin(nx.start)) === today ? '' : DAYS[fromMin(nx.start).getDay()] + ' '}${hm(nx.start)}</span>`
    : '<span class="t2">Next</span> · <span class="muted">nothing planned</span>';
  // Action target: the running session, else the current item, else the top task
  const top = plan.items.find((i) => i.kind === 'task' && i.end > nowMin);
  const tgt = run ? { id: run.itemId, kind: d.tasks.some((t) => t.id === run.itemId) ? 'task' : 'habit', name: nameOf(d, run.itemId) } : cur || top;
  state.target = tgt ? { id: tgt.id, kind: tgt.kind } : null;
  $('#act-for').textContent = tgt && !sameItem(tgt, cur) && tgt.id !== (cur && cur.id) ? `${run ? 'Running' : 'Up next'}: ${tgt.name}` : '';
  const w = canWrite() && !!tgt, label = tgt ? tgt.name : '';
  const btn = (id, hidden, verb) => { const b = $(id); b.hidden = hidden; b.disabled = !w; b.setAttribute('aria-label', `${verb} ${label}`.trim()); };
  btn('#btn-start', !!run, 'Start');
  btn('#btn-pause', !run, 'Pause');
  btn('#btn-done', false, 'Mark done:');
}

// Dopamine loading: rewards stay locked until today's habits and every task due today (or overdue) are done
function renderReward(d, n, check) {
  const today = ymd(n);
  const left = [...d.habits.filter((h) => !check(h, today)), ...d.tasks.filter((t) => !t.done && t.deadline <= today)].map((x) => x.name);
  $('#reward').className = `widget reward ${left.length ? 'locked' : 'open'}`;
  $('#reward-lock').hidden = !left.length;
  $('#reward-open').hidden = !!left.length;
  $('#reward-text').innerHTML = left.length
    ? `<b>Rewards locked</b> · ${left.length} left today: ${esc(left.join(', '))}`
    : '<b>Rewards unlocked</b> · today\'s work is done';
}

function renderHabits(d, n, check) {
  const today = ymd(n), show = d.habits.length > 0;
  $('#habit-card').hidden = !show;
  if (!show) return;
  const week = [...Array(7)].map((_, k) => ymd(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 6 + k)));
  const w = canWrite();
  let done = 0;
  $('#habit-list').innerHTML = d.habits.map((h) => {
    const ok = check(h, today), streak = habitStreak(d, h, n, check);
    if (ok) done++;
    const dots = week.map((ds) => `<i class="${check(h, ds) ? 'on' : ''}${ds === today ? ' today' : ''}"></i>`).join('');
    return `<li class="habit${ok ? ' done' : ''}">
      <button type="button" class="check" data-habit="${esc(h.id)}" aria-pressed="${ok}"${w ? '' : ' disabled'}><span class="box" aria-hidden="true">${ok ? '&#10003;' : ''}</span>${esc(h.name)}</button>
      <span class="week" title="Last 7 days" aria-hidden="true">${dots}</span>
      <span class="streak" title="${streak}-day streak">${streak ? `${streak}d<span class="sr"> streak</span>` : ''}</span></li>`;
  }).join('');
  $('#habit-count').textContent = `Habits · ${done} of ${d.habits.length} today`;
}

function renderGantt(d, plan, nn, n, h) {
  const today = ymd(n), nowMin = toMin(n);
  // Gantt spans the work hours, widened to whole hours
  const g0 = Math.floor(h.workStart / 60), g1 = Math.ceil(h.workEnd / 60);
  const GW = (g1 - g0) * 60;
  const lastDs = plan.items.reduce((m, i) => { const s = ymd(fromMin(i.start)); return s > m ? s : m; }, today);
  const clamp = (m) => Math.min(Math.max(m, 0), GW);
  // Task segments (with an id) are buttons that open the task box
  const seg = (s0, a, b, cls, text, title, id) => {
    const l = clamp(a - s0), r = clamp(b - s0);
    if (r <= l) return '';
    const attrs = !title ? ' aria-hidden="true"'
      : id ? ` title="${esc(title)}" role="button" tabindex="0" data-id="${esc(id)}" aria-label="${esc(title)}: open subtasks and notes"`
      : ` title="${esc(title)}" role="img" aria-label="${esc(title)}"`;
    return `<div class="seg ${cls}" style="left:${(l / GW) * 100}%;width:max(2px, calc(${((r - l) / GW) * 100}% - 1px))"${attrs}>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
  };
  const ticks = [];
  for (let hr = g0; hr <= g1; hr++) ticks.push(`<span class="tick${hr % 3 ? '' : ' h3'}${hr === g0 ? ' first' : hr === g1 ? ' last' : ''}" style="left:${((hr - g0) / (g1 - g0)) * 100}%">${pad(hr)}</span>`);
  $('#gantt').style.setProperty('--gh', g1 - g0);
  let html = `<div class="g-row g-axis" aria-hidden="true"><span></span><div class="g-track">${ticks.join('')}</div></div>`;
  for (let k = 0; ; k++) {
    // s0 = the Gantt's first hour that day (DST-safe origin for this row)
    const day = new Date(n.getFullYear(), n.getMonth(), n.getDate() + k), ds = ymd(day), s0 = toMin(new Date(day.getFullYear(), day.getMonth(), day.getDate(), g0));
    if (ds > lastDs || k > 60) break;
    let row = '';
    for (const it of plan.items) {
      if (it.start >= s0 + GW || it.end <= s0) continue;
      const cls = [it.kind, `p-${it.priority}`, sameItem(it, nn.now) ? 'cur' : '', it.late ? 'late' : ''].join(' ');
      row += seg(s0, it.start, it.end, cls, it.name, `${it.name} ${hm(it.start)}–${hm(it.end, true)}${it.late ? ' (late)' : ''}`, it.id);
    }
    if (ds === today) {
      for (const e of d.log) {
        if (e.date !== ds || !e.end || !d.tasks.some((t) => t.id === e.itemId)) continue;
        const t = (x) => toMin(new Date(day.getFullYear(), day.getMonth(), day.getDate(), +x.slice(0, 2), +x.slice(3, 5)));
        row += seg(s0, t(e.start), Math.max(t(e.end), t(e.start) + 2), 'logged', '', '');
      }
      const x = nowMin - s0;
      if (x >= 0 && x <= GW) row += `<div class="now-line" style="left:${(x / GW) * 100}%" aria-hidden="true"></div>`;
    }
    html += `<div class="g-row"><span class="g-day">${dayLabel(day)}</span><div class="g-track">${row}</div></div>`;
  }
  $('#gantt').innerHTML = html;
  // Keep labels only where they fit reasonably; the name stays in title/aria-label
  for (const sp of $('#gantt').querySelectorAll('.seg span')) if (sp.parentElement.clientWidth < 36) sp.remove();
}

// ---------- Editor ----------
let draft = null, draftOrig = '';

function openEditor() {
  const d = state.data || { habits: [], tasks: [] };
  const { workStart, workEnd, weekends } = { ...DEFAULT_HOURS, ...d.hours };
  draft = structuredClone({ habits: d.habits, tasks: [...d.tasks.filter((t) => !t.done), ...d.tasks.filter((t) => t.done)], hours: { workStart, workEnd, weekends } });
  draftOrig = JSON.stringify(draft);
  const s = getSettings(), w = canWrite();
  $('#set-gist').value = s.gistId;
  $('#set-token').value = '';
  $('#set-token').placeholder = s.token ? `Saved token ending ${s.token.slice(-4)}` : 'Paste a token';
  $('#ed-data').disabled = $('#ed-data-hb').disabled = $('#ed-data-h').disabled = !w;
  $('#ed-note').textContent = w ? '' : SAMPLE ? 'Sample data is read-only' : !s.gistId ? 'Add a Gist below to edit tasks' : 'Read-only right now';
  $('#ed-err').textContent = '';
  $('#qa-input').value = '';
  renderQuickPreview();
  $(`#ed-theme input[value="${document.documentElement.dataset.theme || 'system'}"]`).checked = true;
  drawEditor();
  $('#editor').showModal();
}

const moveBtns = (list, i, lo, hi, name) =>
  `<button type="button" class="btn" data-act="up" data-list="${list}" data-i="${i}" aria-label="Move ${esc(name)} up"${i <= lo ? ' disabled' : ''}>&#8593;</button>` +
  `<button type="button" class="btn" data-act="down" data-list="${list}" data-i="${i}" aria-label="Move ${esc(name)} down"${i >= hi ? ' disabled' : ''}>&#8595;</button>` +
  `<button type="button" class="btn" data-act="del" data-list="${list}" data-i="${i}" aria-label="Delete ${esc(name)}">&#215;</button>`;

function drawEditor() {
  // A time input can't show 24:00, so midnight shows as 00:00
  for (const k of ['workStart', 'workEnd']) $(`#ed-hours [data-h="${k}"]`).value = draft.hours[k] === '24:00' ? '00:00' : draft.hours[k];
  $('#ed-data-h [data-h="weekends"]').checked = draft.hours.weekends === 'needed';
  const open = draft.tasks.filter((t) => !t.done).length;
  $('#ed-tasks').innerHTML = draft.tasks.map((t, i) => t.done
    ? `<li class="ed-row gone"><s>${esc(t.name)}</s><span class="ed-btns"><button type="button" class="btn" data-act="undo" data-list="tasks" data-i="${i}" aria-label="Mark ${esc(t.name)} not done">Undo</button><button type="button" class="btn" data-act="del" data-list="tasks" data-i="${i}" aria-label="Delete ${esc(t.name)}">&#215;</button></span></li>`
    : `<li class="ed-row" data-list="tasks" data-i="${i}">
        <input class="ed-name" data-f="name" value="${esc(t.name)}" placeholder="Task name" aria-label="Task name">
        <input type="number" min="0.25" step="0.25" data-f="estimateMin" value="${toHours(t.estimateMin)}" aria-label="Estimate in hours" title="Estimate (hours; can span several days)"><span class="small">h</span>
        <select data-f="priority" aria-label="Priority">${PRI.map((p) => `<option${p === t.priority ? ' selected' : ''}>${p}</option>`).join('')}</select>
        <input type="date" data-f="deadline" value="${esc(t.deadline)}" aria-label="Deadline">
        <span class="ed-btns">${moveBtns('tasks', i, 0, open - 1, t.name || 'task')}</span></li>`).join('');
  $('#ed-habits').innerHTML = draft.habits.map((r, i) => `<li class="ed-row r" data-list="habits" data-i="${i}">
      <input class="ed-name" data-f="name" value="${esc(r.name)}" placeholder="Habit" aria-label="Habit name">
      <span class="ed-btns">${moveBtns('habits', i, 0, draft.habits.length - 1, r.name || 'habit')}</span></li>`).join('');
}

function onEditorInput(e) {
  const k = e.target.dataset.h;
  if (k === 'weekends') { draft.hours.weekends = e.target.checked ? 'needed' : 'always'; return; }
  if (k) { draft.hours[k] = k === 'workEnd' && e.target.value === '00:00' ? '24:00' : e.target.value; return; }
  const f = e.target.dataset.f, row = e.target.closest('[data-i]');
  if (!f || !row) return;
  // Estimates are typed in hours and stored in minutes
  const v = f === 'estimateMin' ? Math.round(Number(e.target.value) * 60) : e.target.value;
  draft[row.dataset.list][+row.dataset.i][f] = v;
}

function onEditorClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act, list = draft[b.dataset.list], i = +b.dataset.i;
  const id = () => crypto.randomUUID().slice(0, 8);
  let focus = null;
  if (act === 'add-task') {
    // Typed text (e.g. "Essay 2.5h max fri") becomes a filled-in row and the box clears for the next one;
    // with nothing typed, a blank row is added to fill in by hand
    const p = parseQuickAdd($('#qa-input').value, now()), at = draft.tasks.filter((t) => !t.done).length;
    draft.tasks.splice(at, 0, { id: id(), ...(p.name ? p : { name: '', priority: 'med', estimateMin: 60, deadline: ymd(now()) }), done: false });
    if (p.name) { $('#qa-input').value = ''; renderQuickPreview(); drawEditor(); $('#qa-input').focus(); return; }
    focus = ['tasks', at];
  } else if (act === 'add-habit') { focus = ['habits', draft.habits.length]; draft.habits.push({ id: id(), name: '' }); }
  else if (act === 'up' || act === 'down') { const j = act === 'up' ? i - 1 : i + 1; [list[i], list[j]] = [list[j], list[i]]; }
  else if (act === 'del') list.splice(i, 1);
  else if (act === 'undo') { const open = draft.tasks.filter((t) => !t.done).length; const [t] = list.splice(i, 1); t.done = false; delete t.doneDate; list.splice(open, 0, t); }
  drawEditor();
  if (focus) $(`.ed-row[data-list="${focus[0]}"][data-i="${focus[1]}"] .ed-name`).focus();
}

function saveEditor(e) {
  e.preventDefault();
  const s = getSettings(), gistId = $('#set-gist').value.trim(), token = $('#set-token').value.trim() || s.token;
  const gistChanged = gistId !== s.gistId;
  if (gistChanged || token !== s.token) setSettings({ gistId, token });
  const habits = draft.habits.filter((r) => r.name.trim()).map((r) => ({ ...r, name: r.name.trim() }));
  const tasks = draft.tasks.filter((t) => String(t.name).trim()).map((t) => ({ ...t, name: t.name.trim() }));
  const bad = tasks.find((t) => !t.done && (!(t.estimateMin > 0) || !/^\d{4}-\d\d-\d\d$/.test(t.deadline || '')));
  if (bad) { $('#ed-err').textContent = `Check "${bad.name}": it needs an estimate in hours (e.g. 1.5) and a deadline.`; return; }
  const hours = draft.hours, hoursErr = checkHours(hours);
  if (hoursErr) { $('#ed-err').textContent = `Check the hours: ${hoursErr}`; return; }
  const edited = JSON.stringify({ habits, tasks, hours }) !== draftOrig;
  if (!gistChanged && edited && !write({ type: 'edit', habits, tasks, hours })) { $('#ed-err').textContent = 'Not saved: read-only right now.'; return; }
  $('#editor').close();
  if (gistChanged) { state.data = null; state.syncedAt = null; state.error = ''; }
  if (gistChanged || token !== s.token) refresh(); else render();
}

// ---------- Task box (subtasks and notes) ----------
let tbDraft = null, tbTask = null;
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);

function openTaskBox(id) {
  const t = state.data && state.data.tasks.find((x) => x.id === id);
  if (!t) return;
  tbTask = t;
  tbDraft = structuredClone({ subtasks: t.subtasks || [], notes: t.notes || '' });
  const w = canWrite();
  $('#tb-title').textContent = t.name;
  $('#tb-meta').textContent = `${t.priority} priority · due ${fmtDate(t.deadline)} · estimate ${fmtMin(t.estimateMin)}`;
  $('#tb-data').disabled = !w;
  $('#tb-note').textContent = w ? '' : SAMPLE ? 'Sample data is read-only' : 'Read-only right now';
  $('#tb-notes').value = tbDraft.notes;
  $('#tb-err').textContent = '';
  drawTaskBox();
  $('#task-box').showModal();
}

function drawTaskBox() {
  $('#tb-subs').innerHTML = tbDraft.subtasks.map((s, i) => `<li class="ed-row sub-row" data-i="${i}">
      <input type="checkbox" data-s="done"${s.done ? ' checked' : ''} aria-label="Done">
      <input class="ed-name" data-s="name" maxlength="${SUB_NAME_MAX}" value="${esc(s.name)}" placeholder="Subtask" aria-label="Subtask name">
      <input type="number" min="0.25" step="0.25" data-s="min" value="${toHours(s.min)}" placeholder="h" aria-label="Time in hours (optional)" title="Time in hours (optional)">
      <span class="ed-btns"><button type="button" class="btn" data-act="del-sub" data-i="${i}" aria-label="Delete ${esc(s.name || 'subtask')}">&#215;</button></span></li>`).join('');
  $('#tb-add').disabled = tbDraft.subtasks.length >= SUB_LIMIT;
  updateTaskBox();
}

// Counts only; the subtask times are for reference and don't change the schedule
function updateTaskBox() {
  const subs = tbDraft.subtasks, mins = subs.reduce((a, s) => a + (s.min > 0 ? s.min : 0), 0);
  $('#tb-total').textContent = subs.length
    ? `${subs.filter((s) => s.done).length} of ${subs.length} done${mins ? ` · subtasks add up to ${fmtMin(mins)} (task estimate ${fmtMin(tbTask.estimateMin)})` : ''}`
    : 'Break the task into steps.';
  $('#tb-count').textContent = `${$('#tb-notes').value.length}/${NOTE_MAX}`;
}

function onTaskBoxInput(e) {
  if (e.target.id === 'tb-notes') tbDraft.notes = e.target.value;
  const f = e.target.dataset.s, row = e.target.closest('[data-i]');
  if (f && row) {
    const sub = tbDraft.subtasks[+row.dataset.i];
    if (f === 'done') sub.done = e.target.checked;
    else if (f === 'min') sub.min = e.target.value ? Math.round(Number(e.target.value) * 60) : null;
    else sub.name = e.target.value;
  }
  updateTaskBox();
}

function onTaskBoxClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'add-sub' && tbDraft.subtasks.length < SUB_LIMIT) tbDraft.subtasks.push({ id: crypto.randomUUID().slice(0, 8), name: '', done: false });
  else if (b.dataset.act === 'del-sub') tbDraft.subtasks.splice(+b.dataset.i, 1);
  else return;
  drawTaskBox();
  if (b.dataset.act === 'add-sub') $('#tb-subs li:last-child .ed-name').focus();
}

function saveTaskBox(e) {
  e.preventDefault();
  const subtasks = tbDraft.subtasks.filter((s) => s.name.trim()).map((s) => {
    const out = { id: s.id, name: s.name.trim().slice(0, SUB_NAME_MAX), done: !!s.done };
    if (s.min > 0) out.min = Math.round(s.min);
    return out;
  });
  const notes = tbDraft.notes.trim().slice(0, NOTE_MAX);
  if (!write({ type: 'taskbox', id: tbTask.id, subtasks, notes })) { $('#tb-err').textContent = 'Not saved: read-only right now.'; return; }
  $('#task-box').close();
}

// ---------- Theme ----------
// System follows the device; Light or Dark is remembered on this device (applied early by index.html)
function setTheme(t) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { if (t === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', t); } catch { /* not remembered */ }
}
$('#ed-theme').addEventListener('change', (e) => setTheme(e.target.value));

// ---------- Wiring ----------
$('#edit-btn').onclick = $('#setup-edit').onclick = openEditor;
$('#btn-start').onclick = () => act('start');
$('#btn-pause').onclick = () => act('pause');
$('#btn-done').onclick = () => act('done');
$('#ed-cancel').onclick = () => $('#editor').close();
// Clicking the backdrop closes a dialog like Cancel; a drag that starts inside (e.g. selecting text) doesn't
function closeOnBackdrop(dlg) {
  const outside = (e) => { const r = dlg.getBoundingClientRect(); return e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom); };
  let downOutside = false;
  dlg.addEventListener('pointerdown', (e) => { downOutside = outside(e); });
  dlg.addEventListener('click', (e) => { if (downOutside && outside(e)) dlg.close(); });
}
closeOnBackdrop($('#editor'));
closeOnBackdrop($('#task-box'));
$('#habit-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-habit]');
  if (b) toggleHabit(b.dataset.habit);
});
$('#tb-cancel').onclick = () => $('#task-box').close();
$('#tb-form').addEventListener('submit', saveTaskBox);
$('#tb-form').addEventListener('input', onTaskBoxInput);
$('#tb-form').addEventListener('click', onTaskBoxClick);
$('#ed-form').addEventListener('submit', saveEditor);
$('#qa-input').addEventListener('input', renderQuickPreview);
// Enter in the quick-add box adds the task instead of saving the whole dialog
$('#qa-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#ed-form [data-act="add-task"]').click(); } });
$('#ed-form').addEventListener('input', onEditorInput);
$('#ed-form').addEventListener('click', onEditorClick);
$('#gantt').addEventListener('click', (e) => { const s = e.target.closest('.seg[data-id]'); if (s) openTaskBox(s.dataset.id); });
$('#gantt').addEventListener('keydown', (e) => {
  const s = e.target.closest('.seg[data-id]');
  if (s && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTaskBox(s.dataset.id); }
});

setInterval(render, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - state.lastFetch > 60000) refresh(); else render();
});
addEventListener('online', () => { state.offline = false; refresh(); });
addEventListener('offline', render);
let resizeT;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(render, 150); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

if (!SAMPLE && getSettings().gistId) fromCache();
render();
refresh();
