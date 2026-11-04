import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCalendarService, googleEventSignature, managedEventId } from "../calendar-service.mjs";
import { mergeCalendar, localCalendarSignature } from "../calendar-data.js";
import { gcalHttpClient } from "./helpers.mjs";

// Every Google response in this suite is simulated, with separate temporary
// encrypted storage. It never reads credentials or contacts a real calendar.
// The fake provider serves two pages of calendars ("mine", "shared" as reader, then "mine2") and an
// events list for "mine" that is split into two pages. `config` switches faults on per test.
const calendar = (id, accessRole = "owner") => ({
  id,
  summary: `${id} simulated calendar`,
  accessRole,
  timeZone: "America/Los_Angeles",
});
const event = (id, extra = {}) => ({
  id,
  etag: '"v1"',
  summary: "Study: lesson",
  status: "confirmed",
  updated: "2026-10-10T20:00:00Z",
  organizer: { self: true },
  start: { dateTime: "2026-10-12T11:00:00-07:00", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2026-10-12T12:00:00-07:00", timeZone: "America/Los_Angeles" },
  ...extra,
});
const task = (eventId = "original-a", extra = {}) => ({
  id: "task-a",
  uid: "uid-a",
  title: "Study: lesson",
  date: "2026-10-12",
  start: 660,
  duration: 60,
  timeZone: "America/Los_Angeles",
  type: "task",
  calendarLink: { source: "google", managed: true, calendarId: "mine", eventId, etag: '"v1"' },
  ...extra,
});
const payload = (tasks = [task()]) => ({ mode: "personal", profileId: "profile-a", calendarId: "mine", tasks });

async function setup(t, { writes = true, allowedWriteUids = null } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "shunri-import-test-"));
  const calls = [],
    events = new Map([["mine:original-a", event("original-a")]]);
  const config = {
    forbidden: new Set(),
    repeatedPages: false,
    readFailures: new Map(),
    calendarNames: {},
    calendarTimeZones: {},
    eventTimeZones: {},
    echoRequestedTimeZone: false,
    failPuts: new Set(),
    lostResponses: new Set(),
  };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input),
      method = options.method || "GET";
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method });
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({
        access_token: "SIMULATED_TOKEN",
        refresh_token: "SIMULATED_REFRESH",
        expires_in: 3600,
      });
    if (url.pathname.endsWith("/calendarList")) {
      const namedCalendar = (id, role) => ({ ...calendar(id, role),
        ...(config.calendarNames[id] ? { summary: config.calendarNames[id] } : {}),
        ...(Object.hasOwn(config.calendarTimeZones, id) ? { timeZone: config.calendarTimeZones[id] } : {}) });
      return Response.json(
        url.searchParams.has("pageToken")
          ? { items: [namedCalendar("mine"), namedCalendar("mine2")] }
          : {
              items: [namedCalendar("mine"), namedCalendar("shared", "reader")],
              nextPageToken: "calendars-2",
            },
      );
    }
    const parts = url.pathname.split("/").map(decodeURIComponent),
      cId = parts[parts.indexOf("calendars") + 1],
      eId = parts[parts.indexOf("events") + 1];
    if (method === "GET" && !eId) {
      if (config.forbidden.has(cId)) return Response.json({}, { status: 403 });
      const failure = config.readFailures.get(`${cId}:${url.searchParams.get("pageToken") || ""}`);
      if (failure) return Response.json({}, { status: failure });
      const timeZone = config.echoRequestedTimeZone && url.searchParams.get("timeZone")
        || (Object.hasOwn(config.eventTimeZones, cId)
        ? config.eventTimeZones[cId]
        : Object.hasOwn(config.calendarTimeZones, cId)
          ? config.calendarTimeZones[cId] : "America/Los_Angeles");
      if (url.searchParams.get("fields") === "timeZone")
        return Response.json({ timeZone });
      const items = [...events.entries()]
        .filter(([key]) => key.startsWith(`${cId}:`))
        .map(([, value]) => value);
      if (cId === "mine" && !url.searchParams.has("pageToken"))
        return Response.json({
          items: items.slice(0, 2),
          nextPageToken: "events-2",
          timeZone,
        });
      return Response.json({
        items: cId === "mine" ? items : items,
        ...(config.repeatedPages ? { nextPageToken: "events-2" } : {}),
        timeZone,
      });
    }
    const key = `${cId}:${eId}`;
    if (method === "GET")
      return events.has(key)
        ? Response.json(events.get(key))
        : Response.json({}, { status: 404 });
    if (method === "PUT") {
      if (config.failPuts.has(key)) return Response.json({}, { status: 503 });
      if (options.headers["If-Match"] !== events.get(key)?.etag)
        return Response.json({}, { status: 412 });
      const value = { ...JSON.parse(options.body), etag: `"${Date.now()}-${calls.length}"` };
      events.set(key, value);
      if (config.lostResponses.delete(key))
        throw new Error("SIMULATED lost successful response");
      return Response.json(value);
    }
    if (method === "POST") {
      const value = JSON.parse(options.body),
        target = `${cId}:${value.id}`;
      if (events.has(target)) return Response.json({}, { status: 409 });
      events.set(target, { ...value, etag: '"created-v1"' });
      if (config.lostResponses.delete(target))
        throw new Error("SIMULATED lost successful response");
      return Response.json(events.get(target));
    }
    throw new Error("Unexpected simulated method");
  };
  let service;
  const { origin, request } = await gcalHttpClient(t, () => service);
  const env = {
    GOOGLE_CLIENT_ID: "SIMULATED_CLIENT",
    GOOGLE_CLIENT_SECRET: "SIMULATED_SECRET",
    CALENDAR_WRITES_ENABLED: String(writes),
  };
  const restart = () => {
    service = createCalendarService({ origin, fetchImpl, env, dataDir, allowedWriteUids });
  };
  restart();
  await request("status");
  const auth = new URL((await request("connect")).location);
  assert.equal(auth.searchParams.get("include_granted_scopes"), "true");
  assert.match(auth.searchParams.get("scope"), /calendar\.events\.readonly/);
  assert.equal(
    (await request(`callback?state=${encodeURIComponent(auth.searchParams.get("state"))}&code=SIMULATED`)).status,
    302,
  );
  const adopt = async (tasks = [task()]) =>
    (await request("adopt", payload(tasks))).data;
  return { request, adopt, calls, events, config, dataDir, restart };
}
const readRange =
  "events?from=2026-10-10&to=2026-10-14&timeZone=America%2FLos_Angeles";
const catalogRange =
  "events?purpose=job-prepare-catalog&calendarId=mine&from=2026-10-09&to=2036-10-06&timeZone=America%2FLos_Angeles";

// ---- One task, one event: a task cannot be mapped to a second calendar or event ----

test("restoring a backup made before the first sync cannot create the same task in a different calendar", async t => {
  const h = await setup(t), original = task("unused", { calendarLink: null });
  const first = (await h.request("preview", payload([original]))).data;
  assert.equal((await h.request("execute", { planId: first.planId })).data.results[0].ok, true);
  const originalBytes = JSON.stringify([...h.events]);
  const restored = (await h.request("preview", { ...payload([original]), calendarId: "mine2" })).data;
  assert.equal(restored.items[0].action, "error");
  assert.match(restored.items[0].reason, /linked to another Google calendar/);
  assert.equal(restored.canExecute, false);
  assert.equal((await h.request("execute", { planId: restored.planId })).status, 400);
  assert.equal(JSON.stringify([...h.events]), originalBytes);
  assert.equal(h.calls.filter(x => x.method === "POST" && x.path.includes("/events")).length, 1);
  const sameCalendar = (await h.request("preview", payload([original]))).data;
  assert.equal(sameCalendar.items[0].action, "skip");
});

