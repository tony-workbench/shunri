import test from "node:test";
import assert from "node:assert/strict";
import { plan, validatePlan, rulesForDate } from "../planner.js";
import { addDays, wallInstant, dateParts, today } from "../time.js";
import { planningFind as find } from "./helpers.mjs";

const DATE = "2026-10-09";
const settings = {
  dayEnd: 1380,
  dayStart: 0, // The fixture opens the whole day; the personal 09:00 default is tested in personal-rules.test.mjs.
  timeZone: "America/Los_Angeles",
  minGap: 0,
  capacity: null,
};
const task = (id, start = 660, extras = {}) => ({
  id,
  uid: id,
  title: id,
  start,
  duration: 45,
  rest: 15,
  done: false,
  locked: false,
  deferred: false,
  type: "task",
  counted: true,
  dependencies: [],
  ...extras,
});
const activity = (id, start, extras = {}) =>
  task(id, start, {
    type: "activity",
    locked: true,
    rest: 0,
    duration: 60,
    bufferBefore: 60,
    bufferAfter: 60,
    counted: false,
    ...extras,
  });
const run = (days, extraSettings = {}, options = {}) =>
  plan(
    days,
    { ...settings, ...extraSettings },
    { anchorId: "a", start: 720, date: DATE, mode: "same-day", ...options },
  );
test("same-day sequence preserves length/rest and never auto-moves earlier", () => {
  const input = { [DATE]: [task("before", 540), task("a"), task("b", 900)] };
  const before = structuredClone(input);
  const result = run(input);
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").start, 720);
  assert.equal(find(result, "b").start, 900);
  assert.equal(find(result, "before").start, 540);
  assert.deepEqual(input, before);
  assert.equal(find(result, "a").duration, 45);
  assert.equal(find(result, "a").rest, 15);
  assert.deepEqual(run(input), result);
});

test("done, locked, activity and outside scope are immutable obstacles", () => {
  const input = {
    [DATE]: [
      task("a"),
      task("done", 780, { done: true }),
      task("locked", 900, { locked: true }),
      task("outside", 1020),
      task("b", 1140),
    ],
  };
  const result = run(input, {}, { start: 780, selectedIds: ["a", "b"] });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").start, 840);
  for (const id of ["done", "locked", "outside"])
    assert.deepEqual(find(result, id), {
      date: DATE,
      ...input[DATE].find((t) => t.id === id),
    });
});

test("fixed protection exact fit vs task+rest not fitting", () => {
  const input = { [DATE]: [task("a"), activity("film", 840)] };
  assert.equal(find(run(input), "a").start, 720);
  assert.equal(find(run(input, {}, { start: 750 }), "a").start, 960);
});

test("ordinary locked task has no implicit one-hour buffer", () => {
  const result = run({
    [DATE]: [task("a"), task("lock", 780, { locked: true })],
  });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").start, 720);
});

test("rest and minimum gap use max, not addition", () => {
  const result = run({ [DATE]: [task("a"), task("b", 720)] }, { minGap: 20 });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "b").start, 785);
});

test("deadline includes rest and exactly ending at limit fits", () => {
  const input = { [DATE]: [task("a", 1200)] };
  assert.equal(run(input, {}, { start: 1320 }).status, "ok");
  assert.equal(run(input, {}, { start: 1321 }).status, "overflow");
  assert.equal(find(run(input, {}, { start: 1321 }), "a").start, 1200);
});

test("cross-day moves intact task into next day", () => {
  const result = run(
    { [DATE]: [task("a", 1320), task("b", 1380)] },
    {
      weekly: Object.fromEntries(
        Array.from({ length: 7 }, (_, day) => [day, [[660, 1380]]]),
      ),
    },
    { start: 1340, mode: "cross-day" },
  );
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").date, "2026-10-10");
  assert.equal(find(result, "a").start, 660);
  assert.equal(find(result, "b").start, 720);
  assert.equal(Object.values(result.days).flat().length, 2);
});

test("closed day skipped and date-specific windows override weekly", () => {
  const result = run(
    { [DATE]: [task("a", 1320)] },
    {
      dates: {
        "2026-10-10": { closed: true },
        "2026-10-11": { windows: [[960, 1020]] },
      },
    },
    { start: 1340, mode: "cross-day" },
  );
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").date, "2026-10-11");
  assert.equal(find(result, "a").start, 960);
});

test("multiple windows do not permit bridging closed midday", () => {
  const result = run(
    { [DATE]: [task("a")] },
    {
      dates: {
        [DATE]: {
          windows: [
            [660, 780],
            [960, 1140],
          ],
        },
      },
    },
    { start: 750 },
  );
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").start, 960);
});

