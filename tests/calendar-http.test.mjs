import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { createCalendarService, calendarSignature } from "../calendar-service.mjs";
import { CONN_ORIGIN, connEnv, connProvider, connRequest, connTempDir } from "./helpers.mjs";

describe("sessions and preview plans", () => {
  const HOUR = 3600000, TTL = 24 * HOUR, CAPACITY = 256;
  const SESSION_UPDATED = "The operation session changed. Refresh the full page, preview again, and then confirm.";
  const INVALID_REQUEST = "The request origin or security check is invalid. Refresh the page.";
  const origin = CONN_ORIGIN;
  const payload = { mode: "personal", profileId: "synthetic-profile", calendarId: "owned@example.test",
    tasks: [{ id: "synthetic-task", uid: "synthetic-uid", title: "Synthetic task", date: "2026-10-12", start: 660, duration: 45, timeZone: "America/Los_Angeles" }] };
  const eventWrites = (h, predicate) => h.calls.filter(c => c.url.includes("/events") && predicate(c.method));

  // Exercises the production HTTP handler without a listening socket, real OAuth or global clock changes;
  // the service clock is injected through sessionNow.
  async function setup(t, { beforeProvider } = {}) {
    const dataDir = await connTempDir(t, "shunri-session-test-"), calls = [];
    let now = Date.now();
    const service = createCalendarService({ origin, dataDir, sessionNow: () => now, env: connEnv(true),
      fetchImpl: connProvider(calls, { beforeProvider }) });
    const request = (path, options) => connRequest(service, origin, path, options);
    async function client() { const value = {}; await request("status", { client: value }); return value; }
    async function connect(value) {
      const start = await request("connect", { client: value }), state = new URL(start.location).searchParams.get("state");
      const result = await request(`callback?state=${state}&code=SYNTHETIC-CODE`, { client: value });
      assert.equal(result.location, "/?calendar=connected");
    }
    return { request, client, connect, calls, advance(ms) { now += ms; } };
  }

  it("slow execute bodies cannot overlap, consume a rejected plan or release the owner's lock", async t => {
    const gate = () => { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; };
    const ownerEntered = gate(), ownerRelease = gate();
    let armed = false, held = false;
    const h = await setup(t, { beforeProvider: async (url, options) => {
      if (armed && !held && url.includes("/events/") && !options.method) {
        held = true; ownerEntered.release(); await ownerRelease.promise;
      }
    } });
    const client = await h.client(); await h.connect(client);
    const firstPlan = (await h.request("preview", { client, body: payload })).data.planId;
    const secondPayload = { ...payload, tasks: [{ ...payload.tasks[0], id: "second-task", uid: "second-uid", title: "Second task" }] };
    const secondPlan = (await h.request("preview", { client, body: secondPayload })).data.planId;
    function slowBody(planId) {
      const entered = gate(), release = gate();
      const stream = Readable.from((async function* () {
        entered.release(); await release.promise; yield JSON.stringify({ planId });
      })());
      return { entered: entered.promise, release: release.release, stream };
    }
    const firstBody = slowBody(firstPlan), secondBody = slowBody(secondPlan);
    const first = h.request("execute", { client, body: {}, bodyStream: firstBody.stream });
    const second = h.request("execute", { client, body: {}, bodyStream: secondBody.stream });
    await Promise.all([firstBody.entered, secondBody.entered]);
    armed = true; firstBody.release(); await ownerEntered.promise;
    secondBody.release();
    try {
      const rejected = await second;
      assert.equal(rejected.status, 409);
      assert.equal(rejected.data.error, "Sync is in progress. Wait for it to finish.");
      assert.equal((await h.request("status", { client })).data.busy, true);
      assert.equal((await h.request("execute", { client, body: { planId: secondPlan } })).status, 409);
      assert.equal(eventWrites(h, m => m === "POST").length, 0);
    } finally { ownerRelease.release(); await first; }
    assert.equal((await first).data.results[0].ok, true);
    assert.equal((await h.request("status", { client })).data.busy, false);
    const retry = await h.request("execute", { client, body: { planId: secondPlan } });
    assert.equal(retry.status, 200); assert.equal(retry.data.results[0].ok, true);
    assert.equal(eventWrites(h, m => m === "POST").length, 2);
  });

  it("malformed execute JSON does not reserve the lock or consume a valid plan", async t => {
    const h = await setup(t), client = await h.client(); await h.connect(client);
    const planId = (await h.request("preview", { client, body: payload })).data.planId;
    const malformed = await h.request("execute", { client, body: {}, bodyStream: Readable.from(["{"]) });
    assert.equal(malformed.status, 400);
    assert.equal((await h.request("status", { client })).data.busy, false);
    assert.equal(eventWrites(h, m => m !== "GET").length, 0);
    const result = await h.request("execute", { client, body: { planId } });
    assert.equal(result.status, 200); assert.equal(result.data.results[0].ok, true);
  });

  it("the preview cache bounds a single session and rejects evicted plans without writes", async t => {
    const h = await setup(t), client = await h.client();
    await h.connect(client);
    const plans = [];
    for (let i = 0; i < 5; i++) {
      const preview = await h.request("preview", { client, body: payload });
      assert.equal(preview.status, 200); plans.push(preview.data.planId);
    }
    const evicted = await h.request("execute", { client, body: { planId: plans[0] } });
    assert.equal(evicted.status, 400); assert.equal(evicted.data.error, "The preview expired. Preview again.");
    assert.equal(eventWrites(h, m => m !== "GET").length, 0);
    const latest = await h.request("execute", { client, body: { planId: plans.at(-1) } });
    assert.equal(latest.status, 200); assert.equal(latest.data.results[0].ok, true);
    assert.equal((await h.request("execute", { client, body: { planId: plans.at(-1) } })).status, 400);
    assert.equal(eventWrites(h, m => m === "POST").length, 1);
  });

  it("the preview cache has a global bound even while all 65 sessions remain valid", async t => {
    const h = await setup(t), clients = [await h.client()], plans = [];
    await h.connect(clients[0]);
    for (let i = 1; i < 65; i++) clients.push(await h.client());
    for (const client of clients) {
      const preview = await h.request("preview", { client, body: payload });
      assert.equal(preview.status, 200); plans.push(preview.data.planId);
    }
    const original = { ...clients[0] };
    const evicted = await h.request("execute", { client: clients[0], body: { planId: plans[0] } });
    assert.equal(evicted.status, 400); assert.equal(evicted.data.error, "The preview expired. Preview again.");
    assert.deepEqual(clients[0], original); assert.equal(evicted.setCookie, undefined);
    assert.equal(eventWrites(h, m => m !== "GET").length, 0);
    const latest = await h.request("execute", { client: clients.at(-1), body: { planId: plans.at(-1) } });
    assert.equal(latest.status, 200); assert.equal(latest.data.results[0].ok, true);
  });

  it("rejected previews leave other sessions, plan ownership and saved plans untouched", async t => {
    const h = await setup(t), owner = await h.client(), other = await h.client();
    await h.connect(owner);
    const saved = await h.request("preview", { client: other, body: payload });
    for (let i = 0; i < 5; i++) assert.equal((await h.request("preview", { client: owner, body: payload })).status, 200);
    assert.equal((await h.request("preview", { client: other, body: { ...payload, mode: "demo" } })).status, 400);
    assert.equal((await h.request("execute", { client: owner, body: { planId: saved.data.planId } })).status, 400);
    assert.equal(eventWrites(h, m => m !== "GET").length, 0);
    const retained = await h.request("execute", { client: other, body: { planId: saved.data.planId } });
    assert.equal(retained.status, 200); assert.equal(retained.data.results[0].ok, true);
  });

  it("session reuse keeps the CSRF token stable, and a rejected Host allocates no cookie", async t => {
    const h = await setup(t), client = await h.client(), original = { ...client };
    const result = await h.request("status", { client });
    assert.equal(result.setCookie, undefined); assert.deepEqual(client, original);
    const rejected = await h.request("status", { headers: { host: "malicious.example" } });
    assert.equal(rejected.status, 403); assert.equal(rejected.setCookie, undefined);
    assert.equal(h.calls.length, 0);
  });

  it("sessions expire after 24 idle hours while regular use renews the idle lifetime", async t => {
    const h = await setup(t), client = await h.client(), original = { ...client };
    for (let i = 0; i < 2; i++) {
      h.advance(23 * HOUR);
      assert.equal((await h.request("status", { client })).setCookie, undefined);
      assert.deepEqual(client, original);
    }
    h.advance(TTL);
    const renewed = await h.request("status", { client });
    assert.equal(renewed.status, 200); assert.ok(renewed.setCookie);
    assert.notEqual(client.cookie, original.cookie); assert.notEqual(client.csrf, original.csrf);
  });

  it("status and unknown-route bursts keep at most 256 sessions and evict the least recently used", async t => {
    const h = await setup(t), clients = [];
    for (let i = 0; i < CAPACITY; i++) clients.push(await h.client());
    const oldest = { ...clients[0] }, second = { ...clients[1] };
    await h.request("status", { client: clients[0] });
    const newest = await h.client();
    assert.equal((await h.request("status", { client: clients[0] })).setCookie, undefined);
    assert.deepEqual(clients[0], oldest);
    assert.ok((await h.request("status", { client: clients[1] })).setCookie);
    assert.notEqual(clients[1].cookie, second.cookie);
    for (let i = 0; i < CAPACITY; i++) assert.equal((await h.request("unknown-route")).status, 404);
    assert.ok((await h.request("status", { client: newest })).setCookie);
    assert.equal(h.calls.length, 0);
  });

  for (const reason of ["expiry", "eviction"]) it(`${reason} never transfers the old CSRF token or OAuth state to the replacement session`, async t => {
    const h = await setup(t), client = await h.client(), old = { ...client };
    const start = await h.request("connect", { client });
    const state = new URL(start.location).searchParams.get("state");
    if (reason === "expiry") h.advance(TTL);
    else for (let i = 0; i < CAPACITY; i++) await h.client();
    const rejected = await h.request("preview", { client, body: payload });
    assert.equal(rejected.status, 403); assert.notEqual(client.cookie, old.cookie);
    assert.equal(rejected.data.error, SESSION_UPDATED);
    const repeated = await h.request("preview", { client, body: payload });
    assert.equal(repeated.status, 403); assert.equal(repeated.data.error, INVALID_REQUEST);
    assert.equal((await h.request(`callback?state=${state}&code=SYNTHETIC-CODE`, { client })).location, "/?calendar=error");
    assert.equal(h.calls.length, 0);
    await h.request("status", { client });
    assert.notEqual(client.csrf, old.csrf);
    await h.connect(client);
    assert.equal(h.calls.filter(c => c.url.includes("/token")).length, 1);
  });

  for (const reason of ["expiry", "eviction"]) it(`${reason} invalidates old plans without giving another session ownership`, async t => {
    const h = await setup(t), owner = await h.client();
    await h.connect(owner);
    const other = await h.client();
    const preview = await h.request("preview", { client: owner, body: payload });
    assert.equal(preview.status, 200); assert.equal(preview.data.items[0].action, "create");
    const planId = preview.data.planId;
    assert.equal((await h.request("execute", { client: other, body: { planId } })).status, 400);
    if (reason === "expiry") h.advance(TTL);
    else for (let i = 0; i < CAPACITY; i++) await h.client();
    const expiredExecute = await h.request("execute", { client: owner, body: { planId } });
    assert.equal(expiredExecute.status, 403); assert.equal(expiredExecute.data.error, SESSION_UPDATED);
    await h.request("status", { client: owner });
    assert.equal((await h.request("execute", { client: owner, body: { planId } })).status, 400);
    assert.equal(eventWrites(h, m => m !== "GET").length, 0);
    const fresh = await h.request("preview", { client: owner, body: payload });
    const result = await h.request("execute", { client: owner, body: { planId: fresh.data.planId } });
    assert.equal(result.status, 200); assert.equal(result.data.results[0].ok, true);
    assert.equal(eventWrites(h, m => m === "POST").length, 1);
  });

  it("the session-changed message applies only to the request that replaces an unknown old session", async t => {
    const h = await setup(t);
    for (const path of ["preview", "execute"]) {
      const client = { cookie: "shunri_session=synthetic-old-session", csrf: "synthetic-old-csrf" };
      const first = await h.request(path, { client, body: {} });
      assert.equal(first.status, 403); assert.equal(first.data.error, SESSION_UPDATED);
      assert.ok(first.setCookie);
      const repeated = await h.request(path, { client, body: {} });
      assert.equal(repeated.status, 403); assert.equal(repeated.data.error, INVALID_REQUEST);
      assert.equal(repeated.setCookie, undefined);
    }
    assert.equal(h.calls.length, 0);
  });

  it("the session-changed message is never used for first requests, CSRF errors on a valid session, bad origins or other routes", async t => {
    const h = await setup(t), current = await h.client();
    const old = () => ({ cookie: "shunri_session=synthetic-old-session", csrf: "stale" });
    for (const { path = "preview", client, headers } of [
      { client: {} }, { client: { cookie: "shunri_session=" } },
      { client: { ...current, csrf: "wrong" } },
      { client: old(), headers: { origin: "https://evil.invalid" } },
      { client: old(), headers: { origin: undefined } },
      ...["adopt", "disconnect", "unknown-route"].map(path => ({ path, client: old() })),
    ]) {
      const rejected = await h.request(path, { client, headers, body: {} });
      assert.equal(rejected.status, 403); assert.equal(rejected.data.error, INVALID_REQUEST);
    }
    const badHost = await h.request("execute", { client: old(), body: {}, headers: { host: "evil.invalid" } });
    assert.equal(badHost.status, 403); assert.equal(badHost.data.error, "The request address does not match.");
    assert.equal(badHost.setCookie, undefined); assert.equal(h.calls.length, 0);
  });
});

