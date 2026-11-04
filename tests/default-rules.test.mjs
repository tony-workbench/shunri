import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { addDays } from "../time.js";
import { defaults } from "../storage.js";
import { plan } from "../planner.js";
import { moveIntent } from "../intent-planner.js";
import { applyDefaultRules, nextAlternative } from "../workbench.js";
import { proposeReschedule, proposeMoveToDay, proposeAlternative, ALTERNATIVES, DEFAULT_RULES } from "../default-rules.js";
import { allTasks, findTask, PROPOSAL_TODAY as today, PROPOSAL_TOMORROW as tomorrow, proposalItem as item, proposalFixture as fixture } from "./helpers.mjs";

// The five default rules, from the planner up to the previewed result:
//   1. later tasks of the day shift in their original order; fixed events and completed work never move
//   2. only work the day cannot hold leaves the day
//   3. work that leaves takes the first gap tomorrow that holds it, and nothing else there moves
//   4. every task keeps a 10-minute rest on both sides and a 60-minute buffer around fixed events
//   5. each rest is placed on the timeline next to its task
const end = (task) => task.start + task.duration;
const byId = (list) => new Map(list.map((task) => [task.id, task]));
const isFixed = (task) => task.locked || task.type === "activity";
const offsite = () => [item("offsite", 480, 960, { locked: true, type: "activity" })]; // tomorrow is blocked all day
const triple = (change) => [change.id, change.to.date, change.to.start];

// Fixed events and completed work never move; buffers, the day window and the rests on the timeline hold.
// By default every day that has timeline entries is checked.
function assertFiveRules(proposal, before, dates) {
  const { days, timeline } = proposal;
  dates ??= Object.keys(days).filter((date) => timeline.some((entry) => entry.date === date));
  for (const { task } of allTasks(before).filter((entry) => isFixed(entry.task) || entry.task.done))
    assert.deepEqual(findTask(days, task.id), task, `${task.id} never moves`);
  for (const date of dates) {
    const sorted = days[date].filter((t) => !t.deferred).sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].start - end(sorted[i - 1]);
      const fixed = isFixed(sorted[i]) || isFixed(sorted[i - 1]);
      assert.ok(gap >= (fixed ? DEFAULT_RULES.fixedBuffer : DEFAULT_RULES.habitBuffer), `${date} ${sorted[i - 1].id} to ${sorted[i].id} gap ${gap}`);
    }
    for (const task of sorted.filter((t) => !isFixed(t) && !t.done)) {
      assert.ok(end(task) + DEFAULT_RULES.habitBuffer <= DEFAULT_RULES.dayEnd, `${task.id} ends by 23:00`);
      for (const at of [task.start - DEFAULT_RULES.habitBuffer, end(task)])
        assert.ok(timeline.some((e) => e.type === "rest" && e.date === date && e.start === at), `${date} ${task.id} rest at ${at}`);
    }
  }
}

