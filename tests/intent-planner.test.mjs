import test from "node:test";
import assert from "node:assert/strict";
import { moveIntent, validateIntentDays } from "../intent-planner.js";
import {
  learningTask,
  normalizeLearningDays,
  packageSummary,
} from "../learning.js";
import { addDays, wallInstant, MINUTE } from "../time.js";
import { planningFind as find } from "./helpers.mjs";

const MON = "2026-10-12",
  TUE = "2026-10-13",
  WED = "2026-10-14",
  THU = "2026-10-15";
const settings = {
  timeZone: "America/Los_Angeles",
  dayEnd: 1380,
  minGap: 0,
  learningMinGap: 0, // Zero-gap fixture; the personal defaults are tested in personal-rules.test.mjs.
  capacity: null,
  weekly: Object.fromEntries(
    Array.from({ length: 7 }, (_, day) => [day, [[660, 1380]]]),
  ),
  learningCapacity: 150,
};
const task = (id, extras = {}) => ({
  id,
  uid: id,
  title: id,
  start: 660,
  duration: 45,
  rest: 15,
  done: false,
  deferred: false,
  locked: false,
  type: "task",
  counted: true,
  dependencies: [],
  ...extras,
});
const study = (id, packageId, packageOrder, extras = {}) =>
  task(id, {
    tags: ["study"],
    planId: "course",
    packageId,
    packageOrder,
    ...extras,
  });
const abc = () => ({
  [MON]: [study("a", "A", 1)],
  [TUE]: [study("b", "B", 2)],
  [WED]: [study("c", "C", 3)],
});
const run = (days, rules = {}, options = {}) =>
  moveIntent(
    days,
    { ...settings, ...rules },
    { taskId: "a", targetDate: TUE, targetStart: 660, ...options },
  );

test("move A from Monday to Tuesday moves whole following packages one per day", () => {
  const input = abc(),
    snapshot = structuredClone(input),
    result = run(input);
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").date, TUE);
  assert.equal(find(result, "b").date, WED);
  assert.equal(find(result, "c").date, THU);
  assert.equal(find(result, "a").start, 660);
  assert.equal(result.summary.packagesMoved, 3);
  assert.equal(result.summary.lastDate, THU);
  assert.equal(Object.values(result.days).flat().length, 3);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(run(input), result);
});

test("skip a configured non-learning date with a calculated explanation", () => {
  const result = run(abc(), { learningDates: { [WED]: { closed: true } } });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "b").date, THU);
  assert.equal(find(result, "c").date, "2026-10-16");
  assert.ok(
    result.summary.skippedDates.some(
      (day) => day.date === WED && /non-study/.test(day.reason),
    ),
  );
});

test("automatic learning skips a morning-only gap instead of overriding the 11:00 preference", () => {
  const fixed = task("fixed-Wednesday", {
    title: "Fixed activity",
    start: 660,
    duration: 720,
    rest: 0,
    type: "activity",
    locked: true,
    counted: false,
  });
  const input = abc();
  input[WED].push(fixed);
  const snapshot = structuredClone(input);
  const result = run(input, {
    weekly: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [[540, 1380]]])),
    learningMinGap: 20,
  });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").date, TUE);
  assert.equal(find(result, "a").start, 660);
  assert.equal(find(result, "b").date, THU);
  assert.equal(find(result, "b").start, 660);
  assert.equal(find(result, "c").date, "2026-10-16");
  assert.match(result.summary.skippedDates.find((day) => day.date === WED).reason, /after 11:00/);
  assert.deepEqual(find(result, fixed.id), { date: WED, ...fixed });
  assert.deepEqual(input, snapshot);
  assert.equal(validateIntentDays(result.days, { ...settings, weekly: {
    ...settings.weekly, 3: [[540, 1380]],
  }, learningMinGap: 20 }).status, "ok");
});

