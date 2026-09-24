import { buildPlan, nowAndNext, hoursOf, checkHours, DEFAULT_HOURS } from './scheduler.js';
import { getSettings, setSettings, loadData, saveData } from './sync.js';
import { habitsByDay, habitStreak, renderStats } from './stats.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const SAMPLE = params.has('sample');
const FROZEN = parseLocal(params.get('now'));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PRI = ['max', 'med', 'low'];
const TAGS = { tasks: 'Tasks', free: 'Free time', off: 'Off' };

const state = { data: null, syncedAt: null, offline: false, error: '', loading: false, busy: false, lastFetch: 0, target: null };

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
// Older data kept habits as a timed "routine"; carry those over as habits
const habitsOf = (d) => d.habits || (d.routine || []).map(({ id, name }) => ({ id, name }));
const norm = (d) => ({ tasks: [], log: [], ...d, habits: habitsOf(d) });
const yesterday = (date) => { const d = parseLocal(date); d.setDate(d.getDate() - 1); return ymd(d); };
// Open session from today, or from yesterday if work ran past midnight
const runningEntry = (d, date) => d.log.find((e) => (e.date === date || e.date === yesterday(date)) && !e.end);
const doneOn = (d, date, id) => d.log.some((e) => e.date === date && e.itemId === id && e.end);
const nameOf = (d, id) => (d.tasks.find((t) => t.id === id) || d.habits.find((r) => r.id === id) || { name: id }).name;
const errMsg = (e) => (e && e.message) || String(e);
const isNet = (e) => (e && e.networkError) || e instanceof TypeError;
const canWrite = () => !SAMPLE && !FROZEN && !!state.data && !state.offline && navigator.onLine && !state.busy && !!getSettings().gistId;

// ---------- Data ----------
function fromCache() {
  try {
    const c = JSON.parse(localStorage.getItem('tasks.cache'));
    if (c && c.data) { state.data = norm(c.data); state.syncedAt = new Date(c.syncedAt); }
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
    if (started < state.lastWrite) return; // a save landed meanwhile; its data is newer
    Object.assign(state, { data: norm(r.data), syncedAt: r.syncedAt, offline: r.offline, error: '' });
  } catch (e) {
    if (isNet(e)) { state.offline = true; state.error = ''; } else state.error = errMsg(e);
  }
  state.loading = false;
  render();
}

async function write(mutate) {
  if (!canWrite()) return false;
  state.busy = true; render();
  let ok = false;
  try {
    const r = await saveData((d) => { d.habits = habitsOf(d); delete d.routine; d.tasks ||= []; d.log ||= []; mutate(d); });
    Object.assign(state, { data: norm(r.data), syncedAt: r.syncedAt, offline: false, error: '' });
    ok = true; state.lastWrite = Date.now();
  } catch (e) {
    if (isNet(e)) { state.offline = true; state.error = 'Could not save while offline'; } else state.error = errMsg(e);
  }
  state.busy = false; render();
  return ok;
}

function act(kind) {
  const t = state.target;
  if (!t) return;
  const n = now(), date = ymd(n), time = hhmm(n);
  write((d) => {
    let run = runningEntry(d, date);
    // Close sessions left open on earlier days at that day's end
    for (const e of d.log) if (!e.end && e.date < date && e !== run) e.end = '24:00';
    if (run && run.date !== date && kind !== 'start') {
      // Split a session that ran past midnight into one entry per day
      run.end = '24:00';
      run = { date, itemId: run.itemId, start: '00:00' };
      d.log.push(run);
    }
    if (kind === 'start') { if (!run) d.log.push({ date, itemId: t.id, start: time }); return; }
    const mine = run && run.itemId === t.id ? run : null;
    if (mine) mine.end = time;
    else if (kind === 'done') d.log.push({ date, itemId: t.id, start: time, end: time });
    if (kind === 'done' && t.kind === 'task') { const task = d.tasks.find((x) => x.id === t.id); if (task) task.done = true; }
  });
}

