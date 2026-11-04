import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { scheduleContext } from "../schedule-context.js";
import { wallInstant } from "../time.js";
import { uiRig } from "./helpers.mjs";

const date = "2026-10-12";
const settings = { timeZone: "America/Los_Angeles", dayStart: 540, dayEnd: 1380, learningCapacity: 150, learningMinGap: 20 };

describe("day context", () => {
  const task = (id, start, duration, extra = {}) => ({
    id, uid: id, title: id, start, duration, rest: 15, type: "task", learning: true, tags: ["study"],
    planId: "job-prepare", packageId: "day", packageOriginDate: date, ...extra,
  });
  const context = (days, extra = {}) => ({ mode: "demo", branch: { days, settings, calendar: { readRanges: [] } }, ...extra });
  const model = (c, d = date) => scheduleContext(c, d, { date, minute: 690 });

  test("study counts use the completed actual date and cross-plan focus, and exclude rest and deferred work", () => {
    const m = model(context({
      "2026-10-11": [task("done", 660, 30, { done: true, completedDate: date })],
      [date]: [task("today", 660, 45, { planId: "other" }), task("later", 800, 60, { deferred: true })],
    }));
    assert.equal(m.day.learning, 75);
    assert.equal(m.day.completed, 30);
    assert.equal(m.day.capacity, 150);
    assert.equal(m.day.items.length, 1);
    assert.equal(m.week.length, 7);
    assert.equal(m.week[0].date, date);
    assert.equal(m.week[0].label, "75 minutes of study");
  });

  test("medical protection and learning rest are shared with the planner, with no doubled busy ranges", () => {
    const c = context({ [date]: [
      task("medical", 1020, 60, { type: "activity", purpose: "medical", learning: false, tags: [], bufferBefore: 0, bufferAfter: 30 }),
      task("study", 660, 45),
    ] });
    const m = model(c);
    assert.equal(m.day.items[1].before, 60);
    assert.equal(m.day.items[1].after, 30);
    assert.equal(m.day.items[0].after, 20);
    assert.equal(m.day.busyRatio, (150 + 65) / 840);
    const overlap = model(context({ [date]: [task("a", 660, 60), task("b", 680, 60)] }));
    assert.equal(overlap.day.busyRatio, 100 / 840);
    assert.ok(overlap.day.conflicts.length);
  });

  test("empty, closed and incomplete days stay distinct, and the now line shows only today", () => {
    const c = context({});
    c.branch.settings = { ...settings, learningDates: { "2026-10-14": { closed: true } } };
    assert.equal(model(c).day.label, "No plans");
    assert.equal(model(c, "2026-10-14").day.label, "Rest day");
    assert.equal(model(c, "2026-10-14").nowInstant, null);
    assert.equal(model(c).nowInstant, wallInstant(date, 690, settings.timeZone));
    c.mode = "personal"; c.calendarStatus = { state: "connected" };
    assert.equal(model(c).day.known, false);
    assert.equal(model(c).day.label, "Incomplete calendar coverage");
    c.branch.calendar.readRanges = [{ from: date, to: "2026-10-13", timeZone: settings.timeZone }];
    assert.equal(model(c).day.known, true);
    c.readError = "mock";
    assert.equal(model(c).day.known, false);
    delete c.readError;
    c.branch.calendar.readRanges.push({ from: date, to: date, partial: true });
    assert.equal(model(c).day.known, false);
  });

  test("a cross-day occupation is visible on both dates and keeps its full span outside 09:00-23:00", () => {
    const start = wallInstant(date, 1350, settings.timeZone), end = wallInstant("2026-10-13", 90, settings.timeZone);
    const c = context({ [date]: [task("overnight", 1350, 180, { type: "activity", tags: [], learning: false, bufferBefore: 0, bufferAfter: 0, calendarOccupation: { startInstant: start, endInstant: end } })] });
    const a = model(c), b = model(c, "2026-10-13");
    assert.equal(a.day.items.length, 1);
    assert.equal(b.day.items.length, 1);
    assert.equal(a.day.items[0].actualEnd, end);
    assert.equal(a.day.busyRatio, 30 / 840);
    assert.equal(b.day.busyRatio, 0);
  });

  test("transparent annotations stay listed without reserving time, and a week across years is explicit", () => {
    const c = context({ [date]: [task("note", 660, 60, { tags: [], learning: false, externalReadOnly: true, calendarLink: { source: "google" }, calendarSource: { transparency: "transparent" } })] });
    assert.equal(model(c).day.items.length, 1);
    assert.equal(model(c).day.busyRatio, 0);
    assert.deepEqual(model(context({}), "2027-01-01").week.map((d) => d.date),
      ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
  });

  test("a time inside the repeated DST hour cannot break the home screen, and an instant inside the axis is preserved", () => {
    const c = context({}, { mode: "personal" }), day = "2026-11-01";
    for (const instant of [Date.parse("2026-11-01T08:30:00Z"), Date.parse("2026-11-01T09:30:00Z")])
      assert.equal(scheduleContext(c, day, { date: day, minute: 90, instant }).nowInstant, null);
    assert.equal(scheduleContext(c, day, { date: day, minute: 90 }).nowInstant, null);
    const instant = Date.parse("2026-11-01T19:30:00Z");
    assert.equal(scheduleContext(c, day, { date: day, minute: 690, instant }).nowInstant, instant);
  });
});

describe("calendar coverage", () => {
  const unknown = "2026-10-20";
  const context = (calendar = {}, days = {}) => ({ mode: "personal", date: unknown, branch: { days, settings, calendar }, calendarStatus: { state: "network" } });
  const readRanges = [{ from: date, to: "2026-10-13", timeZone: settings.timeZone, partial: false }];
  const model = (c) => scheduleContext(c, c.date, { date, minute: 690 });

  test("a historical zero-event read stays unknown outside its coverage across connection failures", () => {
    for (const state of ["connected", "expired", "network", "disconnected"]) {
      const c = context({ readRanges });
      c.calendarStatus.state = state;
      const before = JSON.stringify(c), m = model(c);
      assert.equal(m.day.known, false, state);
      assert.equal(m.day.label, "Incomplete calendar coverage");
      assert.ok(m.week.every((d) => !d.known));
      assert.equal(JSON.stringify(c), before);
      c.date = date;
      assert.equal(model(c).day.known, true, state + " covered historical snapshot");
    }
  });

  test("other persisted Google provenance also requires a complete covering read", () => {
    for (const calendar of [{ lastRead: { range: { from: date, to: "2026-10-13" } } }, { calendars: [{ id: "mock" }] },
      { learningCatalogs: [{ from: date, to: "2026-10-13" }] }, { targetCalendarId: "mock" }])
      assert.equal(model(context(calendar)).day.known, false);
    const historical = context({}, { [date]: [{ id: "old", title: "Old Google plan", start: 660, duration: 30, rest: 0, calendarLink: { source: "google", remoteDeleted: true } }] });
    assert.equal(model(historical).day.known, false);
    const c = context({});
    c.calendarStatus.state = "expired";
    assert.equal(model(c).day.known, false);
  });

  test("an unknown day keeps its local tasks, and a complete read updates knowledge without altering tasks", () => {
    const days = { [unknown]: [{ id: "local", title: "Local memo", type: "task", start: 660, duration: 30, rest: 0 }] };
    const c = context({ readRanges }, days), before = JSON.stringify(days);
    assert.equal(model(c).day.items.length, 1);
    assert.equal(model(c).day.known, false);
    c.branch.calendar.readRanges.push({ from: unknown, to: "2026-10-21", timeZone: settings.timeZone, partial: true });
    assert.equal(model(c).day.known, false);
    c.branch.calendar.readRanges.at(-1).partial = false;
    assert.equal(model(c).day.known, true);
    assert.equal(JSON.stringify(days), before);
  });

  test("a purely local personal schedule and an independent demo stay usable with an explicit local scope", () => {
    const c = context({});
    c.calendarStatus.state = "disconnected";
    assert.equal(model(c).day.known, true);
    assert.equal(model(c).day.label, "No local plans");
    c.calendarStatus.state = "network";
    assert.equal(model(c).day.label, "No local plans");
    c.mode = "demo"; c.branch.exampleOrigin = date;
    assert.equal(model(c).day.label, "No plans");
  });

  test("the renderer gives every short dense block a direct reference while keeping real proportions", () => {
    const days = { [date]: Array.from({ length: 20 }, (_, i) => ({ id: "t" + i, title: "Dense activity " + (i + 1), start: 540 + i * 40, duration: 20, rest: 0, type: "activity", locked: true })) };
    const r = uiRig({ date, selected: null, branch: { days, settings, calendar: {}, exampleOrigin: date },
      extraApi: (c) => { c.mode = "demo"; c.calendarStatus = { state: "network" }; return { movable: (t) => !t.locked }; } });
    try {
      const html = r.html();
      assert.equal((html.match(/class="axis-reference/g) || []).length, 20);
      assert.equal((html.match(/data-axis-index="/g) || []).length, 20);
      assert.equal((html.match(/class="agenda-item/g) || []).length, 20);
    } finally { r.close(); }
  });
});
