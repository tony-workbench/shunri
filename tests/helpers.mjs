// Fixtures and a minimal fake DOM shared by the test files.
import assert from "node:assert/strict";
import { createWorkbench } from "../workbench.js";
import { moveIntent } from "../intent-planner.js";
import { defaults } from "../storage.js";

export const DAY = "2026-10-13";
export const tick = (ms = 430) => new Promise((resolve) => setTimeout(resolve, ms));

// A plain study task (type "task") or fixed activity (type "activity", locked: true).
export const item = (id, start, duration, extra = {}) => ({ id, uid: id, title: id, start, duration, rest: 10,
  type: "task", done: false, locked: false, tags: [], dependencies: [], ...extra });

// Every task of every day, with its date.
export const allTasks = (days) => Object.entries(days).flatMap(([date, tasks]) => tasks.map((task) => ({ date, task })));
export const findTask = (days, id) => allTasks(days).find((entry) => entry.task.id === id)?.task;

export const emptyBranch = (days = {}) => ({ days, settings: defaults(), undo: null, calendar: { autoSync: false, syncQueue: { jobs: [] } } });

const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// Mounts the production workbench on a tiny fake DOM and a fake app API that
// plans with the production intent planner.
//   days       schedule of the personal branch
//   date       the date on screen
//   selected   id of the selected task, or null
//   now        ISO instant that Date.now() returns
//   branch     a complete branch, replacing days
//   extraApi   (context) => extra or overriding API members
//   saveKeepsUndo  Yes records { before } as the undo step
// Call close() in a finally block to restore the globals.
export function uiRig({ days = {}, date = DAY, selected = "Essay", now = "2026-10-13T15:00:00Z", branch = null,
  extraApi = () => ({}), saveKeepsUndo = false } = {}) {
  const originalDocument = globalThis.document, originalNow = Date.now, nodes = new Map();
  let html = "", proposal = null, saves = 0, clicks = 0, typed = 0, offered = 0;
  const node = (id) => ({ id, value: "", validity: { valid: true }, childIds: new Set(), dataset: {},
    set innerHTML(value) { this.html = value; for (const child of this.childIds) nodes.delete(child); this.childIds = parse(value); },
    get innerHTML() { return this.html || ""; },
    setAttribute() {}, removeAttribute() {}, addEventListener(type, fn) { this["on" + type] = fn; },
    remove() { nodes.delete(id); }, focus() { globalThis.document.activeElement = this; },
    querySelector: (s) => (s === "span" ? node("span") : null) });
  const parse = (value) => {
    const ids = new Set();
    for (const m of value.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>(?:([^<]*)<\/button>)?/g)) {
      const n = node(m[1]);
      n.disabled = /\bdisabled\b/.test(m[0]); n.text = m[2];
      nodes.set(n.id, n); ids.add(n.id);
    }
    return ids;
  };
  const root = { get innerHTML() { return html; }, set innerHTML(value) {
    html = value;
    for (const id of [...nodes.keys()]) if (!["workbench", "wb-calendar", "wb-calendar-label"].includes(id)) nodes.delete(id);
    parse(value);
  }, querySelector: (s) => (s === "h1" ? node("h1") : s === ".photo-frame img" ? node("img") : null) };
  nodes.set("workbench", root); nodes.set("wb-calendar", node("wb-calendar")); nodes.set("wb-calendar-label", node("wb-calendar-label"));
  globalThis.document = { activeElement: null, body: { tagName: "BODY", id: "" }, getElementById: (id) => nodes.get(id) || null };
  const context = { mode: "personal", date, revision: 1, proposalKey: "k", branch: branch || emptyBranch(days),
    ui: { selection: selected ? { mode: "personal", id: selected } : null } };
  const api = { context: () => context, movable: (t) => !t.done && !t.locked, clearNotice() {}, cancel() { proposal = null; },
    ambiguous: () => [], ambiguityFor: () => null,
    select(e) { context.date = e.date; context.ui.selection = { mode: context.mode, id: e.task.id }; },
    move: async (id, targetDate, time, intent) => {
      const result = moveIntent(context.branch.days, context.branch.settings, { taskId: id, targetDate,
        targetStart: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), startFromNow: intent.startFromNow });
      if (result.status !== "ok") offered = Math.max(offered, (result.alternatives || []).length);
      proposal = { result, revision: context.revision, mode: context.mode, targetTaskId: id };
      return proposal;
    },
    // Like app.js: Yes saves the days of the very proposal object the question was built from.
    confirm() {
      if (!proposal || proposal.result.status !== "ok") return false;
      saves++;
      if (saveKeepsUndo) context.branch.undo = { before: context.branch.days };
      context.branch.days = structuredClone(proposal.result.days); context.revision++; proposal = null; return true;
    },
    ...extraApi(context) };
  Date.now = () => Date.parse(now);
  const bench = createWorkbench(api);
  bench.render();
  const r = { nodes, context, bench,
    get branch() { return context.branch; },
    get saves() { return saves; }, get clicks() { return clicks; }, get typed() { return typed; },
    get proposal() { return proposal; }, get offered() { return offered; },
    html: () => html,
    output: () => nodes.get("wb-custom-result")?.innerHTML || html,
    label: (id) => nodes.get("wb-" + id)?.text,
    click(id) { const n = nodes.get("wb-" + id); assert.ok(n?.onclick, id); assert.ok(!n.disabled, id + " is enabled"); clicks++; return n.onclick(); },
    type(text) { const input = nodes.get("wb-expression"); input.value = text; typed++; input.oninput({ isComposing: false }); },
    buttons: () => [...r.output().matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]),
    lines: () => [...r.output().matchAll(/<p class="question-line">([^<]*)<\/p>/g)].map((m) => decode(m[1])),
    textLines: () => [...r.output().matchAll(/<p\b[^>]*>/g)].length,
    // Opens the move editor, asks for "today at 11:00 am" and waits for the question.
    async open(text = "today at 11:00 am") {
      r.click("task-actions");
      r.type(text);
      await tick();
      assert.match(r.output(), /<h2>Change it like this\?<\/h2>/);
    },
    close() { bench.home(); Date.now = originalNow; globalThis.document = originalDocument; } };
  return r;
}

