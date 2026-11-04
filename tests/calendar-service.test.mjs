import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCalendarService, managedEventId, calendarInstant } from "../calendar-service.mjs";
import { gcalHttpClient } from "./helpers.mjs";

// All Google responses below are simulated. No Google account is contacted.
// Options: writes toggles CALENDAR_WRITES_ENABLED; fail(url, options) makes a provider call return 503;
// tokenResponse / providerResponse override the token endpoint and the provider; delay holds a call.
async function setup(t, { writes = true, configured = true, fail = () => false, expires = 3600, tokenFailure = false,
  tokenResponse = null, providerResponse = null, delay = async () => {} } = {}) {
  const calls = [], events = new Map(), dataDir = await mkdtemp(join(tmpdir(), "shunri-calendar-test-"));
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url: String(url), method, body: options.body, headers: options.headers });
    if (String(url).includes("/token")) {
      if (tokenResponse) return tokenResponse(options.body);
      return tokenFailure && options.body.get("grant_type") === "refresh_token"
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : Response.json({ access_token: "SIMULATED-ACCESS-TOKEN", refresh_token: "SIMULATED-REFRESH-TOKEN", expires_in: expires });
    }
    await delay(url, options);
    if (fail(url, options)) return Response.json({ error: "SIMULATED FAILURE" }, { status: 503 });
    const customResponse = await providerResponse?.(url, options);
    if (customResponse) return customResponse;
    if (String(url).includes("/calendarList"))
      return Response.json({ items: [
        { id: "owned@example.test", summary: "Simulated calendar", accessRole: "owner" },
        { id: "other", summary: "Cannot modify", accessRole: "reader" },
      ] });
    const parts = new URL(url).pathname.split("/"), eventId = parts.at(-1) === "events" ? null : parts.at(-1);
    if (method === "GET")
      return events.has(eventId) ? Response.json(events.get(eventId)) : Response.json({}, { status: 404 });
    const event = JSON.parse(options.body);
    if (method === "POST") {
      if (events.has(event.id)) return Response.json({}, { status: 409 });
      events.set(event.id, { ...event, etag: '"v1"' });
      return Response.json(events.get(event.id));
    }
    if (method === "PUT") {
      if (options.headers["If-Match"] !== events.get(eventId)?.etag) return Response.json({}, { status: 412 });
      events.set(eventId, { ...event, etag: '"v2"' });
      return Response.json(events.get(eventId));
    }
    throw new Error(`Unexpected mocked method ${method}`);
  };
  let service;
  const { origin, request } = await gcalHttpClient(t, () => service);
  const env = configured
    ? { GOOGLE_CLIENT_ID: "SIMULATED-CLIENT", GOOGLE_CLIENT_SECRET: "SIMULATED-SECRET", CALENDAR_WRITES_ENABLED: String(writes) }
    : {};
  const restart = () => { service = createCalendarService({ origin, fetchImpl, env, dataDir }); };
  restart();
  await request("status");
  async function connect(code = "SIMULATED-CODE") {
    const result = await request("connect"), auth = new URL(result.location);
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.equal(auth.searchParams.get("scope").includes("gmail"), false);
    assert.equal(auth.searchParams.get("scope").includes("profile"), false);
    const callback = await request(
      `callback?state=${encodeURIComponent(auth.searchParams.get("state"))}&code=${encodeURIComponent(code)}`);
    assert.equal(callback.location, "/?calendar=connected");
  }
  return { request, connect, calls, events, dataDir, origin, restart };
}
const task = (changes = {}) => ({
  id: "a",
  uid: "stable-a",
  title: "Simulated task",
  date: "2026-10-10",
  start: 660,
  duration: 45,
  timeZone: "America/Los_Angeles",
  ...changes,
});
const payload = (tasks = [task()]) => ({
  mode: "personal",
  profileId: "profile-a",
  calendarId: "owned@example.test",
  tasks,
});