describe("postponing one task by 40 minutes", () => {
  test("gives one proposal that satisfies all five rules", () => {
    const days = fixture(), before = structuredClone(days);
    const result = proposeReschedule(days, { date: today, taskId: "t2", delay: 40 });
    assert.deepEqual(days, before, "the input is never mutated");
    assert.equal(result.status, "warning");
    // One proposal, not a list of alternatives.
    assert.ok(result.proposal && !Array.isArray(result.proposal));
    assert.equal(result.alternatives, undefined);
    assert.equal(result.proposal.alternatives, undefined);
    const { days: proposed, changes, warnings, timeline } = result.proposal;
    const day = byId(proposed[today]), next = byId(proposed[tomorrow]);

    // Rule 1: same-day shift in original order, durations unchanged; done work and fixed events stay.
    assert.equal(day.get("t2").start, 650); // 10:50
    assert.equal(day.get("t3").start, 780); // 13:00
    assert.ok(day.get("t2").start < day.get("t3").start);
    for (const id of ["t1", "t2", "t3", "t4"])
      assert.equal((day.get(id) || next.get(id)).duration, before[today].find((t) => t.id === id).duration);
    assert.deepEqual(day.get("t1"), before[today][0]);
    assert.deepEqual(day.get("dinner"), before[today][4]);
    // ...with 60 minutes kept clear on each side of the fixed event.
    for (const task of [...day.values()].filter((t) => !t.locked))
      assert.ok(end(task) + 60 <= 1140 || task.start >= 1200 + 60, `${task.id} respects the fixed buffer`);
    // ...and past 23:00 it warns first instead of moving silently.
    assert.deepEqual(warnings.map((w) => w.id), ["t4"]);
    assert.match(warnings[0].message, /does not fit before 23:00/);
    assert.match(result.message, /Change it like this\?/);

    // Rule 2: only the work the day cannot hold leaves the day.
    assert.deepEqual(changes.filter((c) => c.to?.date === tomorrow).map((c) => c.id), ["t4"]);
    assert.ok(!day.has("t4"));
    assert.deepEqual(changes.map((c) => c.id), ["t2", "t3", "t4"]);

    // Rule 3: t4 takes tomorrow's first gap that holds it, nothing else there moves.
    assert.equal(next.get("t4").start, 740); // 12:20, after standup buffer and x + rest
    for (const task of before[tomorrow]) assert.deepEqual(next.get(task.id), task);

    // Rule 4: every task keeps 10 minutes of rest before and after, on both days.
    for (const list of [proposed[today], proposed[tomorrow]]) {
      const sorted = [...list].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i].start - end(sorted[i - 1]);
        const fixed = sorted[i].locked || sorted[i - 1].locked;
        assert.ok(gap >= (fixed ? DEFAULT_RULES.fixedBuffer : DEFAULT_RULES.habitBuffer),
          `${sorted[i - 1].id} to ${sorted[i].id} gap ${gap}`);
      }
      for (const task of list.filter((t) => !t.locked))
        assert.ok(end(task) + 10 <= DEFAULT_RULES.dayEnd);
    }

    // Rule 5: every rest is placed on the timeline next to its task, never overlapping anything.
    const rests = timeline.filter((entry) => entry.type === "rest");
    for (const [date, list] of [[today, proposed[today]], [tomorrow, proposed[tomorrow]]])
      for (const task of list.filter((t) => !t.locked)) {
        assert.ok(rests.some((r) => r.date === date && r.start === task.start - 10 && r.duration === 10));
        assert.ok(rests.some((r) => r.date === date && r.start === end(task) && r.duration === 10));
      }
    const busy = timeline.filter((entry) => entry.type !== "rest");
    for (const rest of rests)
      for (const other of busy.filter((b) => b.date === rest.date))
        assert.ok(rest.start + rest.duration <= other.start || other.start + other.duration <= rest.start,
          `rest at ${rest.start} overlaps ${other.id}`);
    assertFiveRules(result.proposal, before, [today, tomorrow]);
  });

  test("always returns the same single best proposal; other plans only come one at a time through Try another", () => {
    const days = fixture(), before = structuredClone(days);
    const request = { date: today, taskId: "t2", delay: 40 };
    const best = proposeReschedule(days, request);
    assert.deepEqual(days, before);
    assert.deepEqual(best, proposeReschedule(days, request), "deterministic");
    assert.ok(best.proposal && !Array.isArray(best.proposal) && !best.alternatives);
    assert.ok(Array.isArray(best.proposal.changes));
    assert.equal(best.proposal.changes.filter((c) => c.id === "t2").length, 1);
    // Best: task 2 whole at exactly the asked time, nothing dropped or left unscheduled.
    assert.deepEqual(best.proposal.unscheduled, []);
    // Tomorrow has two gaps that hold t4 (after x and after y); the earliest one wins.
    const gaps = [740, 970].map((at) => proposeMoveToDay(days, { date: today, taskId: "t4", targetDate: tomorrow, start: at }).status);
    assert.deepEqual(gaps, ["ok", "ok"], "both gaps are viable");
    assert.deepEqual(best.proposal.changes.map(triple), [["t2", today, 650], ["t3", today, 780], ["t4", tomorrow, 740]]);
    const order = best.proposal.days[today].filter((t) => ["t2", "t3"].includes(t.id)).sort((a, b) => a.start - b.start).map((t) => t.id);
    assert.deepEqual(order, ["t2", "t3"], "original order kept");
    assertFiveRules(best.proposal, before, [today, tomorrow]);

    // Every other candidate is a separate single proposal, and each one splits task 2 or loses it.
    const others = ALTERNATIVES.map((kind) => proposeAlternative(days, { date: today, taskId: "t2", start: 650 }, kind));
    for (const alt of others) assert.ok(!alt.proposal || !Array.isArray(alt.proposal));
    const key = (r) => JSON.stringify(r.proposal.changes.map((c) => [c.id, c.to && c.to.date, c.to && c.to.start]));
    const differing = others.filter((r) => r.proposal && r.proposal.changes && r.proposal.changes.length).filter((r) => key(r) !== key(best));
    assert.ok(differing.length >= 2, "several other candidate placements exist");
    for (const r of differing) {
      const whole = r.proposal.changes.find((c) => c.id === "t2" && c.to && c.to.date === today && c.to.start === 650);
      assert.ok(!whole || r.proposal.changes.some((c) => c.id.startsWith("t2-")), "a different candidate must split or lose task 2");
    }
    assert.deepEqual(proposeReschedule(days, request), best, "Try another never changes the default");
  });

  test("when the day still holds the work, nothing leaves the day and no warning is given", () => {
    const days = fixture();
    days[today] = days[today].filter((task) => task.id !== "t4");
    const result = proposeReschedule(days, { date: today, taskId: "t2", delay: 40 });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.proposal.warnings, []);
    assert.ok(result.proposal.changes.every((change) => change.to.date === today));
    assert.deepEqual(result.proposal.days[tomorrow], days[tomorrow]);
  });

  test("completed tasks, fixed events and breaks cannot be the postponed task", () => {
    const days = fixture();
    days[today].push(item("lunch", 1300, 30, { type: "break" }));
    for (const taskId of ["t1", "dinner", "lunch"])
      assert.equal(proposeReschedule(days, { date: today, taskId, delay: 40 }).status, "error");
  });

  test("gives the same plan whatever order the day is stored in, and breaks stay put", () => {
    const sorted = proposeReschedule(fixture(), { date: today, taskId: "t2", delay: 40 });
    const days = fixture();
    days[today] = [days[today][3], days[today][4], days[today][0], days[today][2], days[today][1]];
    days[today].push(item("tea", 1320, 15, { type: "break" })); // 22:00-22:15 break
    const before = structuredClone(days);
    const result = proposeReschedule(days, { date: today, taskId: "t2", delay: 40 });
    assert.equal(result.status, "warning");
    assert.deepEqual(result.proposal.changes, sorted.proposal.changes);
    const day = byId(result.proposal.days[today]), next = byId(result.proposal.days[tomorrow]);
    // Completed records, fixed events and breaks are never moved, on either day.
    for (const id of ["t1", "dinner", "tea"])
      assert.deepEqual(day.get(id), before[today].find((task) => task.id === id));
    for (const task of before[tomorrow]) assert.deepEqual(next.get(task.id), task);
    assert.ok(result.proposal.timeline.some((entry) => entry.type === "break" && entry.start === 1320));
  });

  test("keeps a task no gap tomorrow holds in the proposal as visibly unscheduled, never lost", () => {
    const days = fixture();
    days[tomorrow] = offsite();
    const before = structuredClone(days);
    const result = proposeReschedule(days, { date: today, taskId: "t2", delay: 40 });
    assert.deepEqual(days, before, "the input is never mutated");
    assert.equal(result.status, "warning");
    const { days: proposed, changes, unscheduled } = result.proposal;
    const kept = proposed[today].find((task) => task.id === "t4");
    assert.ok(kept, "t4 is still in the proposed day");
    assert.equal(kept.deferred, true);
    assert.equal(kept.duration, 140);
    assert.ok(!proposed[tomorrow].some((task) => task.id === "t4"));
    assert.deepEqual(proposed[tomorrow], before[tomorrow]);
    assert.deepEqual(unscheduled, ["t4"]);
    assert.equal(changes.find((c) => c.id === "t4").to, null);
    assert.doesNotMatch(result.message, /moves to tomorrow/);
    assert.match(result.message, /unscheduled\. Change it like this\?/);
    for (const id of ["t1", "dinner"]) assert.deepEqual(findTask(proposed, id), findTask(before, id));
    // Every task of the day survives confirming the proposal.
    const ids = (list) => list.map((task) => task.id).sort();
    assert.deepEqual(ids(proposed[today]), ids(before[today]));
  });
});