// The five-default-rules scenario: today holds a completed task, three ordinary tasks and a fixed dinner;
// tomorrow holds a fixed standup and two ordinary tasks.
export const PROPOSAL_TODAY = "2026-10-27", PROPOSAL_TOMORROW = "2026-10-28";
export const proposalItem = (id, start, duration, extra = {}) => item(id, start, duration, { deferred: false, ...extra });
export const proposalFixture = () => ({
  [PROPOSAL_TODAY]: [
    proposalItem("t1", 540, 60, { done: true, completedDate: PROPOSAL_TODAY }), // 09:00-10:00, completed
    proposalItem("t2", 610, 120), // 10:10-12:10
    proposalItem("t3", 740, 180), // 12:20-15:20
    proposalItem("t4", 930, 140), // 15:30-17:50
    proposalItem("dinner", 1140, 60, { locked: true, type: "activity" }), // 19:00-20:00 fixed
  ],
  [PROPOSAL_TOMORROW]: [
    proposalItem("standup", 570, 30, { locked: true, type: "activity" }), // 09:30-10:00 fixed
    proposalItem("x", 670, 60), // 11:10-12:10
    proposalItem("y", 900, 60), // 15:00-16:00
  ],
});

// Planning engines: finds a task by id in a planner result and returns it together with the date it sits on.
export const planningFind = (result, id) =>
  Object.entries(result.days)
    .flatMap(([date, tasks]) => tasks.map((task) => ({ date, ...task })))
    .find((task) => task.id === id);

// Calendar connection and HTTP layer: drive createCalendarService().handle() without a socket,
// with a synthetic Google provider and an encrypted store in a temporary directory.
import * as connFs from "node:fs/promises";
import { tmpdir as connTmpdir } from "node:os";
import { join as connJoin } from "node:path";
import { Readable as ConnReadable } from "node:stream";
import { createCipheriv as connCipher, createDecipheriv as connDecipher, randomBytes as connRandom } from "node:crypto";

export const CONN_ORIGIN = "http://localhost:3000";