test("a partial afternoon fit moves the whole package to the next available learning day", () => {
  const input = {
    [MON]: [study("a", "A", 1)],
    [TUE]: [
      study("b1", "B", 2, { duration: 30 }),
      study("b2", "B", 2, { start: 710, duration: 30 }),
    ],
    [WED]: [task("fixed-afternoon", {
      start: 720, duration: 660, rest: 0, type: "activity", locked: true, counted: false,
    })],
  };
  const result = run(input, {
    weekly: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [[540, 1380]]])),
    learningMinGap: 20,
    learningDates: { [THU]: { closed: true } },
  });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "b1").date, "2026-10-16");
  assert.equal(find(result, "b1").start, 660);
  assert.equal(find(result, "b2").date, "2026-10-16");
  assert.equal(find(result, "b2").start, 710);
  assert.equal(find(result, "b1").packageId, "B");
  assert.equal(find(result, "b2").packageId, "B");
  assert.deepEqual(result.summary.skippedDates.map((day) => day.date), [WED, THU]);
  assert.equal((result.days[WED] || []).some((entry) => learningTask(entry)), false);
});

test("an explicit 09:00 target remains exact while following packages start at or after 11:00", () => {
  const result = run(abc(), {
    weekly: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [[540, 1380]]])),
    learningMinGap: 20,
  }, { targetStart: 540 });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").date, TUE);
  assert.equal(find(result, "a").start, 540);
  assert.equal(find(result, "b").date, WED);
  assert.equal(find(result, "b").start, 660);
  assert.equal(find(result, "c").date, THU);
  assert.equal(find(result, "c").start, 660);
});

test("automatic learning uses an available afternoon gap before delaying another day", () => {
  const input = abc();
  input[WED].push(task("fixed-morning", {
    start: 660,
    duration: 120,
    rest: 0,
    type: "activity",
    locked: true,
    counted: false,
  }));
  const result = run(input, {
    weekly: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [[540, 1380]]])),
    learningMinGap: 20,
  });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "b").date, WED);
  assert.equal(find(result, "b").start, 800);
  assert.equal(find(result, "c").date, THU);
});

test("a stale morning-start preference cannot make automatic packages use 09:00 to 11:00", () => {
  const input = abc();
  // B moves off its original date, so the automatic preference rather than
  // its old clock time determines the earliest new slot.
  const result = run(input, {
    weekly: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [[540, 1380]]])),
    learningPreferredStart: 540,
  }, { targetStart: 540 });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").start, 540);
  assert.equal(find(result, "b").start, 660);
});

test("90 original-day packages remain stable when an automatic morning-only date is skipped", () => {
  const input = {};
  for (let i = 0; i < 90; i++)
    input[addDays(MON, i)] = [study(i ? `t${i}` : "a", `original-${i}`, i)];
  const fixed = task("fixed-90-plan", {
    start: 660, duration: 720, rest: 0, type: "activity", locked: true, counted: false,
  });
  input[WED].push(fixed);
  const result = run(input, {
    weekly: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [[540, 1380]]])),
    learningMinGap: 20,
  }, { targetStart: 540 });
  assert.equal(result.status, "ok");
  assert.equal(result.summary.packagesMoved, 90);
  assert.equal(result.summary.lastDate, addDays(MON, 91));
  assert.equal(find(result, "a").start, 540);
  assert.deepEqual(find(result, fixed.id), { date: WED, ...fixed });
  for (let i = 1; i < 90; i++) {
    const placed = find(result, `t${i}`);
    assert.equal(placed.date, addDays(MON, i + 2));
    assert.equal(placed.start, 660);
    assert.equal(placed.packageId, `original-${i}`);
    assert.equal(placed.packageOrder, i);
    assert.equal(placed.packageOriginDate, addDays(MON, i));
  }
  for (const entries of Object.values(result.days))
    assert.ok(new Set(entries.filter((entry) => learningTask(entry)).map((entry) => entry.packageId)).size <= 1);
  assert.equal(new Set(Object.values(result.days).flat().map((entry) => entry.id)).size, 91);
});

test("weekly learning days intersect ordinary availability and specific date overrides", () => {
  const result = run(abc(), {
    learningWeekly: { 3: [] },
    learningDates: { [WED]: { windows: [[900, 1000]] } },
  });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "b").date, WED);
  assert.equal(find(result, "b").start, 900);
});

