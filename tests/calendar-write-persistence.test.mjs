import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createCalendarService, managedEventId } from "../calendar-service.mjs";
import { gcalConnect, gcalDirectClient, gcalPersistenceFault } from "./helpers.mjs";

// These tests make the real atomic save of the encrypted connection record fail and then check what
// the service still trusts, in reads, in a fresh service instance and after later unrelated saves.

describe("write intent and receipt persistence", () => {
  const origin = "http://localhost:3000", calendarId = "persistence@example.test";
  const profileId = "synthetic-persistence-profile", uid = "synthetic-persistence-task";
  const eventId = managedEventId(profileId, uid);
  const task = { id: uid, uid, title: "Synthetic persistence task", date: "2026-10-20",
    start: 660, duration: 35, timeZone: "America/Los_Angeles" };
  const payload = value => ({ mode: "personal", profileId, calendarId, tasks: [value] });
  const readRoute = `events?calendarId=${encodeURIComponent(calendarId)}&from=2026-10-20&to=2026-10-20&timeZone=America%2FLos_Angeles`;

  // Real filesystem rename failures, a local synthetic provider, and a fresh service instance after
  // recovery. No module mocks, debug API, sockets or real credentials.
  async function setup() {
    const dataDir = await mkdtemp(join(tmpdir(), "shunri-write-persistence-"));
    const fault = gcalPersistenceFault(dataDir);
    const events = new Map(), writes = [];
    let failAfterNextWrite = false, version = 0;
    const fetchImpl = async (input, options = {}) => {
      const url = new URL(input), method = options.method || "GET";
      if (url.hostname === "oauth2.googleapis.com")
        return Response.json({ access_token: "SYNTHETIC-PERSISTENCE-ACCESS", expires_in: 3600 });
      if (url.pathname.endsWith("/calendarList"))
        return Response.json({ items: [{ id: calendarId, summary: "Synthetic Calendar", accessRole: "owner", timeZone: "America/Los_Angeles" }] });
      const parts = url.pathname.split("/").map(decodeURIComponent), id = parts[parts.indexOf("events") + 1];
      if (method === "GET" && url.pathname.includes("/events"))
        return id ? (events.has(id) ? Response.json(events.get(id)) : Response.json({}, { status: 404 }))
          : Response.json({ timeZone: "America/Los_Angeles", items: [...events.values()] });
      if ((method === "POST" && !id || method === "PUT" && id) && url.pathname.includes("/events")) {
        const inputEvent = JSON.parse(options.body), key = id || inputEvent.id;
        if (method === "PUT") assert.equal(options.headers["If-Match"], events.get(key).etag);
        const saved = { ...inputEvent, id: key, etag: `"remote-${++version}"`, status: "confirmed", organizer: { self: true } };
        events.set(key, saved);
        writes.push({ method, eventId: key, etag: saved.etag });
        if (failAfterNextWrite) { failAfterNextWrite = false; await fault.block(); }
        return Response.json(saved);
      }
      throw new Error(`Unexpected synthetic provider operation: ${method} ${url.pathname}`);
    };
    const makeClient = () => gcalDirectClient(createCalendarService({ origin, dataDir, fetchImpl,
      env: { GOOGLE_CLIENT_ID: "SYNTHETIC-CLIENT", GOOGLE_CLIENT_SECRET: "SYNTHETIC-SECRET", CALENDAR_WRITES_ENABLED: "true" } }), origin);
    let client = makeClient();
    const request = (route, body) => client.request(route, body);
    await gcalConnect({ request });
    return { request, writes, events, blockPersistence: () => fault.block(), restorePersistence: () => fault.repair(),
      failAfterNextWrite() { failAfterNextWrite = true; },
      async restart() {
        await fault.repair(); client = makeClient();
        assert.equal((await request("status")).data.state, "connected");
      },
      async close() { await fault.repair(); await rm(dataDir, { recursive: true, force: true }); },
    };
  }

  async function preview(h, value, action) {
    const result = await h.request("preview", payload(value));
    assert.equal(result.status, 200); assert.equal(result.data.canExecute, true);
    assert.equal(result.data.items[0].action, action);
    return result.data.planId;
  }
  async function seed(h) {
    const result = await h.request("execute", { planId: await preview(h, task, "create") });
    assert.equal(result.data.results[0].ok, true);
    return result.data.results[0].calendarLink;
  }
  async function readOne(h) {
    const result = await h.request(readRoute);
    assert.equal(result.status, 200); assert.equal(result.data.events.length, 1);
    const event = result.data.events[0];
    assert.equal(event.eventId, eventId); assert.equal(event.managedUid, uid); assert.equal(event.managedProfileId, profileId);
    return event;
  }

  test("when the write intent cannot be saved, neither a create nor an update reaches Google", async () => {
    const observed = [];
    for (const action of ["create", "update"]) {
      const h = await setup();
      try {
        const link = action === "update" ? await seed(h) : null;
        const desired = link ? { ...task, title: "Updated synthetic task", start: 750, calendarLink: link } : task;
        const planId = await preview(h, desired, action), beforeWrites = h.writes.length;
        await h.blockPersistence();
        const result = await h.request("execute", { planId });
        assert.equal(result.status, 200); assert.equal(result.data.results[0].ok, false);
        observed.push({ action, remoteWrites: h.writes.length - beforeWrites });
      } finally { await h.close(); }
    }
    assert.deepEqual(observed, [{ action: "create", remoteWrites: 0 }, { action: "update", remoteWrites: 0 }]);
  });

  test("a create whose receipt cannot be saved stays managed and is recovered without a second POST", async () => {
    const h = await setup();
    try {
      const planId = await preview(h, task, "create"); h.failAfterNextWrite();
      const result = await h.request("execute", { planId });
      assert.equal(result.status, 200); assert.equal(result.data.results[0].ok, false);
      assert.deepEqual(h.writes.map(w => w.method), ["POST"]);
      assert.equal((await readOne(h)).managed, true);
      await h.restart();
      assert.equal((await readOne(h)).managed, true, "durable intent retains management after a fresh service load");
      const recovered = await h.request("execute", { planId: await preview(h, task, "skip") });
      assert.equal(recovered.data.results[0].ok, true); assert.equal(recovered.data.results[0].action, "skip");
      assert.equal(h.events.size, 1); assert.deepEqual(h.writes.map(w => w.method), ["POST"]);
      const final = await readOne(h); assert.equal(final.managed, true); assert.equal(final.baselineEtag, '"remote-1"');
    } finally { await h.close(); }
  });

  test("an update whose receipt cannot be saved keeps the old baseline and is recovered by comparing the actual remote event", async () => {
    const h = await setup();
    try {
      const link = await seed(h), desired = { ...task, title: "Updated synthetic task", start: 750, calendarLink: link };
      const planId = await preview(h, desired, "update"); h.failAfterNextWrite();
      const result = await h.request("execute", { planId });
      assert.equal(result.status, 200); assert.equal(result.data.results[0].ok, false);
      assert.deepEqual(h.writes.map(w => w.method), ["POST", "PUT"]);
      assert.equal((await readOne(h)).managed, true);
      await h.restart();
      const pending = await readOne(h); assert.equal(pending.managed, true);
      assert.equal(pending.etag, '"remote-2"'); assert.equal(pending.baselineEtag, '"remote-1"');
      const recovered = await h.request("execute", { planId: await preview(h, desired, "skip") });
      assert.equal(recovered.data.results[0].ok, true); assert.equal(recovered.data.results[0].action, "skip");
      assert.deepEqual(h.writes.map(w => w.method), ["POST", "PUT"]); assert.equal(h.events.size, 1);
      const final = await readOne(h); assert.equal(final.managed, true); assert.equal(final.baselineEtag, '"remote-2"');
    } finally { await h.close(); }
  });

  test("a pending create receipt cannot manage an event whose ownership markers changed", async () => {
    const h = await setup();
    try {
      const planId = await preview(h, task, "create"); h.failAfterNextWrite();
      assert.equal((await h.request("execute", { planId })).data.results[0].ok, false);
      await h.restart();
      const previous = h.events.get(eventId);
      h.events.set(eventId, { ...previous, extendedProperties: { private: {
        shunriOwner: "another-profile", shunriTask: "another-task",
      } } });
      const read = await h.request(readRoute), event = read.data.events[0];
      assert.equal(event.managed, false);
      assert.equal(event.managedUid, "another-task");
      assert.equal(event.managedProfileId, "another-profile");
      const rejected = await h.request("preview", payload(task));
      assert.equal(rejected.data.canExecute, false);
      assert.deepEqual(h.writes.map(w => w.method), ["POST"]);
    } finally { await h.close(); }
  });
});