// ---- Connection, write gate and request checks ----
test("an unconfigured service reports the missing settings, exposes no secret and makes no provider call", async (t) => {
  const h = await setup(t, { configured: false });
  const result = await h.request("status");
  assert.equal(result.data.state, "unconfigured");
  assert.deepEqual(result.data.missing, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  assert.equal((await h.request("preview", payload())).status, 503);
  assert.equal(h.calls.length, 0);
});
test("the OAuth callback is bound to the session and state, and the connection is stored encrypted with private permissions", async (t) => {
  const h = await setup(t);
  assert.equal((await h.request("callback?state=wrong&code=x")).location, "/?calendar=error");
  await h.connect();
  assert.equal((await h.request("status")).data.state, "connected");
  const bytes = await readFile(join(h.dataDir, "connection.enc"));
  assert.equal(bytes.includes(Buffer.from("SIMULATED-ACCESS-TOKEN")), false);
  assert.equal((await stat(join(h.dataDir, "key"))).mode & 0o777, 0o600);
  assert.equal((await stat(h.dataDir)).mode & 0o777, 0o700);
  assert.equal((await h.request("callback?state=wrong&code=x")).location, "/?calendar=error");
});
test("with writes disabled, preview works but every event write is refused", async (t) => {
  const h = await setup(t, { writes: false });
  await h.connect();
  const preview = (await h.request("preview", payload())).data;
  assert.equal(preview.items[0].action, "create");
  assert.equal(preview.canExecute, false);
  assert.equal((await h.request("execute", { planId: preview.planId })).status, 403);
  assert.equal(h.calls.some((x) => x.url.includes("/events") && x.method !== "GET"), false);
});
test("demo mode, a wrong CSRF token or origin, a calendar that is not owned and duplicate task UIDs are all refused", async (t) => {
  const h = await setup(t);
  await h.connect();
  assert.equal((await h.request("preview", { ...payload(), mode: "demo" })).status, 400);
  assert.equal((await h.request("preview", payload(), { "X-Shunri-CSRF": "wrong" })) .status, 403);
  assert.equal((await h.request("preview", payload(), { Origin: "http://evil.test" })) .status, 403);
  assert.equal((await h.request("preview", { ...payload(), calendarId: "other" })).status, 400);
  assert.equal((await h.request("preview", payload([task(), task()]))).status, 400);
  assert.equal(h.events.size, 0);
});
// ---- Creating, updating and retrying events ----
test("create is idempotent, a repeat is skipped, and a move to another day updates the same event", async (t) => {
  const h = await setup(t);
  await h.connect();
  let p = (await h.request("preview", payload())).data;
  const result = (await h.request("execute", { planId: p.planId })).data;
  assert.equal(result.results[0].ok, true);
  const id = result.results[0].calendarLink.eventId;
  assert.match(id, /^[a-v0-9]{5,1024}$/);
  assert.equal(h.events.size, 1);
  assert.equal((await h.request("execute", { planId: p.planId })).status, 400);
  p = (await h.request("preview", payload())).data;
  assert.equal(p.items[0].action, "skip");
  await h.request("execute", { planId: p.planId });
  assert.equal(h.events.size, 1);
  p = (await h.request("preview", payload([task({ date: "2026-10-11", start: 800 })]))).data;
  assert.equal(p.items[0].action, "update");
  const updated = (await h.request("execute", { planId: p.planId })).data;
  assert.equal(updated.results[0].calendarLink.eventId, id);
  assert.equal(h.events.size, 1);
  assert.equal(h.calls.some((x) => x.method === "DELETE"), false);
});

test("an event Shunri does not own and an event changed in Google since the preview are never updated", async (t) => {
  const h = await setup(t);
  await h.connect();
  const id = managedEventId("profile-a", "stable-a");
  h.events.set(id, { id, summary: "Non-Shunri activity", etag: '"foreign"' });
  const foreign = (await h.request("preview", payload())).data;
  assert.equal(foreign.items[0].action, "error");
  assert.equal((await h.request("execute", { planId: foreign.planId })).status, 400);
  h.events.delete(id);
  let p = (await h.request("preview", payload())).data;
  await h.request("execute", { planId: p.planId });
  p = (await h.request("preview", payload([task({ start: 900 })]))).data;
  h.events.get(id).etag = '"external"';
  const result = (await h.request("execute", { planId: p.planId })).data;
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].message, /changed/);
  assert.equal(h.events.get(id).start.dateTime, "2026-10-10T18:00:00.000Z");
});
test("after a partial failure the successes persist and a retry creates no duplicates", async (t) => {
  let broken = true;
  const h = await setup(t, {
    fail: (url, options) =>
      broken &&
      options.method === "POST" &&
      JSON.parse(options.body).extendedProperties.private.shunriTask ===
        "stable-b",
  });
  await h.connect();
  const tasks = [task(), task({ id: "b", uid: "stable-b", title: "Simulated failing task" })];
  let p = (await h.request("preview", payload(tasks))).data;
  let result = (await h.request("execute", { planId: p.planId })).data;
  assert.equal(result.partial, true);
  assert.deepEqual(result.results.map((x) => x.ok), [true, false]);
  assert.equal(h.events.size, 1);
  broken = false;
  p = (await h.request("preview", payload(tasks))).data;
  assert.deepEqual(p.items.map((x) => x.action), ["skip", "create"]);
  result = (await h.request("execute", { planId: p.planId })).data;
  assert.equal(result.results.every((x) => x.ok), true);
  assert.equal(h.events.size, 2);
});