test("executing an old create preview for another calendar is rejected once the task is synced, before any provider call", async t => {
  const h = await setup(t), original = task("unused", { calendarLink: null });
  const first = (await h.request("preview", payload([original]))).data;
  const stale = (await h.request("preview", { ...payload([original]), calendarId: "mine2" })).data;
  assert.equal(first.items[0].action, "create");
  assert.equal(stale.items[0].action, "create");
  assert.equal((await h.request("execute", { planId: first.planId })).data.results[0].ok, true);
  const before = h.calls.length, originalBytes = JSON.stringify([...h.events]);
  const denied = (await h.request("execute", { planId: stale.planId })).data.results[0];
  assert.equal(denied.ok, false);
  assert.match(denied.message, /linked to another Google calendar/);
  assert.equal(h.calls.length, before, "a stale target must be rejected before provider I/O");
  assert.equal(JSON.stringify([...h.events]), originalBytes);
});
test("different task UIDs and different profiles can still create events in several calendars", async t => {
  const h = await setup(t);
  const variants = [payload([task("unused", { calendarLink: null })]),
    { ...payload([task("unused", { uid: "uid-b", calendarLink: null })]), calendarId: "mine2" },
    { ...payload([task("unused", { calendarLink: null })]), profileId: "profile-b", calendarId: "mine2" },
    { ...payload([task("unused", { uid: "a:b", calendarLink: null })]), profileId: "profile" },
    { ...payload([task("unused", { uid: "b", calendarLink: null })]), profileId: "profile:a", calendarId: "mine2" }];
  for (const data of variants) {
    const preview = (await h.request("preview", data)).data;
    assert.equal(preview.items[0].action, "create");
    assert.equal((await h.request("execute", { planId: preview.planId })).data.results[0].ok, true);
  }
  assert.equal(h.calls.filter(x => x.method === "POST" && x.path.includes("/events")).length, variants.length);
});

test("an uncertain committed create retains its mapping and cannot be copied into another calendar", async t => {
  const h = await setup(t), original = task("unused", { calendarLink: null });
  const eventId = managedEventId("profile-a", original.uid);
  h.config.lostResponses.add(`mine:${eventId}`);
  const first = (await h.request("preview", payload([original]))).data;
  assert.equal((await h.request("execute", { planId: first.planId })).data.results[0].ok, false);
  assert.equal(h.events.has(`mine:${eventId}`), true);
  const restored = (await h.request("preview", { ...payload([original]), calendarId: "mine2" })).data;
  assert.equal(restored.items[0].action, "error");
  assert.match(restored.items[0].reason, /linked to another Google calendar/);
  assert.equal(h.events.has(`mine2:${eventId}`), false);
  assert.equal(h.calls.filter(x => x.method === "POST" && x.path.includes("/events")).length, 1);
});

test("adoption keeps the exact original mapping and rejects a different event for the same task", async t => {
  for (const calendarId of ["mine", "mine2"]) await t.test(calendarId, async t => {
    const h = await setup(t);
    assert.equal((await h.adopt()).results[0].ok, true);
    assert.equal((await h.adopt()).results[0].ok, true, "the exact calendar/event may be re-adopted");
    h.events.set(`${calendarId}:original-b`, event("original-b"));
    const replacement = task("original-b", { calendarLink: { ...task().calendarLink, calendarId, eventId: "original-b" } });
    const denied = (await h.adopt([replacement])).results[0];
    assert.equal(denied.ok, false);
    assert.match(denied.message, /linked to another Google event/);
    const read = (await h.request(readRange)).data;
    assert.equal(read.events.find(e => e.eventId === "original-a").managed, true);
    assert.equal(read.events.find(e => e.eventId === "original-b").managed, false);
    h.restart();
    const restarted = (await h.request(readRange)).data;
    assert.equal(restarted.events.find(e => e.eventId === "original-a").managed, true);
    assert.equal(restarted.events.find(e => e.eventId === "original-b").managed, false);
    assert.equal(h.calls.filter(x => x.method !== "GET" && x.path.includes("/events")).length, 0);
  });
});

// ---- Learning catalog read ----

test("the catalog read pages through every event and returns only learning events, including far-future ones, with original IDs and no change to authorization or calendar", async (t) => {
  const h = await setup(t, { writes: false });
  h.events.clear();
  h.events.set("mine:lesson", event("lesson", { summary: "SQL ROW_NUMBER lesson" }));
  for (let day = 0; day < 90; day++)
    h.events.set(`mine:meal-${day}`, event(`meal-${day}`, { summary: "Lunch", recurringEventId: "meal-series" }));
  h.events.set("mine:far-lesson", event("far-lesson", {
    summary: "interface.ai course module 2 remaining homework",
    recurringEventId: "course-series",
    originalStartTime: { dateTime: "2027-06-20T11:00:00-07:00" },
    start: { dateTime: "2027-06-20T11:00:00-07:00" },
    end: { dateTime: "2027-06-20T12:00:00-07:00" },
  }));
  h.events.set("mine:description-learning", event("description-learning", {
    summary: "Today's plan", description: "Job Prepare: SQL LAG lesson and practice.",
  }));
  h.events.set("shared:unrelated", event("unrelated", { summary: "SQL lesson" }));
  const keyBefore = await readFile(join(h.dataDir, "key"));
  const authorizationBefore = await readFile(join(h.dataDir, "connection.enc"));
  const start = h.calls.length;
  const first = await h.request(catalogRange), second = await h.request(catalogRange);
  assert.equal(first.status, 200);
  assert.equal(first.data.partial, false);
  assert.equal(first.data.complete, true);
  assert.equal(first.data.readScope, "job-prepare-catalog");
  assert.equal(first.data.range.catalog, true);
  assert.equal(first.data.range.fullOccupationCoverage, false);
  assert.deepEqual(first.data.completedCalendarIds, ["mine"]);
  assert.deepEqual(first.data.events.map((item) => item.eventId), ["lesson", "far-lesson", "description-learning"]);
  assert.equal(first.data.events[1].originalStartTime.dateTime, "2027-06-20T11:00:00-07:00");
  assert.deepEqual(first.data.events, second.data.events);
  assert.equal(first.data.catalog.filteredEventCount, 3);
  assert.ok(first.data.catalog.scannedEventCount >= 93);
  assert.ok(h.calls.slice(start).every((call) => call.method === "GET"));
  const pages = h.calls.slice(start).filter((call) => call.path.endsWith("/events"));
  assert.equal(pages.length, 4);
  assert.ok(pages.every((call) => call.path.includes("/calendars/mine/") && call.query.singleEvents === "true" && call.query.showDeleted === "true"));
  assert.equal(pages[1].query.pageToken, "events-2");
  assert.deepEqual(await readFile(join(h.dataDir, "key")), keyBefore);
  assert.deepEqual(await readFile(join(h.dataDir, "connection.enc")), authorizationBefore);
});