describe("moving a task to another day", () => {
  test("a time that fits follows all five rules and changes only the chosen task", () => {
    const days = fixture(), before = structuredClone(days);
    const result = proposeMoveToDay(days, { date: today, taskId: "t2", targetDate: tomorrow, start: 740 });
    assert.equal(result.status, "ok");
    assert.deepEqual(days, before);
    assert.ok(result.proposal.timeline.length > 0);
    assertFiveRules(result.proposal, before, [today, tomorrow]);
    assert.deepEqual(result.proposal.changes.map((c) => c.id), ["t2"]);
    assert.equal(findTask(result.proposal.days, "t2").start, 740);
    assert.deepEqual(findTask(result.proposal.days, "x"), findTask(before, "x"));
    assert.ok(!result.proposal.days[today].some((t) => t.id === "t2"));
  });

  test("times that break a rule are conflicts with no proposal and no change", () => {
    const days = fixture(), before = structuredClone(days);
    for (const start of [570 + 30 + 50, 570 - 120 - 59, 1300, 500, 600]) {
      const r = proposeMoveToDay(days, { date: today, taskId: "t2", targetDate: tomorrow, start });
      assert.equal(r.status, "conflict", `start ${start}`);
      assert.equal(r.proposal, null);
    }
    assert.deepEqual(days, before);
  });

  test("a time that only ordinary tasks block still conflicts when a fixed event, a rest or the day window is the problem", () => {
    const days = exampleDemoData().days, sql = findByTitle(days, "SQL practice");
    days["2026-10-13"].push({ ...days["2026-10-13"][0], id: "fixed-tomorrow", uid: "fixed-tomorrow", start: 900, duration: 30, type: "activity", locked: true });
    assert.equal(proposeMoveToDay(days, { date: "2026-10-12", taskId: sql.id, targetDate: "2026-10-13", start: 870 }).status, "conflict");
    assert.equal(proposeMoveToDay(days, { date: "2026-10-12", taskId: sql.id, targetDate: "2026-10-13", start: 1380 }).status, "conflict");
  });
});

