import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createCalendarService } from "../calendar-service.mjs";
import { CONN_ORIGIN as origin, connEnv, connReadStore, connRequest, connStoreFault, connTempDir, connWriteStore } from "./helpers.mjs";

// A fresh browser: its own cookie jar against a given service.
const browser = (service) => {
  const client = {};
  return {
    request: (route, body) => connRequest(service, origin, route, { client, body }),
    async connect(account) {
      const started = await connRequest(service, origin, "connect", { client });
      assert.equal(started.status, 302);
      const state = new URL(started.location).searchParams.get("state");
      return connRequest(service, origin, `callback?state=${encodeURIComponent(state)}&code=${account}`, { client });
    },
  };
};

describe("reconnecting to another Google account", () => {
  // Two synthetic accounts: the authorization code names the account. A directory at the atomic rename
  // destination deterministically rejects the save of the new connection.
  async function setup(t) {
    const dataDir = await connTempDir(t, "shunri-oauth-persistence-");
    const calls = [], events = new Map();
    const options = {
      origin, dataDir, env: connEnv(true),
      fetchImpl: async (url, init = {}) => {
        const parsed = new URL(url), method = init.method || "GET";
        if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
          assert.equal(init.body.get("grant_type"), "authorization_code");
          const account = init.body.get("code");
          assert.ok(["A", "B"].includes(account));
          calls.push({ kind: "token", account, method });
          return Response.json({ access_token: `SYNTHETIC-${account}`, refresh_token: `SYNTHETIC-REFRESH-${account}`, expires_in: 3600 });
        }
        assert.equal(parsed.origin, "https://www.googleapis.com");
        const authorization = init.headers.Authorization;
        const account = authorization === "Bearer SYNTHETIC-A" ? "A" : authorization === "Bearer SYNTHETIC-B" ? "B" : null;
        assert.ok(account, "only synthetic authorization may reach the fake provider");
        if (parsed.pathname.endsWith("/calendarList")) {
          calls.push({ kind: "calendars", account, method });
          return Response.json({ items: [{ id: `account-${account}@example.test`, summary: `Synthetic ${account}`, accessRole: "owner", timeZone: "America/Los_Angeles" }] });
        }
        assert.match(parsed.pathname, /\/calendars\/.*\/events(?:\/|$)/);
        calls.push({ kind: "events", account, method });
        if (method === "GET") {
          const event = events.get(`${account}:${parsed.pathname.split("/").at(-1)}`);
          return event ? Response.json(event) : Response.json({}, { status: 404 });
        }
        assert.equal(method, "POST");
        const event = { ...JSON.parse(init.body), etag: '"synthetic-v1"' };
        events.set(`${account}:${event.id}`, event);
        return Response.json(event);
      },
    };
    async function rejectCandidateSave(callback, { existing = false } = {}) {
      const destination = join(dataDir, "connection.enc"), backup = join(dataDir, "synthetic-previous.enc");
      if (existing) await rename(destination, backup);
      await mkdir(destination);
      try { return await callback(); }
      finally {
        await rm(destination, { recursive: true, force: true });
        if (existing) await rename(backup, destination);
      }
    }
    return { client: () => browser(createCalendarService(options)), rejectCandidateSave, calls, dataDir };
  }

  const payload = {
    mode: "personal", profileId: "synthetic-profile", calendarId: "account-A@example.test",
    tasks: [{ id: "synthetic-task", uid: "synthetic-uid", title: "Synthetic saved plan", date: "2026-10-19", start: 660, duration: 45, timeZone: "America/Los_Angeles" }],
  };

  it("a failed reconnect keeps the previous account and its valid plan, including after restart", async t => {
    const h = await setup(t), current = h.client();
    await current.request("status");
    assert.equal((await current.connect("A")).location, "/?calendar=connected");
    const preview = await current.request("preview", payload);
    assert.equal(preview.status, 200); assert.equal(preview.data.items[0].action, "create");
    const encryptedPath = join(h.dataDir, "connection.enc"), previous = await readFile(encryptedPath);
    const failed = await h.rejectCandidateSave(() => current.connect("B"), { existing: true });
    assert.equal(failed.location, "/?calendar=error");
    assert.deepEqual(await readFile(encryptedPath), previous, "failed atomic replacement preserves the old encrypted snapshot");
    const live = await current.request("calendars"), liveStatus = await current.request("status");
    const execution = await current.request("execute", { planId: preview.data.planId });
    const restarted = h.client();
    const restartedStatus = await restarted.request("status"), restartedCalendars = await restarted.request("calendars");
    assert.deepEqual({
      liveAccount: live.data?.calendars?.[0]?.id,
      liveState: liveStatus.data.state,
      busy: liveStatus.data.busy,
      executionStatus: execution.status,
      executed: execution.data?.results?.[0]?.ok ?? false,
      restartedAccount: restartedCalendars.data?.calendars?.[0]?.id,
      restartedState: restartedStatus.data.state,
      eventWriteAccounts: h.calls.filter(call => call.kind === "events" && call.method !== "GET").map(call => call.account),
    }, {
      liveAccount: "account-A@example.test", liveState: "connected", busy: false,
      executionStatus: 200, executed: true,
      restartedAccount: "account-A@example.test", restartedState: "connected", eventWriteAccounts: ["A"],
    });
    assert.equal(h.calls.some(call => call.kind !== "token" && call.account === "B"), false);
  });

  it("a failed first connection stays disconnected and never uses the unsaved account", async t => {
    const h = await setup(t), current = h.client();
    assert.equal((await current.request("status")).data.state, "disconnected");
    const failed = await h.rejectCandidateSave(() => current.connect("B"));
    assert.equal(failed.location, "/?calendar=error");
    const liveStatus = await current.request("status"), live = await current.request("calendars");
    const restarted = h.client();
    const restartedStatus = await restarted.request("status"), restartRead = await restarted.request("calendars");
    const notConnected = "Google Calendar is not connected. Choose Connect Google Calendar, sign in to Google, then try again.";
    assert.deepEqual({
      liveState: liveStatus.data.state, busy: liveStatus.data.busy,
      liveReadStatus: live.status, liveReadError: live.data?.error,
      restartedState: restartedStatus.data.state,
      restartReadStatus: restartRead.status, restartReadError: restartRead.data?.error,
      providerCallsAfterToken: h.calls.filter(call => call.kind !== "token").length,
    }, {
      liveState: "disconnected", busy: false,
      liveReadStatus: 400, liveReadError: notConnected,
      restartedState: "disconnected",
      restartReadStatus: 400, restartReadError: notConnected,
      providerCallsAfterToken: 0,
    });
  });
});