test("capacity exact fit counts duration only", () => {
  const result = run({ [DATE]: [task("a"), task("b", 780)] }, { capacity: 90 });
  assert.equal(result.status, "ok");
  assert.equal(result.daily.find((d) => d.date === DATE).focus, 90);
});

test("capacity counts done and immutable tasks; cross-day deducts and adds once", () => {
  const result = run(
    {
      [DATE]: [
        task("done", 540, { done: true }),
        task("a"),
        task("lock", 900, { locked: true }),
      ],
    },
    { capacity: 90 },
    { mode: "cross-day" },
  );
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").date, "2026-10-10");
  assert.deepEqual(
    result.daily.filter((d) => d.focus),
    [
      { date: DATE, focus: 90, capacity: 90 },
      { date: "2026-10-10", focus: 45, capacity: 90 },
    ],
  );
});

test("single task larger than capacity stops at bounded range without skipping successor", () => {
  const result = run(
    {
      [DATE]: [
        task("a", 660, { duration: 151 }),
        task("b", 900, { duration: 15 }),
      ],
    },
    { capacity: 150 },
    { mode: "cross-day", searchDays: 2 },
  );
  assert.equal(result.status, "conflict");
  assert.equal(result.unscheduled.length, 2);
  assert.match(result.unscheduled[0].reason, /capacity is insufficient/i);
  assert.match(result.unscheduled[1].reason, /order was preserved/);
  assert.equal(find(result, "a").date, DATE);
});

test("future unselected tasks are obstacles, selected future tasks join ordered queue", () => {
  const input = {
    [DATE]: [task("a", 1320)],
    "2026-10-10": [task("obstacle", 660), task("b", 720)],
  };
  const extra = {
    weekly: Object.fromEntries(
      Array.from({ length: 7 }, (_, day) => [day, [[660, 1380]]]),
    ),
  };
  const result = run(input, extra, {
    start: 1340,
    mode: "cross-day",
    selectedIds: ["a", "b"],
  });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").start, 720);
  assert.equal(find(result, "b").start, 780);
  assert.equal(find(result, "obstacle").start, 660);
});

test("multiple predecessors use latest actual elapsed end + gap", () => {
  const input = {
    [DATE]: [
      task("p", 540, { rest: 0 }),
      task("q", 600, { rest: 0 }),
      task("a", 660, {
        dependencies: [
          { id: "p", gap: 180 },
          { id: "q", gap: 90 },
        ],
      }),
    ],
  };
  const result = run(input, {}, { start: 660 });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").start, 765);
});

test("unfinished predecessor planned first, cross-day dependency waits without marking complete", () => {
  const input = {
    [DATE]: [
      task("a", 1320),
      task("b", 1380, { dependencies: [{ id: "a", gap: 60 }] }),
    ],
  };
  const result = run(input, {}, { start: 1340, mode: "cross-day" });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "b").start, 105);
  assert.equal(find(result, "a").done, false);
});

test("rejects cycles, self, missing and deferred predecessors", () => {
  for (const tasks of [
    [task("a", 660, { dependencies: [{ id: "a" }] })],
    [task("a", 660, { dependencies: [{ id: "missing" }] })],
    [
      task("p", 540, { deferred: true }),
      task("a", 660, { dependencies: [{ id: "p" }] }),
    ],
    [
      task("a", 660, { dependencies: [{ id: "b" }] }),
      task("b", 780, { dependencies: [{ id: "a" }] }),
    ],
  ])
    assert.equal(run({ [DATE]: tasks }).status, "error");
});

test("locked descendant invalidated by predecessor move reports conflict and stays put", () => {
  const input = {
    [DATE]: [
      task("a"),
      task("b", 780, { locked: true, dependencies: [{ id: "a", gap: 120 }] }),
    ],
  };
  const result = run(input, {}, { start: 900 });
  assert.equal(result.status, "conflict");
  assert.equal(find(result, "b").start, 780);
  assert.ok(result.conflicts.some((c) => /minutes after .* ends\./.test(c.message)));
});

test("fixed activity crosses midnight and blocks next date protection", () => {
  const result = run(
    { [DATE]: [task("a", 1320), activity("film", 1410, { duration: 90 })] },
    {},
    { start: 1340, mode: "cross-day" },
  );
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").date, "2026-10-10");
  assert.equal(find(result, "a").start, 120);
});

test("next-day early fixed protection blocks preceding date", () => {
  const result = run(
    { [DATE]: [task("a", 1320)], "2026-10-10": [activity("early", 30)] },
    { dayEnd: 1440 },
    { start: 1380 },
  );
  assert.equal(result.status, "overflow");
  assert.equal(result.unscheduled.length, 1);
});