describe("fixed events and completed work never move", () => {
  // Tomorrow also holds a completed task here.
  const withDoneTomorrow = () => {
    const days = fixture();
    days[tomorrow] = [item("standup", 570, 30, { locked: true, type: "activity" }), item("done", 700, 30, { done: true }), item("x", 900, 60)];
    return days;
  };

  test("holds in a 40-minute postponement and in cross-day moves", () => {
    const before = withDoneTomorrow();
    const proposals = [proposeReschedule(before, { date: today, taskId: "t2", delay: 40 })];
    for (const start of [970, 1260])
      proposals.push(proposeMoveToDay(before, { date: today, taskId: "t3", targetDate: tomorrow, start }));
    let accepted = 0;
    for (const result of proposals) {
      if (!result.proposal) continue;
      accepted++;
      for (const id of ["t1", "dinner", "standup", "done"]) assert.deepEqual(findTask(result.proposal.days, id), findTask(before, id), id);
    }
    assert.ok(accepted >= 2, "at least the postponement and one cross-day move produced a proposal");
    assert.deepEqual(before, withDoneTomorrow(), "the input is never mutated");
  });

  test("a cross-day move keeps the 60-minute fixed buffer and the 10-minute rest around the moved task", () => {
    const before = withDoneTomorrow();
    const result = proposeMoveToDay(before, { date: today, taskId: "t3", targetDate: tomorrow, start: 970 });
    assert.ok(result.proposal, result.message);
    const moved = findTask(result.proposal.days, "t3");
    assert.equal(moved.start, 970);
    for (const other of result.proposal.days[tomorrow].filter((t) => t.id !== "t3")) {
      const gap = other.start >= end(moved) ? other.start - end(moved) : moved.start - end(other);
      assert.ok(gap >= (other.locked ? DEFAULT_RULES.fixedBuffer : DEFAULT_RULES.habitBuffer), `${other.id} gap ${gap}`);
    }
    // A time inside the standup's buffer is refused and moves nothing.
    assert.equal(proposeMoveToDay(before, { date: today, taskId: "t3", targetDate: tomorrow, start: 615 }).proposal, null);
  });
});