test("the catalog recognises learning from the event facts and context, not real interviews, hard assessments or life events", async (t) => {
  const h = await setup(t, { writes: false });
  h.events.clear();
  h.config.calendarNames.mine = "Job Prepare";
  for (const [id, summary, description] of [
    ["context", "Teaching and practice", ""],
    ["mock", "Mock interview practice", ""],
    ["practice", "Practice assessment", ""],
    ["real", "Real interview", "SQL hiring interview, the interviewer attends"],
    ["hard", "Hiring assessment", "Job Prepare real timed assessment, not practice"],
    ["medical", "Dentist appointment", "Review SQL LAG afterwards"],
    ["trip", "Mid-Autumn park barbecue", "That day is an outing rest day, so no Job Prepare study is scheduled"],
    ["meal", "Lunch", ""],
    ["unknown", "A while", ""],
  ]) h.events.set(`mine:${id}`, event(id, { summary, description }));
  const result = (await h.request(catalogRange)).data;
  assert.deepEqual(result.events.map((item) => item.eventId), ["context", "mock", "practice"]);
  assert.equal(result.events[0].calendarName, "Job Prepare");
  const all = (await h.request(`${readRange}&calendarId=mine`)).data;
  assert.equal(all.events.length, 9);
  assert.equal(all.readScope, "all-events");
  assert.equal(all.range.catalog, false);
  assert.equal(all.range.fullOccupationCoverage, true);
});

test("the catalog never claims to be complete when a later page fails or repeats", async (t) => {
  const h = await setup(t, { writes: false });
  h.events.set("mine:lesson", event("lesson", { summary: "SQL LAG lesson" }));
  h.config.readFailures.set("mine:events-2", 400);
  const start = h.calls.length;
  const failed = (await h.request(catalogRange)).data;
  assert.equal(failed.partial, true);
  assert.equal(failed.complete, false);
  assert.deepEqual(failed.completedCalendarIds, []);
  assert.match(failed.errors[0].message, /HTTP 400/);
  assert.equal(failed.range.fullOccupationCoverage, false);
  h.config.readFailures.clear();
  h.config.repeatedPages = true;
  const repeated = (await h.request(catalogRange)).data;
  assert.equal(repeated.complete, false);
  assert.ok(repeated.errors.some((error) => /page repeated/.test(error.message)));
  assert.ok(h.calls.slice(start).every((call) => call.method === "GET"));
});

test("an empty catalog means no recognised learning rather than no occupied dates, and invalid catalog requests are rejected", async (t) => {
  const h = await setup(t, { writes: false });
  h.events.clear();
  h.events.set("mine:meal", event("meal", { summary: "Lunch" }));
  const result = (await h.request(catalogRange)).data;
  assert.equal(result.complete, true);
  assert.deepEqual(result.events, []);
  assert.equal(result.range.catalog, true);
  assert.equal(result.range.fullOccupationCoverage, false);
  assert.equal((await h.request(catalogRange.replace("&calendarId=mine", ""))).status, 400);
  assert.equal((await h.request(catalogRange.replace("calendarId=mine", "calendarId=shared"))).status, 400);
  assert.equal((await h.request(catalogRange.replace("purpose=job-prepare-catalog", "purpose=unknown"))).status, 400);
  assert.equal((await h.request(catalogRange.replace("2036-10-06", "2037-10-06"))).status, 400);
});

test("an adopted event stays the same task and package across repeated catalog imports", async (t) => {
  const h = await setup(t, { writes: false });
  h.events.get("mine:original-a").summary = "SQL LAG lesson";
  const adopted = await h.adopt([task("original-a", { title: "SQL LAG lesson" })]);
  assert.equal(adopted.results[0].ok, true);
  const start = h.calls.length, response = (await h.request(catalogRange)).data;
  assert.equal(response.events[0].managed, true);
  assert.equal(response.events[0].managedUid, "uid-a");
  assert.equal(response.events[0].managedProfileId, "profile-a");
  assert.equal(response.events[0].baselineEtag, '"v1"');
  const initial = { days: {}, settings: { timeZone: "America/Los_Angeles" } };
  const first = mergeCalendar(initial, response, { profileId: "profile-a" });
  const originalTask = Object.values(first.data.days).flat()[0];
  assert.equal(originalTask.uid, "uid-a");
  assert.equal(originalTask.planId, "job-prepare");
  assert.equal(originalTask.calendarLink.eventId, "original-a");
  assert.equal(originalTask.calendarLink.adoptedEtag, '"v1"');
  assert.equal(originalTask.externalReadOnly, false);
  const repeated = mergeCalendar(first.data, response, { profileId: "profile-a" });
  const sameTask = Object.values(repeated.data.days).flat()[0];
  assert.equal(Object.values(repeated.data.days).flat().length, 1);
  assert.equal(sameTask.id, originalTask.id);
  assert.equal(sameTask.packageId, originalTask.packageId);
  assert.ok(h.calls.slice(start).every((call) => call.method === "GET"));
});

// ---- Reading events ----

test("repeated reads return each event once across pages and shared calendars", async (t) => {
  const h = await setup(t);
  h.events.set(
    "mine:repeat_20261013",
    event("repeat_20261013", {
      recurringEventId: "repeat",
      originalStartTime: { dateTime: "2026-10-13T11:00:00-07:00" },
      description: "The study label is expressed by the user's text",
      colorId: "5",
    }),
  );
  h.events.set("shared:other", event("other", { organizer: { self: false } }));
  const first = (await h.request(readRange)).data,
    second = (await h.request(readRange)).data;
  assert.equal(first.events.length, 3);
  assert.deepEqual(first.events, second.events);
  assert.equal(first.calendars.length, 3);
  assert.equal(first.events.find((x) => x.eventId === "repeat_20261013").recurringEventId, "repeat");
  assert.equal(first.events.find((x) => x.calendarId === "shared").canManage, false);
  const reads = h.calls.filter((x) => x.path.endsWith("/events"));
  assert.ok(reads.every((x) => x.query.singleEvents === "true" && x.query.showDeleted === "true"));
  assert.equal(first.range.timeMin, "2026-10-10T07:00:00.000Z");
  assert.equal(first.range.timeMax, "2026-10-15T07:00:00.000Z");
  assert.equal(h.calls.some((x) => x.path.includes("/events") && x.method !== "GET"), false);
});

test("all-day, overnight and cancelled events and their time zones are read unchanged", async (t) => {
  const h = await setup(t);
  h.events.set("mine:all-day", event("all-day", { start: { date: "2026-10-11" }, end: { date: "2026-10-14" } }));
  h.events.set(
    "mine:overnight",
    event("overnight", {
      start: { dateTime: "2026-10-11T23:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-10-12T02:00:00+09:00", timeZone: "Asia/Tokyo" },
    }),
  );
  h.events.set("mine:cancelled", { id: "cancelled", status: "cancelled", etag: '"deleted"' });
  const events = (await h.request(readRange)).data.events;
  assert.deepEqual(events.find((x) => x.eventId === "all-day").end, { date: "2026-10-14" });
  assert.equal(events.find((x) => x.eventId === "overnight").start.timeZone, "Asia/Tokyo");
  assert.equal(events.find((x) => x.eventId === "overnight").canManage, false);
  assert.equal(events.find((x) => x.eventId === "cancelled").status, "cancelled");
});

