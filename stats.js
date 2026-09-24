// Stats: habit completion percentage per day and streaks, plus a small SVG bar chart renderer.

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function habitsByDay(data, today, days = 30) {
  const habits = data.habits || [];
  if (habits.length === 0) return [];

  const log = data.log || [];
  let earliest = null;
  for (const entry of log) {
    if (earliest === null || entry.date < earliest) earliest = entry.date;
  }
  if (earliest === null) return [];

  const habitIds = new Set(habits.map((r) => r.id));

  // Map date -> set of distinct habit ids checked off (ended session) that date.
  const doneByDate = new Map();
  for (const entry of log) {
    if (!entry.end) continue;
    if (!habitIds.has(entry.itemId)) continue;
    let set = doneByDate.get(entry.date);
    if (!set) {
      set = new Set();
      doneByDate.set(entry.date, set);
    }
    set.add(entry.itemId);
  }

  const series = [];
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const dateStr = fmtDate(d);
    if (dateStr < earliest) continue;
    const doneSet = doneByDate.get(dateStr);
    const pct = Math.round(100 * (doneSet ? doneSet.size : 0) / habits.length);
    series.push({ date: dateStr, pct });
  }
  return series;
}

// Consecutive days the habit was checked off, ending today (or yesterday while today is still open).
export function habitStreak(data, id, today) {
  const done = new Set((data.log || []).filter((e) => e.itemId === id && e.end).map((e) => e.date));
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!done.has(fmtDate(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  for (; done.has(fmtDate(d)); d.setDate(d.getDate() - 1)) n++;
  return n;
}

function average(values) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

// Groups a daily series into weeks (starting Monday) or months, averaging each group's percentages.
// Each group is dated by its first day in the series.
export function bucketSeries(series, unit) {
  if (unit === "day") return series;
  const groups = new Map();
  for (const s of series) {
    let key = s.date.slice(0, 7);
    if (unit === "week") {
      const [y, m, d] = s.date.split("-").map(Number);
      const monday = new Date(y, m - 1, d);
      monday.setDate(d - ((monday.getDay() + 6) % 7));
      key = fmtDate(monday);
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.values()].map((g) => ({ date: g[0].date, pct: average(g.map((s) => s.pct)) }));
}

// Chart ranges: longer ranges show weekly or monthly averages so bars stay readable
const RANGES = {
  "1M": { days: 30, unit: "day", axis: "Date" },
  "3M": { days: 91, unit: "week", axis: "Week" },
  "6M": { days: 182, unit: "week", axis: "Week" },
  "1Y": { days: 365, unit: "month", axis: "Month" },
};
let range = "1M";
try { if (RANGES[localStorage.getItem("statsRange")]) range = localStorage.getItem("statsRange"); } catch { /* default */ }

// One tonal colour: bars get more solid the more habits got done (Material-style)
const barOpacity = (pct) => 0.25 + 0.75 * (pct / 100);

function monthLabel(dateStr, long) {
  const [y, m] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, long ? { month: "long", year: "numeric" } : { month: "short" });
}

function dayLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  const month = date.toLocaleDateString(undefined, { month: "short" });
  return `${weekday} ${d} ${month}`;
}

function shortLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const month = date.toLocaleDateString(undefined, { month: "short" });
  return `${month} ${d}`;
}