export async function connTempDir(t, prefix = "shunri-conn-") {
  const dir = await connFs.mkdtemp(connJoin(connTmpdir(), prefix));
  t.after(() => connFs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Environment for the service; `writes` omitted leaves CALENDAR_WRITES_ENABLED unset.
export const connEnv = (writes) => ({
  GOOGLE_CLIENT_ID: "SYNTHETIC-CLIENT", GOOGLE_CLIENT_SECRET: "SYNTHETIC-SECRET",
  ...(writes === undefined ? {} : { CALENDAR_WRITES_ENABLED: String(writes) }),
});

// Sends one request through service.handle(). `client` is a { cookie, csrf } jar that is updated from the response.
export async function connRequest(service, origin, path, { client = {}, body, bodyStream, headers = {} } = {}) {
  const req = bodyStream || ConnReadable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = body === undefined ? "GET" : "POST";
  req.headers = { host: new URL(origin).host, cookie: client.cookie || "",
    ...(body === undefined ? {} : { origin, "x-shunri-csrf": client.csrf }), ...headers };
  const responseHeaders = new Map();
  let status, text;
  const res = { setHeader(name, value) { responseHeaders.set(name.toLowerCase(), value); },
    writeHead(code, values = {}) { status = code; for (const [k, v] of Object.entries(values)) this.setHeader(k, v); },
    end(value = "") { text = String(value); } };
  assert.equal(await service.handle(req, res, new URL(`/api/calendar/${path}`, origin)), true);
  const setCookie = responseHeaders.get("set-cookie"), data = text ? JSON.parse(text) : null;
  if (setCookie) client.cookie = setCookie.split(";")[0];
  if (data?.csrfToken) client.csrf = data.csrfToken;
  return { status, data, setCookie, location: responseHeaders.get("location") };
}

// Fake Google: token endpoint, one owned calendar, empty events (404 on GET), and POST echoing the event.
// `calls` collects { url, method, body }; `beforeProvider(url, options)` may delay a call.
export function connProvider(calls, { beforeProvider } = {}) {
  return async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url: String(url), method, body: options.body });
    if (beforeProvider) await beforeProvider(String(url), options);
    if (String(url).includes("/token")) return Response.json({ access_token: "SYNTHETIC-ACCESS", expires_in: 3600 });
    if (String(url).includes("/calendarList")) return Response.json({ items: [{ id: "owned@example.test", summary: "Synthetic", accessRole: "owner", timeZone: "America/Los_Angeles" }] });
    if (method === "GET") return Response.json({}, { status: 404 });
    if (method === "POST") return Response.json({ ...JSON.parse(options.body), etag: '"synthetic-v1"' });
    throw new Error("Unexpected synthetic provider operation");
  };
}