// ---- Time zones ----
test("wall times in a spring-forward gap or a fall-back repeat are rejected, and the offset follows the season", () => {
  assert.throws(
    () => calendarInstant("2026-03-08", 150, "America/Los_Angeles"),
    /skipped at the start of daylight saving/,
  );
  assert.throws(
    () => calendarInstant("2026-11-01", 90, "America/Los_Angeles"),
    /repeats at the end of daylight saving/,
  );
  assert.equal(
    new Date(calendarInstant("2026-01-10", 660, "America/Los_Angeles")).toISOString(),
    "2026-01-10T19:00:00.000Z",
  );
  assert.equal(
    new Date(calendarInstant("2026-07-10", 660, "America/Los_Angeles")).toISOString(),
    "2026-07-10T18:00:00.000Z",
  );
  assert.throws(() => calendarInstant("2026-02-30", 660, "America/Los_Angeles"), /The date is invalid/);
});
// ---- Connection state and concurrency ----
test("expired authorization and a network failure are reported as distinct states", async (t) => {
  const expired = await setup(t, { expires: -1, tokenFailure: true });
  await expired.connect();
  assert.equal((await expired.request("status")).data.state, "expired");
  assert.equal((await expired.request("calendars")).status, 400);
  const network = await setup(t, { fail: (url) => String(url).includes("/calendarList") });
  await network.connect();
  assert.equal((await network.request("calendars")).status, 400);
  assert.equal((await network.request("status")).data.state, "network");
});
test("the encrypted connection survives a service restart without reauthorization", async (t) => {
  const h = await setup(t);
  await h.connect();
  let p = (await h.request("preview", payload())).data;
  await h.request("execute", { planId: p.planId });
  h.restart();
  assert.equal((await h.request("status")).data.state, "connected");
  p = (await h.request("preview", payload())).data;
  assert.equal(p.items[0].action, "skip");
  assert.equal(h.events.size, 1);
});
test("a second execute is rejected with 409 while a sync is still running", async (t) => {
  let release, started;
  const gate = new Promise((r) => {
      release = r;
    }),
    began = new Promise((r) => {
      started = r;
    });
  const h = await setup(t, {
    delay: async (url, options) => {
      if (String(url).includes("/events") && options.method === "POST") {
        started();
        await gate;
      }
    },
  });
  await h.connect();
  const p = (await h.request("preview", payload())).data;
  const running = h.request("execute", { planId: p.planId });
  await began;
  const duplicate = await h.request("execute", { planId: p.planId });
  assert.equal(duplicate.status, 409);
  release();
  assert.equal((await running).data.results[0].ok, true);
  assert.equal(h.events.size, 1);
});
test("a create answered with 409 is checked for ownership and keeps one stable event", async (t) => {
  let h,
    raced = false;
  h = await setup(t, {
    fail: (url, options) => {
      if (
        !raced &&
        String(url).includes("/events") &&
        options.method === "POST"
      ) {
        const event = JSON.parse(options.body);
        h.events.set(event.id, { ...event, etag: '"race"' });
        raced = true;
      }
      return false;
    },
  });
  await h.connect();
  const p = (await h.request("preview", payload())).data;
  const result = (await h.request("execute", { planId: p.planId })).data;
  assert.equal(result.results[0].ok, true);
  assert.equal(h.events.size, 1);
  assert.equal(result.results[0].action, "skip");
  assert.equal(h.calls.some((call) => call.method === "PUT"), false);
});

