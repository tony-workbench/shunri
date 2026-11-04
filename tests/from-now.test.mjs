// "Plan from now": the planner, the app's calendar re-read around it, and the
// explanation shown when nothing changes.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { moveIntent } from "../intent-planner.js";
import { defaults } from "../storage.js";
import { needsCalendarCoverage } from "../schedule-context.js";
import { learningTask } from "../learning.js";
import { addDays } from "../time.js";
import { planningNow, retainedRecommendation } from "../workbench.js";

describe("planner", () => {
  const date = "2026-10-12", tomorrow = "2026-10-13";
  const study = (id, day, extra = {}) => ({
    id, uid: id, title: id === "sql" ? "SQL practice" : id, start: 660, duration: 45, rest: 15, type: "task",
    done: false, locked: false, deferred: false, tags: ["study"], planId: "course", packageId: day,
    packageOriginDate: day, packageOrder: day === date ? 0 : 1, packageTaskOrder: 0, dependencies: [], ...extra,
  });
  const fixed = (start, duration = 60, extra = {}) => ({
    id: "fixed", title: "Appointment", start, duration, type: "activity", locked: true, bufferBefore: 60, bufferAfter: 20, ...extra,
  });
  const fixture = () => ({ [date]: [study("sql", date)], [tomorrow]: [study("python", tomorrow)] });
  const run = (days, minute = 690, rules = {}) => moveIntent(days, { ...defaults(), ...rules },
    { taskId: "sql", targetDate: date, targetStart: minute, startFromNow: true });
  const entry = (result, id) => Object.entries(result.days)
    .flatMap(([day, tasks]) => tasks.map((t) => ({ date: day, ...t }))).find((t) => t.id === id);

  test("moves the whole remaining package to now without marking anything completed", () => {
    const days = fixture(), copy = structuredClone(days), result = run(days);
    assert.equal(result.status, "ok");
    assert.equal(entry(result, "sql").start, 690);
    assert.equal(entry(result, "python").date, tomorrow);
    assert.equal(entry(result, "sql").done, false);
    assert.equal(entry(result, "sql").doneAt, undefined);
    assert.deepEqual(days, copy);
  });

  test("a fixed event's protection window pushes the task to the nearest full slot with a single result", () => {
    const days = fixture();
    days[date].push(fixed(720));
    const result = run(days);
    assert.equal(result.status, "ok");
    assert.equal(entry(result, "sql").start, 800);
    assert.equal(result.alternatives.length, 0);
    assert.match(result.recommendation.reason, /protection|Appointment/);
  });

  test("an ordinary task also finds the next protected slot", () => {
    const days = fixture();
    days[date][0] = { id: "sql", title: "Tidy desk", start: 660, duration: 30, type: "task", rest: 0 };
    days[date].push(fixed(720));
    const result = run(days);
    assert.equal(result.status, "ok");
    assert.equal(entry(result, "sql").start, 800);
  });

  test("150 completed minutes force the whole package to the next day", () => {
    const days = fixture();
    days[date].push(study("done", date, { planId: "other", packageId: "done", start: 540, duration: 150, done: true, completedDate: date }));
    const result = run(days);
    assert.equal(result.status, "ok");
    assert.equal(entry(result, "sql").date, tomorrow);
    assert.equal(entry(result, "sql").start, 660);
    assert.equal(entry(result, "python").date, "2026-10-14");
    assert.equal(entry(result, "done").date, date);
  });

  test("at 22:50 the task moves to tomorrow after the 11:00 fixed event's protection, never to 09:00", () => {
    const days = fixture();
    days[tomorrow].push(fixed(660, 10, { bufferBefore: 0, bufferAfter: 0 }));
    const result = run(days, 1370);
    assert.equal(result.status, "ok");
    assert.equal(entry(result, "sql").date, tomorrow);
    assert.equal(entry(result, "sql").start, 690);
  });

  test("closed days are skipped to the next allowed learning date", () => {
    const result = run(fixture(), 690, { learningDates: { [date]: { closed: true }, [tomorrow]: { closed: true } } });
    assert.equal(result.status, "ok");
    assert.equal(entry(result, "sql").date, "2026-10-14");
    assert.equal(entry(result, "sql").start, 660);
  });

  test("unfinished predecessors stay ordered before the task and never move into the past", () => {
    const days = fixture();
    days[date].unshift(study("prior", date, { start: 600, duration: 40, packageTaskOrder: 0 }));
    days[date][1].packageTaskOrder = 1;
    days[date][1].dependencies = [{ id: "prior", gap: 0 }];
    const result = run(days);
    assert.equal(result.status, "ok");
    assert.equal(entry(result, "prior").start, 690);
    assert.equal(entry(result, "sql").start, 750);
    assert.match(result.recommendation.reason, /prerequisite/);
  });

  test("an over-capacity package is not split and completed, locked, time-locked or deferred tasks do not move", () => {
    for (const extra of [{ done: true }, { locked: true }, { timeLocked: true }, { deferred: true }]) {
      const days = fixture();
      Object.assign(days[date][0], extra);
      const result = run(days);
      assert.notEqual(result.status, "ok");
      assert.equal(result.changes.length, 0);
    }
    const days = fixture();
    days[date][0].duration = 151;
    const result = run(days);
    assert.notEqual(result.status, "ok");
    assert.equal(result.changes.length, 0);
  });

  test("planning to the current slot makes no change, and explicit targets are honoured exactly", () => {
    const same = run(fixture(), 660);
    assert.equal(same.status, "ok");
    assert.equal(same.changes.length, 0);
    const days = fixture();
    days[date].push(fixed(720));
    const explicit = moveIntent(days, defaults(), { taskId: "sql", targetDate: date, targetStart: 690 });
    assert.equal(explicit.status, "conflict");
    assert.equal(explicit.changes.length, 0);
    const morning = moveIntent(fixture(), defaults(), { taskId: "sql", targetDate: date, targetStart: 540 });
    assert.equal(morning.status, "ok");
    assert.equal(entry(morning, "sql").start, 540);
  });

  test("before opening hours the task starts at 09:00 and a completed member of the same package stays put", () => {
    const days = fixture();
    days[date].push(study("done", date, { start: 480, duration: 20, done: true, completedDate: date, packageTaskOrder: -1 }));
    const result = run(days, 480);
    assert.equal(result.status, "ok");
    assert.equal(entry(result, "sql").start, 540);
    assert.equal(entry(result, "done").start, 480);
  });

  test("a task originally later in the day moves earlier, and an anchor already at now still carries its unfinished predecessor forward", () => {
    const days = fixture();
    days[date][0].start = 900;
    assert.equal(entry(run(days), "sql").start, 690);
    days[date][0].start = 690;
    days[date][0].packageTaskOrder = 1;
    days[date].unshift(study("prior", date, { start: 600, duration: 30, packageTaskOrder: 0 }));
    const result = run(days);
    assert.equal(result.status, "ok");
    assert.equal(entry(result, "prior").start, 690);
    assert.equal(entry(result, "sql").start, 740);
    assert.notEqual(result.noEffect, true);
    assert.equal(entry(run(fixture(), 570), "sql").start, 570);
  });

  test("either occurrence of the repeated 01:30 on a daylight-saving fall-back day is searched safely, while a custom ambiguous time is rejected", () => {
    const day = "2026-11-01";
    for (const instant of ["2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z"]) {
      for (const ordinary of [false, true]) {
        const days = { [day]: [study("sql", day, ordinary ? { tags: [], planId: undefined, packageId: undefined } : {})] };
        const settings = defaults();
        const now = planningNow({ mode: "personal", branch: { settings } }, Date.parse(instant));
        assert.equal(now.minute, 90);
        const result = moveIntent(days, settings, { taskId: "sql", targetDate: now.date, targetStart: now.minute, startFromNow: true });
        assert.equal(result.status, "ok");
        assert.equal(entry(result, "sql").start, 540);
        assert.match(result.recommendation.reason, /window/);
        const custom = moveIntent(days, settings, { taskId: "sql", targetDate: now.date, targetStart: now.minute });
        assert.notEqual(custom.status, "ok");
        assert.equal(custom.changes.length, 0);
      }
    }
  });

  test("the current time follows the application time zone and the fixed demo clock, not the device zone", () => {
    const context = { mode: "personal", branch: { settings: { timeZone: "America/Los_Angeles" } } };
    const instant = Date.parse("2026-10-13T05:50:00Z");
    assert.equal(planningNow(context, instant).date, date);
    assert.equal(planningNow(context, instant).minute, 1370);
    assert.deepEqual(planningNow({ mode: "demo", branch: { exampleOrigin: date } }, instant), { date, minute: 690 });
  });
});