export function renderStats(el, data, now) {
  const width = el.clientWidth || 700; // measured before clearing; the chart is sized from it
  const series = habitsByDay(data, now, 30);
  el.innerHTML = "";

  const card = document.createElement("div");
  card.className = "widget stats-card";

  const head = document.createElement("div");
  head.className = "row";
  head.innerHTML = `<p class="title">Habits</p>
    <div class="seg-ctl" role="group" aria-label="Chart range">${Object.keys(RANGES).map((r) =>
      `<button type="button" data-range="${r}" aria-pressed="${r === range}">${r}</button>`).join("")}</div>`;
  head.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-range]");
    if (!b) return;
    range = b.dataset.range;
    try { localStorage.setItem("statsRange", range); } catch { /* not remembered */ }
    renderStats(el, data, now);
    el.querySelector(`button[data-range="${range}"]`).focus();
  });
  card.appendChild(head);

  if (series.length === 0) {
    const empty = document.createElement("p");
    empty.className = "small";
    empty.textContent = "No habit data yet";
    card.appendChild(empty);
    el.appendChild(card);
    return;
  }

  const today = series[series.length - 1].pct;
  const last7 = average(series.slice(-7).map((s) => s.pct));
  const last30 = average(series.slice(-30).map((s) => s.pct));

  const summary = document.createElement("div");
  summary.className = "stats-summary";
  summary.innerHTML = `
    <div class="stats-summary-item">
      <p class="small">Today</p>
      <p class="stats-num">${today}%</p>
    </div>
    <div class="stats-summary-item">
      <p class="small">7-day avg</p>
      <p class="stats-num">${last7 === null ? "–" : last7 + "%"}</p>
    </div>
    <div class="stats-summary-item">
      <p class="small">30-day avg</p>
      <p class="stats-num">${last30 === null ? "–" : last30 + "%"}</p>
    </div>
  `;
  card.appendChild(summary);

  const R = RANGES[range];
  const buckets = bucketSeries(habitsByDay(data, now, R.days), R.unit);
  // Month labels carry a short year on the first bar and on January, e.g. "Sep '25"
  const label = (date, i) => R.unit !== "month" ? shortLabel(date)
    : monthLabel(date) + (i === 0 || date.slice(5, 7) === "01" ? ` '${date.slice(2, 4)}` : "");
  const tip = (b) => R.unit === "day" ? `${dayLabel(b.date)} · ${b.pct}%`
    : R.unit === "week" ? `Week of ${shortLabel(b.date)} · ${b.pct}% avg` : `${monthLabel(b.date, true)} · ${b.pct}% avg`;

  // Layout in viewBox units. Green graph paper: 6-unit minor squares, a major line every 4 squares (every 25%).
  // The paper runs one square above 100% so full-day dots stay inside it.
  const n = buckets.length;
  const cell = 6;
  const major = cell * 4;
  const padLeft = 32; // y-axis labels and title
  // Aim for ~1.6px per unit so labels stay readable on phones: narrow screens get fewer squares, not smaller text
  const plotW = cell * Math.min(54, Math.max(24, Math.floor((width / 1.6 - padLeft - 12) / cell)));
  const chartW = padLeft + plotW + 12; // right margin keeps the last date label inside
  const plotTop = 10 + cell; // the 100% line
  const plotH = major * 4; // 0% to 100%
  const plotBottom = plotTop + plotH;
  const chartH = plotBottom + 30; // x-axis labels and title
  // Bars take 60% of their slot so the graph paper shows between them
  const slot = plotW / n;
  const barW = Math.max(1, slot * 0.6);
  const barGap = slot - barW;

  const yFor = (pct) => plotTop + plotH * (1 - pct / 100);

  let bars = "";
  let labels = "";
  const points = [];
  // As many labels as fit, counted back from today so the latest bar is always labelled
  const labelEvery = Math.ceil(n / Math.max(2, Math.floor(plotW / (R.unit === "month" ? 18 : 30))));
  for (let i = 0; i < n; i++) {
    const item = buckets[i];
    const x = padLeft + i * slot + barGap / 2;
    const y = yFor(item.pct);
    points.push([x + barW / 2, y]);
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(plotBottom - y).toFixed(1)}" rx="1.5" fill="var(--habit)" fill-opacity="${barOpacity(item.pct).toFixed(2)}"><title>${tip(item)}</title></rect>`;
    if ((n - 1 - i) % labelEvery === 0) {
      labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${plotBottom + 10}" font-size="7" fill="var(--text-2)" text-anchor="middle">${label(item.date, i)}</text>`;
    }
  }
  let yLabels = "";
  for (const pct of [0, 25, 50, 75, 100]) {
    yLabels += `<text x="${padLeft - 3}" y="${(yFor(pct) + 2.5).toFixed(1)}" font-size="7" fill="var(--text-2)" text-anchor="end">${pct}%</text>`;
  }
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const dots = points.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.8" fill="var(--card)" stroke="var(--text)" stroke-width="1" />`).join("");
  const paperTop = plotTop - cell;

  const svg = `
    <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="${chartH}" role="img" aria-label="Habit completion by day">
      <defs>
        <pattern id="paper-minor" width="${cell}" height="${cell}" x="${padLeft}" y="${plotTop}" patternUnits="userSpaceOnUse">
          <path d="M ${cell} 0 L 0 0 0 ${cell}" fill="none" stroke="var(--paper-minor)" stroke-width="0.5" />
        </pattern>
        <pattern id="paper-major" width="${major}" height="${major}" x="${padLeft}" y="${plotTop}" patternUnits="userSpaceOnUse">
          <rect width="${major}" height="${major}" fill="url(#paper-minor)" />
          <path d="M ${major} 0 L 0 0 0 ${major}" fill="none" stroke="var(--paper-major)" stroke-width="0.8" />
        </pattern>
      </defs>
      <rect x="${padLeft}" y="${paperTop}" width="${plotW}" height="${plotBottom - paperTop}" fill="var(--paper)" />
      <rect x="${padLeft}" y="${paperTop}" width="${plotW}" height="${plotBottom - paperTop}" fill="url(#paper-major)" stroke="var(--paper-major)" stroke-width="0.8" />
      ${bars}
      <polyline points="${line}" fill="none" stroke="var(--text)" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
      <line x1="${padLeft}" y1="${paperTop}" x2="${padLeft}" y2="${plotBottom}" stroke="var(--text-2)" stroke-width="0.8" />
      <line x1="${padLeft}" y1="${plotBottom}" x2="${padLeft + plotW}" y2="${plotBottom}" stroke="var(--text-2)" stroke-width="0.8" />
      ${yLabels}
      ${labels}
      <text x="8" y="${plotTop + plotH / 2}" font-size="7" fill="var(--muted)" text-anchor="middle" transform="rotate(-90 8 ${plotTop + plotH / 2})">Habits done</text>
      <text x="${padLeft + plotW / 2}" y="${chartH - 3}" font-size="7" fill="var(--muted)" text-anchor="middle">${R.axis}</text>
    </svg>
  `;

  const chartWrap = document.createElement("div");
  chartWrap.className = "stats-chart";
  chartWrap.innerHTML = svg;
  card.appendChild(chartWrap);

  const legend = document.createElement("p");
  legend.className = "label legend stats-legend";
  legend.innerHTML = `0%${[0, 33, 67, 100].map((p) => `<i style="opacity: ${barOpacity(p)}"></i>`).join("")}100%`;
  card.appendChild(legend);

  el.appendChild(card);
}
