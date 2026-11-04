import test from "node:test";
import assert from "node:assert/strict";
import { schedule, parseTime, formatTime } from "../scheduler.js";

const task = (id, start, duration = 60, rest = 15, extra = {}) => ({
  id,
  title: id,
  start,
  duration,
  rest,
  done: false,
  locked: false,
  deferred: false,
  ...extra,
});

test("changing one start time moves later tasks in their original order, keeping durations and rest", () => {
  const input = [task("a", 600), task("b", 675, 45, 30), task("c", 750, 30, 0)];
  const result = schedule(input, { anchorId: "a", start: 660 });
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.tasks.map((t) => t.start),
    [660, 735, 810],
  );
  assert.deepEqual(
    result.tasks.map((t) => [t.duration, t.rest]),
    input.map((t) => [t.duration, t.rest]),
  );
  assert.deepEqual(
    input.map((t) => t.start),
    [600, 675, 750],
  );
});
test("earlier items stay put and cannot be overlapped by the changed task", () => {
  const result = schedule([task("a", 600), task("b", 675)], {
    anchorId: "b",
    start: 620,
  });
  assert.deepEqual(
    result.tasks.map((t) => t.start),
    [600, 675],
  );
});
test("completed tasks keep their place and shifted tasks avoid them and their rest", () => {
  const input = [
    task("a", 600, 30, 10),
    task("done", 690, 30, 15, { done: true }),
    task("b", 735, 45),
  ];
  const result = schedule(input, { anchorId: "a", start: 700 });
  assert.equal(result.tasks[0].start, 735);
  assert.deepEqual(result.tasks[1], input[1]);
  assert.equal(result.tasks[2].start, 775);
});
test("a task cannot enter the hour before a locked event or use the hour after it", () => {
  const input = [
    task("a", 600),
    task("interview", 870, 60, 0, { locked: true }),
    task("b", 1000, 30),
  ];
  const result = schedule(input, { anchorId: "a", start: 780 });
  assert.equal(result.tasks[0].start, 990);
  assert.deepEqual(result.tasks[1], input[1]);
  assert.equal(result.tasks[2].start, 1065);
});
test("a task that ends exactly when a protection period starts is allowed", () => {
  const result = schedule(
    [
      task("a", 600),
      task("lock", 870, 60, 0, { locked: true }),
      task("b", 1000, 30),
    ],
    { anchorId: "a", start: 735 },
  );
  assert.equal(result.tasks[0].start, 735);
  assert.equal(result.tasks[2].start, 1000);
});
test("several protection periods are avoided by the full task length", () => {
  const input = [
    task("a", 480, 90),
    task("l1", 660, 60, 0, { locked: true }),
    task("l2", 840, 60, 0, { locked: true }),
  ];
  const result = schedule(input, { anchorId: "a", start: 570 });
  assert.equal(result.tasks[0].start, 960);
  assert.equal(result.tasks[0].duration, 90);
});
test("ending exactly at 23:00 is allowed; going past it returns only a proposal and leaves the input unchanged", () => {
  const input = [task("a", 1200, 60, 15), task("b", 1275, 30, 0)];
  assert.equal(schedule(input, { anchorId: "a", start: 1275 }).status, "ok");
  const result = schedule(input, { anchorId: "a", start: 1276 });
  assert.equal(result.status, "overflow");
  assert.equal(result.overflow[0].id, "b");
  assert.equal(result.overflow[0].start + result.overflow[0].duration, 1381);
  assert.equal(input[0].start, 1200);
});
test("completed and locked events cannot start a shift", () => {
  for (const extra of [{ done: true }, { locked: true }]) {
    assert.equal(
      schedule([task("a", 600, 60, 0, extra)], { anchorId: "a", start: 700 })
        .status,
      "error",
    );
  }
});
test("after explicitly deferring a later task, recalculating does not move it to tomorrow", () => {
  const input = [
    task("a", 1200),
    task("b", 1275, 60, 15, { deferred: true }),
    task("c", 1350, 30, 0),
  ];
  const result = schedule(input, { anchorId: "a", start: 1275 });
  assert.equal(result.status, "ok");
  assert.equal(result.tasks[1].start, 1275);
  assert.equal(result.tasks[1].deferred, true);
  assert.equal(result.tasks[2].start, 1350);
});
test("after deferring the starting task, later tasks do not move earlier on their own", () => {
  const input = [task("a", 600, 60, 15, { deferred: true }), task("b", 675)];
  assert.equal(
    schedule(input, { anchorId: "a", start: 610 }).tasks[1].start,
    675,
  );
});
test("a completed task that conflicts with a new locked event is refused without moving the completion record", () => {
  const input = [
    task("done", 600, 60, 0, { done: true }),
    task("lock", 690, 60, 0, { locked: true }),
    task("a", 840),
  ];
  assert.equal(
    schedule(input, { anchorId: "a", start: 840 }).status,
    "conflict",
  );
});
test("a locked event in an otherwise empty day is still checked against the 23:00 boundary", () => {
  assert.equal(
    schedule([task("lock", 1360, 30, 0, { locked: true })]).status,
    "overflow",
  );
});
test("time parsing rejects invalid minutes; an overtime proposal is shown without wrapping to the next day", () => {
  assert.ok(Number.isNaN(parseTime("12:99")));
  assert.ok(Number.isNaN(parseTime("24:00")));
  assert.equal(parseTime("23:00"), 1380);
  assert.equal(formatTime(1500), "Next day 01:00");
});