describe("calendar re-read in the app", () => {
  // Runs the real calculateMove from app.js against a stubbed calendar reader.
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const method = source.slice(source.indexOf("async function calculateMove("), source.indexOf("function confirmProposal("));
  function rig(state = "connected") {
    const day = "2026-10-12";
    const task = { id: "sql", title: "SQL practice", uid: "sql", start: 660, duration: 45, rest: 15, type: "task", tags: ["study"], planId: "course", packageId: "one", dependencies: [] };
    const branch = { days: { [day]: [task] }, settings: defaults(), calendar: { readRanges: [] } }, calls = [];
    const c = vm.createContext({
      structuredClone, Date, mode: "personal", data: () => branch, calendarStatus: { state },
      needsCalendarCoverage, learningTask, addDays, moveIntent,
      all: (days = branch.days) => Object.entries(days).flatMap(([date, ts]) => ts.map((t) => ({ date, task: t }))),
      readCalendar: async (date, options) => {
        calls.push(options);
        branch.calendar.readRanges.push({ from: options.rangeFrom, to: options.rangeTo, timeZone: "America/Los_Angeles", loadedAt: new Date().toISOString(), partial: false });
        return { ok: true, complete: true };
      },
    });
    vm.runInContext(method, c);
    return { c, branch, calls, day };
  }

  test("an automatic move re-reads the expanded range and recomputes around protection discovered by that read", async () => {
    const r = rig(), read = r.c.readCalendar;
    r.c.readCalendar = async (date, options) => {
      const result = await read(date, options);
      if (options.rangeTo > "2026-10-13") {
        r.branch.days["2026-10-13"] = [{ id: "fixed", title: "Fixed activity", start: 660, duration: 60, rest: 0, type: "activity", locked: true, bufferBefore: 0, bufferAfter: 20 }];
      }
      return result;
    };
    const result = await r.c.calculateMove("sql", r.day, 1370, null, { startFromNow: true });
    assert.equal(result.status, "ok");
    assert.equal(result.exactTarget.date, "2026-10-13");
    assert.equal(result.exactTarget.start, 740);
    assert.ok(r.calls.some((c) => c.rangeTo === "2026-10-14"));
    assert.equal(r.branch.days[r.day][0].start, 660, "previewing never commits");
  });

  test("a failed calendar read is a conflict even when earlier reads found no events, because unread dates are unknown", async () => {
    for (const state of ["network", "expired", "disconnected"]) {
      const r = rig(state);
      r.branch.calendar.readRanges = [{ from: "2026-10-01", to: "2026-10-02", timeZone: "America/Los_Angeles", partial: false }];
      let calls = 0;
      r.c.readCalendar = async () => { calls++; return { ok: false, complete: false, message: "mock unavailable" }; };
      const result = await r.c.calculateMove("sql", r.day, 690, null, { startFromNow: true });
      assert.equal(result.status, "conflict");
      assert.match(result.conflicts[0].message, /Unknown time cannot be treated as free/);
      assert.equal(calls, 1);
      assert.equal(result.changes.length, 0);
    }
  });

  test("cancelling while a fresh read is in flight produces no proposal", async () => {
    const r = rig();
    let current = true;
    r.c.readCalendar = async () => { current = false; return { ok: true, complete: true }; };
    assert.equal(await r.c.calculateMove("sql", r.day, 690, null, { startFromNow: true, isCurrent: () => current }), null);
  });
});