for (const race of [false, true]) {
  for (const changedField of ["title", "time"]) {
    test(`${race ? "a create answered with 409" : "an older create preview"} preserves an external ${changedField} edit instead of overwriting it`, async (t) => {
      const changeRemote = (event) => ({
        ...event,
        ...(changedField === "title"
          ? { summary: "Title edited by the user in Google" }
          : {
              start: { ...event.start, dateTime: "2026-10-10T19:00:00.000Z" },
              end: { ...event.end, dateTime: "2026-10-10T19:45:00.000Z" },
            }),
        etag: '"external-change"',
      });
      let h, expected;
      h = await setup(t, {
        fail: (url, options) => {
          if (race && String(url).includes("/events") && options.method === "POST") {
            expected = changeRemote(JSON.parse(options.body));
            h.events.set(expected.id, expected);
          }
          return false;
        },
      });
      await h.connect();
      const first = (await h.request("preview", payload())).data;
      let stale = first;
      if (!race) {
        stale = (await h.request("preview", payload())).data;
        assert.equal((await h.request("execute", { planId: first.planId })).data.results[0].ok, true);
        const event = [...h.events.values()][0];
        expected = changeRemote(event);
        h.events.set(event.id, expected);
      }
      const result = (await h.request("execute", { planId: stale.planId })).data.results[0];
      assert.equal(result.ok, false);
      assert.match(result.message, /Preview again/);
      assert.equal(h.calls.some((call) => call.method === "PUT"), false);
      assert.equal(h.events.size, 1);
      assert.deepEqual([...h.events.values()][0], expected);
    });
  }
}

test("re-running an older create preview that still matches is a no-write skip and keeps notes added in Google", async (t) => {
  const h = await setup(t);
  await h.connect();
  const first = (await h.request("preview", payload())).data;
  const stale = (await h.request("preview", payload())).data;
  await h.request("execute", { planId: first.planId });
  const remote = [...h.events.values()][0];
  remote.description = "Note added by the user only in Google";
  remote.etag = '"notes-added"';
  const expected = structuredClone(remote);
  const writesBefore = h.calls.filter((call) => ["POST", "PUT"].includes(call.method)).length;
  const result = (await h.request("execute", { planId: stale.planId })).data.results[0];
  assert.equal(result.ok, true);
  assert.equal(result.action, "skip");
  assert.equal(result.calendarLink.etag, expected.etag);
  assert.equal(h.events.size, 1);
  assert.deepEqual([...h.events.values()][0], expected);
  assert.equal(h.calls.filter((call) => ["POST", "PUT"].includes(call.method)).length, writesBefore);
});

// ---- Switching accounts: nothing from the previous authorization may leak into the new one ----
test("reconnecting without a refresh token never refreshes the previous account, even after a restart", async (t) => {
  const h = await setup(t, {
    tokenResponse: (body) => Response.json(
      body.get("grant_type") === "refresh_token"
        ? { access_token: "SIMULATED-A-REFRESHED", expires_in: 3600 }
        : body.get("code") === "A"
          ? { access_token: "SIMULATED-A", refresh_token: "SIMULATED-REFRESH-A", expires_in: 3600 }
          : { access_token: "SIMULATED-B", expires_in: 1 },
    ),
  });
  await h.connect("A");
  await h.connect("B");
  for (const restart of [false, true]) {
    if (restart) h.restart();
    assert.equal((await h.request("status")).data.state, "expired");
    assert.match((await h.request("calendars")).data.error, /Reconnect/);
  }
  assert.equal(h.calls.some((call) => call.body instanceof URLSearchParams && call.body.get("grant_type") === "refresh_token"), false);
  assert.equal(h.calls.some((call) => call.url.includes("/calendarList")), false);
});