// A habit counts as done for the day once it has an ended entry; ticking again clears the day
function toggleHabit(id) {
  const n = now(), date = ymd(n), time = hhmm(n);
  write((d) => {
    if (doneOn(d, date, id)) d.log = d.log.filter((e) => !(e.date === date && e.itemId === id));
    else d.log.push({ date, itemId: id, start: time, end: time });
  });
}

// ---------- Render ----------
function renderStatus() {
  const s = getSettings();
  let t;
  if (SAMPLE) t = state.error || 'Sample data · read-only';
  else if (!s.gistId) t = 'Not connected';
  else if (state.busy) t = 'Saving…';
  else if (state.error) t = `Sync error: ${state.error}`;
  else if (state.offline || !navigator.onLine) t = `Offline · last synced ${state.syncedAt ? hhmm(state.syncedAt) : 'never'}`;
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
    renderHabits(d, n);
    renderGantt(d, plan, nn, n, h);
    $('#risk-card').hidden = !plan.atRisk.length;
    $('#risk').innerHTML = plan.atRisk.map((r) => `<li><span>${esc(r.name)}</span><span class="muted">due ${esc(fmtDate(r.deadline))}</span></li>`).join('');
    renderStats($('#stats'), habitsByDay(d, n));
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
  $('#now-card').className = `widget${cur ? ` p-${cur.priority}` : ''}`;
  if (cur) {
    $('#now-bar').style.width = `${Math.round((nn.progress || 0) * 100)}%`;
    $('#now-slot').textContent = `${hm(cur.start)} – ${hm(cur.end, true)}`;
    $('#now-left').textContent = `${nn.minutesLeft} min left`;
  }
  // Mini strip: today's remaining items, with gaps shown as free time
  const dayEnd = toMin(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1));
  const segs = [];
  let c = nowMin;
  for (const it of plan.items) {
    if (it.end <= nowMin || it.start >= dayEnd) continue;
    const s = Math.max(it.start, nowMin), e = Math.min(it.end, dayEnd);
    if (s > c) segs.push(['free', s - c, 'Free']);
    segs.push([`${sameItem(it, cur) ? 'cur' : 'later'} p-${it.priority}`, e - s, it.name]);
    c = e;
  }
  $('#strip').hidden = !segs.length;
  $('#strip').innerHTML = segs.map(([k, w, t]) => `<div class="${k}" style="flex:${w}" title="${esc(t)}"></div>`).join('');
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