// The previewed result (what the user sees and saves with Yes) is checked, not only the internal proposal.
describe("the previewed result", () => {
  const entryOf = (days) => ({ date: today, task: days[today][1] });
  const rawPlannerAnswer = (days) => ({ status: "ok", days: structuredClone(days), changes: [], conflicts: [], alternatives: [], warnings: [], unscheduled: [] });

  test("for a same-day postponement is the proposal, with rests and the fixed buffer on both days", () => {
    const days = fixture(), before = structuredClone(days);
    const out = plan(days, defaults(), { anchorId: "t2", date: today, start: 650 });
    const ruled = applyDefaultRules(out, days, entryOf(days), today, 650);
    assert.deepEqual(days, before);
    assert.ok(ruled && ruled.proposal && !Array.isArray(ruled.proposal));
    assert.deepEqual(out.days, ruled.proposal.days, "the preview is the proposal");
    assertFiveRules(ruled.proposal, before, [today, tomorrow]);
    assert.deepEqual(out.changes.map((c) => c.id), ["t2", "t3", "t4"]);
    assert.equal(out.changes.filter((c) => c.to.date === tomorrow).length, 1);
    assert.equal(findTask(out.days, "t2").start, 650);
    assert.equal(findTask(out.days, "t4").start, 740);
    // It shows exactly the one best proposal.
    const best = proposeReschedule(days, { date: today, taskId: "t2", delay: 40 });
    assert.deepEqual(out.changes.map(triple), best.proposal.changes.map(triple));
  });

  test("for a cross-day move to a time that fits is the single ruled proposal and carries the rest timeline", () => {
    const days = fixture(), before = structuredClone(days);
    const out = rawPlannerAnswer(days);
    const ruled = applyDefaultRules(out, days, entryOf(days), tomorrow, 740);
    assert.ok(ruled, "a legal cross-day time gets a ruled proposal");
    assertFiveRules(ruled.proposal, before, [today, tomorrow]);
    assert.deepEqual(out.days, ruled.proposal.days);
    assert.deepEqual(out.changes.map((c) => c.id), ["t2"]);
    assert.equal(out.status, "ok");
    assert.ok(Array.isArray(out.timeline) && out.timeline.length > 0);
    assert.ok(out.timeline.some((e) => e.type === "rest" && e.date === tomorrow && e.start === 730));
    assertFiveRules({ days: out.days, timeline: out.timeline }, before, [today, tomorrow]);
    assert.deepEqual(days, before);
  });

  test("for a cross-day move onto an occupied time offers the nearest legal time and moves only the chosen task", () => {
    const days = fixture(), before = structuredClone(days);
    const out = rawPlannerAnswer(days);
    const ruled = applyDefaultRules(out, days, entryOf(days), tomorrow, 660);
    assert.equal(out.status, "ok");
    assert.match(ruled.lead, /The nearest time that fits is 12:20\. Other options need a same-day time\./);
    assert.deepEqual(findTask(out.days, "standup"), findTask(before, "standup"));
    assert.deepEqual(findTask(out.days, "x"), findTask(before, "x"), "x does not move");
    assert.deepEqual(out.changes.map((c) => c.id), ["t2"]);
    assert.equal(findTask(out.days, "t2").start, 740);
    assert.ok(Array.isArray(out.timeline) && out.timeline.length > 0);
  });

  for (const [layout, tomorrowDay] of [["a day with other tasks", () => fixture()[tomorrow]], ["a day blocked by one fixed event", offsite]]) {
    test(`for a cross-day time no legal slot follows (${layout}) is a conflict with no proposal; Try another is unavailable and nothing moves`, () => {
      const days = fixture();
      days[tomorrow] = tomorrowDay();
      const before = structuredClone(days);
      const out = rawPlannerAnswer(days);
      assert.equal(applyDefaultRules(out, days, entryOf(days), tomorrow, 1300), null);
      assert.equal(out.status, "conflict");
      assert.match(out.conflicts[0].message, /Try another is unavailable for a move to another day/);
      assert.deepEqual(out.changes, []);
      assert.deepEqual(out.days, before);
      assert.deepEqual(days, before);
    });
  }

  test("when no slot satisfies the rules keeps the planner's answer with the task visibly unscheduled", () => {
    const days = fixture();
    days[tomorrow] = offsite();
    const before = structuredClone(days);
    const out = plan(days, defaults(), { anchorId: "t2", date: today, start: 650 });
    const ruled = applyDefaultRules(out, days, entryOf(days), today, 650);
    assert.deepEqual(days, before);
    assert.ok(ruled && ruled.status === "warning" && ruled.proposal.unscheduled.includes("t4"));
    assert.deepEqual(out.unscheduled.map((u) => u.id), ["t4"]);
    assert.match(out.unscheduled[0].reason, /unscheduled/);
    assert.equal(findTask(out.days, "t4").deferred, true, "t4 is kept, not silently placed or lost");
    assert.equal(out.days[tomorrow].length, 1, "nothing else moved to tomorrow");
    assert.equal(findTask(out.days, "t2").start, 650);
    assert.deepEqual(out.changes.map((c) => c.id), ["t2", "t3"]);
    assert.ok(!out.changes.some((c) => c.id === "t4"), "t4 has no invented time");
    assert.deepEqual(findTask(out.days, "offsite"), findTask(before, "offsite"));
    assert.deepEqual(findTask(out.days, "dinner"), findTask(before, "dinner"));
    assert.equal(findTask(out.days, "t1").done, true);
    assertFiveRules(ruled.proposal, before, [today, tomorrow]);
  });

  test("for a same-day overflow offers only a Try another that is savable and never moves fixed events or completed work", () => {
    const days = fixture();
    days[tomorrow] = offsite();
    const before = structuredClone(days);
    const alt = nextAlternative(days, entryOf(days), 650);
    if (alt) {
      assert.ok(alt.ruled.proposal.changes.length > 0);
      for (const id of ["dinner", "offsite", "t1"]) assert.deepEqual(findTask(alt.ruled.proposal.days, id), findTask(before, id));
    }
    assert.deepEqual(days, before);
  });
});