test("a calendar that refuses access gives a partial read that lists the calendars completed", async (t) => {
  const h = await setup(t);
  h.config.forbidden.add("shared");
  const result = (await h.request(readRange)).data;
  assert.equal(result.partial, true);
  assert.equal(result.errors[0].permissionRequired, true);
  assert.equal(result.range.fullOccupationCoverage, false);
  assert.equal(result.complete, false);
  assert.match(result.errors[0].message, /Existing authorization is retained/);
  assert.deepEqual(result.completedCalendarIds, ["mine", "mine2"]);
  assert.equal(result.events[0].eventId, "original-a");
});

test("a repeating page token and invalid ranges fail without writing any event", async (t) => {
  const h = await setup(t);
  h.config.repeatedPages = true;
  const result = (await h.request(readRange)).data;
  assert.ok(result.errors.some((x) => /page repeated/.test(x.message)));
  assert.equal((await h.request("events?from=2026-02-30&to=2026-10-14")).status, 400);
  assert.equal((await h.request("events?from=2026-10-12&to=2026-10-11")).status, 400);
  assert.equal((await h.request(`${readRange}&calendarId=unlisted`)).status, 400);
});

// ---- Adopting events and writing to them ----

test("adoption verifies the original event and version and persists without writing to Google", async (t) => {
  const h = await setup(t, { writes: false });
  const keyBefore = await readFile(join(h.dataDir, "key"));
  const result = await h.adopt();
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].calendarLink.eventId, "original-a");
  assert.equal(result.results[0].calendarLink.managed, true);
  assert.deepEqual(await readFile(join(h.dataDir, "key")), keyBefore);
  assert.equal((await h.request("adopt", { ...payload(), mode: "demo" })).status, 400);
  assert.equal((await h.request("adopt", payload(), { "X-Shunri-CSRF": "wrong" })).status, 403);
  assert.equal(h.calls.some((x) => x.path.includes("/events") && x.method !== "GET"), false);
  h.restart();
  await h.request("status");
  const e = (await h.request(readRange)).data.events[0];
  assert.equal(e.managed, true);
  assert.equal(e.managedUid, "uid-a");
  assert.equal(e.managedProfileId, "profile-a");
});

test("unadopted, other-organizer, fixed and stale imported events cannot be written", async (t) => {
  const h = await setup(t);
  let result = (await h.request("preview", payload())).data;
  assert.equal(result.items[0].action, "error");
  assert.match(result.items[0].reason, /has not been entrusted/);
  h.events.set("mine:original-a", event("original-a", { organizer: { self: false } }));
  assert.equal((await h.adopt()).results[0].ok, false);
  h.events.set("mine:original-a", event("original-a"));
  assert.equal(
    (await h.adopt([task("original-a", { calendarLink: { ...task().calendarLink, etag: '"stale"' } })])).results[0].ok,
    false,
  );
  await h.adopt();
  result = (
    await h.request("preview", payload([task("original-a", { locked: true, type: "activity", date: "2026-10-13" })]))
  ).data;
  assert.equal(result.items[0].action, "error");
  assert.equal(h.calls.some((x) => x.path.includes("/events") && x.method !== "GET"), false);
});

test("moving an imported event to another day updates the original event once and a retry is skipped", async (t) => {
  const h = await setup(t);
  const adopted = await h.adopt();
  const moved = task("original-a", { date: "2026-10-13", calendarLink: adopted.results[0].calendarLink });
  let preview = (await h.request("preview", payload([moved]))).data;
  assert.equal(preview.items[0].action, "update");
  const result = (await h.request("execute", { planId: preview.planId })).data;
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].calendarLink.eventId, "original-a");
  assert.equal(h.events.size, 1);
  assert.equal(h.events.get("mine:original-a").start.dateTime, "2026-10-13T18:00:00.000Z");
  h.restart();
  await h.request("status");
  preview = (await h.request("preview", payload([moved]))).data;
  assert.equal(preview.items[0].action, "skip");
  assert.equal((await h.request("execute", { planId: preview.planId })).data.results[0].ok, true);
  assert.equal(h.calls.filter((x) => x.method === "PUT").length, 1);
  assert.equal(h.calls.filter((x) => x.method === "POST" && x.path.includes("/events")) .length, 0);
});

// ---- Time zones ----

test("events without a time zone use each calendar's own zone when previewed and executed", async (t) => {
  const h = await setup(t);
  h.config.calendarTimeZones.mine = "Europe/London";
  h.config.calendarTimeZones.mine2 = "Asia/Tokyo";
  // Both are single-day events in their calendars. Their 07:30Z–08:30Z
  // interval straddles Los Angeles midnight and must not use that fallback.
  for (const [calendarId, eventId] of [["mine", "london"], ["mine2", "tokyo"]])
    h.events.set(`${calendarId}:${eventId}`, event(eventId, {
      start: { dateTime: "2026-11-12T07:30:00Z" },
      end: { dateTime: "2026-11-12T08:30:00Z" },
    }));
  const entries = [
    // The UI may use a different zone; it is not the calendar's eligibility zone.
    task("london", { date: "2026-11-11", start: 1410, timeZone: "America/Los_Angeles" }),
    task("tokyo", { id: "task-b", uid: "uid-b", date: "2026-11-12", start: 990, timeZone: "Asia/Tokyo",
      calendarLink: { ...task().calendarLink, calendarId: "mine2", eventId: "tokyo" } }),
  ];
  assert.deepEqual((await h.adopt(entries)).results.map((r) => r.ok), [true, true]);
  const unchanged = (await h.request("preview", payload(entries))).data;
  assert.deepEqual(unchanged.items.map((item) => item.action), ["skip", "skip"]);
  assert.deepEqual((await h.request("execute", { planId: unchanged.planId })).data.results.map((item) => item.ok), [true, true]);
  const moved = [{ ...entries[0], date: "2026-11-12", start: 60 }, { ...entries[1], start: entries[1].start + 90 }];
  const preview = (await h.request("preview", payload(moved))).data;
  assert.deepEqual(preview.items.map((item) => item.action), ["update", "update"]);
  assert.equal(preview.canExecute, true);
  const result = (await h.request("execute", { planId: preview.planId })).data;
  assert.deepEqual(result.results.map((item) => item.ok), [true, true]);
  for (const key of ["mine:london", "mine2:tokyo"])
    assert.equal(h.events.get(key).start.dateTime, "2026-11-12T09:00:00.000Z");
  assert.equal(h.calls.filter((call) => call.method === "PUT").length, 2);
  assert.equal(h.calls.some((call) => call.method === "POST" && call.path.includes("/events")), false);
});