test("partial completion keeps original date, actual record, calendar metadata, and package ID", () => {
  const done = study("done", "A", 1, {
    start: 600,
    done: true,
    completedDate: MON,
    completedAt: "2026-10-12T18:50:00Z",
    calendarLink: { eventId: "done-event" },
  });
  const input = {
    [MON]: [
      done,
      study("a", "A", 1, { start: 720, dependencies: [{ id: "done" }] }),
    ],
    [TUE]: [study("b", "B", 2)],
  };
  const result = run(input);
  assert.equal(result.status, "ok");
  const kept = find(result, "done");
  assert.equal(kept.date, MON);
  for (const [key, value] of Object.entries(done))
    assert.deepEqual(kept[key], value);
  assert.equal(find(result, "a").packageId, "A");
  assert.equal(find(result, "b").date, WED);
  assert.equal(
    packageSummary(result.days).find((p) => p.packageId === "A").completedCount,
    1,
  );
});

test("mid-package anchor schedules every unfinished predecessor before the exact requested time", () => {
  const input = {
    [MON]: [
      study("before", "A", 1),
      study("a", "A", 1, {
        start: 720,
        dependencies: [{ id: "before", gap: 15 }],
      }),
      study("after", "A", 1, { start: 780 }),
    ],
  };
  const result = run(input, {}, { targetStart: 780 });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").start, 780);
  assert.equal(find(result, "before").date, TUE);
  assert.equal(find(result, "before").start, 720);
  assert.equal(find(result, "after").start, 840);
});

test("mid-package anchor conflicting with predecessor is explicit, never omitted or silently delayed", () => {
  const input = {
    [MON]: [
      study("before", "A", 1),
      study("a", "A", 1, { start: 720, dependencies: [{ id: "before" }] }),
    ],
  };
  const result = run(input);
  assert.equal(result.status, "conflict");
  assert.match(result.conflicts[0].message, /prerequisite/);
  assert.equal(find(result, "a").date, MON);
  assert.equal(find(result, "before").date, MON);
});

test("package cannot split or merge; capacity-full date skips whole next package", () => {
  const input = {
    [MON]: [study("a", "A", 1)],
    [TUE]: [study("b1", "B", 2), study("b2", "B", 2, { start: 720 })],
    [WED]: [
      study("other", "X", 1, {
        planId: "other-course",
        duration: 100,
        start: 900,
      }),
    ],
  };
  const result = run(input);
  assert.equal(result.status, "ok");
  assert.equal(find(result, "b1").date, THU);
  assert.equal(find(result, "b2").date, THU);
  assert.equal(find(result, "other").date, WED);
  assert.match(
    result.summary.skippedDates.find((d) => d.date === WED).reason,
    /study limit/,
  );
});

test("whole package exceeding learning capacity fails clearly, without a 30-day partial result", () => {
  const input = {
    [MON]: [study("a", "A", 1)],
    [TUE]: [study("b", "B", 2, { duration: 151 })],
  };
  const result = run(input);
  assert.equal(result.status, "conflict");
  assert.match(result.conflicts[0].message, /study limit/);
  assert.equal(find(result, "a").date, MON);
  assert.equal(Object.values(result.days).flat().length, 2);
});

test("more than 30 days: 65 packages shift once, keep unique IDs and stable order", () => {
  const input = {};
  for (let i = 0; i < 65; i++)
    input[addDays(MON, i)] = [study(i ? `t${i}` : "a", `p${i}`, i)];
  const result = run(input);
  assert.equal(result.status, "ok");
  assert.equal(result.summary.packagesMoved, 65);
  assert.equal(find(result, "t64").date, addDays(MON, 65));
  assert.equal(
    new Set(
      Object.values(result.days)
        .flat()
        .map((t) => t.id),
    ).size,
    65,
  );
  assert.equal(find(result, "t64").packageOrder, 64);
});

test("specified target far beyond 30 days participates in actual calculation", () => {
  const target = addDays(MON, 90),
    result = run(abc(), {}, { targetDate: target, targetStart: 750 });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").date, target);
  assert.equal(find(result, "a").start, 750);
  assert.equal(find(result, "b").date, addDays(target, 1));
});