describe("explanation when nothing changes", () => {
  const days = JSON.parse(readFileSync(new URL("./fixtures/completed-package-next-day.json", import.meta.url)));
  const date = "2026-10-12";
  const plan = (input = days, minute = 690) => moveIntent(input, defaults(),
    { taskId: "selected-next-package", targetDate: date, targetStart: minute, startFromNow: true });

  test("an automatic no-change keeps the real target and says the completed package already uses the day, at either reported clock", () => {
    for (const minute of [690, 840]) {
      const result = plan(days, minute);
      assert.equal(result.noEffect, true);
      assert.deepEqual(result.changes, []);
      assert.deepEqual(result.exactTarget, { date: "2026-10-13", start: 660 });
      assert.equal(retainedRecommendation(result, date),
        "Keeping Tomorrow 11:00. The original study group already uses this day, including completed work. The groups cannot be combined.");
    }
  });

  test("the package explanation reflects the actual result instead of a hard-coded 150-minute capacity", () => {
    const input = structuredClone(days);
    input[date][0].duration = 30;
    const result = plan(input);
    assert.equal(result.noEffect, true);
    assert.match(retainedRecommendation(result, date), /original study group already uses this day/);
    assert.doesNotMatch(retainedRecommendation(result, date), /150|capacity is full/);
    const closed = structuredClone(result);
    closed.recommendation.reason = "There is no available study time on this day.";
    assert.match(retainedRecommendation(closed, date), /no available study time/i);
    assert.doesNotMatch(retainedRecommendation(closed, date), /original study group/);
  });

  test("the same target or a non-automatic no-op adds no invented conflict, and distant dates are spelled out", () => {
    const result = plan();
    result.recommendation.requested = { ...result.exactTarget };
    result.recommendation.reason = "stale reason";
    assert.equal(retainedRecommendation(result, date), "");
    delete result.recommendation;
    assert.equal(retainedRecommendation(result, date), "");
    const future = plan();
    future.exactTarget = { date: "2027-01-02", start: 720 };
    assert.match(retainedRecommendation(future, date), /Jan 2, 2027 12:00/);
  });
});
