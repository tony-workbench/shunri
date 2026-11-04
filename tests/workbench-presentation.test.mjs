import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  adjustmentPresentation, arrangementRange, conciseChanges, friendlyDate, packageChanges,
  previewOverview, previewScope, skippedDateSummary, taskTiming, timelineDate,
} from "../workbench.js";
import { addDays } from "../time.js";

const study = (id, origin, packageId, extra = {}) => ({
  id, title: `Study ${id}`, start: 660, duration: 30, tags: ["study"], planId: "job-prepare",
  packageId, packageOriginDate: origin, done: false, ...extra,
});
const change = (task, from, to, fromStart = 660, toStart = 660) => ({
  id: task.id, title: task.title, from: { date: from, start: fromStart }, to: { date: to, start: toStart },
});
// The package summary the preview shows for one original study day.
const summary = (planId, packageId, members, origin, from, to) => ({
  key: JSON.stringify([planId, packageId]), planId, packageId,
  memberIds: members.map((m) => m.id), members, origin, from, to, count: members.length,
});

describe("dates and ranges", () => {
  test("timeline dates show the exact day and keep the year across New Year", () => {
    assert.equal(timelineDate("2026-12-31", "2026-12-31"), "Today · Dec 31");
    assert.equal(timelineDate("2027-01-01", "2026-12-31"), "Tomorrow · Jan 1, 2027");
    assert.equal(timelineDate("2026-10-14", "2026-10-12"), "Wed · Oct 14");
    assert.equal(timelineDate("2026-10-09", "2026-10-12"), "Fri · Oct 9");
  });

  test("a compact date across years keeps the year to avoid ambiguity", () => {
    assert.equal(friendlyDate("2027-01-02", "2026-12-31"), "Jan 2, 2027");
    assert.equal(friendlyDate("2026-10-13", "2026-10-12"), "Oct 13");
  });

  describe("arrangement range", () => {
    const event = (start, end) => ({
      date: "2026-11-01",
      task: { start: 90, duration: 60, calendarOccupation: { startInstant: Date.parse(start), endInstant: Date.parse(end) } },
    });

    test("a Google range across a DST change is shown from two instants, not start plus duration", () => {
      assert.equal(arrangementRange(event("2026-11-01T01:30:00-07:00", "2026-11-01T01:30:00-08:00")), "2026-11-01 01:30 PDT–01:30 PST");
    });

    test("second-level events from another time zone show the real end in the app time zone", () => {
      assert.equal(arrangementRange(event("2026-10-13T02:59:01-04:00", "2026-10-13T03:01:03-04:00")), "2026-10-12 23:59:01–2026-10-13 00:01:03");
    });

    test("a multi-day all-day range keeps the last day of the exclusive end", () => {
      const task = { calendarSource: { allDay: true, end: { date: "2026-10-15" } } };
      assert.equal(arrangementRange({ date: "2026-10-12", task }), "2026-10-12 — 2026-10-14 · All day");
    });

    test("an ordinary local event shows its exact minute range and cross-day date", () => {
      assert.equal(arrangementRange({ date: "2026-10-12", task: { start: 1380, duration: 120 } }), "2026-10-12 23:00–2026-10-13 01:00");
    });
  });
});

describe("short change list", () => {
  test("always leads with the target, and prerequisites stay in the full change list", () => {
    const changes = ["prior1", "prior2", "prior3", "anchor", "next1", "next2", "next3"].map((id) => ({ id }));
    assert.deepEqual(conciseChanges(changes, "anchor").map((c) => c.id), ["anchor", "next1", "next2"]);
    assert.equal(changes.length, 7);
  });

  test("a prerequisite is not shown as a change after a target that is last", () => {
    assert.deepEqual(conciseChanges(["p1", "p2", "p3", "anchor"].map((id) => ({ id })), "anchor"), [{ id: "anchor" }]);
  });
});