test("ordinary past task moves to today/future and related successors are selected automatically", () => {
  const input = {
    [MON]: [
      task("a"),
      task("b", { start: 720 }),
      task("locked", { start: 1000, locked: true }),
    ],
    [TUE]: [task("unrelated", { start: 900 })],
  };
  const result = run(input, {}, { targetStart: 720 });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").date, TUE);
  assert.equal(find(result, "a").start, 720);
  assert.equal(find(result, "b").date, TUE);
  assert.equal(find(result, "b").start, 780);
  assert.equal(find(result, "locked").date, MON);
  assert.equal(find(result, "unrelated").start, 900);
});

test("named ordinary plan moves related future tasks but leaves other plans untouched", () => {
  const input = {
    [MON]: [task("a", { planId: "work" })],
    [TUE]: [
      task("b", { planId: "work" }),
      task("x", { planId: "other", start: 1000 }),
    ],
  };
  const result = run(input);
  assert.equal(result.status, "ok");
  assert.equal(find(result, "b").start, 720);
  assert.equal(find(result, "x").start, 1000);
});

const conflictingImport = (date, start) => ({
  calendarConflict: { type: "both_changed", remoteEtag: '"remote-v2"' },
  calendarLink: { source: "google", managed: true, eventId: "synthetic-event", localFingerprint: "local-v1" },
  calendarOccupation: { startInstant: wallInstant(date, start, settings.timeZone),
    endInstant: wallInstant(date, start + 45, settings.timeZone) },
});

test("Calendar conflict: related successor stays unchanged and remains an occupied obstacle", () => {
  const b = task("b", { groupId: "work", start: 780, rest: 0, ...conflictingImport(TUE, 780) });
  const input = { [MON]: [task("a", { groupId: "work" })], [TUE]: [b] }, snapshot = structuredClone(input);
  const possible = run(input);
  assert.equal(possible.status, "ok");
  assert.equal(find(possible, "a").date, TUE);
  assert.deepEqual(find(possible, "b"), { date: TUE, ...b });
  assert.deepEqual(possible.changes.map(change => change.id), ["a"]);
  const collision = run(input, {}, { targetStart: 780 });
  assert.equal(collision.status, "conflict");
  assert.deepEqual(collision.days, input);
  assert.deepEqual(collision.changes, []);
  const automatic = run(input, {}, { targetStart: 780, startFromNow: true });
  assert.equal(automatic.status, "ok");
  assert.ok(find(automatic, "a").start >= 825);
  assert.deepEqual(find(automatic, "b"), { date: TUE, ...b });
  assert.deepEqual(input, snapshot);
});

test("Calendar conflict: a conflicted learning-package tail rejects the whole move", () => {
  const input = abc();
  Object.assign(input[TUE][0], conflictingImport(TUE, 660));
  const snapshot = structuredClone(input), result = run(input);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.days, normalizeLearningDays(input));
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.alternatives, []);
  assert.ok(result.conflicts.some(conflict => conflict.ids.includes("b")));
  assert.deepEqual(input, snapshot);
  const resolved = structuredClone(input); delete resolved[TUE][0].calendarConflict;
  const possible = run(resolved);
  assert.equal(possible.status, "ok");
  assert.equal(find(possible, "b").date, WED);
});

test("Calendar conflict: directly selecting the conflicted import cannot bypass the movement guard", () => {
  const input = { [MON]: [task("a", conflictingImport(MON, 660))] }, snapshot = structuredClone(input);
  for (const startFromNow of [false, true]) {
    const result = run(input, {}, { startFromNow });
    assert.equal(result.status, "error");
    assert.deepEqual(result.days, input);
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.alternatives, []);
  }
  assert.deepEqual(input, snapshot);
});

test("exact target colliding with fixed protection conflicts, rather than changing target time", () => {
  const fixed = task("film", {
    start: 720,
    duration: 60,
    rest: 0,
    type: "activity",
    locked: true,
    counted: false,
    bufferBefore: 60,
    bufferAfter: 60,
  });
  const input = abc();
  input[TUE].push(fixed);
  const result = run(input);
  assert.equal(result.status, "conflict");
  assert.match(result.conflicts[0].message, /film/);
  assert.equal(find(result, "film").start, 720);
  assert.equal(find(result, "a").date, MON);
});