test("after reconnecting, imported events must be adopted again before they can be written", async (t) => {
  const h = await setup(t);
  await h.connect("A");
  const eventId = "synthetic-imported-event";
  h.events.set(eventId, {
    id: eventId, summary: task().title, etag: '"import-v1"', organizer: { self: true },
    start: { dateTime: "2026-10-10T18:00:00.000Z", timeZone: "America/Los_Angeles" },
    end: { dateTime: "2026-10-10T18:45:00.000Z", timeZone: "America/Los_Angeles" },
  });
  const imported = task({ calendarLink: { source: "google", managed: true, calendarId: "owned@example.test", eventId, etag: '"import-v1"' } });
  const adopted = (await h.request("adopt", payload([imported]))).data;
  assert.equal(adopted.results[0].ok, true);
  assert.equal((await h.request("preview", payload([imported]))).data.items[0].action, "skip");
  await h.connect("B");
  const preview = (await h.request("preview", payload([imported]))).data;
  assert.equal(preview.items[0].action, "error");
  assert.match(preview.items[0].reason, /has not been entrusted to Shunri/);
  assert.equal(h.calls.some((call) => call.method === "PUT"), false);
});

for (const outcome of ["success", "network failure"]) {
  test(`a late refresh of the previous account (${outcome}) cannot change the new connection`, async (t) => {
    let release, started;
    const gate = new Promise((resolve) => { release = resolve; });
    const began = new Promise((resolve) => { started = resolve; });
    t.after(() => release());
    const h = await setup(t, {
      tokenResponse: async (body) => {
        if (body.get("grant_type") === "refresh_token") {
          started();
          await gate;
          if (outcome === "network failure") throw new Error("SIMULATED NETWORK FAILURE");
          return Response.json({ access_token: "SIMULATED-A-LATE", expires_in: 3600 });
        }
        return Response.json(body.get("code") === "A"
          ? { access_token: "SIMULATED-A", refresh_token: "SIMULATED-REFRESH-A", expires_in: 1 }
          : { access_token: "SIMULATED-B", refresh_token: "SIMULATED-REFRESH-B", expires_in: 3600 });
      },
    });
    await h.connect("A");
    const pending = h.request("calendars");
    await began;
    await h.connect("B");
    release();
    assert.match((await pending).data.error, /Authorization changed/);
    assert.equal((await h.request("status")).data.state, "connected");
    assert.equal((await h.request("calendars")).status, 200);
    assert.deepEqual(h.calls.filter((call) => call.url.includes("/calendarList")).map((call) => call.headers.Authorization), ["Bearer SIMULATED-B"]);
    h.restart();
    assert.equal((await h.request("calendars")).status, 200);
    assert.equal(h.calls.at(-1).headers.Authorization, "Bearer SIMULATED-B");
  });
}

test("a refresh token rotated within the same authorization survives a restart", async (t) => {
  const refreshTokens = [];
  const h = await setup(t, {
    tokenResponse: (body) => {
      if (body.get("grant_type") !== "refresh_token")
        return Response.json({ access_token: "SIMULATED-A", refresh_token: "SIMULATED-REFRESH-A", expires_in: 1 });
      refreshTokens.push(body.get("refresh_token"));
      return Response.json(refreshTokens.length === 1
        ? { access_token: "SIMULATED-A-REFRESHED", refresh_token: "SIMULATED-ROTATED-A", expires_in: 1 }
        : { access_token: "SIMULATED-A-REFRESHED-AGAIN", expires_in: 3600 });
    },
  });
  await h.connect();
  assert.equal((await h.request("calendars")).status, 200);
  h.restart();
  assert.equal((await h.request("calendars")).status, 200);
  assert.deepEqual(refreshTokens, ["SIMULATED-REFRESH-A", "SIMULATED-ROTATED-A"]);
  assert.equal(h.calls.at(-1).headers.Authorization, "Bearer SIMULATED-A-REFRESHED-AGAIN");
});