test("no allowed date gives explicit bounded failure and preserves all tasks", () => {
  const result = run(
    { [DATE]: [task("a"), task("b", 780)] },
    {
      weekly: Object.fromEntries(
        Array.from({ length: 7 }, (_, day) => [day, []]),
      ),
    },
    { mode: "cross-day", searchDays: 3 },
  );
  assert.equal(result.status, "conflict");
  assert.equal(result.unscheduled.length, 2);
  assert.match(result.unscheduled[0].reason, /No date in the search range is available/);
});

test("cross-month, cross-year date navigation uses calendar dates", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  const result = plan({ "2026-12-31": [task("a", 1320)] }, settings, {
    anchorId: "a",
    date: "2026-12-31",
    start: 1340,
    mode: "cross-day",
  });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").date, "2027-01-01");
});

test("DST offsets differ, nonexistent and ambiguous local times rejected", () => {
  assert.equal(
    wallInstant("2026-07-01", 720) - Date.parse("2026-07-01T12:00:00Z"),
    7 * 3600000,
  );
  assert.equal(
    wallInstant("2026-12-01", 720) - Date.parse("2026-12-01T12:00:00Z"),
    8 * 3600000,
  );
  assert.throws(() => wallInstant("2026-03-08", 150), /unavailable/);
  assert.throws(() => wallInstant("2026-11-01", 90), /ambiguous/);
  assert.equal(
    today("America/Los_Angeles"),
    dateParts(Date.now(), "America/Los_Angeles").date,
  );
});

test("dependency gap is elapsed time across DST rather than local clock difference", () => {
  const days = {
    "2026-03-07": [task("p", 1380, { duration: 30, rest: 0 })],
    "2026-03-08": [task("a", 180, { dependencies: [{ id: "p", gap: 240 }] })],
  };
  const result = plan(
    days,
    { ...settings, dayEnd: 1440, weekly: { 0: [[180, 1380]] } },
    { anchorId: "a", date: "2026-03-08", start: 180, mode: "same-day" },
  );
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").start, 270);
});

test("existing impossible DST input rejected, ordinary blocks never execute across midnight", () => {
  assert.equal(
    validatePlan({ "2026-03-08": [task("a", 150)] }, settings).status,
    "error",
  );
  assert.equal(
    validatePlan({ [DATE]: [task("a", 1430)] }, { ...settings, dayEnd: 1440 })
      .status,
    "conflict",
  );
});

test("specific capacity override null disables weekly capacity and settings remain unchanged", () => {
  const configured = {
    ...settings,
    capacity: 30,
    dates: { [DATE]: { capacity: null, windows: [[660, 1000]] } },
  };
  assert.equal(rulesForDate(configured, DATE).capacity, null);
  assert.equal(
    plan({ [DATE]: [task("a")] }, configured, {
      anchorId: "a",
      date: DATE,
      start: 720,
    }).status,
    "ok",
  );
});

test("duplicate IDs and malformed date/window rejected", () => {
  assert.equal(run({ [DATE]: [task("a"), task("a", 900)] }).status, "error");
  assert.equal(run({ "2026-02-30": [task("a")] }).status, "error");
  assert.equal(
    run({ [DATE]: [task("a")] }, { weekly: { 5: [[900, 660]] } }).status,
    "error",
  );
});

test("invalid empty/future date rules rejected before search, not ignored or thrown", () => {
  assert.equal(
    validatePlan({}, { ...settings, weekly: { 1: [[1000, 800]] } }).status,
    "error",
  );
  assert.equal(
    run(
      { [DATE]: [task("a")] },
      { dates: { "2026-10-11": { capacity: -1 } } },
      { mode: "cross-day" },
    ).status,
    "error",
  );
  assert.equal(
    run({ [DATE]: [task("a", 660, { dependencies: [null] })] }).status,
    "error",
  );
});

test("a dependency on a later task is an error that names the original order, whether the later task is movable or locked", () => {
  for (const later of [task("b", 780), task("later", 900, { locked: true })]) {
    const result = run({
      [DATE]: [task("a", 660, { dependencies: [{ id: later.id }] }), later],
    });
    assert.equal(result.status, "error");
    assert.match(result.conflicts[0].message, /conflicts with the original order/);
  }
});

test("same-day mode does not relocate future tasks; invalid anchor time rejected", () => {
  const input = { [DATE]: [task("a")], "2026-10-10": [task("future", 720)] };
  assert.deepEqual(find(run(input), "future"), {
    date: "2026-10-10",
    ...input["2026-10-10"][0],
  });
  assert.equal(run(input, {}, { start: 1440 }).status, "error");
  assert.equal(run(input, {}, { selectedIds: ["future"] }).status, "error");
});