function renderHabits(d, n) {
  const today = ymd(n), show = d.habits.length > 0;
  $('#habit-card').hidden = !show;
  $('#cards').classList.toggle('two', show);
  if (!show) return;
  const week = [...Array(7)].map((_, k) => ymd(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 6 + k)));
  const w = canWrite();
  let done = 0;
  $('#habit-list').innerHTML = d.habits.map((h) => {
    const ok = doneOn(d, today, h.id), streak = habitStreak(d, h.id, n);
    if (ok) done++;
    const dots = week.map((ds) => `<i class="${doneOn(d, ds, h.id) ? 'on' : ''}${ds === today ? ' today' : ''}"></i>`).join('');
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
  const seg = (s0, a, b, cls, text, title) => {
    const l = clamp(a - s0), r = clamp(b - s0);
    if (r <= l) return '';
    const attrs = title ? ` title="${esc(title)}" role="img" aria-label="${esc(title)}"` : ' aria-hidden="true"';
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
      row += seg(s0, it.start, it.end, cls, it.name, `${it.name} ${hm(it.start)}–${hm(it.end, true)}${it.late ? ' (late)' : ''}`);
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
  const { workStart, workEnd } = { ...DEFAULT_HOURS, ...d.hours };
  draft = structuredClone({ habits: d.habits, tasks: [...d.tasks.filter((t) => !t.done), ...d.tasks.filter((t) => t.done)], hours: { workStart, workEnd } });
  draftOrig = JSON.stringify(draft);
  const s = getSettings(), w = canWrite();
  $('#set-gist').value = s.gistId;
  $('#set-token').value = '';
  $('#set-token').placeholder = s.token ? `Saved token ending ${s.token.slice(-4)}` : 'Paste a token';
  $('#ed-data').disabled = $('#ed-data-hb').disabled = $('#ed-data-h').disabled = !w;
  $('#ed-note').textContent = w ? '' : SAMPLE ? 'Sample data is read-only' : !s.gistId ? 'Add a Gist below to edit tasks' : 'Offline: tasks are read-only';
  $('#ed-err').textContent = '';
  drawEditor();
  $('#editor').showModal();
}

const moveBtns = (list, i, lo, hi, name) =>
  `<button type="button" class="btn" data-act="up" data-list="${list}" data-i="${i}" aria-label="Move ${esc(name)} up"${i <= lo ? ' disabled' : ''}>&#8593;</button>` +
  `<button type="button" class="btn" data-act="down" data-list="${list}" data-i="${i}" aria-label="Move ${esc(name)} down"${i >= hi ? ' disabled' : ''}>&#8595;</button>` +
  `<button type="button" class="btn" data-act="del" data-list="${list}" data-i="${i}" aria-label="Delete ${esc(name)}">&#215;</button>`;

function drawEditor() {
  // A time input can't show 24:00, so midnight shows as 00:00
  for (const k in draft.hours) $(`#ed-hours [data-h="${k}"]`).value = draft.hours[k] === '24:00' ? '00:00' : draft.hours[k];
  const open = draft.tasks.filter((t) => !t.done).length;
  $('#ed-tasks').innerHTML = draft.tasks.map((t, i) => t.done
    ? `<li class="ed-row gone"><s>${esc(t.name)}</s><span class="ed-btns"><button type="button" class="btn" data-act="undo" data-list="tasks" data-i="${i}" aria-label="Mark ${esc(t.name)} not done">Undo</button><button type="button" class="btn" data-act="del" data-list="tasks" data-i="${i}" aria-label="Delete ${esc(t.name)}">&#215;</button></span></li>`
    : `<li class="ed-row" data-list="tasks" data-i="${i}">
        <input class="ed-name" data-f="name" value="${esc(t.name)}" placeholder="Task name" aria-label="Task name">
        <input type="number" min="1" step="5" data-f="estimateMin" value="${esc(t.estimateMin)}" aria-label="Estimate in minutes" title="Estimate (min)">
        <select data-f="priority" aria-label="Priority">${PRI.map((p) => `<option${p === t.priority ? ' selected' : ''}>${p}</option>`).join('')}</select>
        <input type="date" data-f="deadline" value="${esc(t.deadline)}" aria-label="Deadline">
        <span class="ed-btns">${moveBtns('tasks', i, 0, open - 1, t.name || 'task')}</span></li>`).join('');
  $('#ed-habits').innerHTML = draft.habits.map((r, i) => `<li class="ed-row r" data-list="habits" data-i="${i}">
      <input class="ed-name" data-f="name" value="${esc(r.name)}" placeholder="Habit" aria-label="Habit name">
      <span class="ed-btns">${moveBtns('habits', i, 0, draft.habits.length - 1, r.name || 'habit')}</span></li>`).join('');
}

function onEditorInput(e) {
  const k = e.target.dataset.h;
  if (k) { draft.hours[k] = k === 'workEnd' && e.target.value === '00:00' ? '24:00' : e.target.value; return; }
  const f = e.target.dataset.f, row = e.target.closest('[data-i]');
  if (!f || !row) return;
  const v = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
  draft[row.dataset.list][+row.dataset.i][f] = v;
}

function onEditorClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act, list = draft[b.dataset.list], i = +b.dataset.i;
  const id = () => crypto.randomUUID().slice(0, 8);
  let focus = null;
  if (act === 'add-task') {
    focus = ['tasks', draft.tasks.filter((t) => !t.done).length];
    draft.tasks.splice(focus[1], 0, { id: id(), name: '', priority: 'med', estimateMin: 60, deadline: ymd(now()), done: false });
  } else if (act === 'add-habit') { focus = ['habits', draft.habits.length]; draft.habits.push({ id: id(), name: '' }); }
  else if (act === 'up' || act === 'down') { const j = act === 'up' ? i - 1 : i + 1; [list[i], list[j]] = [list[j], list[i]]; }
  else if (act === 'del') list.splice(i, 1);
  else if (act === 'undo') { const open = draft.tasks.filter((t) => !t.done).length; const [t] = list.splice(i, 1); t.done = false; list.splice(open, 0, t); }
  drawEditor();
  if (focus) $(`.ed-row[data-list="${focus[0]}"][data-i="${focus[1]}"] .ed-name`).focus();
}

async function saveEditor(e) {
  e.preventDefault();
  const s = getSettings(), gistId = $('#set-gist').value.trim(), token = $('#set-token').value.trim() || s.token;
  const gistChanged = gistId !== s.gistId;
  if (gistChanged || token !== s.token) setSettings({ gistId, token });
  const habits = draft.habits.filter((r) => r.name.trim()).map((r) => ({ ...r, name: r.name.trim() }));
  const tasks = draft.tasks.filter((t) => String(t.name).trim()).map((t) => ({ ...t, name: t.name.trim() }));
  const bad = tasks.find((t) => !t.done && (!(t.estimateMin > 0) || !/^\d{4}-\d\d-\d\d$/.test(t.deadline || '')));
  if (bad) { $('#ed-err').textContent = `Check "${bad.name}": it needs a positive number of minutes and a deadline.`; return; }
  const hours = draft.hours, hoursErr = checkHours(hours);
  if (hoursErr) { $('#ed-err').textContent = `Check the hours: ${hoursErr}`; return; }
  const edited = JSON.stringify({ habits, tasks, hours }) !== draftOrig;
  if (!gistChanged && edited && !canWrite()) { $('#ed-err').textContent = 'Not saved: offline. Your edits are still here; try again when connected.'; return; }
  if (!gistChanged && edited) {
    $('#ed-save').disabled = true;
    const ok = await write((d) => { d.habits = habits; d.tasks = tasks; d.hours = hours; });
    $('#ed-save').disabled = false;
    if (!ok) { $('#ed-err').textContent = `Not saved: ${state.error}`; return; }
  }
  $('#editor').close();
  if (gistChanged) { state.data = null; state.syncedAt = null; state.error = ''; }
  if (gistChanged || token !== s.token) refresh(); else render();
}

// ---------- Theme ----------
// Follows the system until the button picks light or dark; the choice is remembered on this device
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light')) === 'dark';
function syncThemeBtn() {
  const dark = isDark(), label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  $('#theme-btn').setAttribute('aria-label', label);
  $('#theme-btn').title = label;
  $('#theme-btn .i-sun').style.display = dark ? '' : 'none';
  $('#theme-btn .i-moon').style.display = dark ? 'none' : '';
}
$('#theme-btn').onclick = () => {
  const t = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch { /* not remembered */ }
  syncThemeBtn();
};
systemDark.addEventListener('change', syncThemeBtn);
syncThemeBtn();

// ---------- Wiring ----------
$('#edit-btn').onclick = $('#setup-edit').onclick = openEditor;
$('#btn-start').onclick = () => act('start');
$('#btn-pause').onclick = () => act('pause');
$('#btn-done').onclick = () => act('done');
$('#ed-cancel').onclick = () => $('#editor').close();
// Clicking the backdrop closes the dialog like Cancel; a drag that starts inside (e.g. selecting text) doesn't
const onBackdrop = (e) => { const r = $('#editor').getBoundingClientRect(); return e.target === $('#editor') && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom); };
let downOnBackdrop = false;
$('#editor').addEventListener('pointerdown', (e) => { downOnBackdrop = onBackdrop(e); });
$('#editor').addEventListener('click', (e) => { if (downOnBackdrop && onBackdrop(e)) $('#editor').close(); });
$('#habit-list').addEventListener('click', (e) => { const b = e.target.closest('button[data-habit]'); if (b) toggleHabit(b.dataset.habit); });
$('#ed-form').addEventListener('submit', saveEditor);
$('#ed-form').addEventListener('input', onEditorInput);
$('#ed-form').addEventListener('click', onEditorClick);
$('#gantt').addEventListener('click', (e) => { const s = e.target.closest('.seg[title]'); $('#gantt-info').textContent = s ? s.title : ''; });

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