test("a preview still running for the previous account cannot produce a plan after reconnecting", async (t) => {
  let release, started, hold = true;
  const gate = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  t.after(() => release());
  const h = await setup(t, {
    delay: async (url) => {
      if (hold && String(url).includes("/events/")) {
        hold = false;
        started();
        await gate;
      }
    },
  });
  await h.connect("A");
  const pending = h.request("preview", payload());
  await began;
  await h.connect("B");
  release();
  const stale = await pending;
  assert.equal(stale.status, 400);
  assert.match(stale.data.error, /Authorization changed/);
  assert.equal(stale.data.planId, undefined);
  assert.equal((await h.request("preview", payload())).data.items[0].action, "create");
});

test("an OAuth exchange that finishes during a sync cannot replace the sync's authorization", async (t) => {
  let releaseExchange, exchangeStarted, releaseWrite, writeStarted;
  const exchangeGate = new Promise((resolve) => { releaseExchange = resolve; });
  const exchangeBegan = new Promise((resolve) => { exchangeStarted = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const writeBegan = new Promise((resolve) => { writeStarted = resolve; });
  t.after(() => { releaseExchange(); releaseWrite(); });
  const h = await setup(t, {
    tokenResponse: async (body) => {
      if (body.get("code") === "B") { exchangeStarted(); await exchangeGate; }
      return Response.json({ access_token: `SIMULATED-${body.get("code")}`, expires_in: 3600 });
    },
    delay: async (url, options) => {
      if (String(url).includes("/events") && options.method === "POST") {
        writeStarted();
        await writeGate;
      }
    },
  });
  await h.connect("A");
  const plan = (await h.request("preview", payload())).data;
  const auth = new URL((await h.request("connect")).location);
  const callback = h.request(`callback?state=${encodeURIComponent(auth.searchParams.get("state"))}&code=B`);
  await exchangeBegan;
  const execute = h.request("execute", { planId: plan.planId });
  await writeBegan;
  releaseExchange();
  assert.equal((await callback).location, "/?calendar=error");
  releaseWrite();
  assert.equal((await execute).data.results[0].ok, true);
  assert.equal((await h.request("calendars")).status, 200);
  assert.equal(h.calls.at(-1).headers.Authorization, "Bearer SIMULATED-A");
});

for (const route of ["calendars", "events"]) {
  test(`a delayed ${route} response cannot return the previous account's data after reconnecting`, async (t) => {
    let release, started, hold = true;
    const gate = new Promise((resolve) => { release = resolve; });
    const began = new Promise((resolve) => { started = resolve; });
    t.after(() => release());
    const h = await setup(t, {
      tokenResponse: (body) => Response.json({ access_token: `SIMULATED-${body.get("code")}`, expires_in: 3600 }),
      providerResponse: (url, options) => {
        const isList = String(url).includes("/calendarList");
        const isAccountA = options.headers.Authorization === "Bearer SIMULATED-A";
        if (route === "events" && !isList) {
          if (isAccountA && !new URL(url).searchParams.has("pageToken"))
            return Response.json({
              nextPageToken: "synthetic-page-2",
              items: [{ id: "account-a-only", summary: "ACCOUNT A PRIVATE FIXTURE", start: { dateTime: "2026-10-10T18:00:00.000Z" }, end: { dateTime: "2026-10-10T18:45:00.000Z" } }],
            });
          if (!isAccountA) return Response.json({ items: [] });
        }
        if (hold && isAccountA && ((route === "calendars" && isList) || (route === "events" && !isList))) {
          hold = false;
          return {
            ok: true, status: 200,
            json: async () => {
              started();
              await gate;
              return { items: route === "calendars" ? [{ id: "a@example.test", summary: "ACCOUNT A PRIVATE FIXTURE", accessRole: "owner" }] : [] };
            },
          };
        }
      },
    });
    const path = route === "calendars" ? route : "events?from=2026-10-10&to=2026-10-10&calendarId=owned%40example.test";
    await h.connect("A");
    const pending = h.request(path);
    await began;
    await h.connect("B");
    release();
    const stale = await pending;
    assert.equal(stale.status, 400);
    assert.match(stale.data.error, /Authorization changed/);
    assert.equal(JSON.stringify(stale.data).includes("ACCOUNT A PRIVATE FIXTURE"), false);
    assert.equal(stale.data.events, undefined);
    assert.equal(stale.data.calendars, undefined);
    assert.equal((await h.request(path)).status, 200);
  });
}
