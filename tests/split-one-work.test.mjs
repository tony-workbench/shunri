import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { proposeAlternative, workDone, workParts } from "../default-rules.js";
import { doneLabel } from "../schedule-context.js";
import { defaults } from "../storage.js";
import { adjustmentRecord, undoAdjustment } from "../workflow.js";
import { DAY as date, tick, item, allTasks, uiRig } from "./helpers.mjs";

// "Try another: split" cuts one piece of work into parts on two days. The parts share one work id,
// are labelled "part N of M", and the work counts as done only when every part is done.
const next = "2026-10-14";
const task = (id, start, duration, extra = {}) => item(id, start, duration, { rest: 0, ...extra });
const splitEssay = (days, start) => proposeAlternative(days, { date, taskId: "Essay", start }, "split", {});
const essayDays = () => ({ [date]: [task("Essay", 600, 60)], [next]: [] });
const splitDays = () => splitEssay(essayDays(), 1330).proposal.days;

describe("splitting one piece of work", () => {
  test("both parts share one work id and say part 1 of 2 and part 2 of 2", () => {
    const out = splitEssay(essayDays(), 1330);
    assert.equal(out.kind, "split");
    const p1 = out.proposal.days[date].find((t) => t.id === "Essay"), p2 = out.proposal.days[next].find((t) => t.id === "Essay-part2");
    assert.ok(p1.workId && p1.workId === p2.workId);
    assert.match(p1.title, /part 1 of 2/);
    assert.match(p2.title, /part 2 of 2/);
    assert.equal(out.message, "Change it like this?");
  });

  test("the work is done only when both parts are done", () => {
    const days = splitDays();
    const p1 = days[date].find((t) => t.id === "Essay"), p2 = days[next].find((t) => t.id === "Essay-part2");
    assert.equal(workParts(days, p1).length, 2);
    assert.equal(workDone(days, p1), false);
    p1.done = true;
    assert.equal(workDone(days, p2), false);
    p2.done = true;
    assert.equal(workDone(days, p1), true);
  });

  test("Undo removes both parts and leaves the original task", () => {
    const before = essayDays(), settings = defaults();
    const after = splitEssay(before, 1330).proposal.days;
    const undo = adjustmentRecord(before, after, {}, {}, "Try another: split", settings);
    const undone = undoAdjustment({ days: structuredClone(after), settings, daySettings: {}, undo });
    assert.equal(undone.ok, true, undone.message);
    assert.deepEqual(undone.data.days, before);
    assert.equal(allTasks(undone.data.days).filter((entry) => entry.task.workId).length, 0);
  });

  test("a part of a split work is never split again, so the 1-of-2 and 2-of-2 pair stays intact", () => {
    const first = splitEssay({ [date]: [task("Essay", 600, 120)], [next]: [] }, 1300);
    assert.equal(first.kind, "split");
    const days = first.proposal.days;
    const parts = Object.values(days).flat().filter((t) => t.workId);
    assert.equal(parts.length, 2);
    assert.deepEqual(parts.map((t) => [t.part, t.parts]).sort(), [[1, 2], [2, 2]]);
    assert.ok(parts.every((t) => !/part \d of \d.*part \d of \d/.test(t.title)));
    for (const [d, id] of [[date, "Essay"], [next, "Essay-part2"]]) {
      const again = proposeAlternative(days, { date: d, taskId: id, start: 1300 }, "split", {});
      assert.equal(again.status, "unavailable", `${id} cannot be split again`);
    }
  });

  test("a second split relabels all three parts 1 to 3 of 3 under one work id, done only when all are done", () => {
    const first = splitEssay({ [date]: [task("Essay", 600, 300)], [next]: [] }, 1100);
    assert.equal(first.status, "ok");
    const again = proposeAlternative(first.proposal.days, { date, taskId: "Essay", start: 1250 }, "split", {});
    assert.ok(["ok", "warning"].includes(again.status), again.message);
    const parts = Object.values(again.proposal.days).flat().filter((t) => t.workId);
    assert.equal(parts.length, 3);
    assert.equal(new Set(parts.map((t) => t.id)).size, 3);
    assert.deepEqual(parts.map((t) => t.title).sort(), [1, 2, 3].map((i) => `Essay (part ${i} of 3)`));
    assert.ok(parts.every((t) => t.parts === 3));
    parts[0].done = true; parts[1].done = true;
    assert.equal(workDone(again.proposal.days, parts[0]), false);
    parts[2].done = true;
    assert.equal(workDone(again.proposal.days, parts[0]), true);
  });
});

describe("split work on screen", () => {
  test("the Home screen does not call part 1 alone Completed", () => {
    const days = splitDays();
    days[date].find((t) => t.workId).done = true;
    const r = uiRig({ days });
    try {
      assert.match(r.html(), /Part 1 of 2 done · the rest is still open/);
      assert.doesNotMatch(r.html(), /Completed/);
      days[next][0].done = true;
      assert.equal(doneLabel(days, days[date].find((t) => t.workId)), "Completed");
    } finally { r.close(); }
  });

  test("the split proposal stays at three buttons and three lines", async () => {
    const r = uiRig({ days: { [date]: [
      item("Done", 540, 30, { done: true, completedDate: date }),
      item("Essay", 600, 60, { postponed: 3, idealStart: 960 }),
      item("Review", 720, 60, { deadline: "2026-10-20", priority: 1 }),
      item("Report", 800, 60, { deadline: "2026-10-14", priority: 1 }),
      item("Gym", 1000, 60, { type: "activity", locked: true }),
    ] } });
    try {
      r.click("task-actions");
      r.type("today at 11:00 am");
      await tick();
      for (let i = 0; i < 6 && !/split across/.test(r.lines()[2] || ""); i++) r.click("another");
      const lines = r.lines();
      assert.match(r.output(), /<h2>Change it like this\?<\/h2>/);
      assert.deepEqual(r.buttons(), ["Yes", "Try another", "Cancel"]);
      assert.equal(lines.length, 3, JSON.stringify(lines));
      assert.match(lines[2], /split across today and tomorrow/);
      assert.match(lines.join(" "), /part 2 of 2/);
    } finally { r.close(); }
  });
});