test("fixed and unrelated plans remain unchanged while future package slots avoid protection", () => {
  const input = abc();
  input[WED].push(
    task("badminton", {
      start: 660,
      duration: 60,
      rest: 0,
      locked: true,
      type: "activity",
      counted: false,
      bufferBefore: 60,
      bufferAfter: 60,
    }),
  );
  input[THU] = [task("unrelated", { start: 1000, counted: false })];
  const result = run(input);
  assert.equal(result.status, "ok");
  assert.equal(find(result, "b").start, 780);
  assert.equal(find(result, "badminton").start, 660);
  assert.equal(find(result, "unrelated").start, 1000);
});

test("locked learning member prevents whole package move and is explicitly named", () => {
  const input = {
    [MON]: [
      study("a", "A", 1),
      study("lock", "A", 1, { start: 720, locked: true }),
    ],
  };
  const result = run(input);
  assert.equal(result.status, "conflict");
  assert.match(result.conflicts[0].message, /lock.*locked/);
  assert.equal(find(result, "lock").date, MON);
});

test("completed package consumes its original package quota on its completion day", () => {
  const input = {
    [MON]: [study("a", "A", 1)],
    [TUE]: [study("done", "Done", 0, { start: 900, done: true })],
  };
  assert.equal(run(input).status, "conflict");
});

test("capacity includes already completed content but excludes rest from minutes", () => {
  const input = {
    [MON]: [study("a", "A", 1)],
    [TUE]: [
      study("done", "A", 1, { start: 900, done: true, duration: 110, packageTaskOrder: 0 }),
    ],
  };
  const result = run(input);
  assert.equal(result.status, "conflict");
  assert.match(result.conflicts[0].message, /study limit/);
});

test("unrelated future plan blocks later tasks but isn't automatically moved", () => {
  const input = {
    [MON]: [task("a"), task("b", { start: 720 })],
    [TUE]: [task("outside", { start: 720, duration: 180 })],
  };
  const result = run(input);
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").start, 660);
  assert.equal(find(result, "b").start, 915);
  assert.equal(find(result, "outside").start, 720);
});

test("dependencies reject cycles, self, missing, deferred, and package ordering contradictions", () => {
  for (const input of [
    { [MON]: [task("a", { dependencies: [{ id: "a" }] })] },
    { [MON]: [task("a", { dependencies: [{ id: "missing" }] })] },
    {
      [MON]: [
        task("p", { deferred: true }),
        task("a", { dependencies: [{ id: "p" }] }),
      ],
    },
    {
      [MON]: [study("a", "A", 1, { dependencies: [{ id: "b" }] })],
      [TUE]: [study("b", "B", 2)],
    },
    {
      [MON]: [
        task("a", { dependencies: [{ id: "b" }] }),
        task("b", { start: 720, dependencies: [{ id: "a" }] }),
      ],
    },
  ])
    assert.notEqual(run(input).status, "ok");
});

test("immutable descendant invalidated by moving its predecessor conflicts and remains unchanged", () => {
  const input = {
    [MON]: [task("a")],
    [TUE]: [
      task("child", {
        start: 800,
        locked: true,
        dependencies: [{ id: "a", gap: 200 }],
      }),
    ],
  };
  const result = run(input);
  assert.equal(result.status, "conflict");
  assert.match(result.conflicts[0].message, /child.*unchanged/);
  assert.equal(find(result, "child").start, 800);
});

test("movable dependency descendants outside ordinary group are automatically included", () => {
  const input = {
    [MON]: [task("a")],
    [TUE]: [
      task("child", {
        start: 700,
        planId: "other",
        dependencies: [{ id: "a", gap: 60 }],
      }),
    ],
  };
  const result = run(input);
  assert.equal(result.status, "ok");
  assert.equal(find(result, "child").start, 765);
});

test("actual imported all-day and cross-day occupations block managed placements without splitting IDs", () => {
  const blocked = task("all-day", {
    type: "activity",
    externalReadOnly: true,
    locked: true,
    allDay: true,
    counted: false,
    start: 0,
    duration: 2880,
    rest: 0,
    bufferBefore: 0,
    bufferAfter: 0,
    calendarOccupation: {
      startInstant: wallInstant(TUE, 0),
      endInstant: wallInstant(THU, 0),
    },
  });
  const input = { [MON]: [task("a")], [TUE]: [blocked] };
  const result = run(input);
  assert.equal(result.status, "conflict");
  assert.match(result.conflicts[0].message, /all-day/);
  assert.equal(Object.values(result.days).flat().length, 2);
  assert.equal(validateIntentDays({ [TUE]: [blocked] }, settings).status, "ok");
});