describe("preview overview of study packages", () => {
  test("a 90-day preview distinguishes 90 original packages from 180 unfinished tasks", () => {
    const origin = "2026-10-12";
    const days = {};
    const changes = [];
    for (let i = 0; i < 90; i++) {
      const date = addDays(origin, i);
      const tasks = [study(`teach-${i}`, date, `original-${i}`), study(`practice-${i}`, date, `original-${i}`, { start: 710 })];
      days[date] = tasks;
      changes.push(...tasks.map((task) => change(task, date, addDays(date, 2), task.start, task.start)));
    }
    days[origin].unshift(study("done", origin, "original-0", { done: true, start: 540, completedDate: origin, doneAt: "2026-10-12T16:30:00Z" }));
    days[origin].push({ id: "fixed", title: "Fixed activity", type: "activity", locked: true, start: 1080, duration: 60 });
    const snapshot = structuredClone({ days, changes });
    const overview = previewOverview(changes, days);
    assert.equal(overview.packageCount, 90);
    assert.equal(overview.taskCount, 180);
    assert.equal(overview.packages.reduce((sum, item) => sum + item.count, 0), 180);
    assert.equal(overview.from, origin);
    assert.equal(overview.to, addDays(origin, 91));
    assert.equal(overview.later, true);
    assert.deepEqual(overview.packages.at(-1),
      summary("job-prepare", "original-89", changes.slice(-2), addDays(origin, 89), addDays(origin, 89), addDays(origin, 91)));
    assert.deepEqual({ days, changes }, snapshot, "the calculation keeps completion and fixed-activity evidence");
  });

  test("a second postponement keeps the original package identity even when packages now share a day", () => {
    const current = "2026-10-15";
    const a = study("a", "2026-10-12", "original-12");
    const b = study("b", "2026-10-12", "original-12", { start: 710 });
    const c = study("c", "2026-10-13", "original-13", { start: 780 });
    const done = study("done", "2026-10-12", "original-12", { done: true });
    const changes = [a, b, c].map((task) => change(task, current, "2026-10-17", task.start, task.start));
    const overview = previewOverview(changes, { [current]: [a, b, c, done] });
    const initial = previewOverview([
      change(a, "2026-10-12", current),
      change(b, "2026-10-12", current, b.start, b.start),
      change(c, "2026-10-13", current, c.start, c.start),
    ], { "2026-10-12": [a, b, done], "2026-10-13": [c] });
    assert.equal(overview.packageCount, 2);
    assert.equal(overview.taskCount, 3);
    assert.deepEqual(overview.packages.map((p) => p.key), initial.packages.map((p) => p.key));
    assert.ok(overview.packages.every((p) => !p.memberIds.includes("done")));
    assert.deepEqual(overview.packages, [
      summary("job-prepare", "original-12", changes.slice(0, 2), "2026-10-12", current, "2026-10-17"),
      summary("job-prepare", "original-13", changes.slice(2), "2026-10-13", current, "2026-10-17"),
    ]);
  });

  test("same-origin packages in different plans keep only their own members and times", () => {
    const origin = "2026-10-12";
    const a = study("a", origin, "package-a", { planId: "plan-a", duration: 45 });
    const b = study("b", origin, "package-b", { planId: "plan-b", start: 960, duration: 45 });
    const done = study("done", origin, "package-a", { planId: "plan-a", done: true });
    const changes = [change(a, origin, "2026-10-13", 660, 720), change(b, origin, "2026-10-14", 960, 960), change(done, origin, "2026-10-13", 600, 600)];
    const days = { [origin]: [a, b, done] };
    const snapshot = structuredClone({ changes, days });
    const overview = previewOverview(changes, days);
    assert.equal(overview.packageCount, 2);
    assert.deepEqual(overview.packages, [
      summary("plan-a", "package-a", [changes[0]], origin, origin, "2026-10-13"),
      summary("plan-b", "package-b", [changes[1]], origin, origin, "2026-10-14"),
    ]);
    assert.strictEqual(overview.packages[0].members[0], changes[0]);
    assert.strictEqual(overview.packages[1].members[0], changes[1]);
    assert.equal(overview.packages[0].members[0].to.start, 720);
    assert.equal(overview.packages[1].members[0].to.start, 960);
    assert.deepEqual({ changes, days }, snapshot);
  });

  test("completed content changes do not create an unfinished learning package", () => {
    const date = "2026-10-12";
    const done = study("done", date, "original-12", { done: true, completedDate: date });
    const overview = previewOverview([change(done, date, date)], { [date]: [done] });
    assert.equal(overview.packageCount, 0);
    assert.deepEqual(overview.packages, []);
    assert.equal(overview.taskCount, 1, "an actual content change stays visible in the total change count");
  });

  test("a same-day earlier start is not described as a postponement", () => {
    const date = "2026-10-12";
    const a = study("a", date, "original-12");
    assert.equal(previewOverview([change(a, date, date, 660, 540)], { [date]: [a] }).later, false);
    assert.equal(previewOverview([change(a, date, date, 660, 780)], { [date]: [a] }).later, true);
    assert.equal(previewOverview([], { [date]: [a] }).later, false);
  });

  describe("package changes", () => {
    test("the original day package keeps its stable identity and is not renamed or merged by a second shift", () => {
      const pkg = (id, packageId, origin, extra = {}) => ({ id, title: id, start: 660, tags: ["study"], planId: "job-prepare", packageId, packageOriginDate: origin, ...extra });
      const days = {
        "2026-10-13": [pkg("a", "original12", "2026-10-12"), pkg("b", "original12", "2026-10-12"), pkg("done", "original12", undefined, { done: true })],
        "2026-10-14": [pkg("c", "original13", "2026-10-13")],
      };
      const changes = ["a", "b", "c"].map((id) => ({
        id, from: { date: id === "c" ? "2026-10-14" : "2026-10-13" }, to: { date: id === "c" ? "2026-10-16" : "2026-10-15" },
      }));
      assert.deepEqual(packageChanges(changes, days), [
        summary("job-prepare", "original12", changes.slice(0, 2), "2026-10-12", "2026-10-13", "2026-10-15"),
        summary("job-prepare", "original13", changes.slice(2), "2026-10-13", "2026-10-14", "2026-10-16"),
      ]);
    });

    test("package identities do not collide when planId and packageId both contain slashes", () => {
      const date = "2026-10-12";
      const days = { [date]: [
        { id: "a", title: "a", start: 660, tags: ["study"], planId: "plan/one", packageId: "two", packageOriginDate: date },
        { id: "b", title: "b", start: 720, tags: ["study"], planId: "plan", packageId: "one/two", packageOriginDate: date },
      ] };
      const changes = ["a", "b"].map((id) => ({ id, from: { date }, to: { date: "2026-10-13" } }));
      const groups = packageChanges(changes, days);
      assert.equal(groups.length, 2);
      assert.notEqual(groups[0].key, groups[1].key);
      assert.deepEqual(groups.map((group) => group.memberIds), [["a"], ["b"]]);
      assert.deepEqual(groups.map((group) => group.members), [[changes[0]], [changes[1]]]);
    });
  });
});

