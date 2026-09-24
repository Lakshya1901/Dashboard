import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

// Node may define its own (experimental) localStorage global; overwrite it.
Object.defineProperty(globalThis, "localStorage", {
  value: makeLocalStorage(),
  writable: true,
  configurable: true,
});

const { getSettings, setSettings, loadData, saveData } = await import("../sync.js");

function jsonResponse(status, body, headers) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
  };
}

function gistBody(data) {
  return { files: { "schedule.json": { content: JSON.stringify(data) } } };
}

beforeEach(() => {
  globalThis.localStorage.clear();
  setSettings({ gistId: "gist123", token: "" });
});

test("loadData success caches data", async () => {
  const sample = { routine: [], tasks: [], log: [] };
  globalThis.fetch = async () => jsonResponse(200, gistBody(sample));

  const result = await loadData();

  assert.deepEqual(result.data, sample);
  assert.equal(result.offline, false);
  assert.ok(result.syncedAt instanceof Date);

  const cached = JSON.parse(globalThis.localStorage.getItem("tasks.cache"));
  assert.deepEqual(cached.data, sample);
  assert.ok(cached.syncedAt);
});

test("auth header only present when a token is set", async () => {
  const sample = { routine: [], tasks: [], log: [] };
  let seenHeaders;
  globalThis.fetch = async (url, opts) => {
    seenHeaders = opts.headers;
    return jsonResponse(200, gistBody(sample));
  };

  setSettings({ gistId: "gist123", token: "" });
  await loadData();
  assert.equal(seenHeaders.Authorization, undefined);

  setSettings({ gistId: "gist123", token: "secret-token" });
  await loadData();
  assert.equal(seenHeaders.Authorization, "Bearer secret-token");
});

test("network error returns cached data with offline true", async () => {
  const sample = { routine: [], tasks: [], log: [] };
  globalThis.fetch = async () => jsonResponse(200, gistBody(sample));
  await loadData(); // populate cache

  globalThis.fetch = async () => {
    throw new Error("network down");
  };

  const result = await loadData();
  assert.equal(result.offline, true);
  assert.deepEqual(result.data, sample);
});

test("network error with no cache rethrows", async () => {
  globalThis.fetch = async () => {
    throw new Error("network down");
  };

  await assert.rejects(() => loadData());
});

test("HTTP error throws with status", async () => {
  globalThis.fetch = async () => jsonResponse(404, { message: "Not Found" });

  await assert.rejects(() => loadData(), (err) => {
    assert.match(err.message, /404/);
    assert.match(err.message, /Not Found/);
    return true;
  });
});

test("saveData fetches fresh, applies mutation, PATCHes body, updates cache", async () => {
  const remote = { routine: [], tasks: [{ id: "t1", done: false }], log: [] };
  const calls = [];

  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const method = (opts && opts.method) || "GET";
    if (method === "GET") {
      return jsonResponse(200, gistBody(remote));
    }
    if (method === "PATCH") {
      return jsonResponse(200, {});
    }
    throw new Error(`unexpected method ${method}`);
  };

  const result = await saveData((data) => {
    data.tasks[0].done = true;
  });

  assert.equal(result.data.tasks[0].done, true);
  assert.ok(result.syncedAt instanceof Date);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.github.com/gists/gist123");
  assert.equal((calls[0].opts && calls[0].opts.method) || "GET", "GET");

  const patchCall = calls[1];
  assert.equal(patchCall.opts.method, "PATCH");
  const sentBody = JSON.parse(patchCall.opts.body);
  const sentData = JSON.parse(sentBody.files["schedule.json"].content);
  assert.equal(sentData.tasks[0].done, true);

  const cached = JSON.parse(globalThis.localStorage.getItem("tasks.cache"));
  assert.equal(cached.data.tasks[0].done, true);
});