test("a multi-day event starting earlier still blocks a later package, which skips whole day", () => {
  const input = abc();
  input[MON].push(
    task("travel", {
      type: "activity",
      externalReadOnly: true,
      locked: true,
      counted: false,
      start: 1400,
      duration: 1700,
      rest: 0,
      bufferBefore: 0,
      bufferAfter: 0,
      calendarOccupation: {
        startInstant: wallInstant(MON, 1400),
        endInstant: wallInstant(WED, 800),
      },
    }),
  );
  assert.equal(run(input).status, "conflict"); // Anchor exact Tuesday is protected, never silently moved.
  const ordinary = {
    [MON]: [task("a"), task("b", { start: 720 })],
    [TUE]: [
      task("travel", {
        type: "activity",
        externalReadOnly: true,
        locked: true,
        counted: false,
        start: 780,
        duration: 1500,
        rest: 0,
        bufferBefore: 0,
        bufferAfter: 0,
        calendarOccupation: {
          startInstant: wallInstant(TUE, 780),
          endInstant: wallInstant(THU, 780),
        },
      }),
    ],
  };
  const result = run(ordinary, {}, { targetStart: 720 });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "b").date, THU);
  assert.equal(find(result, "b").start, 780);
});

test("moving managed imported events updates occupation without changing Google event identity", () => {
  const imported = task("a", {
    calendarLink: { eventId: "google-a", calendarId: "primary" },
    calendarOccupation: {
      startInstant: wallInstant(MON, 660),
      endInstant: wallInstant(MON, 705),
    },
  });
  const result = run({ [MON]: [imported] });
  assert.equal(result.status, "ok");
  assert.equal(
    find(result, "a").calendarOccupation.startInstant,
    wallInstant(TUE, 660),
  );
  assert.equal(
    find(result, "a").calendarOccupation.endInstant,
    wallInstant(TUE, 660) + 45 * MINUTE,
  );
  assert.deepEqual(find(result, "a").calendarLink, imported.calendarLink);
});

test("DST exact target fold/gap rejected; elapsed dependency gaps use real instants", () => {
  const input = {
    "2026-03-07": [
      task("p", { start: 1380, duration: 30, rest: 0, done: true }),
      task("a", { start: 1200, dependencies: [{ id: "p", gap: 240 }] }),
    ],
  };
  const conflict = run(
    input,
    { dayStart: 0, dayEnd: 1440, weekly: { 0: [[180, 1380]] } },
    { targetDate: "2026-03-08", targetStart: 180 },
  );
  assert.equal(conflict.status, "conflict");
  const result = run(
    input,
    { dayStart: 0, dayEnd: 1440, weekly: { 0: [[180, 1380]] } },
    { targetDate: "2026-03-08", targetStart: 270 },
  );
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").start, 270);
  assert.match(
    run(
      { [MON]: [task("a")] },
      {},
      { targetDate: "2026-03-08", targetStart: 150 },
    ).conflicts[0].message,
    /unavailable in America\/Los_Angeles because of a daylight-saving change/,
  );
  assert.match(
    run(
      { [MON]: [task("a")] },
      {},
      { targetDate: "2026-11-01", targetStart: 90 },
    ).conflicts[0].message,
    /ambiguous in America\/Los_Angeles because of a daylight-saving change/,
  );
});

test("window gap and deadline do not silently replace the specified anchor time", () => {
  const input = { [MON]: [task("a")] };
  assert.equal(
    run(
      input,
      {
        weekly: {
          2: [
            [660, 720],
            [900, 1000],
          ],
        },
      },
      { targetStart: 700 },
    ).status,
    "conflict",
  );
  assert.equal(run(input, {}, { targetStart: 1340 }).status, "conflict");
});