test("the calendar zone fallback does not bypass a stale ETag or an explicit event zone", async (t) => {
  const h = await setup(t);
  h.config.calendarTimeZones.mine = "Europe/London";
  const londonEvent = event("london", {
    start: { dateTime: "2026-11-12T07:30:00Z" },
    end: { dateTime: "2026-11-12T08:30:00Z" },
  });
  const londonTask = task("london", { date: "2026-11-12", start: 450, timeZone: "Europe/London" });
  h.events.set("mine:london", londonEvent);
  assert.equal((await h.adopt([londonTask])).results[0].ok, true);
  const preview = (await h.request("preview", payload([{ ...londonTask, start: 540 }]))).data;
  assert.equal(preview.items[0].action, "update");
  h.events.set("mine:london", { ...londonEvent, etag: '"external-v2"', summary: "Edited remotely" });
  const stale = (await h.request("execute", { planId: preview.planId })).data.results[0];
  assert.equal(stale.ok, false);
  assert.match(stale.message, /Google event changed/);
  assert.equal(h.events.get("mine:london").summary, "Edited remotely");
  h.events.set("mine:london", { ...londonEvent,
    start: { ...londonEvent.start, timeZone: "America/Los_Angeles" },
    end: { ...londonEvent.end, timeZone: "America/Los_Angeles" },
  });
  assert.equal((await h.adopt([londonTask])).results[0].ok, false);
  assert.equal(h.calls.some((call) => call.method === "PUT"), false);
});

test("a missing or invalid calendar zone does not allow adopting a cross-midnight event", async (t) => {
  const h = await setup(t);
  const source = event("london", {
    start: { dateTime: "2026-11-12T07:30:00Z" },
    end: { dateTime: "2026-11-12T08:30:00Z" },
  });
  h.events.set("mine:london", source);
  const entry = task("london", { date: "2026-11-12", start: 450, timeZone: "Europe/London" });
  for (const zone of [undefined, "Invalid/Synthetic_Zone"]){
    h.config.calendarTimeZones.mine = zone;
    assert.equal((await h.adopt([entry])).results[0].ok, false);
  }
  // A supplied event zone remains authoritative over calendar metadata.
  h.events.set("mine:london", { ...source,
    start: { ...source.start, timeZone: "Europe/London" },
    end: { ...source.end, timeZone: "Europe/London" },
  });
  assert.equal((await h.adopt([entry])).results[0].ok, true);
  const preview = (await h.request("preview", payload([{ ...entry, start: 540 }]))).data;
  assert.equal(preview.items[0].action, "update");
  assert.equal((await h.request("execute", { planId: preview.planId })).data.results[0].ok, true);
});

test("the events metadata supplies a calendar zone missing from the calendar list through read, adopt and execute", async (t) => {
  const h = await setup(t);
  h.config.calendarTimeZones.mine = undefined;
  h.config.eventTimeZones.mine = "Europe/London";
  h.config.echoRequestedTimeZone = true;
  h.events.clear();
  h.events.set("mine:london", event("london", {
    start: { dateTime: "2026-11-12T07:30:00Z" },
    end: { dateTime: "2026-11-12T08:30:00Z" },
  }));
  const read = (await h.request("events?calendarId=mine&from=2026-11-11&to=2026-11-12&timeZone=America%2FLos_Angeles")).data;
  assert.equal(read.complete, true);
  assert.equal(read.events[0].calendarTimeZone, "Europe/London");
  assert.equal(read.events[0].canManage, true);
  const entry = task("london", { date: "2026-11-11", start: 1410, timeZone: "America/Los_Angeles" });
  assert.equal((await h.adopt([entry])).results[0].ok, true);
  const preview = (await h.request("preview", payload([{ ...entry, date: "2026-11-12", start: 60 }]))).data;
  assert.equal(preview.items[0].action, "update");
  assert.equal((await h.request("execute", { planId: preview.planId })).data.results[0].ok, true);
  assert.equal(h.events.get("mine:london").start.dateTime, "2026-11-12T09:00:00.000Z");
  const metadata = h.calls.filter((call) => call.query.fields === "timeZone");
  assert.ok(metadata.length >= 3);
  assert.ok(metadata.every((call) => !call.query.timeZone));
  assert.ok(h.calls.filter((call) => call.path.endsWith("/events") && call.method === "GET").every((call) => !call.query.timeZone));
});

test("a changed or unavailable calendar zone invalidates a fallback-zone execution without trusting the client zone", async (t) => {
  const h = await setup(t);
  h.config.calendarTimeZones.mine = undefined;
  h.config.eventTimeZones.mine = "Europe/London";
  const source = event("london", {
    start: { dateTime: "2026-11-12T07:30:00Z" }, end: { dateTime: "2026-11-12T08:30:00Z" },
  });
  h.events.set("mine:london", source);
  const entry = task("london", { date: "2026-11-12", start: 450, timeZone: "Europe/London", calendarTimeZone: "Europe/London" });
  assert.equal((await h.adopt([entry])).results[0].ok, true);
  const preview = (await h.request("preview", payload([{ ...entry, start: 540 }]))).data;
  h.config.eventTimeZones.mine = "Asia/Tokyo";
  const changed = (await h.request("execute", { planId: preview.planId })).data.results[0];
  assert.equal(changed.ok, false);
  assert.match(changed.message, /time zone changed/);
  h.config.eventTimeZones.mine = undefined;
  const missing = (await h.request("preview", payload([{ ...entry, start: 540 }]))).data.items[0];
  assert.equal(missing.action, "error");
  assert.match(missing.reason, /time zone/);
  assert.equal(h.calls.some((call) => call.method === "PUT"), false);
  assert.deepEqual(h.events.get("mine:london"), source);
});

test("event times with an IANA zone and no offset match the browser instants, and an unchanged preview is skipped", async (t) => {
  const h = await setup(t);
  h.events.clear();
  h.events.set("mine:new-york", event("new-york", {
    start: { dateTime: "2026-10-12T11:00:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-10-12T12:00:00", timeZone: "America/New_York" },
  }));
  const read = (await h.request(readRange)).data;
  assert.equal(read.complete, true);
  const merged = mergeCalendar({ days: {}, settings: { timeZone: "America/Los_Angeles" } }, read);
  const imported = Object.values(merged.data.days).flat()[0];
  assert.equal(imported.start, 480);
  const entry = task("new-york", { start: 480 });
  assert.equal((await h.adopt([entry])).results[0].ok, true);
  let preview = (await h.request("preview", payload([entry]))).data;
  assert.equal(preview.items[0].action, "skip");
  assert.equal((await h.request("execute", { planId: preview.planId })).data.results[0].ok, true);
  assert.equal(h.calls.some((call) => call.method === "PUT"), false);
  preview = (await h.request("preview", payload([{ ...entry, start: 540 }]))).data;
  assert.equal((await h.request("execute", { planId: preview.planId })).data.results[0].ok, true);
  assert.equal(h.events.get("mine:new-york").start.dateTime, "2026-10-12T16:00:00.000Z");
});

test("event times inside a daylight-saving gap or repeat cannot be adopted", async (t) => {
  const h = await setup(t);
  for (const [date, start] of [["2026-03-08", "02:30:00"], ["2026-11-01", "01:30:00"]]) {
    h.events.set("mine:dst", event("dst", {
      start: { dateTime: `${date}T${start}`, timeZone: "America/New_York" },
      end: { dateTime: `${date}T03:30:00`, timeZone: "America/New_York" },
    }));
    const result = (await h.adopt([task("dst", { date, start: 0 })])).results[0];
    assert.equal(result.ok, false);
  }
  assert.equal(h.calls.some((call) => call.method === "PUT"), false);
});