describe("adjustment presentation", () => {
  const noPlanEnd = (p) => assert.doesNotMatch([p.result, ...p.facts].join(" "), /plan (?:end|finish)|end of (?:the )?(?:study )?plan/i);

  test("one same-day delay describes the task and keeps later untouched learning dates", () => {
    const date = "2026-10-12";
    const sql = study("sql", date, "sql-day", { title: "SQL practice", duration: 45 });
    const python = study("python", "2026-10-13", "python-day", { title: "Python practice" });
    const review = study("review", "2026-10-15", "review-day", { title: "Study review" });
    const days = { [date]: [sql], "2026-10-13": [python], "2026-10-15": [review] };
    const changes = [change(sql, date, date, 660, 720)];
    const snapshot = structuredClone({ days, changes });
    const presentation = adjustmentPresentation(changes, days, sql.id, date);
    assert.equal(presentation.headline.replace(/\s/g, ""), "1planlaterby1hr");
    assert.match(presentation.result, /SQL practice.*Today\s*12:00/);
    assert.match(presentation.result, /Later study dates stay the same/);
    assert.equal(presentation.affectedDays, 1);
    assert.equal(presentation.sameDay, true);
    assert.ok(presentation.facts.length <= 2);
    noPlanEnd(presentation);
    assert.deepEqual({ days, changes }, snapshot);
  });

  test("a cross-day change reports the affected learning days and the latest adjustment date", () => {
    const first = "2026-10-12";
    const tasks = [study("sql", first, "sql-day"), study("python", "2026-10-13", "python-day"), study("review", "2026-10-15", "review-day")];
    const days = Object.fromEntries(tasks.map((task) => [task.packageOriginDate, [task]]));
    const changes = tasks.map((task, i) => change(task, task.packageOriginDate, ["2026-10-13", "2026-10-14", "2026-10-16"][i]));
    const presentation = adjustmentPresentation(changes, days, "sql", first);
    assert.equal(presentation.headline.replace(/\s/g, ""), "3studydaysmovelaterinorder");
    assert.match(presentation.result, /This changes\s*3\s*study days/);
    assert.match(presentation.result, /through\s*Oct\s*16/);
    assert.equal(presentation.affectedDays, 3);
    assert.equal(presentation.sameDay, false);
    assert.ok(presentation.facts.length <= 2);
    noPlanEnd(presentation);
  });

  test("an untouched later package is not presented as ending on the latest affected date", () => {
    const first = "2026-10-12";
    const sql = study("sql", first, "sql-day");
    const days = { [first]: [sql], "2026-10-20": [study("future", "2026-10-20", "future-day")] };
    const presentation = adjustmentPresentation([change(sql, first, "2026-10-13")], days, "sql", first);
    assert.equal(presentation.affectedDays, 1);
    assert.equal(presentation.sameDay, false);
    assert.match(presentation.result, /through\s*Oct\s*13/);
    noPlanEnd(presentation);
    assert.ok(presentation.facts.length <= 2);
  });

  test("separate plans sharing an original date count as separate affected packages", () => {
    const first = "2026-10-12";
    const a = study("a", first, "shared-id", { planId: "plan-a" });
    const b = study("b", first, "shared-id", { planId: "plan-b" });
    const done = study("done", first, "shared-id", { planId: "plan-b", done: true });
    const changes = [change(a, first, "2026-10-13"), change(b, first, "2026-10-14")];
    const presentation = adjustmentPresentation(changes, { [first]: [a, b, done] }, "a", first);
    assert.equal(presentation.affectedDays, 2);
    assert.equal(presentation.packageCount, 2);
    assert.equal(presentation.headline.replace(/\s/g, ""), "2studygroupsmovelaterinorder");
    assert.match(presentation.result, /This changes\s*2\s*study groups/);
    assert.match(presentation.result, /through\s*Oct\s*14/);
    assert.equal(presentation.sameDay, false);
    assert.ok(presentation.facts.length <= 2);
    noPlanEnd(presentation);
  });

  describe("preview scope sentence", () => {
    const pkg = (id, origin, plan = "p") => ({ id, title: id, start: 660, duration: 30, tags: ["study"], planId: plan, packageId: origin, packageOriginDate: origin });
    const move = (task, from, to) => ({ id: task.id, title: task.title, from: { date: from, start: 660 }, to: { date: to, start: 660 } });

    test("is one natural sentence, and members of one package are not counted as learning days", () => {
      const a = pkg("a", "2026-10-12"), b = pkg("b", "2026-10-13"), c = pkg("c", "2026-10-15");
      const days = { "2026-10-12": [a], "2026-10-13": [b], "2026-10-15": [c] };
      const changes = [move(a, "2026-10-12", "2026-10-13"), move(b, "2026-10-13", "2026-10-15"), move(c, "2026-10-15", "2026-10-16")];
      assert.equal(previewScope(changes, days, "a", "2026-10-12"), "2 later study days will move through Oct 16.");
      b.packageId = b.packageOriginDate = "2026-10-12";
      assert.doesNotMatch(previewScope(changes.slice(0, 2), days, "a", "2026-10-12"), /later|study day/);
    });

    test("does not claim sequential learning days for mixed plans, earlier moves or ordinary tasks", () => {
      const a = pkg("a", "2026-10-12"), b = pkg("b", "2026-10-13", "other"), ordinary = { id: "n", title: "Shopping", start: 660, duration: 20 };
      const days = { "2026-10-12": [a, ordinary], "2026-10-13": [b] };
      const changes = [move(a, "2026-10-12", "2026-10-13"), move(b, "2026-10-13", "2026-10-15")];
      assert.match(previewScope(changes, days, "a", "2026-10-12"), /^1 other study group will move/);
      b.planId = "p"; changes[0].to.date = "2026-10-11";
      assert.doesNotMatch(previewScope(changes, days, "a", "2026-10-12"), /later study days/);
      const n = move(ordinary, "2026-10-12", "2026-10-16");
      assert.equal(previewScope([n], days, "n", "2026-10-12"), "");
      assert.match(previewScope([n, ...changes], days, "n", "2026-10-12"), /^2 other study groups will move through Oct 16/);
    });
  });
});

