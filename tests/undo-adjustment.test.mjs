import test from "node:test";
import assert from "node:assert/strict";
import { defaults } from "../storage.js";
import { adjustmentRecord, undoAdjustment } from "../workflow.js";

const date = "2026-10-10";
const task = (id, start) => ({
  id, title: id, start, duration: 45, rest: 15,
  done: false, locked: false, deferred: false, bufferBefore: 60, bufferAfter: 60,
});
// A schedule that was moved from `before` to `after` and carries the matching undo record.
const adjusted = (before, after) => ({
  days: structuredClone(after), settings: defaults(), daySettings: {},
  undo: adjustmentRecord(before, after, {}, {}, "Pushed back"),
});

test("Undoing a time change keeps tasks added afterwards and the Calendar correspondence", () => {
  const data = adjusted({ [date]: [task("a", 600), task("b", 700)] }, { [date]: [task("a", 660), task("b", 760)] });
  data.days[date].push(task("new", 1000));
  data.days[date][0].calendarLink = { eventId: "google-event", signature: "old" };
  const result = undoAdjustment(data);
  assert.equal(result.ok, true);
  assert.equal(result.data.days[date].length, 3);
  assert.equal(result.data.days[date][0].start, 600);
  assert.equal(result.data.days[date][0].calendarLink.eventId, "google-event");
});

test("If the completion state changed later, undo refuses to move that task", () => {
  const data = adjusted({ [date]: [task("a", 600)] }, { [date]: [task("a", 660)] });
  data.days[date][0].done = true;
  assert.equal(undoAdjustment(data).ok, false);
  assert.equal(data.days[date][0].done, true);
});

test("Undo is refused when it would collide with a later addition, and does not overwrite the new task", () => {
  const data = adjusted({ [date]: [task("a", 600)] }, { [date]: [task("a", 700)] });
  data.days[date].push(task("new", 600));
  assert.equal(undoAdjustment(data).ok, false);
});