describe("refresh token rotation and persistence", () => {
  // Account A connects with an access token that is already expired. The first refresh rotates the token and
  // then the encrypted save fails (the store is blocked), so the rotated credentials stay pending in memory.
  async function setup(t, { writes = false, refreshFailure = null } = {}) {
    const dataDir = await connTempDir(t, "shunri-refresh-persistence-");
    const fault = connStoreFault(t, dataDir);
    const refreshes = [], calendarAccess = [];
    let rotated = false;
    const config = { origin, dataDir, env: connEnv(writes), fetchImpl: async (input, options = {}) => {
      const url = new URL(input);
      if (url.hostname === "oauth2.googleapis.com") {
        if (options.body.get("grant_type") === "authorization_code") {
          const account = options.body.get("code"); assert.ok(["A", "B"].includes(account));
          return Response.json({ access_token: `SYNTHETIC-ACCESS-${account}`, refresh_token: `SYNTHETIC-REFRESH-${account}`,
            expires_in: account === "A" ? 1 : 3600 });
        }
        assert.equal(options.body.get("grant_type"), "refresh_token");
        const token = options.body.get("refresh_token"); refreshes.push(token);
        if (refreshFailure === "network") throw new Error("SYNTHETIC-NETWORK-FAILURE");
        if (refreshFailure === "expired") return Response.json({ error: "invalid_grant" }, { status: 400 });
        if (!rotated) {
          assert.equal(token, "SYNTHETIC-REFRESH-A"); rotated = true;
          await fault.block();
          return Response.json({ access_token: "SYNTHETIC-ACCESS-A-ROTATED", refresh_token: "SYNTHETIC-REFRESH-A-ROTATED", expires_in: 3600 });
        }
        if (token === "SYNTHETIC-REFRESH-A") return Response.json({ error: "invalid_grant" }, { status: 400 });
        assert.equal(token, "SYNTHETIC-REFRESH-A-ROTATED");
        return Response.json({ access_token: "SYNTHETIC-ACCESS-A-AGAIN", expires_in: 3600 });
      }
      assert.equal(url.hostname, "www.googleapis.com"); assert.ok(url.pathname.endsWith("/calendarList"));
      calendarAccess.push(options.headers.Authorization);
      return Response.json({ items: [{ id: "mine", summary: "Synthetic", accessRole: "owner", timeZone: "America/Los_Angeles" }] });
    } };
    const client = () => browser(createCalendarService(config));
    const current = client(); await current.request("status"); await current.connect("A");
    return { current, client, repair: () => fault.repair(), saved: () => connReadStore(dataDir), refreshes, calendarAccess, dataDir,
      async expireSavedAccess() { await connWriteStore(dataDir, { ...(await connReadStore(dataDir)), expiresAt: 0 }); },
      setRefreshFailure(value) { refreshFailure = value; } };
  }

  it("a repaired store saves the rotated refresh token and reloads it for the next refresh", async t => {
    const h = await setup(t);
    const failed = await h.current.request("calendars"); assert.equal(failed.status, 400); assert.match(failed.data.error, /EISDIR|ENOTDIR|EEXIST|EPERM/);
    assert.equal(h.calendarAccess.length, 0); await h.repair();
    assert.equal((await h.current.request("calendars")).status, 200);
    assert.equal((await h.saved()).refreshToken, "SYNTHETIC-REFRESH-A-ROTATED", "a successful read must not leave the rotated refresh token memory-only");
    assert.deepEqual(h.refreshes, ["SYNTHETIC-REFRESH-A"]);
    await h.expireSavedAccess(); const restarted = h.client();
    assert.equal((await restarted.request("calendars")).status, 200);
    assert.deepEqual(h.refreshes, ["SYNTHETIC-REFRESH-A", "SYNTHETIC-REFRESH-A-ROTATED"]);
    assert.equal(h.calendarAccess.at(-1), "Bearer SYNTHETIC-ACCESS-A-AGAIN");
  });

  it("reconnecting as B after A's failed save does not carry A's pending credentials into B", async t => {
    const h = await setup(t);
    assert.equal((await h.current.request("calendars")).status, 400); await h.repair();
    await h.current.connect("B");
    assert.equal((await h.current.request("calendars")).status, 200);
    const saved = await h.saved(); assert.equal(saved.accessToken, "SYNTHETIC-ACCESS-B"); assert.equal(saved.refreshToken, "SYNTHETIC-REFRESH-B");
    assert.equal((await h.client().request("calendars")).status, 200);
    assert.deepEqual(h.calendarAccess, ["Bearer SYNTHETIC-ACCESS-B", "Bearer SYNTHETIC-ACCESS-B"]);
    assert.deepEqual(h.refreshes, ["SYNTHETIC-REFRESH-A"]);
  });

  for (const writes of [false, true]) it(`status reports a failed save of rotated tokens and retries it after repair with writes ${writes ? "enabled" : "disabled"}`, async t => {
    const h = await setup(t, { writes });
    for (let attempt = 0; attempt < 2; attempt++) {
      const status = await h.current.request("status");
      assert.equal(status.status, 200);
      assert.equal(status.data.state, "storage_error");
      assert.equal(status.data.storageRetryable, true);
      assert.match(status.data.message, /saved.*try again/);
      assert.doesNotMatch(status.data.message, /SYNTHETIC|EISDIR|connection\.enc/);
      assert.equal(status.data.writesEnabled, writes);
      assert.equal(typeof status.data.csrfToken, "string");
      assert.equal(h.calendarAccess.length, 0);
    }
    // While storage keeps failing, reads are rejected without using the unsaved access token or spending the old refresh token again.
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await h.current.request("calendars")).status, 400);
      assert.equal(h.calendarAccess.length, 0);
    }
    assert.deepEqual(h.refreshes, ["SYNTHETIC-REFRESH-A"]);
    await h.repair();
    const recovered = await h.current.request("status");
    assert.equal(recovered.data.state, "connected");
    assert.equal(recovered.data.storageRetryable, false);
    assert.doesNotMatch(recovered.data.message, /cannot be read yet/);
    assert.equal((await h.saved()).refreshToken, "SYNTHETIC-REFRESH-A-ROTATED");
    assert.equal((await h.current.request("calendars")).status, 200);
    assert.equal((await h.client().request("calendars")).status, 200);
    assert.equal(h.calendarAccess.length, 2);
    assert.deepEqual(h.refreshes, ["SYNTHETIC-REFRESH-A"], "status recovery must reuse the pending rotated token, not refresh again");
  });

  for (const state of ["network", "expired"]) it(`status reports a ${state} provider failure separately from storage failure, and clears it once pending credentials are saved`, async t => {
    const h = await setup(t, { refreshFailure: state });
    const status = await h.current.request("status");
    assert.equal(status.status, 200);
    assert.equal(status.data.state, state);
    assert.equal(status.data.storageRetryable, false);
    assert.doesNotMatch(status.data.message, /could not be saved yet/);
    assert.equal(h.calendarAccess.length, 0);
    h.setRefreshFailure(null);
    const failedSave = await h.current.request("status");
    assert.equal(failedSave.data.state, "storage_error");
    assert.equal(failedSave.data.storageRetryable, true);
    assert.equal(h.calendarAccess.length, 0);
    await h.repair();
    const recovered = await h.current.request("status");
    assert.equal(recovered.data.state, "connected");
    assert.equal(recovered.data.storageRetryable, false);
    assert.equal((await h.saved()).refreshToken, "SYNTHETIC-REFRESH-A-ROTATED");
    assert.equal((await h.current.request("calendars")).status, 200);
    assert.equal(h.calendarAccess.length, 1);
    assert.deepEqual(h.refreshes, ["SYNTHETIC-REFRESH-A", "SYNTHETIC-REFRESH-A"], "storage recovery must not issue another provider refresh");
  });

  it("an unreadable stored record does not claim it can retry a pending save", async t => {
    const h = await setup(t), damaged = Buffer.from("SYNTHETIC-INVALID-ENCRYPTED-RECORD");
    const path = join(h.dataDir, "connection.enc");
    await writeFile(path, damaged, { mode: 0o600 });
    const status = await h.client().request("status");
    assert.equal(status.data.state, "storage_error");
    assert.equal(status.data.storageRetryable, false);
    assert.match(status.data.message, /could not be read/);
    assert.deepEqual(await readFile(path), damaged);
    assert.equal(h.refreshes.length, 0);
    assert.equal(h.calendarAccess.length, 0);
  });

  it("failed saves remove their own temporary files across retries and recovery", async t => {
    const dataDir = await connTempDir(t, "shunri-persist-cleanup-");
    const fault = connStoreFault(t, dataDir, "synthetic-durable.enc");
    const destination = join(dataDir, "connection.enc");
    let refreshes = 0, calendarReads = 0;
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    const temporaryFiles = async () => (await readdir(dataDir)).filter(name => /^connection-.*\.tmp$/.test(name));
    const service = createCalendarService({ origin, dataDir, env: connEnv(),
      fetchImpl: async (input, options = {}) => {
        const url = new URL(input);
        if (url.hostname === "oauth2.googleapis.com") {
          if (options.body.get("grant_type") === "authorization_code")
            return Response.json({ access_token: "SYNTHETIC-OLD-ACCESS", refresh_token: "SYNTHETIC-OLD-REFRESH", expires_in: 1 });
          assert.equal(options.body.get("grant_type"), "refresh_token");
          assert.equal(options.body.get("refresh_token"), "SYNTHETIC-OLD-REFRESH");
          assert.equal(++refreshes, 1, "later attempts retry persistence, not token rotation");
          await fault.block();
          return Response.json({ access_token: "SYNTHETIC-NEW-ACCESS", refresh_token: "SYNTHETIC-ROTATED-REFRESH", expires_in: 3600 });
        }
        assert.equal(url.hostname, "www.googleapis.com"); assert.ok(url.pathname.endsWith("/calendarList"));
        assert.equal(options.headers.Authorization, "Bearer SYNTHETIC-NEW-ACCESS"); calendarReads++;
        return Response.json({ items: [] });
      } });
    const me = browser(service);
    await me.request("status");
    assert.equal((await me.connect("SYNTHETIC")).location, "/?calendar=connected");
    const durableHash = hash(await readFile(destination)), counts = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const failed = await me.request("calendars"); assert.equal(failed.status, 400);
      assert.match(failed.data.error, /EISDIR|ENOTDIR|EEXIST|EPERM/, "keep the original save error");
      counts.push((await temporaryFiles()).length);
      assert.equal(hash(await readFile(fault.preserved)), durableHash, "cleanup must not change the previously durable encrypted file");
    }
    assert.equal(calendarReads, 0); assert.equal(refreshes, 1);
    assert.deepEqual(counts, [0, 0, 0], "each failed save must remove only its own temporary file");
    await fault.repair(); assert.equal((await me.request("calendars")).status, 200);
    assert.equal(calendarReads, 1); assert.equal(refreshes, 1); assert.deepEqual(await temporaryFiles(), []);
    assert.equal((await connReadStore(dataDir)).refreshToken, "SYNTHETIC-ROTATED-REFRESH");
  });
});