describe("skipped date summary", () => {
  test("uses closed-day evidence and separates missing windows, capacity and package quota", () => {
    const reason = "This is a non-study date or has no available study time";
    const skipped = [{ date: "2026-10-14", reason }, { date: "2026-10-14", reason }, { date: "2026-10-15", reason }];
    const text = skippedDateSummary(skipped, { learningDates: { "2026-10-14": { closed: true } } }, "2026-10-12");
    assert.equal(text, "Oct 14: skipped. Rest day. Oct 15: skipped. No available study time.");
    assert.equal(skippedDateSummary([skipped[0]], {}, "2026-10-12"), "Oct 14: skipped. No available study time.");
    assert.match(skippedDateSummary([{ date: "2026-10-15", reason: "The same study plan already has another original day package on that day" }], {}, "2026-10-12"), /Another study group already scheduled/);
    assert.match(skippedDateSummary([{ date: "2026-10-15", reason: "Study of 180 minutes exceeds the daily study limit of 150 minutes" }], {}, "2026-10-12"), /Not enough remaining study capacity/);
  });

  test("many skipped attempts stay bounded and keep every input reason for the details", () => {
    const reasons = ["This is a non-study date or has no available study time", "That day already has another original day package", "Exceeds the daily study limit of 150 minutes"];
    const skipped = Array.from({ length: 20 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, reason: reasons[i % 3] }));
    const before = structuredClone(skipped), text = skippedDateSummary([...skipped, ...skipped], {}, "2026-10-01");
    assert.match(text, /6 more days/);
    assert.ok(text.length < 320);
    assert.deepEqual(skipped, before);
  });
});