test("an event that crosses midnight in the calendar zone stays read-only even when the display zone hides the midnight", async (t) => {
  const h = await setup(t);
  h.config.calendarTimeZones.mine = undefined;
  h.config.eventTimeZones.mine = "Europe/London";
  h.config.echoRequestedTimeZone = true;
  h.events.clear();
  h.events.set("mine:overnight", event("overnight", {
    start: { dateTime: "2026-10-12T23:30:00+01:00" },
    end: { dateTime: "2026-10-13T00:30:00+01:00" },
  }));
  const read = (await h.request(readRange)).data;
  assert.equal(read.complete, true);
  assert.equal(read.events[0].calendarTimeZone, "Europe/London");
  assert.equal(read.events[0].canManage, false);
  assert.equal((await h.adopt([task("overnight", { start: 930 })])).results[0].ok, false);
  assert.equal(h.calls.some((call) => call.method === "PUT"), false);
});

test("an edit of only the end zone stays a remote conflict, with no fallback to the older signature", async (t) => {
  const h = await setup(t);
  const source = event("mixed", { end: { dateTime: "2026-10-12T12:00:00", timeZone: "America/Los_Angeles" } });
  const rawSignature = (item) => createHash("sha256").update(JSON.stringify([
    item.summary || "", item.start?.dateTime || item.start?.date || null,
    item.end?.dateTime || item.end?.date || null, item.start?.timeZone || null,
    item.status || "confirmed",
  ])).digest("hex");
  // Offset-bearing history keeps its existing identity; offsetless history
  // requires a fresh baseline because the old hash omitted end.timeZone.
  assert.equal(googleEventSignature(event("explicit")), rawSignature(event("explicit")));
  assert.notEqual(googleEventSignature(source), rawSignature(source));
  h.events.set("mine:mixed", source);
  assert.equal((await h.adopt([task("mixed")])).results[0].ok, true);
  const remote = { ...source, etag: '"remote-end-zone"', end: { ...source.end, timeZone: "Pacific/Honolulu" } };
  assert.equal(rawSignature(remote), rawSignature(source));
  assert.notEqual(googleEventSignature(remote), googleEventSignature(source));
  h.events.set("mine:mixed", remote);
  const preview = (await h.request("preview", payload([task("mixed", { start: 720 })]))).data;
  assert.equal(preview.canExecute, false);
  assert.equal(preview.items[0].action, "error");
  assert.match(preview.items[0].reason, /Google has newer changes/);
  assert.equal(h.calls.some((call) => call.method === "PUT"), false);
  assert.deepEqual(h.events.get("mine:mixed"), remote);
});

test("malformed and ambiguous events do not hide later ordinary or catalog events", async (t) => {
  const h = await setup(t, { writes: false });
  h.events.clear();
  for (const [id, date, start] of [
    ["fold", "2026-11-01", "01:30:00"],
    ["gap", "2026-03-08", "02:30:00"],
    ["malformed", "2026-11-01", "25:30:00"],
  ]) {
    h.events.set(`mine:${id}`, event(id, {
      summary: "SQL ROW_NUMBER lesson",
      start: { dateTime: `${date}T${start}`, timeZone: "America/New_York" },
      end: { dateTime: `${date}T03:30:00`, timeZone: "America/New_York" },
    }));
  }
  h.events.set("mine:good-after", event("good-after", { summary: "SQL ROW_NUMBER lesson" }));
  for (const route of [readRange, catalogRange]) {
    const result = (await h.request(route)).data;
    assert.equal(result.complete, true);
    assert.equal(result.partial, false);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.events.map((item) => item.eventId), ["fold", "gap", "malformed", "good-after"]);
    assert.deepEqual(result.events.map((item) => item.canManage), [false, false, false, true]);
    assert.ok(result.events.every((item) => /^[a-f0-9]{64}$/.test(item.remoteSignature)));
    const merged = mergeCalendar({ days: {}, settings: { timeZone: "America/Los_Angeles" } }, result);
    assert.equal(merged.errors.length, 3);
    assert.equal(merged.imported, 1);
    assert.equal(Object.values(merged.data.days).flat()[0].calendarLink.eventId, "good-after");
  }
  assert.equal(h.calls.some((call) => call.method === "PUT"), false);
});

// ---- Conflicts, partial failures and retries ----

test("changes on both sides produce a conflict, and adopting the clean remote version rebases explicitly", async (t) => {
  const h = await setup(t);
  await h.adopt();
  h.events.set(
    "mine:original-a",
    event("original-a", {
      etag: '"remote-v2"',
      start: { dateTime: "2026-10-12T12:00:00-07:00" },
      end: { dateTime: "2026-10-12T13:00:00-07:00" },
    }),
  );
  let p = (await h.request("preview", payload([task("original-a", { date: "2026-10-13" })]))).data;
  assert.match(p.items[0].reason, /Google has newer changes/);
  assert.equal(p.canExecute, false);
  const remoteAccepted = task("original-a", {
    start: 720,
    calendarLink: { ...task().calendarLink, etag: '"remote-v2"' },
  });
  assert.equal((await h.adopt([remoteAccepted])).results[0].ok, true);
  p = (await h.request("preview", payload([{ ...remoteAccepted, date: "2026-10-13" }]))).data;
  assert.equal(p.items[0].action, "update");
});

test("a partly failed update across calendars resumes with no duplicate original IDs", async (t) => {
  const h = await setup(t);
  h.events.set("mine2:original-b", event("original-b"));
  const b = task("original-b", {
    id: "task-b",
    uid: "uid-b",
    calendarLink: { ...task().calendarLink, calendarId: "mine2", eventId: "original-b" },
  });
  assert.ok((await h.adopt([task(), b])).results.every((x) => x.ok));
  const moved = [task(), b].map((x) => ({ ...x, date: "2026-10-13" }));
  h.config.failPuts.add("mine2:original-b");
  let p = (await h.request("preview", payload(moved))).data;
  let result = (await h.request("execute", { planId: p.planId })).data;
  assert.equal(result.partial, true);
  assert.deepEqual(result.results.map((x) => x.ok), [true, false]);
  h.config.failPuts.clear();
  h.restart();
  await h.request("status");
  p = (await h.request("preview", payload(moved))).data;
  assert.deepEqual(p.items.map((x) => x.action), ["skip", "update"]);
  result = (await h.request("execute", { planId: p.planId })).data;
  assert.ok(result.results.every((x) => x.ok));
  assert.equal(h.events.size, 2);
  assert.equal(h.calls.filter((x) => x.method === "POST" && x.path.includes("/events")) .length, 0);
});

test("a lost response to a successful update recovers without duplicating the event", async (t) => {
  const h = await setup(t);
  await h.adopt();
  h.config.lostResponses.add("mine:original-a");
  const moved = task("original-a", { date: "2026-10-13" });
  let p = (await h.request("preview", payload([moved]))).data;
  assert.equal((await h.request("execute", { planId: p.planId })).data.results[0].ok, false);
  p = (await h.request("preview", payload([moved]))).data;
  assert.equal(p.items[0].action, "skip");
  assert.equal((await h.request("execute", { planId: p.planId })).data.results[0].ok, true);
  assert.equal(h.events.size, 1);
  assert.equal(h.calls.filter((x) => x.method === "PUT").length, 1);
});