test("learning migration doesn't guess titles and stable package identity survives repeated normalization/moving", () => {
  const input = {
    [MON]: [
      task("a", { tags: ["study"] }),
      task("b", { start: 720, learning: true }),
      task("normal", { start: 900, title: "Study some film making" }),
    ],
  };
  const normalized = normalizeLearningDays(input);
  assert.equal(learningTask(normalized[MON][2]), false);
  assert.equal(normalized[MON][0].packageId, normalized[MON][1].packageId);
  const result = run(normalized);
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").packageId, normalized[MON][0].packageId);
  assert.equal(find(result, "a").packageOriginDate, MON);
  assert.deepEqual(normalizeLearningDays(result.days), result.days);
  assert.deepEqual(input[MON][0].tags, ["study"]);
  assert.equal(input[MON][0].packageId, undefined);
});

test("validator checks learning quota and capacity independently of counted flag", () => {
  const input = {
    [MON]: [
      study("a", "A", 1, { counted: false }),
      study("b", "B", 2, { start: 720, counted: false }),
    ],
  };
  const result = validateIntentDays(input, {
    ...settings,
    learningCapacity: 80,
  });
  assert.equal(result.status, "conflict");
  assert.ok(result.conflicts.some((c) => /two original day packages/.test(c.message)));
  assert.ok(result.conflicts.some((c) => /study limit/.test(c.message)));
});

test("known actual completion timestamp constrains dependencies without inventing missing records", () => {
  const input = {
    [MON]: [task("a", { dependencies: [{ id: "done", gap: 15 }] })],
    [TUE]: [
      task("done", { start: 500, done: true, doneAt: "2026-10-13T19:00:00Z" }),
    ],
  };
  const conflict = run(input);
  assert.equal(conflict.status, "conflict");
  const result = run(input, {}, { targetStart: 750 });
  assert.equal(result.status, "ok");
  assert.equal(find(result, "done").doneAt, "2026-10-13T19:00:00Z");
});

test("normalization inherits existing package order without renumbering or overwriting it", () => {
  const input = {
    [MON]: [study("a", "A", 1), study("b", "A", undefined, { start: 720 })],
  };
  const normalized = normalizeLearningDays(input);
  assert.equal(normalized[MON][1].packageOrder, 1);
  assert.equal(run(normalized).status, "ok");
});

const availableGoogle = (id, date, start, endDate, end, extras = {}) => task(id, {
  start, duration: Math.ceil((wallInstant(endDate, end) - wallInstant(date, start)) / MINUTE),
  rest: 0, type: "task", locked: true, externalReadOnly: true, counted: false,
  bufferBefore: 0, bufferAfter: 0,
  calendarLink: { source: "google", calendarId: "primary", eventId: id, managed: false },
  calendarSource: { transparency: "transparent" },
  calendarOccupation: { startInstant: wallInstant(date, start), endInstant: wallInstant(endDate, end) },
  ...extras,
});

test("unclassified Google Available all-day stays visible without blocking exact target or validation", () => {
  const annotation = availableGoogle("available-all-day", TUE, 0, WED, 0, { allDay: true });
  const input = { [MON]: [task("a")], [TUE]: [annotation] }, before = structuredClone(input);
  const result = run(input);
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").date, TUE);
  assert.equal(find(result, "a").start, 660);
  assert.deepEqual(find(result, annotation.id), { date: TUE, ...annotation });
  assert.deepEqual(input, before);
  assert.equal(validateIntentDays(result.days, settings).status, "ok");
});

test("unclassified Google Available cross-day does not block automatic successor slots", () => {
  const annotation = availableGoogle("available-cross-day", TUE, 0, THU, 1000);
  const input = { [MON]: [task("a"), task("b", { start: 720 })], [TUE]: [annotation] };
  const result = run(input);
  assert.equal(result.status, "ok");
  assert.equal(find(result, "a").start, 660);
  assert.equal(find(result, "b").date, TUE);
  assert.equal(find(result, "b").start, 720);
  assert.deepEqual(find(result, annotation.id), { date: TUE, ...annotation });
  assert.equal(validateIntentDays(result.days, settings).status, "ok");
});