// The first-use guide moves the example's SQL task to tomorrow at 11 am; app.js builds the example data.
function exampleDemoData() {
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const from = source.indexOf("function demoData() {"), to = source.indexOf("\nfunction switchMode(", from);
  const context = vm.createContext({ addDays, defaults, structuredClone, crypto, EXAMPLE_DATE: "2026-10-12" });
  vm.runInContext(source.slice(from, to), context);
  return JSON.parse(JSON.stringify(vm.runInContext("demoData()", context))); // crosses the vm realm so deepEqual compares plain objects
}
const findByTitle = (days, prefix) => Object.values(days).flat().find((t) => t.title.startsWith(prefix));

describe("the example data from the first-use guide", () => {
  test("moving the example task to tomorrow at 11 am gives one proposal that obeys the rules on every day it touches", () => {
    const days = exampleDemoData().days, before = structuredClone(days);
    const sql = findByTitle(days, "SQL practice");
    const out = moveIntent(structuredClone(days), defaults(), { taskId: sql.id, targetDate: "2026-10-13", targetStart: 660 });
    const ruled = applyDefaultRules(out, days, { date: "2026-10-12", task: sql }, "2026-10-13", 660);
    assert.deepEqual(days, before, "the default rules do not mutate their input");
    assert.ok(ruled && ruled.status === "ok" && !Array.isArray(ruled.proposal), "a conflict-free single proposal");
    assert.equal(out.status, "ok");
    assert.deepEqual(out.conflicts, []);
    // 11:00 is blocked by an ordinary task tomorrow, which never moves (rule 3); the nearest legal time is offered.
    assert.match(ruled.lead, /11:00 does not fit\. The nearest time that fits is 12:10\. Other options need a same-day time\./);
    assert.deepEqual(findTask(out.days, sql.id), findTask(ruled.proposal.days, sql.id));
    assert.equal(out.days["2026-10-13"].some((t) => t.id === sql.id), true);
    const touched = [...new Set(out.changes.flatMap((c) => [c.from.date, c.to.date]))];
    assert.ok(touched.includes("2026-10-13"));
    for (const date of touched) assert.ok(ruled.proposal.timeline.some((e) => e.date === date), `${date} is on the timeline`);
    assertFiveRules(ruled.proposal, before);
    assertFiveRules({ days: out.days, timeline: ruled.proposal.timeline }, before, touched);
    assert.equal(out.changes[0].id, sql.id, "the chosen task is the first change");
    assert.deepEqual([out.changes[0].to.date, out.changes[0].to.start], ["2026-10-13", 730]);
    assert.equal(out.changes.length, 1, "nothing else moves");
    assert.ok(out.changes.every((c) => !isFixed(findTask(before, c.id))), "only ordinary tasks shift");
    const badminton = Object.values(before).flat().find((t) => t.locked);
    assert.deepEqual(findTask(out.days, badminton.id), badminton, "the fixed event did not move");
  });
});