describe("task timing", () => {
  test("rest and the required gap take the larger value, showing the rest and gap facts without promising a start", () => {
    const e = { date: "2026-10-12", task: study("sql", "2026-10-12", "pkg", { duration: 45, rest: 15 }) };
    const view = taskTiming(e, { learningMinGap: 20 });
    assert.equal(view.range, "2026-10-12 11:00–11:45");
    assert.equal(view.rest, "11:45–12:00 Break");
    assert.equal(view.next, "Required gap until 12:05");
    assert.equal(taskTiming({ ...e, task: { ...e.task, rest: 30 } }, { learningMinGap: 20 }).next, "");
  });

  test("the 60-minute protection before a medical appointment is shown separately and is neither the event nor a repeated gap", () => {
    const e = { date: "2026-10-12", task: { id: "d", title: "Dental appointment", start: 900, duration: 60, rest: 0, type: "activity", purpose: "medical", bufferBefore: 0, bufferAfter: 0 } };
    const view = taskTiming(e, { learningMinGap: 20 });
    assert.equal(view.range, "2026-10-12 15:00–16:00");
    assert.deepEqual(view.protection, ["14:00–15:00 Before appointment buffer"]);
    assert.equal(view.rest, "");
    assert.equal(view.next, "");
  });

  test("a rest that falls into an adjacent fixed protection is not passed off as a gap the user can continue after", () => {
    const task = study("sql", "2026-10-12", "pkg", { start: 795, duration: 45, rest: 15 });
    const days = { "2026-10-12": [task, { id: "medical", title: "Dental appointment", type: "activity", purpose: "medical", start: 900, duration: 60, bufferBefore: 60, bufferAfter: 0 }] };
    const view = taskTiming({ date: "2026-10-12", task }, { learningMinGap: 20 }, days);
    assert.equal(view.rest, "14:00–14:15 Break");
    assert.equal(view.next, "Required gap until 14:20");
  });

  test("a hint is not a scheduling promise: a closed day and an 11 pm end cannot suggest more study", () => {
    const date = "2026-10-12";
    const fixed = { id: "bbq", title: "Barbecue", start: 560, duration: 460, type: "activity", purpose: "outing" };
    const closed = taskTiming({ date, task: fixed }, { dates: { [date]: { closed: true } }, learningMinGap: 20 });
    assert.match(closed.next, /No study scheduled/);
    assert.doesNotMatch(closed.next, /earliest|17:20/i);
    const late = taskTiming({ date, task: study("late", date, "p", { start: 1350, duration: 30, rest: 0 }) }, { dayEnd: 1380, learningMinGap: 20 });
    assert.doesNotMatch(late.next, /23:20|earliest|continue/i);
  });

  // These are presentation-only fixtures, not schedules produced by the planner.
  test("when capacity is used up, only facts are shown and no further study is promised", () => {
    const date = "2026-10-12";
    for (const extra of [{ learningCapacity: 0 }, { learningDates: { [date]: { closed: true } } }]) {
      const e = { date, task: study("t", date, "p", { duration: 150, rest: 15 }) };
      const view = taskTiming(e, { ...extra, learningMinGap: 20 }, { [date]: [study("done", date, "other", { done: true })] });
      assert.doesNotMatch(view.next, /earliest|can start|continue|study starts?/i);
      assert.match(view.rest, /Break/);
    }
    const midnight = taskTiming({ date, task: { id: "m", start: 1380, duration: 120, type: "activity", bufferAfter: 30 } }, { timeZone: "America/Los_Angeles" });
    assert.match(midnight.range, /2026-10-13 01:00/);
    assert.match(midnight.protection[0], /2026-10-13 01:30/);
    assert.equal(midnight.next, "");
    const dst = taskTiming({ date: "2026-11-01", task: { id: "d", start: 90, duration: 60, rest: 15, calendarOccupation: {
      startInstant: Date.parse("2026-11-01T01:30:00-07:00"), endInstant: Date.parse("2026-11-01T01:30:00-08:00") } } }, { timeZone: "America/Los_Angeles" });
    assert.match(dst.range, /PDT.*PST/);
    assert.match(dst.rest, /PST/);
    assert.doesNotMatch(dst.next, /earliest/i);
  });
});
