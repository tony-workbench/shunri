import test from "node:test";
import assert from "node:assert/strict";
import { proposeReschedule, proposeAlternative } from "../schedule-context.js";
import { normalizeDays } from "../storage.js";
import { bufferedDuration, habitStart, tiringViolations, commuteFootprint,
  recoveryAfter, byPriorityThenDeadline, missesDeadline } from "../task-attributes.js";

const D = "2026-10-26";
const t = (id, start, duration, extra = {}) => ({ id, uid: `u-${id}`, title: id, start, duration, type: "task", rest: 10, ...extra });
const run = (list, req) => proposeReschedule({ [D]: list }, { date: D, ...req });
const at = (r, id) => r.proposal.days[D].find((x) => x.id === id);

test("footprint, recovery, buffer, priority and deadline helpers compute their values", () => {
  assert.deepEqual(commuteFootprint(t("a", 600, 60, { commute: { before: 20, after: 30 } })), { start: 580, end: 690 });
  assert.equal(recoveryAfter(t("a", 0, 1, { tiring: true })), 30);
  assert.equal(recoveryAfter(t("a", 0, 1)), 10);
  assert.ok([100, 125].map((n) => bufferedDuration(n)).every((v, i) => v >= [125, 156][i]));
  assert.equal(bufferedDuration(100, 0.3), 130);
  assert.deepEqual([{ id: 1, priority: "low" }, { id: 2, priority: "high", deadline: "2026-11-01" },
    { id: 3, priority: "high", deadline: "2026-10-30" }].sort(byPriorityThenDeadline).map((x) => x.id), [3, 2, 1]);
  assert.ok(missesDeadline({ deadline: "2026-10-26" }, "2026-10-27"));
  assert.equal(tiringViolations([t("a", 0, 10, { tiring: true }), t("b", 20, 10, { tiring: true })]).length, 1);
});

test("a postponed task moves together with its travel time", () => {
  const r = run([t("a", 600, 60, { commute: { before: 30, after: 30 } }), t("b", 700, 30)], { taskId: "a", start: 660 });
  const a = at(r, "a"), b = at(r, "b");
  assert.equal(a.start, 660);
  assert.ok(b.start >= a.start + a.duration + 30 + 10, "b clears the travel home");
  const blocked = run([t("f", 600, 60, { type: "activity", locked: true }), t("a", 800, 30, { commute: { before: 45, after: 0 } })],
    { taskId: "a", start: 700 });
  assert.ok(at(blocked, "a").start - 45 >= 660 + 60, "travel before does not overlap the fixed buffer");
});

test("two tiring tasks never follow each other after a postponement and recovery takes 30 minutes", () => {
  const r = run([t("a", 600, 60, { tiring: true }), t("b", 700, 60, { tiring: true }), t("c", 800, 30)], { taskId: "a", start: 640 });
  const list = r.proposal.days[D].filter((x) => !x.deferred);
  assert.deepEqual(tiringViolations(list), []);
  const a = at(r, "a");
  assert.equal(at(r, "b"), undefined, "the second tiring task does not follow the first today");
  assert.ok(r.proposal.days["2026-10-27"].some((x) => x.id === "b"));
  assert.ok(r.proposal.timeline.some((x) => x.type === "rest" && x.start === a.start + a.duration && x.duration === 30));
});

test("the estimate buffer makes the placed length 125-130% of the estimate and the change reason says why", () => {
  const r = run([t("a", 600, 60, { estimate: 60 })], { taskId: "a", start: 620 });
  const d = at(r, "a").duration;
  assert.ok(d >= 75 && d <= 78, String(d));
  const change = r.proposal.changes.find((c) => c.id === "a");
  assert.match(change.reason, /now 75 minutes \(estimate 60 plus its buffer\)/);
  assert.doesNotMatch(change.reason, /duration/);
});