test("a Google edit after the preview blocks execution, whether only the ETag changed or the metadata too", async (t) => {
  const cases = [
    { name: "ETag only", moved: { date: "2026-10-13" }, before: {}, after: { etag: '"changed-after-preview"' } },
    { name: "metadata", moved: { start: 720 },
      before: { etag: '"metadata-v2"', description: "Description version one" },
      after: { etag: '"metadata-v3"', description: "Description version two" } },
  ];
  for (const { name, moved, before, after } of cases) {
    const h = await setup(t);
    await h.adopt();
    h.events.set("mine:original-a", { ...h.events.get("mine:original-a"), ...before });
    const preview = (await h.request("preview", payload([task("original-a", moved)]))).data;
    assert.equal(preview.items[0].action, "update", name);
    h.events.set("mine:original-a", { ...h.events.get("mine:original-a"), ...after });
    const result = (await h.request("execute", { planId: preview.planId })).data;
    assert.equal(result.results[0].ok, false, name);
    assert.match(result.results[0].message, /Google event changed/);
    assert.equal(h.calls.filter((x) => x.method === "PUT").length, 0, name);
  }
});
// ---- Ownership markers ----

test("reconnecting withdraws management of an app-created event without duplicating its pending local task", async t => {
  const h = await setup(t);
  h.events.clear();
  const original = task("unused", { title: "Ordinary plan", calendarLink: null, locked: false, externalReadOnly: false });
  const preview = (await h.request("preview", payload([original]))).data;
  const created = (await h.request("execute", { planId: preview.planId })).data.results[0];
  assert.equal(created.ok, true);
  assert.equal(created.calendarLink.source, "app");
  h.events.get(`mine:${created.calendarLink.eventId}`).organizer = { self: true };
  const verified = (await h.request(readRange)).data;
  assert.equal(verified.events[0].managed, true, "a current mapping still authorizes readback");
  const fingerprint = localCalendarSignature(original, original.date, original.timeZone);
  const pending = { ...original, start: 720, calendarLink: { ...created.calendarLink,
    adoptedEtag: created.calendarLink.etag, localFingerprint: fingerprint } };
  const input = { days: { [original.date]: [pending] }, settings: { timeZone: original.timeZone } };
  const auth = new URL((await h.request("connect")).location);
  assert.equal((await h.request(`callback?state=${encodeURIComponent(auth.searchParams.get("state"))}&code=SIMULATED-RECONNECT`)).status, 302);
  const read = (await h.request(readRange)).data;
  const merged = mergeCalendar(input, read, { profileId: "profile-a" });
  const tasks = Object.values(merged.data.days).flat(), kept = tasks.find(item => item.uid === original.uid);
  const denied = (await h.request("preview", payload([{ ...kept, date: original.date }]))).data;
  assert.equal(read.events[0].managed, false);
  assert.equal(tasks.length, 1);
  assert.equal(merged.imported, 0);
  assert.equal(kept.id, original.id);
  assert.equal(kept.calendarLink.source, "google");
  assert.equal(kept.calendarLink.eventId, created.calendarLink.eventId);
  assert.equal(kept.calendarLink.managed, false);
  assert.equal(kept.calendarLink.adoptedEtag, undefined);
  assert.equal(kept.calendarLink.localFingerprint, fingerprint);
  assert.equal(kept.externalReadOnly, true);
  assert.equal(kept.start, 720);
  assert.equal(kept.locked, true);
  assert.equal(denied.items[0].action, "error");
  assert.match(denied.items[0].reason, /has not been entrusted/);
  assert.equal(pending.calendarLink.source, "app", "input is not mutated");
  assert.equal(h.calls.filter(c => c.method === "POST" && c.path.endsWith("/events")).length, 1);
  assert.equal(h.calls.filter(c => c.method === "PUT").length, 0);
});

test("a marker UID cannot match a task linked to another calendar or event, or an unlinked task", () => {
  const original = task("original-a", { title: "Ordinary plan", locked: false, externalReadOnly: false });
  original.calendarLink = { ...original.calendarLink, source: "app",
    localFingerprint: localCalendarSignature(original, original.date, original.timeZone), adoptedEtag: '"v1"' };
  const responseEvent = { ...event("original-a", { summary: original.title }), eventId: "original-a",
    calendarId: "mine", accessRole: "owner", calendarTimeZone: original.timeZone, canManage: true,
    managed: false, managedUid: original.uid, managedProfileId: "profile-a" };
  for (const link of [
    { ...original.calendarLink, calendarId: "mine2" },
    { ...original.calendarLink, eventId: "different-event" },
    null,
  ]) {
    const other = { ...original, calendarLink: link };
    const merged = mergeCalendar({ days: { [original.date]: [other] },
      settings: { timeZone: original.timeZone } }, { events: [responseEvent] }, { profileId: "profile-a" });
    const tasks = Object.values(merged.data.days).flat();
    assert.equal(tasks.length, 2, "the different identity is imported separately");
    const unchanged = tasks.find(item => item.id === original.id);
    assert.deepEqual(unchanged.calendarLink, link);
    assert.equal(unchanged.externalReadOnly, false);
    const imported = tasks.find(item => item.id !== original.id);
    assert.notEqual(imported.uid, original.uid, "unverified marker UID cannot assign local identity");
    assert.equal(imported.calendarLink.managed, false);
    assert.equal(imported.externalReadOnly, true);
  }
});

test("an event with only an ownership marker stays unverified until it is adopted explicitly", async t => {
  const h = await setup(t, { writes: false });
  const remote = h.events.get("mine:original-a");
  remote.extendedProperties = { private: { shunriOwner: "profile-a", shunriTask: "uid-a" } };
  const first = (await h.request(readRange)).data;
  const before = first.events.find(item => item.eventId === "original-a");
  assert.equal(before.managed, false);
  assert.equal(before.managedUid, "uid-a", "marker remains metadata, not authorization");
  const local = task("original-a", { calendarLink: { ...task().calendarLink, source: "app" },
    calendarClassification: { kind: "task", manage: true }, locked: false });
  const original = { days: { [local.date]: [local] }, settings: { timeZone: local.timeZone } };
  const withdrawn = mergeCalendar(original, first, { profileId: "profile-a" });
  const entry = Object.values(withdrawn.data.days).flat().find(item => item.uid === local.uid);
  assert.equal(entry.calendarLink.managed, false);
  assert.equal(entry.externalReadOnly, true);
  assert.equal((await h.adopt([{ ...entry, date: local.date }])).results[0].ok, true);
  const reverified = (await h.request(readRange)).data;
  assert.equal(reverified.events.find(item => item.eventId === "original-a").managed, true);
  const restored = Object.values(mergeCalendar(withdrawn.data, reverified, { profileId: "profile-a" }).data.days).flat();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].uid, local.uid);
  assert.equal(restored[0].calendarLink.managed, true);
  assert.equal(restored[0].externalReadOnly, false);
  assert.equal(h.calls.some(c => c.path.includes("/events") && c.method !== "GET"), false);
});

// ---- Metadata edits and write allowlist ----

test("metadata-only edits in Google still allow a local move, keeping the metadata and using the fresh ETag", async (t) => {
  const h = await setup(t);
  await h.adopt();
  h.events.set("mine:original-a", {
    ...h.events.get("mine:original-a"),
    etag: '"metadata-v2"',
    description: "The note added on the Google side must be kept",
    location: "Original event location",
  });
  const moved = task("original-a", { start: 720 });
  const preview = (await h.request("preview", payload([moved]))).data;
  assert.equal(preview.items[0].action, "update");
  assert.equal(preview.canExecute, true);
  const result = (await h.request("execute", { planId: preview.planId })).data;
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].calendarLink.eventId, "original-a");
  assert.equal(h.events.get("mine:original-a").description, "The note added on the Google side must be kept");
  assert.equal(h.events.get("mine:original-a").location, "Original event location");
  assert.equal(h.events.get("mine:original-a").start.dateTime, "2026-10-12T19:00:00.000Z");
  assert.equal(h.events.size, 1);
});

