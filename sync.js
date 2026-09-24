// sync.js — GitHub Gist-backed storage with an offline localStorage cache.

const GIST_ID_KEY = "tasks.gistId";
const TOKEN_KEY = "tasks.token";
const CACHE_KEY = "tasks.cache";
const FILE_NAME = "schedule.json";

export function getSettings() {
  return {
    gistId: localStorage.getItem(GIST_ID_KEY) || "",
    token: localStorage.getItem(TOKEN_KEY) || "",
  };
}

export function setSettings({ gistId, token }) {
  // The cache belongs to one Gist; drop it when switching
  if ((gistId || "") !== (localStorage.getItem(GIST_ID_KEY) || "")) localStorage.removeItem(CACHE_KEY);
  localStorage.setItem(GIST_ID_KEY, gistId || "");
  localStorage.setItem(TOKEN_KEY, token || "");
}

function readCache() {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return { data: parsed.data, syncedAt: new Date(parsed.syncedAt) };
}

function writeCache(data, syncedAt) {
  localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ data, syncedAt: syncedAt.toISOString() })
  );
}

async function fetchGist() {
  const { gistId, token } = getSettings();
  if (!gistId) throw new Error("No gist ID configured. Add one in settings.");

  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers,
      cache: "no-store",
    });
  } catch (err) {
    throw { networkError: true, cause: err };
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.message) message += `: ${body.message}`;
    } catch {
      // ignore body parse errors
    }
    throw new Error(message);
  }

  const json = await res.json();
  const file = json.files && json.files[FILE_NAME];
  if (!file) throw new Error(`Gist has no file named ${FILE_NAME}`);
  return JSON.parse(file.content);
}

export async function loadData() {
  try {
    const data = await fetchGist();
    const syncedAt = new Date();
    writeCache(data, syncedAt);
    return { data, syncedAt, offline: false };
  } catch (err) {
    if (err && err.networkError) {
      const cached = readCache();
      if (cached) return { data: cached.data, syncedAt: cached.syncedAt, offline: true };
      throw err.cause;
    }
    throw err;
  }
}

export async function saveData(mutate) {
  const data = await fetchGist();
  mutate(data);

  const { gistId, token } = getSettings();
  const headers = {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers,
    cache: "no-store",
    body: JSON.stringify({
      files: { [FILE_NAME]: { content: JSON.stringify(data, null, 2) } },
    }),
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.message) message += `: ${body.message}`;
    } catch {
      // ignore body parse errors
    }
    throw new Error(message);
  }

  const syncedAt = new Date();
  writeCache(data, syncedAt);
  return { data, syncedAt };
}
