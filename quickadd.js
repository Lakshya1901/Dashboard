// Quick add: turns "Essay 2.5h max fri" into a task. Recognised words, anywhere in the text:
//   time      2h, 1.5h, 90m, 2h30m          (default 1h)
//   priority  max, med, low                 (default med)
//   deadline  today, tomorrow/tmrw, mon..sun (next one, today included), 2026-10-01   (default: a week from today)
// Everything else is the task's name.

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plusDays = (today, n) => ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));

export function parseQuickAdd(text, today) {
  let estimateMin = null, priority = null, deadline = null;
  const name = [];
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const w = word.toLowerCase();
    const time = /^(?:(\d+(?:\.\d+)?)h(?:rs?)?)?(?:(\d+)m(?:in)?)?$/.exec(w);
    const day = DAYS.findIndex((d) => w === d || w === d.slice(0, 3));
    if (estimateMin === null && time && (time[1] || time[2])) {
      estimateMin = Math.round(Number(time[1] || 0) * 60 + Number(time[2] || 0));
    } else if (priority === null && ["max", "med", "low"].includes(w)) {
      priority = w;
    } else if (deadline === null && ["today", "tod"].includes(w)) {
      deadline = ymd(today);
    } else if (deadline === null && ["tomorrow", "tmrw", "tmr"].includes(w)) {
      deadline = plusDays(today, 1);
    } else if (deadline === null && day >= 0) {
      deadline = plusDays(today, (day - today.getDay() + 7) % 7);
    } else if (deadline === null && /^\d{4}-\d\d-\d\d$/.test(w)) {
      deadline = w;
    } else {
      name.push(word);
    }
  }
  return {
    name: name.join(" "),
    estimateMin: estimateMin > 0 ? estimateMin : 60,
    priority: priority || "med",
    deadline: deadline || plusDays(today, 7),
  };
}