test("a habit task stays inside its window, nearest its ideal time, and stays unscheduled when no window fits", () => {
  assert.equal(habitStart(t("h", 0, 30, { habit: { from: 600, to: 720, ideal: 660 } }), [{ start: 540, end: 1000 }]), 660);
  assert.equal(habitStart(t("h", 0, 30, { habit: { from: 600, to: 720, ideal: 660 } }), [{ start: 800, end: 1000 }]), null);
  const habit = { from: 840, to: 960, ideal: 900 };
  const r = run([t("a", 600, 30), t("h", 700, 30, { habit })], { taskId: "a", start: 620 });
  const h = r.proposal.days[D].find((x) => x.id === "h");
  assert.ok(h.start >= 840 && h.start + h.duration <= 960);
  // Today's window has passed: it goes to tomorrow, still inside its window.
  const early = { from: 560, to: 600, ideal: 570 };
  const next = run([t("a", 600, 30), t("h", 700, 30, { habit: early })], { taskId: "a", start: 620 });
  const hn = next.proposal.days["2026-10-27"].find((x) => x.id === "h");
  assert.ok(hn && hn.start >= 560 && hn.start + hn.duration <= 600, JSON.stringify(hn));
  // No window holds it today or tomorrow: it stays visibly unscheduled, never placed outside the window.
  const none = proposeReschedule({ [D]: [t("a", 600, 30), t("h", 700, 30, { habit: early })],
    "2026-10-27": [t("f", 540, 120, { type: "activity", locked: true })] }, { date: D, taskId: "a", start: 620 });
  const kept = none.proposal.days[D].filter((x) => x.id === "h");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].deferred, true);
  assert.ok(none.proposal.unscheduled.includes("h"));
  assert.ok(!none.proposal.days["2026-10-27"].some((x) => x.id === "h"));
});

test("reorder puts the urgent task first and a task pushed past its deadline is reported late", () => {
  const list = [t("a", 600, 30), t("low", 660, 30, { priority: "low" }), t("high", 720, 30, { priority: "high" }),
    t("due", 780, 30, { deadline: "2026-10-27" })];
  const r = proposeAlternative({ [D]: list }, { date: D, taskId: "a", start: 600 }, "reorder");
  const order = r.proposal.days[D].filter((x) => x.id !== "a").sort((x, y) => x.start - y.start).map((x) => x.id);
  assert.deepEqual(order, ["due", "high", "low"]);
  const late = run([t("a", 600, 30), t("b", 1300, 60, { deadline: D })], { taskId: "a", start: 1290 });
  assert.ok(late.proposal.late.includes("b"), "a task pushed past its deadline is flagged");
  assert.ok(!run([t("a", 600, 30)], { taskId: "a", start: 620 }).proposal.late.length);
});

test("storage rejects invalid attributes and keeps valid ones", () => {
  const bad = (extra) => assert.throws(() => normalizeDays({ [D]: [t("a", 600, 30, extra)] }));
  bad({ commute: { before: -1 } }); bad({ tiring: "yes" }); bad({ priority: "urgent" }); bad({ deadline: "2026-13-40" });
  bad({ bufferRatio: 0.5 }); bad({ habit: { from: 700, to: 600, ideal: 650 } });
  bad({ commute: { before: 1.5 } }); bad({ estimate: 0 }); bad({ manuallyMoved: "yes" }); bad({ habit: { from: 600, to: 700, ideal: 800 } });
  const attrs = { commute: { before: 10, after: 10 }, tiring: true, priority: "high", deadline: "2026-10-30",
    estimate: 30, bufferRatio: 0.3, habit: { from: 600, to: 700, ideal: 650 }, manuallyMoved: true };
  const ok = normalizeDays(JSON.parse(JSON.stringify({ [D]: [t("a", 600, 30, attrs)] })))[D][0];
  for (const [key, value] of Object.entries(attrs)) assert.deepEqual(ok[key], value, key);
});

test("priority breaks ties between tasks that start together", () => {
  const r = run([t("a", 600, 30), t("low", 700, 30, { priority: "low" }), t("hi", 700, 30, { priority: "high" })],
    { taskId: "a", start: 620 });
  assert.ok(at(r, "hi").start < at(r, "low").start);
});

test("commute and tiring recovery push the next task's earliest start", () => {
  const r = run([t("a", 600, 60, { commute: { before: 0, after: 40 }, tiring: true }), t("b", 700, 30)], { taskId: "a", start: 620 });
  assert.ok(at(r, "b").start >= 620 + 60 + 40 + 30, String(at(r, "b").start));
});

test("work leaving a full day takes tomorrow's first gaps in priority order", () => {
  const r = run([t("a", 600, 30), t("low", 1200, 60, { priority: "low" }), t("high", 1270, 60, { priority: "high" })],
    { taskId: "a", start: 1300 });
  const next = r.proposal.days["2026-10-27"];
  const high = next.find((x) => x.id === "high"), low = next.find((x) => x.id === "low");
  assert.ok(high && low && high.start < low.start, JSON.stringify(next));
});

test("tiring neighbours made adjacent by a move away are reported", () => {
  const r = run([t("x", 600, 60, { tiring: true }), t("a", 700, 30),
    t("f", 800, 60, { type: "activity", locked: true, tiring: true })], { taskId: "a", start: 900 });
  assert.deepEqual(r.proposal.tiringPairs, [["x", "f"]]);
  assert.deepEqual(run([t("a", 600, 30)], { taskId: "a", start: 620 }).proposal.tiringPairs, []);
});