describe("request body handling over real HTTP", () => {
  // Real loopback HTTP and production body parsing; provider and OAuth responses are synthetic.
  async function setup(t) {
    const dataDir = await connTempDir(t, "shunri-body-test-");
    const calls = [], received = [], waiters = [];
    let service, origin, cookie = "", csrf = "";
    const server = createServer(async (req, res) => {
      const iterate = req[Symbol.asyncIterator].bind(req);
      req[Symbol.asyncIterator] = async function* () {
        for await (const chunk of iterate()) {
          received.push(Buffer.from(chunk));
          waiters.shift()?.();
          yield chunk;
        }
      };
      await service.handle(req, res, new URL(req.url, origin));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    service = createCalendarService({ origin, dataDir, env: connEnv(true), fetchImpl: connProvider(calls) });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    async function request(path, { chunks, headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const req = httpRequest(new URL(`/api/calendar/${path}`, origin), {
          method: chunks ? "POST" : "GET",
          headers: { Cookie: cookie, ...(chunks ? { Origin: origin, "X-Shunri-CSRF": csrf, "Content-Type": "application/json" } : {}), ...headers },
        }, res => {
          const buffers = [];
          res.on("data", chunk => buffers.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            if (res.headers["set-cookie"]) cookie = res.headers["set-cookie"][0].split(";")[0];
            const text = Buffer.concat(buffers).toString("utf8");
            const data = text ? JSON.parse(text) : null;
            if (data?.csrfToken) csrf = data.csrfToken;
            resolve({ status: res.statusCode, data, location: res.headers.location });
          });
        });
        req.on("error", reject);
        (async () => {
          // Wait for the actual IncomingMessage iterator to observe each prefix,
          // so TCP coalescing cannot hide a split UTF-8 sequence.
          for (const chunk of (chunks || []).slice(0, -1)) {
            const observed = new Promise(resolve => waiters.push(resolve));
            req.write(chunk);
            await observed;
          }
          req.end(chunks?.at(-1));
        })().catch(reject);
      });
    }
    await request("status");
    const start = await request("connect");
    const state = new URL(start.location).searchParams.get("state");
    assert.equal((await request(`callback?state=${encodeURIComponent(state)}&code=SYNTHETIC-CODE`)).location, "/?calendar=connected");
    return { request, calls, received };
  }

  const task = { id: "body-task", uid: "body-task-uid", title: "Euro€🚀item", date: "2026-10-19", start: 660, duration: 45, timeZone: "America/Los_Angeles" };
  const payload = { mode: "personal", profileId: "body-profile", calendarId: "owned@example.test", tasks: [task] };

  it("preserves UTF-8 characters split across chunks through preview and simulated execution", async t => {
    const h = await setup(t), body = Buffer.from(JSON.stringify(payload));
    const euro = body.indexOf(Buffer.from("€")), emoji = body.indexOf(Buffer.from("🚀"));
    const chunks = [body.subarray(0, euro + 1), body.subarray(euro + 1, emoji + 2), body.subarray(emoji + 2)];
    const before = h.received.length;
    const preview = await h.request("preview", { chunks });
    assert.equal(h.received.length - before, 3, "the real request exposed all three controlled chunks");
    assert.deepEqual(h.received.slice(before).map(b => b.length), chunks.map(b => b.length));
    assert.equal(preview.status, 200);
    assert.equal(preview.data.items[0].title, task.title);
    assert.equal(preview.data.items[0].action, "create");
    const execute = await h.request("execute", { chunks: [Buffer.from(JSON.stringify({ planId: preview.data.planId }))] });
    assert.equal(execute.status, 200);
    assert.equal(execute.data.results[0].ok, true);
    assert.equal(execute.data.results[0].calendarLink.signature, calendarSignature(task));
    const writes = h.calls.filter(c => c.url.includes("/events") && c.method === "POST");
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].body).summary, task.title);
  });

  it("limits the body to 512000 bytes, counting multibyte JSON by bytes", async t => {
    const h = await setup(t);
    const withPadding = { ...payload, padding: "" };
    const base = Buffer.byteLength(JSON.stringify(withPadding));
    const remaining = 512000 - base;
    withPadding.padding = "€".repeat(Math.floor(remaining / 3)) + "a".repeat(remaining % 3);
    const exact = Buffer.from(JSON.stringify(withPadding));
    assert.equal(exact.length, 512000);
    assert.ok(exact.toString("utf8").length < 512000);
    assert.equal((await h.request("preview", { chunks: [exact] })).status, 200);
    const callsBefore = h.calls.length;
    const over = Buffer.concat([exact, Buffer.from(" ")]);
    assert.equal(over.length, 512001);
    const rejected = await h.request("preview", { chunks: [over] });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.error, "The request is too large. Select fewer tasks and try again.");
    assert.equal(h.calls.length, callsBefore, "oversized requests never reach provider operations");
  });

  it("rejects invalid JSON, empty bodies and requests with a wrong CSRF token, origin or host", async t => {
    const h = await setup(t), callsBefore = h.calls.length;
    const invalid = await h.request("preview", { chunks: [Buffer.from("{")] });
    assert.equal(invalid.status, 400);
    const empty = await h.request("preview", { chunks: [Buffer.alloc(0)] });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.error, "The example schedule cannot sync to a real calendar.");
    for (const headers of [{ "X-Shunri-CSRF": "wrong" }, { Origin: "http://evil.test" }, { Host: "evil.test" }]) {
      const denied = await h.request("preview", { chunks: [Buffer.from(JSON.stringify(payload))], headers });
      assert.equal(denied.status, 403);
    }
    assert.equal(h.calls.length, callsBefore);
  });
});