test("opaque Google occupation still blocks exact targets and validator", () => {
  const busy = availableGoogle("busy-all-day", TUE, 0, WED, 0, { calendarSource: { transparency: "opaque" } });
  const result = run({ [MON]: [task("a")], [TUE]: [busy] });
  assert.equal(result.status, "conflict");
  assert.match(result.conflicts[0].message, /busy-all-day/);
  assert.equal(validateIntentDays({ [TUE]: [task("a"), busy] }, settings).status, "conflict");
});

test("explicit fixed classification overrides Google Available and enforces 60-minute protection", () => {
  const fixed = availableGoogle("available-but-user-fixed", TUE, 720, TUE, 780, {
    type: "activity", calendarClassification: { kind: "fixed" }, bufferBefore: 60, bufferAfter: 60,
  });
  const input = { [MON]: [task("a", { duration: 15 })], [TUE]: [fixed] };
  assert.equal(run(input, {}, { targetStart: 690 }).status, "conflict"); // Before-event protection.
  assert.equal(run(input, {}, { targetStart: 800 }).status, "conflict"); // After-event protection.
  assert.equal(run(input, {}, { targetStart: 840 }).status, "ok");
  assert.deepEqual(find(run(input), fixed.id), { date: TUE, ...fixed });
});

test("explicit App task, learning or time lock cannot be overridden by Google Available", () => {
  for (const overrides of [
    { calendarClassification: { kind: "task" } },
    { calendarClassification: { kind: "learning", planId: "explicit" }, tags: ["study"], planId: "explicit", packageId: "explicit", packageOrder: 1 },
    { timeLocked: true },
  ]) {
    const fixed = availableGoogle("explicit-rule", TUE, 660, TUE, 720, overrides);
    const result = run({ [MON]: [task("a")], [TUE]: [fixed] });
    assert.equal(result.status, "conflict");
    assert.equal(validateIntentDays({ [TUE]: [task("a"), fixed] }, settings).status, "conflict");
  }
});

test("a completed original package holds the day, so an exact target on that day conflicts instead of being replaced", () => {
  const input = { [MON]: [study("a", "B", 1, { rest: 0 })],
    [TUE]: [study("done", "A", 0, { start: 540, rest: 0, done: true, completedDate: TUE,
      doneAt: "2026-10-13T16:45:00Z", packageOriginDate: "2026-10-11" })] };
  const before = structuredClone(input), result = run(input, {}, { targetStart: 720 });
  assert.equal(result.status, "conflict");
  assert.deepEqual(input, before);
  assert.ok(result.alternatives.some(a => a.targetDate === WED));
  const overlapped = structuredClone(input); overlapped[TUE].push(overlapped[MON].pop());
  assert.equal(validateIntentDays(overlapped, settings).status, "conflict");
});

test("a completed package holds its actual completion day, while historical rows stay on their original planned date", () => {
  for (const completion of [{ completedDate: TUE }, { doneAt: "2026-10-14T01:00:00Z" }, { completedDate: TUE, deferred: true }]) {
    const input = { [MON]: [study("a", "B", 1), study("done", "A", 0, { done: true, start: 540, ...completion })] };
    assert.equal(run(input).status, "conflict");
    assert.equal(run(input, {}, { targetDate: MON, targetStart: 780 }).status, "ok");
  }
});

test("the remainder of the same original package can continue, and an unfinished deferred item holds no package", () => {
  const input = { [MON]: [study("a", "A", 1, { packageTaskOrder: 1 })],
    [TUE]: [study("done", "A", 1, { start: 540, done: true, packageTaskOrder: 0 })] };
  assert.equal(run(input).status, "ok");
  input[TUE] = [study("deferred", "Other", 0, { deferred: true })];
  assert.equal(run(input).status, "ok");
});

test('candidate days skip a long run of days held by completed packages without exhausting the scheduling attempt budget',()=>{
  const input={[MON]:[study('a','A',30)]};
  for(let i=0;i<22;i++){const d=addDays(TUE,i);input[d]=[study('done'+i,'Done'+i,i,{done:true,completedDate:d,start:540,rest:0})];}
  const result=run(input);assert.equal(result.status,'conflict');
  assert.ok(result.alternatives.some(a=>a.targetDate===addDays(TUE,22)));
});
