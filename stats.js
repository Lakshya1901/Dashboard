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

export function renderStats(el, series) {
  el.innerHTML = "";

  const card = document.createElement("div");
  card.className = "widget stats-card";

  const title = document.createElement("p");
  title.className = "title";
  title.textContent = "Habits";
  card.appendChild(title);

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

  const n = series.length;
  const chartW = 360; // small viewBox so labels stay readable when the SVG scales to the card width
  const chartH = 120;
  const padTop = 8;
  const padBottom = 16;
  const padSide = 4;
  const plotH = chartH - padTop - padBottom;
  // Bars take 60% of their slot so the graph paper shows between them
  const slot = (chartW - padSide * 2) / n;
  const barW = Math.max(1, slot * 0.6);
  const barGap = slot - barW;

  const yFor = (pct) => padTop + plotH * (1 - pct / 100);

  let bars = "";
  let labels = "";
  const points = [];
  const labelEvery = 7;
  for (let i = 0; i < n; i++) {
    const item = series[i];
    const x = padSide + i * slot + barGap / 2;
    const y = yFor(item.pct);
    const h = padTop + plotH - y;
    const fill = item.pct >= 100 ? "var(--habit)" : "var(--habit-bg)";
    points.push(`${(x + barW / 2).toFixed(1)},${y.toFixed(1)}`);
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="1.5" fill="${fill}"><title>${dayLabel(item.date)} · ${item.pct}%</title></rect>`;
    if (i % labelEvery === 0 || i === n - 1) {
      const lx = x + barW / 2;
      labels += `<text x="${lx.toFixed(1)}" y="${chartH - 4}" font-size="9" fill="var(--muted)" text-anchor="middle">${shortLabel(item.date)}</text>`;
    }
  }

  // Graph paper: a minor grid of 6-unit squares with a major line every 4 squares (every 25%), aligned to the plot
  const cell = 6;
  const major = cell * 4;
  const plotW = chartW - padSide * 2;
  const dots = points.map((p) => { const [cx, cy] = p.split(","); return `<circle cx="${cx}" cy="${cy}" r="1.8" fill="var(--card)" stroke="var(--text)" stroke-width="1" />`; }).join("");

  const svg = `
    <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="${chartH}" role="img" aria-label="Habit completion by day">
      <defs>
        <pattern id="paper-minor" width="${cell}" height="${cell}" x="${padSide}" y="${padTop}" patternUnits="userSpaceOnUse">
          <path d="M ${cell} 0 L 0 0 0 ${cell}" fill="none" stroke="var(--text)" stroke-opacity="0.09" stroke-width="0.5" />
        </pattern>
        <pattern id="paper-major" width="${major}" height="${major}" x="${padSide}" y="${padTop}" patternUnits="userSpaceOnUse">
          <rect width="${major}" height="${major}" fill="url(#paper-minor)" />
          <path d="M ${major} 0 L 0 0 0 ${major}" fill="none" stroke="var(--text)" stroke-opacity="0.2" stroke-width="0.7" />
        </pattern>
      </defs>
      <rect x="${padSide}" y="${padTop}" width="${plotW}" height="${plotH}" fill="url(#paper-major)" stroke="var(--text)" stroke-opacity="0.2" stroke-width="0.7" />
      ${bars}
      <polyline points="${points.join(" ")}" fill="none" stroke="var(--text)" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
      ${labels}
    </svg>
  `;

  const chartWrap = document.createElement("div");
  chartWrap.className = "stats-chart";
  chartWrap.innerHTML = svg;
  card.appendChild(chartWrap);

  el.appendChild(card);
}
