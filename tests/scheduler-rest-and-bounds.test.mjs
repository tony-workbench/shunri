import test from "node:test";
import assert from "node:assert/strict";
import { schedule } from "../scheduler.js";

const task = (id, start, duration = 45, rest = 15, extra = {}) => ({
  id, title: id, start, duration, rest,
  done: false, locked: false, deferred: false, bufferBefore: 60, bufferAfter: 60, ...extra,
});

test("If a task fits but not with its rest added, the whole item skips the protected time", () => {
  const input = [task("a", 600), task("lock", 840, 60, 0, { locked: true })];
  assert.equal(schedule(input, { anchorId: "a", start: 720 }).tasks[0].start, 720);
  assert.equal(schedule(input, { anchorId: "a", start: 750 }).tasks[0].start, 960);
});

test("Rest counts toward the daily end time and ending exactly at the boundary is allowed", () => {
  assert.equal(schedule([task("a", 1320, 50, 15)], { anchorId: "a", start: 1320 }).status, "overflow");
  assert.equal(schedule([task("a", 1315, 50, 15)], { anchorId: "a", start: 1315 }).status, "ok");
  assert.equal(schedule([task("a", 1200, 50, 15)], { anchorId: "a", start: 1200, dayEnd: 1260 }).status, "overflow");
});

test("A later task is not moved earlier automatically even when there is free time; the protection length may be 0", () => {
  const input = [
    task("a", 600),
    task("lock", 720, 30, 0, { locked: true, bufferBefore: 0, bufferAfter: 0 }),
    task("b", 1000),
  ];
  const result = schedule(input, { anchorId: "a", start: 610 });
  assert.equal(result.tasks[2].start, 1000);
  assert.equal(result.tasks[1].start, 720);
});

test("An empty schedule and no adjustable tasks do not report a missing start; a fixed-constraint conflict is still reported", () => {
  assert.equal(schedule([]).status, "ok");
  assert.equal(schedule([task("done", 600, 45, 15, { done: true })]).status, "ok");
  assert.equal(schedule([
    task("one", 600, 60, 0, { locked: true }),
    task("two", 690, 60, 0, { locked: true }),
  ]).status, "conflict");
});