describe("GET requests that read from the provider", () => {
  // Connected through a callback that arrives with cross-site metadata, then each request is sent with chosen headers.
  async function fixture(t) {
    const dataDir = await connTempDir(t, "shunri-get-boundary-"), calls = [];
    const service = createCalendarService({ origin: CONN_ORIGIN, dataDir, env: connEnv(),
      fetchImpl: async (input) => {
        const url = new URL(input); calls.push({ host: url.hostname, path: url.pathname });
        if (url.hostname === "oauth2.googleapis.com")
          return Response.json({ access_token: "SYNTHETIC-ACCESS", refresh_token: "SYNTHETIC-REFRESH", expires_in: 1 });
        assert.equal(url.hostname, "www.googleapis.com");
        return Response.json({ items: url.pathname.endsWith("/calendarList")
          ? [{ id: "synthetic", summary: "Synthetic", accessRole: "owner", timeZone: "America/Los_Angeles" }] : [],
          timeZone: "America/Los_Angeles" });
      } });
    const jar = {};
    const request = (route, { headers = {}, noCookie = false } = {}) =>
      connRequest(service, CONN_ORIGIN, route, { client: noCookie ? {} : jar, headers });
    await request("status");
    const begin = await request("connect"), state = new URL(begin.location).searchParams.get("state");
    assert.equal((await request(`callback?state=${state}&code=SYNTHETIC`, { headers: { "sec-fetch-site": "cross-site" } })).status, 302);
    return { request, calls, origin: CONN_ORIGIN };
  }

  const routes = ["status", "calendars", "events?from=2026-10-12&to=2026-10-12"];

  it("rejects cookie-free cross-site metadata and foreign origins before any provider call or new session", async t => {
    for (const route of routes) for (const headers of [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site", origin: "http://localhost:3000" },
      { origin: "https://unrelated.example" },
      { "sec-fetch-site": "same-origin", origin: "https://unrelated.example" },
      { "sec-fetch-site": "same-site", origin: "http://localhost:4000" },
      { origin: "null" },
    ]) await t.test(`${route} ${JSON.stringify(headers)}`, async t => {
      const h = await fixture(t), before = h.calls.length;
      const denied = await h.request(route, { noCookie: true, headers });
      assert.equal(denied.status, 403);
      assert.equal(h.calls.length, before, "denial must precede token refresh and Calendar I/O");
      assert.equal(denied.setCookie, undefined, "denial must not allocate a new session");
    });
  });

  it("allows same-origin, direct navigation and headerless local clients", async t => {
    for (const route of routes) for (const headers of [
      {}, { "sec-fetch-site": "same-origin", origin: "http://localhost:3000" }, { "sec-fetch-site": "none" },
    ]) await t.test(`${route} ${JSON.stringify(headers)}`, async t => {
      const h = await fixture(t), before = h.calls.length;
      assert.equal((await h.request(route, { headers })).status, 200);
      assert.ok(h.calls.length > before);
    });
  });

  it("requires the active session state for a cross-site OAuth callback and denies cross-site connect", async t => {
    const h = await fixture(t), before = h.calls.length;
    assert.equal((await h.request("connect", { headers: { "sec-fetch-site": "cross-site" } })).status, 400);
    assert.equal(h.calls.length, before);
    const begin = await h.request("connect", { headers: { "sec-fetch-site": "same-origin", origin: h.origin } });
    assert.equal(begin.status, 302);
    assert.equal((await h.request("callback?state=wrong&code=SYNTHETIC", { headers: { "sec-fetch-site": "cross-site" } })).location, "/?calendar=error");
    assert.equal(h.calls.length, before);
    const restarted = await h.request("connect");
    const state = new URL(restarted.location).searchParams.get("state");
    assert.equal((await h.request(`callback?state=${state}&code=SYNTHETIC`, { headers: { "sec-fetch-site": "cross-site" } })).location, "/?calendar=connected");
    assert.equal(h.calls.length, before + 1);
  });

  it("denies an invalid host before any provider access", async t => {
    const h = await fixture(t), before = h.calls.length;
    assert.equal((await h.request("status", { headers: { host: "unrelated.example" } })).status, 403);
    assert.equal(h.calls.length, before);
  });
});