describe("adoption persistence", () => {
  const event = id => ({
    id, etag: '"v1"', summary: `Synthetic ${id}`, status: "confirmed", organizer: { self: true },
    start: { dateTime: "2026-10-19T11:00:00-07:00", timeZone: "America/Los_Angeles" },
    end: { dateTime: "2026-10-19T12:00:00-07:00", timeZone: "America/Los_Angeles" },
  });
  const task = (id, changes = {}) => ({
    id: `task-${id}`, uid: `uid-${id}`, title: `Synthetic ${id}`, date: "2026-10-19",
    start: 660, duration: 60, timeZone: "America/Los_Angeles", type: "task",
    calendarLink: { source: "google", managed: true, calendarId: "mine", eventId: id, etag: '"v1"' },
    ...changes,
  });
  const payload = tasks => ({ mode: "personal", profileId: "synthetic-profile", calendarId: "mine", tasks });
  const readRange = "events?from=2026-10-19&to=2026-10-19&timeZone=America%2FLos_Angeles";

  async function setup(t) {
    const dataDir = await mkdtemp(join(tmpdir(), "shunri-adopt-persistence-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const origin = "http://localhost:3000", events = new Map(["a", "b"].map(id => [id, event(id)])), calls = [];
    let beforeEventGet;
    const options = {
      origin, dataDir,
      env: { GOOGLE_CLIENT_ID: "SYNTHETIC-CLIENT", GOOGLE_CLIENT_SECRET: "SYNTHETIC-SECRET", CALENDAR_WRITES_ENABLED: "true" },
      fetchImpl: async (input, init = {}) => {
        const url = new URL(input), method = init.method || "GET";
        if (url.origin === "https://oauth2.googleapis.com") {
          assert.equal(init.body.get("grant_type"), "authorization_code");
          return Response.json({ access_token: "SYNTHETIC-ACCESS", refresh_token: "SYNTHETIC-REFRESH", expires_in: 3600 });
        }
        assert.equal(url.origin, "https://www.googleapis.com");
        assert.equal(init.headers.Authorization, "Bearer SYNTHETIC-ACCESS");
        calls.push({ path: url.pathname, method });
        assert.equal(method, "GET", "adoption and preview must not mutate provider events");
        if (url.pathname.endsWith("/calendarList")) return Response.json({ items: [{ id: "mine", summary: "Synthetic", accessRole: "owner", timeZone: "America/Los_Angeles" }] });
        const parts = url.pathname.split("/").map(decodeURIComponent), eventIndex = parts.indexOf("events");
        assert.ok(eventIndex > 0);
        const id = parts[eventIndex + 1];
        if (!id) return Response.json({ items: [...events.values()], timeZone: "America/Los_Angeles" });
        if (beforeEventGet) await beforeEventGet(id);
        return events.has(id) ? Response.json(events.get(id)) : Response.json({}, { status: 404 });
      },
    };
    function client() {
      const { request } = gcalDirectClient(createCalendarService(options), origin);
      async function read() {
        const response = await request(readRange);
        assert.equal(response.status, 200); assert.deepEqual(response.data.errors, []);
        return Object.fromEntries(response.data.events.map(item => [item.eventId, {
          managed: item.managed, baselineEtag: item.baselineEtag ?? null,
        }]));
      }
      async function adopt(tasks) {
        const response = await request("adopt", payload(tasks));
        assert.equal(response.status, 200);
        return response.data;
      }
      return { request, read, adopt };
    }
    // Fails the next save of the connection record; the returned function undoes the fault.
    async function blockPersistence() {
      const fault = gcalPersistenceFault(dataDir, "synthetic-approved.enc");
      await fault.block();
      return () => fault.repair();
    }
    const current = client();
    await gcalConnect(current);
    async function restarted() { const next = client(); await next.request("status"); return next; }
    return { current, restarted, events, calls, blockPersistence,
      onEventGet(callback) { beforeEventGet = callback; } };
  }

  test("failed first adoption never becomes managed in reads, restart or an unrelated later save", async t => {
    const h = await setup(t);
    assert.equal((await h.current.read()).a.managed, false);
    const repair = await h.blockPersistence(); let result;
    try { result = await h.current.adopt([task("a")]); } finally { await repair(); }
    assert.equal(result.results[0].ok, false);
    const afterFailure = await h.current.read(), restartedBeforeSave = await (await h.restarted()).read();
    assert.equal((await h.current.adopt([task("b")])).results[0].ok, true);
    const afterUnrelatedSave = await h.current.read(), restartedAfterSave = await (await h.restarted()).read();
    assert.deepEqual({ afterFailure: afterFailure.a, restartedBeforeSave: restartedBeforeSave.a,
      afterUnrelatedSave: afterUnrelatedSave.a, restartedAfterSave: restartedAfterSave.a }, {
      afterFailure: { managed: false, baselineEtag: null }, restartedBeforeSave: { managed: false, baselineEtag: null },
      afterUnrelatedSave: { managed: false, baselineEtag: null }, restartedAfterSave: { managed: false, baselineEtag: null },
    });
    assert.deepEqual(afterUnrelatedSave.b, { managed: true, baselineEtag: '"v1"' });
    assert.deepEqual(restartedAfterSave.b, afterUnrelatedSave.b);
  });

  test("failed re-adoption keeps the existing approved baseline and its remote-conflict protection", async t => {
    const h = await setup(t);
    assert.equal((await h.current.adopt([task("a")])).results[0].ok, true);
    h.events.set("a", { ...event("a"), etag: '"v2"', summary: "Synthetic revised a" });
    const replacement = task("a", { title: "Synthetic revised a", calendarLink: { ...task("a").calendarLink, etag: '"v2"' } });
    const repair = await h.blockPersistence(); let result;
    try { result = await h.current.adopt([replacement]); } finally { await repair(); }
    assert.equal(result.results[0].ok, false);
    const live = await h.current.read(), beforeUnrelated = await (await h.restarted()).read();
    const moved = await h.current.request("preview", payload([task("a", { start: 720 })]));
    assert.equal((await h.current.adopt([task("b")])).results[0].ok, true);
    const afterUnrelated = await (await h.restarted()).read();
    assert.deepEqual({ live: live.a, restarted: beforeUnrelated.a, afterUnrelated: afterUnrelated.a,
      previewAction: moved.data.items[0].action }, {
      live: { managed: true, baselineEtag: '"v1"' }, restarted: { managed: true, baselineEtag: '"v1"' },
      afterUnrelated: { managed: true, baselineEtag: '"v1"' }, previewAction: "error",
    });
    assert.match(moved.data.items[0].reason, /Google has newer changes/);
  });

  test(`colon-colliding identities preserve both receipts across restart`, { timeout: 10000 }, async t => {
    const first = { profileId: "a:b", uid: "c" };
    const second = { profileId: "a", uid: "b:c" };
    assert.equal(`${first.profileId}:${first.uid}:mine`, `${second.profileId}:${second.uid}:mine`);
    const h = await setup(t);
    async function adopt(client, identity, id) {
      const response = await client.request("adopt", {
        ...payload([task(id, { uid: identity.uid })]), profileId: identity.profileId,
      });
      assert.equal(response.status, 200);
      return response.data.results[0];
    }
    assert.equal((await adopt(h.current, first, "a")).ok, true);
    assert.equal((await adopt(h.current, second, "b")).ok, true);
    for (const client of [h.current, await h.restarted()]) {
      const read = await client.request(readRange);
      assert.equal(read.status, 200);
      assert.deepEqual(read.data.errors, []);
      assert.deepEqual(read.data.events.map(item => [item.eventId, item.managed, item.managedProfileId,
        item.managedUid, item.baselineEtag]).sort(), [
        ["a", true, first.profileId, first.uid, '"v1"'],
        ["b", true, second.profileId, second.uid, '"v1"'],
      ]);
      const denied = await adopt(client, first, "b");
      assert.equal(denied.ok, false, "the original identity must retain its original event association");
      assert.match(denied.message, /linked to another Google event/);
    }
  });

  test("a two-item adoption keeps the committed first item without approving the failed second item", async t => {
    const h = await setup(t); let repair;
    h.onEventGet(async id => {
      if (id === "b" && !repair) repair = await h.blockPersistence();
    });
    let result;
    try { result = await h.current.adopt([task("a"), task("b")]); }
    finally { if (repair) await repair(); h.onEventGet(null); }
    assert.ok(repair, "the second item reached its real provider check after the first persisted");
    assert.deepEqual(result.results.map(item => item.ok), [true, false]);
    assert.equal(result.partial, true);
    const live = await h.current.read(), restarted = await (await h.restarted()).read();
    const expected = { a: { managed: true, baselineEtag: '"v1"' }, b: { managed: false, baselineEtag: null } };
    assert.deepEqual({ live, restarted }, { live: expected, restarted: expected });
  });

  test("late adoption cannot replace the same task's mapping committed while its provider check was pending", async t => {
    const h = await setup(t); let release, reached;
    const waiting = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    h.onEventGet(async id => { if (id === "a") { reached(); await gate; } });
    const late = h.current.adopt([task("a", { uid: "shared-uid" })]);
    await waiting;
    try { assert.equal((await h.current.adopt([task("b", { uid: "shared-uid" })])).results[0].ok, true); }
    finally { release(); h.onEventGet(null); }
    const denied = (await late).results[0];
    assert.equal(denied.ok, false);
    assert.match(denied.message, /linked to another Google event/);
    const live = await h.current.read(), restarted = await (await h.restarted()).read();
    assert.deepEqual(live, { a: { managed: false, baselineEtag: null }, b: { managed: true, baselineEtag: '"v1"' } });
    assert.deepEqual(restarted, live);
  });

  test("late adoption cannot take an event that another task claimed during its provider check", async t => {
    const h = await setup(t); let release, reached, held = false;
    const waiting = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    h.onEventGet(async id => { if (id === "a" && !held) { held = true; reached(); await gate; } });
    const late = h.current.adopt([task("a")]);
    await waiting;
    try { assert.equal((await h.current.adopt([task("a", { uid: "other-uid" })])).results[0].ok, true); }
    finally { release(); h.onEventGet(null); }
    const denied = (await late).results[0];
    assert.equal(denied.ok, false);
    assert.match(denied.message, /linked to another task/);
    for (const client of [h.current, await h.restarted()]) {
      const current = (await client.request(readRange)).data.events.find(item => item.eventId === "a");
      assert.equal(current.managed, true);
      assert.equal(current.managedUid, "other-uid");
    }
  });
});

describe("shared refresh and colliding identities across restarts", () => {
  const origin = "http://localhost:3000", calendarId = "mine";
  const first = { profileId: "a:b", uid: "c", eventId: "a" };
  const second = { profileId: "a", uid: "b:c", eventId: "b" };
  const readRoute = "events?from=2026-10-19&to=2026-10-19&timeZone=America%2FLos_Angeles";
  const receiptKey = identity => JSON.stringify([identity.profileId, identity.uid, calendarId]);
  const providerEvent = id => ({
    id, etag: `"seed-${id}"`, summary: `Synthetic ${id}`, status: "confirmed", organizer: { self: true },
    start: { dateTime: "2026-10-19T11:00:00-07:00", timeZone: "America/Los_Angeles" },
    end: { dateTime: "2026-10-19T12:00:00-07:00", timeZone: "America/Los_Angeles" },
  });
  const task = (identity, changes = {}) => ({
    id: `synthetic-${identity.eventId}`, uid: identity.uid, title: `Synthetic ${identity.eventId}`,
    date: "2026-10-19", start: 660, duration: 60, timeZone: "America/Los_Angeles", type: "task",
    calendarLink: { source: "google", managed: true, calendarId, eventId: identity.eventId, etag: `"seed-${identity.eventId}"` },
    ...changes,
  });
  const payload = (identity, value = task(identity)) => ({ mode: "personal", profileId: identity.profileId, calendarId, tasks: [value] });
  function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  }

  // Every provider response, credential and encrypted record is synthetic. The
  // filesystem faults use the production atomic rename in an isolated directory.
  async function setup(t, { failRefreshSave = false, holdRead = false }) {
    const dataDir = await mkdtemp(join(tmpdir(), "synthetic-composed-calendar-"));
    const destination = join(dataDir, "connection.enc"), fault = gcalPersistenceFault(dataDir, "before-fault.enc");
    const key = randomBytes(32), refreshEntered = gate(), refreshRelease = gate(), readEntered = gate(), readRelease = gate();
    const events = new Map(["a", "b"].map(id => [id, providerEvent(id)]));
    const refreshes = [], primingRefreshes = [], calendarAccess = [], writes = [];
    const firstKey = receiptKey(first);
    let primeSession = true, rotation = 0, version = 0, beforeEventGet;
    let expectedAccess = "SYNTHETIC-OLD-ACCESS", expectedRefresh = "SYNTHETIC-OLD-REFRESH";
    async function save(snapshot) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
      await writeFile(destination, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
    }
    async function saved() {
      const bytes = await readFile(fault.durablePath);
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    }
    t.after(async () => {
      refreshRelease.release(); readRelease.release();
      await fault.repair();
      await rm(dataDir, { recursive: true, force: true });
    });
    await writeFile(join(dataDir, "key"), key, { mode: 0o600 });
    await save({ accessToken: expectedAccess, refreshToken: expectedRefresh, expiresAt: 0,
      mappings: { [firstKey]: { profileId: first.profileId, uid: first.uid, calendarId,
        eventId: first.eventId, source: "google", imported: true, managed: true, etag: '"seed-a"' } } });
    const config = { origin, dataDir,
      env: { GOOGLE_CLIENT_ID: "SYNTHETIC-CLIENT", GOOGLE_CLIENT_SECRET: "SYNTHETIC-SECRET", CALENDAR_WRITES_ENABLED: "true" },
      fetchImpl: async (input, options = {}) => {
        const url = new URL(input), method = options.method || "GET";
        if (url.origin === "https://oauth2.googleapis.com") {
          assert.equal(options.body.get("grant_type"), "refresh_token");
          const refresh = options.body.get("refresh_token");
          // Obtain the public session/CSRF response without refreshing the seed.
          // The measured concurrent wave starts after this controlled failure.
          if (primeSession) {
            primeSession = false; primingRefreshes.push(refresh);
            throw new Error("Synthetic session priming failure");
          }
          refreshes.push(refresh);
          assert.equal(refresh, expectedRefresh, "a rotated refresh token must never be spent twice");
          refreshEntered.release();
          await refreshRelease.promise;
          expectedAccess = `SYNTHETIC-ROTATED-ACCESS-${++rotation}`;
          expectedRefresh = `SYNTHETIC-ROTATED-REFRESH-${rotation}`;
          if (failRefreshSave) { failRefreshSave = false; await fault.block(); }
          return Response.json({ access_token: expectedAccess, refresh_token: expectedRefresh, expires_in: 3600 });
        }
        assert.equal(url.origin, "https://www.googleapis.com");
        calendarAccess.push({ method, path: url.pathname, authorization: options.headers.Authorization });
        assert.equal(options.headers.Authorization, `Bearer ${expectedAccess}`);
        const durable = await saved();
        assert.equal(durable.accessToken, expectedAccess, "Calendar requests must wait for durable refreshed credentials");
        assert.equal(durable.refreshToken, expectedRefresh);
        if (url.pathname.endsWith("/calendarList"))
          return Response.json({ items: [{ id: calendarId, summary: "Synthetic", accessRole: "owner", timeZone: "America/Los_Angeles" }] });
        const parts = url.pathname.split("/").map(decodeURIComponent), eventIndex = parts.indexOf("events"), id = parts[eventIndex + 1];
        assert.ok(eventIndex > 0);
        if (method === "GET" && !id) {
          if (holdRead) { readEntered.release(); await readRelease.promise; }
          return Response.json({ items: [...events.values()], timeZone: "America/Los_Angeles" });
        }
        if (method === "GET") {
          if (beforeEventGet) await beforeEventGet(id);
          return events.has(id) ? Response.json(events.get(id)) : Response.json({}, { status: 404 });
        }
        assert.ok(method === "PUT" || method === "POST");
        const value = JSON.parse(options.body), eventId = id || value.id;
        if (method === "PUT") assert.equal(options.headers["If-Match"], events.get(eventId).etag);
        const result = { ...value, id: eventId, etag: `"written-${++version}"`, status: "confirmed", organizer: { self: true } };
        events.set(eventId, result); writes.push({ method, eventId });
        return Response.json(result);
      },
    };
    const client = () => gcalDirectClient(createCalendarService(config), origin);
    const current = client();
    assert.equal((await current.request("status")).data.state, "network");
    assert.deepEqual(primingRefreshes, ["SYNTHETIC-OLD-REFRESH"]);
    return { current, client, saved, firstKey, events, refreshes, calendarAccess, writes,
      refreshEntered, refreshRelease, readEntered, readRelease, blockPersistence: () => fault.block(), repair: () => fault.repair(),
      onEventGet(callback) { beforeEventGet = callback; },
      async expireSavedAccess() { const snapshot = await saved(); snapshot.expiresAt = 0; await save(snapshot); } };
  }

  async function read(client) {
    const result = await client.request(readRoute);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.errors, []);
    return Object.fromEntries(result.data.events.map(event => [event.eventId, event]));
  }
  function assertOwner(event, identity, baseline) {
    assert.equal(event.managed, true);
    assert.equal(event.managedProfileId, identity.profileId);
    assert.equal(event.managedUid, identity.uid);
    assert.equal(event.baselineEtag, baseline);
  }
  async function preview(client, identity, value, action) {
    const result = await client.request("preview", payload(identity, value));
    assert.equal(result.status, 200);
    assert.equal(result.data.canExecute, true);
    assert.equal(result.data.items[0].action, action);
    return result.data.planId;
  }
  async function execute(client, identity, value, action) {
    const planId = await preview(client, identity, value, action);
    const result = await client.request("execute", { planId });
    assert.equal(result.status, 200);
    assert.equal(result.data.results[0].ok, true);
    assert.equal(result.data.results[0].action, action);
    assert.equal(result.data.results[0].calendarLink.eventId, identity.eventId);
    return result.data.results[0].calendarLink;
  }
  async function assertReceipts(h, identities) {
    const saved = await h.saved();
    assert.deepEqual(Object.keys(saved.mappings).sort(), identities.map(identity => identity === first ? h.firstKey : receiptKey(identity)).sort());
    for (const identity of identities) {
      const mapping = saved.mappings[identity === first ? h.firstKey : receiptKey(identity)];
      assert.equal(mapping.eventId, identity.eventId);
      assert.equal(mapping.profileId, identity.profileId);
      assert.equal(mapping.uid, identity.uid);
      assert.equal(mapping.pendingWrite, undefined);
    }
  }

  test(`one shared token refresh, an overlapping adoption and colliding receipts all survive execution and restart`, { timeout: 10000 }, async t => {
    const h = await setup(t, { holdRead: true });
    const reading = h.current.request(readRoute);
    await h.refreshEntered.promise;
    const calendars = h.current.request("calendars");
    const adopting = h.current.request("adopt", payload(second));
    try {
      await setImmediate();
      assert.deepEqual(h.refreshes, ["SYNTHETIC-OLD-REFRESH"]);
      assert.equal(h.calendarAccess.length, 0);
    } finally { h.refreshRelease.release(); }
    await h.readEntered.promise;
    try {
      const adopted = await adopting;
      assert.equal(adopted.status, 200);
      assert.equal(adopted.data.results[0].ok, true);
      await assertReceipts(h, [first, second]);
    } finally { h.readRelease.release(); }
    const [readResult, calendarResult] = await Promise.all([reading, calendars]);
    assert.equal(readResult.status, 200); assert.deepEqual(readResult.data.errors, []);
    assert.equal(calendarResult.status, 200);
    const overlapping = Object.fromEntries(readResult.data.events.map(event => [event.eventId, event]));
    assertOwner(overlapping.a, first, '"seed-a"');
    assertOwner(overlapping.b, second, '"seed-b"');
    assert.equal(h.refreshes.length, 1);
    const movedFirst = task(first, { start: 720 }), movedSecond = task(second, { start: 780 });
    const firstLink = await execute(h.current, first, movedFirst, "update");
    const secondLink = await execute(h.current, second, movedSecond, "update");
    assert.deepEqual(h.writes, [{ method: "PUT", eventId: "a" }, { method: "PUT", eventId: "b" }]);
    await assertReceipts(h, [first, second]);
    assertOwner((await read(h.current)).a, first, firstLink.etag);
    assertOwner((await read(h.current)).b, second, secondLink.etag);
    await h.expireSavedAccess();
    const restarted = h.client();
    assert.equal((await restarted.request("status")).data.state, "connected");
    assert.deepEqual(h.refreshes, ["SYNTHETIC-OLD-REFRESH", "SYNTHETIC-ROTATED-REFRESH-1"]);
    const afterRestart = await read(restarted);
    assertOwner(afterRestart.a, first, firstLink.etag);
    assertOwner(afterRestart.b, second, secondLink.etag);
    await execute(restarted, first, { ...movedFirst, calendarLink: firstLink }, "skip");
    await execute(restarted, second, { ...movedSecond, calendarLink: secondLink }, "skip");
    assert.equal(h.writes.length, 2);
    await assertReceipts(h, [first, second]);
  });

  test(`after failed saves, retries keep colliding identities separate and leave no ghost receipts`, { timeout: 10000 }, async t => {
    const h = await setup(t, { failRefreshSave: true });
    const calendars = h.current.request("calendars");
    await h.refreshEntered.promise;
    const reading = h.current.request(readRoute), adopting = h.current.request("adopt", payload(second));
    try {
      await setImmediate();
      assert.equal(h.refreshes.length, 1);
      assert.equal(h.calendarAccess.length, 0);
    } finally { h.refreshRelease.release(); }
    assert.deepEqual((await Promise.all([calendars, reading, adopting])).map(result => result.status), [400, 400, 400]);
    const failedStatus = await h.current.request("status");
    assert.equal(failedStatus.data.state, "storage_error");
    assert.equal(failedStatus.data.storageRetryable, true);
    assert.equal(h.calendarAccess.length, 0);
    await assertReceipts(h, [first]);
    await h.repair();
    assert.equal((await h.current.request("calendars")).status, 200);
    assert.deepEqual(h.refreshes, ["SYNTHETIC-OLD-REFRESH"]);
    assert.equal((await h.saved()).refreshToken, "SYNTHETIC-ROTATED-REFRESH-1");
    h.onEventGet(async id => { if (id === second.eventId) { h.onEventGet(null); await h.blockPersistence(); } });
    const failedAdoption = await h.current.request("adopt", payload(second));
    assert.equal(failedAdoption.status, 200);
    assert.equal(failedAdoption.data.results[0].ok, false);
    await h.repair();
    assert.equal((await read(h.current)).b.managed, false);
    const restartedBeforeSave = h.client();
    assert.equal((await restartedBeforeSave.request("status")).data.state, "connected");
    assert.equal((await read(restartedBeforeSave)).b.managed, false);
    const unlinked = task(second, { calendarLink: undefined });
    const createPlan = await preview(h.current, second, unlinked, "create");
    await h.blockPersistence();
    const failedIntent = await h.current.request("execute", { planId: createPlan });
    assert.equal(failedIntent.status, 200);
    assert.equal(failedIntent.data.results[0].ok, false);
    assert.deepEqual(h.writes, []);
    assert.equal(h.events.has(managedEventId(second.profileId, second.uid)), false);
    await h.repair();
    const firstLink = await execute(h.current, first, task(first, { start: 720 }), "update");
    await assertReceipts(h, [first]);
    assert.equal((await read(h.current)).b.managed, false, "an unrelated successful save must not resurrect failed consent or write intent");
    const restarted = h.client();
    assert.equal((await restarted.request("status")).data.state, "connected");
    const afterSave = await read(restarted);
    assertOwner(afterSave.a, first, firstLink.etag);
    assert.equal(afterSave.b.managed, false);
    const retry = await restarted.request("adopt", payload(second));
    assert.equal(retry.status, 200); assert.equal(retry.data.results[0].ok, true);
    const secondLink = await execute(restarted, second, task(second, { start: 780 }), "update");
    await assertReceipts(h, [first, second]);
    const finalClient = h.client();
    assert.equal((await finalClient.request("status")).data.state, "connected");
    const finalRead = await read(finalClient);
    assertOwner(finalRead.a, first, firstLink.etag);
    assertOwner(finalRead.b, second, secondLink.etag);
    assert.deepEqual(h.writes, [{ method: "PUT", eventId: "a" }, { method: "PUT", eventId: "b" }]);
    assert.deepEqual(h.refreshes, ["SYNTHETIC-OLD-REFRESH"]);
  });
});