// Reads and writes the encrypted connection record (iv, auth tag, ciphertext) next to its key file.
export async function connReadStore(dataDir) {
  const key = await connFs.readFile(connJoin(dataDir, "key")), bytes = await connFs.readFile(connJoin(dataDir, "connection.enc"));
  const decipher = connDecipher("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
}
export async function connWriteStore(dataDir, state, key) {
  if (key) await connFs.writeFile(connJoin(dataDir, "key"), key, { mode: 0o600 });
  else key = await connFs.readFile(connJoin(dataDir, "key"));
  const iv = connRandom(12), cipher = connCipher("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
  await connFs.writeFile(connJoin(dataDir, "connection.enc"), Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
}

// Makes the atomic rename of the encrypted record fail: the record moves aside and a directory takes its place.
export function connStoreFault(t, dataDir, preservedName = "connection.before-fault.enc") {
  const destination = connJoin(dataDir, "connection.enc"), preserved = connJoin(dataDir, preservedName);
  let blocked = false;
  const fault = {
    preserved,
    async block() { await connFs.rename(destination, preserved); await connFs.mkdir(destination); blocked = true; },
    async repair() {
      if (!blocked) return;
      blocked = false;
      await connFs.rm(destination, { recursive: true, force: true });
      await connFs.rename(preserved, destination).catch(() => {});
    },
  };
  t.after(() => fault.repair());
  return fault;
}

// Calendar service tests: a throw-away HTTP front end, an in-process client and a storage fault.
import { createServer as gcalCreateServer } from "node:http";
import { mkdir as gcalMkdir, rename as gcalRename, rm as gcalRm } from "node:fs/promises";
import { join as gcalJoin } from "node:path";
import { Readable as gcalReadable } from "node:stream";

// Serves a calendar service on a random local port and returns a cookie- and CSRF-aware client.
// getService is read on every request, so a test can swap in a restarted service.
export async function gcalHttpClient(t, getService) {
  let origin;
  const server = gcalCreateServer(async (req, res) => {
    if (!(await getService().handle(req, res, new URL(req.url, origin)))) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  let cookie = "", csrf = "";
  async function request(route, body, extraHeaders = {}) {
    const response = await fetch(`${origin}/api/calendar/${route}`, {
      redirect: "manual",
      method: body ? "POST" : "GET",
      headers: { Cookie: cookie,
        ...(body ? { Origin: origin, "X-Shunri-CSRF": csrf, "Content-Type": "application/json" } : {}),
        ...extraHeaders },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    const data = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data, location: response.headers.get("location") };
  }
  return { origin, request };
}

// Calls service.handle directly with a fake request and response, without a socket.
export function gcalDirectClient(service, origin = "http://localhost:3000") {
  let cookie = "", csrf;
  async function request(route, body) {
    const req = gcalReadable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = body === undefined ? "GET" : "POST";
    req.headers = { host: new URL(origin).host, cookie,
      ...(body === undefined ? {} : { origin, "x-shunri-csrf": csrf }) };
    const headers = new Map();
    let status, output = "";
    const res = {
      setHeader(key, value) { headers.set(key.toLowerCase(), value); },
      writeHead(code, values = {}) { status = code; for (const [key, value] of Object.entries(values)) this.setHeader(key, value); },
      end(value = "") { output = String(value); },
    };
    assert.equal(await service.handle(req, res, new URL(`/api/calendar/${route}`, origin)), true);
    const data = output ? JSON.parse(output) : null;
    if (headers.has("set-cookie")) cookie = headers.get("set-cookie").split(";")[0];
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status, data, location: headers.get("location") };
  }
  return { request };
}

// Starts a session and completes the OAuth round trip against a simulated Google.
export async function gcalConnect(client, code = "SYNTHETIC-CODE") {
  await client.request("status");
  const state = new URL((await client.request("connect")).location).searchParams.get("state");
  assert.equal((await client.request(`callback?state=${encodeURIComponent(state)}&code=${code}`)).location, "/?calendar=connected");
}

// Makes the next atomic save of connection.enc fail: the durable file is moved aside and a
// directory takes its place, so the production rename fails even when tests run as root.
export function gcalPersistenceFault(dataDir, backupName = "connection.before-fault.enc") {
  const destination = gcalJoin(dataDir, "connection.enc"), backup = gcalJoin(dataDir, backupName);
  let blocked = false;
  return {
    get blocked() { return blocked; },
    // The file that still holds the last durable bytes.
    get durablePath() { return blocked ? backup : destination; },
    async block() {
      assert.equal(blocked, false);
      await gcalRename(destination, backup);
      await gcalMkdir(destination);
      blocked = true;
    },
    async repair() {
      if (!blocked) return;
      await gcalRm(destination, { recursive: true, force: true });
      await gcalRename(backup, destination);
      blocked = false;
    },
  };
}

// ---- Fixed events and task locks: the demo-mode home screen on a tiny fake DOM ----
import { isActivity } from "../planner.js";

export const LOCK_DATE = "2026-10-12";
export const lockSettings = () => ({ ...defaults(), timeZone: "America/Los_Angeles", dayStart: 540, dayEnd: 1380 });
// A task at 12:00 for 45 minutes with no buffers.
export const lockTask = (id, extra = {}) => ({ ...item(id, 720, 45), bufferBefore: 0, bufferAfter: 0, ...extra });
export const lockMovable = (t) => !t.locked && !t.timeLocked && !isActivity(t);

// Renders the production home screen of the demo branch that holds `tasks` on LOCK_DATE.
//   api     extra workbench API members (unlock, undo, move, ...)
//   branch  () => branch, to read a branch that changes during the test
export function lockHome(tasks, { api = {}, branch = null } = {}) {
  const nodes = new Map();
  let html = "";
  const node = (id) => ({ id, setAttribute() {}, removeAttribute() {}, focus() {}, addEventListener() {}, classList: { add() {} } });
  const root = { get innerHTML() { return html; }, set innerHTML(v) { html = v; for (const m of v.matchAll(/id="([^"]+)"/g)) nodes.set(m[1], node(m[1])); },
    querySelector: (s) => (s === "h1" || s === ".photo-frame img" ? node(s) : null) };
  nodes.set("workbench", root); nodes.set("wb-calendar", node("calendar")); nodes.set("wb-calendar-label", node("label"));
  // The refresh notice is a live region outside the replaced shell.
  const notice = { textContent: "", hidden: true };
  globalThis.document = { getElementById: (id) => (id === "wb-refresh-notice" ? notice : nodes.get(id) || null) };
  const own = { days: { [LOCK_DATE]: tasks }, settings: lockSettings(), calendar: {}, exampleOrigin: LOCK_DATE };
  const bench = createWorkbench({ context: () => ({ mode: "demo", date: LOCK_DATE, branch: branch ? branch() : own,
    calendarStatus: { state: "disconnected" } }), movable: lockMovable, select() {}, clearNotice() {}, ...api });
  bench.render();
  return { bench, nodes, branch: own, html: () => html };
}