test("an explicit UID allowlist permits only the authorized task and does not widen when the original Set is changed", async (t) => {
  const allowed = new Set(["uid-a"]),
    h = await setup(t, { allowedWriteUids: allowed });
  const authorized = task("unused", { calendarLink: null });
  const other = task("unused-b", { id: "task-b", uid: "uid-b", calendarLink: null });
  allowed.add("uid-b"); // The service snapshots the permission boundary at construction.
  assert.equal((await h.request("preview", payload([other]))).status, 403);
  assert.equal((await h.request("preview", payload([authorized, other]))).status, 403);
  assert.equal(h.calls.filter((x) => ["POST", "PUT"].includes(x.method) && x.path.includes("/events")).length, 0);
  const preview = (await h.request("preview", payload([authorized]))).data;
  assert.equal(preview.canExecute, true);
  assert.equal((await h.request("execute", { planId: preview.planId })).data.results[0].ok, true);
  const writes = h.calls.filter((x) => ["POST", "PUT"].includes(x.method) && x.path.includes("/events"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "POST");
  assert.equal(h.events.size, 2); // One original fixture and exactly one authorized new event.
});

test("a UID allowlist never bypasses the write gate and an empty allowlist denies every task", async (t) => {
  const h = await setup(t, { writes: false, allowedWriteUids: ["uid-a"] });
  const preview = (await h.request("preview", payload([task("unused", { calendarLink: null })]))).data;
  assert.equal(preview.canExecute, false);
  assert.equal((await h.request("execute", { planId: preview.planId })).status, 403);
  assert.equal(h.calls.filter((x) => ["POST", "PUT"].includes(x.method) && x.path.includes("/events")).length, 0);
  const empty = await setup(t, { allowedWriteUids: [] });
  assert.equal((await empty.request("preview", payload([task("unused", { calendarLink: null })]))).status, 403);
  assert.equal(empty.calls.filter((x) => ["POST", "PUT"].includes(x.method) && x.path.includes("/events")).length, 0);
});

// ---- Events created by the app and read back from Google ----

// Creates the event through the app, then returns the task as the app sees it after reading the
// event back from Google and moving it locally.
async function createThenReadBack(h) {
  const original = task("unused", { calendarLink: null });
  const p = (await h.request("preview", payload([original]))).data;
  const created = (await h.request("execute", { planId: p.planId })).data.results[0];
  const fromGoogle = { ...original, start: 720, calendarLink: { ...created.calendarLink, source: "google" } };
  return { original, created, fromGoogle };
}

test("an app-created event read back as a Google event can be moved and restored under the same owned ID", async (t) => {
  const h = await setup(t);
  const original = task("unused", { calendarLink: null });
  const createdPreview = (await h.request("preview", payload([original]))).data;
  const creation = (await h.request("execute", { planId: createdPreview.planId })).data.results[0];
  assert.equal(creation.ok, true);
  const eventId = creation.calendarLink.eventId;
  const created = h.events.get(`mine:${eventId}`);
  created.organizer = { self: true }; // Google supplies this field on created events.
  const read = (await h.request(readRange)).data.events.find((e) => e.eventId === eventId);
  assert.equal(read.managedUid, "uid-a");
  assert.equal(read.managedProfileId, "profile-a");
  // No adoption call: creation already established this exact profile/UID/ID relationship.
  const fromGoogle = {
    ...original,
    start: 720,
    calendarLink: { ...creation.calendarLink, source: "google", etag: read.etag },
  };
  const moving = (await h.request("preview", payload([fromGoogle]))).data;
  assert.equal(moving.items[0].action, "update");
  const movement = (await h.request("execute", { planId: moving.planId })).data
    .results[0];
  assert.equal(movement.ok, true);
  assert.equal(movement.calendarLink.eventId, eventId);
  const restoration = (
    await h.request("preview", payload([{ ...fromGoogle, start: 660, calendarLink: movement.calendarLink }]))
  ).data;
  assert.equal(restoration.items[0].action, "update");
  assert.equal((await h.request("execute", { planId: restoration.planId })).data.results[0] .ok, true);
  assert.equal(h.events.get(`mine:${eventId}`).start.dateTime, "2026-10-12T18:00:00.000Z");
  assert.equal(h.events.size, 2);
  assert.equal(h.calls.filter((x) => x.method === "POST" && x.path.includes("/events")) .length, 1);
  assert.equal(h.calls.filter((x) => x.method === "PUT").length, 2);
});

test("a Google event cannot claim an unknown ID or another profile's app-created marker", async (t) => {
  const h = await setup(t);
  const { created, fromGoogle } = await createThenReadBack(h);
  const unknown = { ...fromGoogle, calendarLink: { ...fromGoogle.calendarLink, eventId: "unknown-original-id" } };
  assert.equal((await h.request("preview", payload([unknown]))).data.items[0].action, "error");
  const event = h.events.get(`mine:${created.calendarLink.eventId}`);
  event.extendedProperties.private.shunriOwner = "other-profile";
  const preview = (await h.request("preview", payload([fromGoogle]))).data;
  assert.equal(preview.items[0].action, "error");
  assert.match(preview.items[0].reason, /another app profile/);
  event.extendedProperties.private.shunriOwner = "profile-a";
  event.organizer = { self: false };
  const foreignOrganizer = (await h.request("preview", payload([fromGoogle])))
    .data;
  assert.equal(foreignOrganizer.items[0].action, "error");
  assert.match(foreignOrganizer.items[0].reason, /Someone else organizes/);
  assert.equal(h.calls.filter((x) => x.method === "PUT").length, 0);
});

test("app-created events read back from Google keep their fixed and time-lock write protection", async (t) => {
  const h = await setup(t);
  const { fromGoogle } = await createThenReadBack(h);
  for (const flags of [
    { locked: true },
    { timeLocked: true },
    { type: "activity" },
    { externalReadOnly: true },
  ]) {
    const preview = (await h.request("preview", payload([{ ...fromGoogle, ...flags }]))).data;
    assert.equal(preview.items[0].action, "error");
    assert.match(preview.items[0].reason, /Fixed|locked/);
  }
  assert.equal(h.calls.filter((x) => x.method === "PUT").length, 0);
});

test("an ownership marker changed after the preview prevents execution", async (t) => {
  const h = await setup(t);
  const { created, fromGoogle } = await createThenReadBack(h);
  const move = (await h.request("preview", payload([fromGoogle]))).data;
  assert.equal(move.items[0].action, "update");
  h.events.get(`mine:${created.calendarLink.eventId}`).extendedProperties.private.shunriTask = "other-task";
  const execute = (await h.request("execute", { planId: move.planId })).data
    .results[0];
  assert.equal(execute.ok, false);
  assert.match(execute.message, /ownership changed/);
  assert.equal(h.calls.filter((x) => x.method === "PUT").length, 0);
});