describe("concurrent refresh", () => {
  const gate = () => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  };

  for (const failure of [null, "network", "invalid_grant"]) {
    it(`requests share one token rotation and may retry after ${failure || "success"}`, { timeout: 5000 }, async t => {
      const dataDir = await connTempDir(t, "synthetic-refresh-concurrency-");
      const key = randomBytes(32);
      await connWriteStore(dataDir, {
        accessToken: "SYNTHETIC-OLD-ACCESS", refreshToken: "SYNTHETIC-OLD-REFRESH", expiresAt: 0, mappings: {},
      }, key);
      const entered = gate(), release = gate(), refreshes = [], calendarAccess = [];
      t.after(() => release.release());
      const service = createCalendarService({
        dataDir, env: connEnv(),
        fetchImpl: async (input, options) => {
          const url = new URL(input);
          if (url.hostname === "oauth2.googleapis.com") {
            refreshes.push(options.body.get("refresh_token"));
            const attempt = refreshes.length;
            entered.release();
            await release.promise;
            if (attempt === 1 && failure === "network") throw new Error("Synthetic network failure");
            // A duplicate use of the old token fails after the first rotation.
            if ((attempt === 1 && failure === "invalid_grant") || (!failure && attempt > 1))
              return Response.json({ error: "invalid_grant" }, { status: 400 });
            return Response.json({ access_token: "SYNTHETIC-ROTATED-ACCESS", refresh_token: "SYNTHETIC-ROTATED-REFRESH", expires_in: 3600 });
          }
          assert.equal(url.hostname, "www.googleapis.com");
          assert.ok(url.pathname.endsWith("/calendarList"));
          calendarAccess.push(options.headers.Authorization);
          return Response.json({ items: [] });
        },
      });
      const request = (route) => connRequest(service, origin, route);
      const first = request("calendars");
      await entered.promise;
      const others = Array.from({ length: 3 }, () => request("calendars"));
      try {
        // Drain runnable handlers while the provider is held; no timing sleeps.
        await setImmediate();
        assert.deepEqual(refreshes, ["SYNTHETIC-OLD-REFRESH"]);
        assert.equal(calendarAccess.length, 0);
      } finally {
        release.release();
        await Promise.all([first, ...others]);
      }
      const results = await Promise.all([first, ...others]);
      assert.deepEqual(results.map(result => result.status), Array(4).fill(failure ? 400 : 200));
      if (failure) {
        assert.equal(calendarAccess.length, 0);
        assert.equal((await request("calendars")).status, 200);
      }
      const status = await request("status");
      assert.equal(status.data.state, "connected");
      assert.equal(status.data.storageRetryable, false);
      assert.equal(refreshes.length, failure ? 2 : 1);
      assert.ok(calendarAccess.every(value => value === "Bearer SYNTHETIC-ROTATED-ACCESS"));
      const saved = await connReadStore(dataDir);
      assert.equal(saved.refreshToken, "SYNTHETIC-ROTATED-REFRESH");
      assert.equal(saved.accessToken, "SYNTHETIC-ROTATED-ACCESS");
    });
  }
});
