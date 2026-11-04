import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { ALTERNATIVES, proposeAlternative, proposeReschedule } from "../default-rules.js";
import { defaults } from "../storage.js";
import { adjustmentRecord, undoAdjustment } from "../workflow.js";
import { addDays } from "../time.js";
import { moveIntent } from "../intent-planner.js";
import { applyDefaultRules, defaultRulesQuestion, nextAlternative } from "../workbench.js";
import { DAY, item, findTask, tick, uiRig } from "./helpers.mjs";

// The production demo data (from app.js), whose SQL practice task sits on the example day.
const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
const demoFrom = appSource.indexOf("function demoData() {"), demoTo = appSource.indexOf("\nfunction switchMode(", demoFrom);
const sandbox = vm.createContext({ addDays, defaults, structuredClone, crypto, EXAMPLE_DATE: "2026-10-12" });
vm.runInContext(appSource.slice(demoFrom, demoTo), sandbox);
const demo = () => JSON.parse(JSON.stringify(vm.runInContext("demoData()", sandbox)));

// "Try another" offers the default-rules alternatives one after another, always as a proposal that
// is saved only after Yes. The first half tests the alternatives themselves, the second half the button.

const date = DAY, next = "2026-10-14";
const task = (id, start, duration, extra = {}) => ({ id, uid: id, title: id, start, duration, rest: 0, type: "task", done: false,
  locked: extra.type === "activity", tags: [], dependencies: [], ...extra });
// Today holds a completed task, a fixed event, a break and three movable tasks; tomorrow holds a completed task and a fixed event.
const fixture = ({ lunch = true } = {}) => ({
  [date]: [
    task("Done", 540, 30, { done: true }),
    task("Essay", 600, 60),
    task("Review", 720, 60, { deadline: "2026-10-20", priority: 1 }),
    task("Report", 800, 60, { deadline: "2026-10-14", priority: 1 }),
    task("Gym", 900, 60, { type: "activity", locked: true }),
    ...(lunch ? [task("Lunch", 660, 30, { type: "break" })] : []),
  ],
  [next]: [
    task("TDone", 540, 30, { done: true }),
    task("TGym", 600, 60, { type: "activity", locked: true }),
  ],
});
const find = findTask;
const PROTECTED = ["Done", "Gym", "Lunch", "TDone", "TGym"];
const protectedStay = (before, proposal) => {
  for (const id of PROTECTED) assert.deepEqual(find(proposal.days, id), find(before, id), id + " is untouched");
};
const OPTS = { usualStart: 960, postponements: 3, choice: "archive", now: { date, minute: 480 } };
const START = { split: 1330 }; // only 40 minutes remain before 23:00 less the rest buffer
const request = (kind) => ({ date, taskId: "Essay", start: START[kind] ?? 630 });
const ask = (kind, opts = {}, extra = {}) => {
  const days = fixture(), copy = structuredClone(days);
  const out = proposeAlternative(days, { ...request(kind), ...extra }, kind, opts);
  assert.deepEqual(days, copy, "input is never mutated");
  return { days, out };
};

describe("the default-rules alternatives", () => {
  test("alternatives are listed in the product-direction order and an unknown kind is an error", () => {
    assert.deepEqual(ALTERNATIVES, ["reorder", "split", "usual-slot", "unscheduled", "drop-or-archive", "morning-replan"]);
    assert.equal(proposeAlternative(fixture(), request("reorder"), "nope").status, "error");
  });

  test("reorder puts the rest of the day in deadline and priority order", () => {
    const { days, out } = ask("reorder");
    assert.equal(out.kind, "reorder");
    assert.ok(["ok", "warning"].includes(out.status));
    const p = out.proposal;
    assert.ok(find(p.days, "Report").start < find(p.days, "Review").start, "earlier deadline first");
    assert.ok(find(p.days, "Essay").start >= 630, "target keeps its requested floor");
    assert.equal(find(p.days, "Report").duration, 60);
    protectedStay(days, p);
  });

  test("split divides the task across today and tomorrow", () => {
    const { days, out } = ask("split");
    assert.equal(out.kind, "split");
    const p = out.proposal;
    assert.ok(p.split.today >= 15 && p.split.tomorrow > 0);
    assert.equal(p.split.today + p.split.tomorrow, 60);
    assert.equal(find(p.days, "Essay").duration, p.split.today);
    assert.equal(p.days[next].find((t) => t.id === "Essay-part2").duration, p.split.tomorrow);
    protectedStay(days, p);
    assert.deepEqual(find(p.days, "Review"), find(days, "Review"), "other tasks do not move");
  });

  test("usual-slot places the task where this kind of task is usually done", () => {
    const { days, out } = ask("usual-slot", { usualStart: 960 });
    assert.equal(find(out.proposal.days, "Essay").start, 1020, "first free time after the usual start, outside the fixed buffer");
    protectedStay(days, out.proposal);
    assert.equal(ask("usual-slot").out.status, "unavailable", "no usual time known");
  });

  test("unscheduled says plainly that the task does not fit and leaves it unscheduled", () => {
    const { days, out } = ask("unscheduled");
    assert.equal(out.status, "warning");
    assert.match(out.message, /does not fit/);
    assert.match(out.message, /unscheduled/);
    assert.equal(find(out.proposal.days, "Essay").deferred, true);
    assert.deepEqual(out.proposal.unscheduled, ["Essay"]);
    protectedStay(days, out.proposal);
  });

  test("drop-or-archive asks only after enough postponements and changes nothing until answered", () => {
    assert.equal(ask("drop-or-archive", { postponements: 2 }).out.status, "unavailable");
    const asked = ask("drop-or-archive", { postponements: 3 }).out;
    assert.equal(asked.status, "ask");
    assert.deepEqual(asked.choices, ["drop", "archive", "keep"]);
    assert.equal(asked.proposal, null, "nothing changes until the user answers");
    const dropped = ask("drop-or-archive", { postponements: 3, choice: "drop" });
    assert.equal(find(dropped.out.proposal.days, "Essay"), undefined);
    const archived = ask("drop-or-archive", { postponements: 3, choice: "archive" });
    assert.equal(find(archived.out.proposal.days, "Essay").archived, true);
    protectedStay(archived.days, archived.out.proposal);
    protectedStay(dropped.days, dropped.out.proposal);
  });

  test("morning-replan replans the whole day once, in the morning only", () => {
    const { days, out } = ask("morning-replan", { now: { date, minute: 480 } });
    assert.equal(out.proposal.replannedOn, date);
    assert.ok(find(out.proposal.days, "Report").start < find(out.proposal.days, "Review").start);
    protectedStay(days, out.proposal);
    assert.equal(ask("morning-replan", { replannedOn: date }).out.status, "unavailable", "only once per day");
    assert.equal(ask("morning-replan", { now: { date, minute: 900 } }).out.status, "unavailable", "only in the morning");
  });

  test("the morning-replan limit follows the first available window of an early or late day", () => {
    const run = (minute, settings) => proposeAlternative(fixture(), request("reorder"), "morning-replan", { now: { date, minute } }, settings);
    const early = { dayStart: 360 }, late = { dayStart: 840, dayEnd: 1380 };
    assert.notEqual(run(500, early).status, "unavailable", "early start: still its morning at 08:20");
    assert.equal(run(600, early).status, "unavailable", "early start: 10:00 is past the first hours");
    assert.notEqual(run(1000, late).status, "unavailable", "late start: 16:40 is within the first hours of a 14:00 day");
    assert.equal(run(1100, late).status, "unavailable", "late start: 18:20 is past them");
    assert.equal(proposeAlternative(fixture(), request("reorder"), "morning-replan",
      { now: { date, minute: 900 }, replannedOn: date }, late).status, "unavailable", "still once per day");
  });

  test("no alternative moves fixed events or completed records, or accepts them as the task", () => {
    for (const kind of ALTERNATIVES) {
      for (const taskId of ["Gym", "Done", "Lunch"])
        assert.equal(proposeAlternative(fixture(), { date, taskId, start: 600 }, kind, { postponements: 9, usualStart: 600 }).status,
          "error", `${kind}: ${taskId}`);
      const out = proposeAlternative(fixture(), request("reorder"), kind, { ...OPTS, postponements: 9 });
      if (out.proposal) protectedStay(fixture(), out.proposal);
    }
  });
});

describe("each alternative as a proposal", () => {
  for (const kind of ALTERNATIVES) {
    test(`${kind}: revealing it keeps the current schedule, the request and the first proposal`, () => {
      const days = fixture(), copy = structuredClone(days), req = request(kind), reqCopy = structuredClone(req);
      const first = proposeReschedule(days, request("reorder")), firstCopy = structuredClone(first);
      const out = proposeAlternative(days, req, kind, OPTS);
      assert.deepEqual(days, copy, "current schedule unchanged");
      assert.deepEqual(req, reqCopy, "request unchanged");
      assert.deepEqual(first, firstCopy, "first proposal unchanged");
      assert.equal(out.kind, kind);
      assert.ok(out.proposal, "a proposal is revealed");
      assert.ok(find(days, "Essay"), "current task still in context");
    });

    test(`${kind}: its proposal keeps the confirmation question and protected records`, () => {
      const before = fixture();
      const out = proposeAlternative(before, request(kind), kind, OPTS);
      assert.ok(["ok", "warning"].includes(out.status), `${kind}: ${out.status} ${out.message}`);
      assert.match(out.message, /Change it like this\?$/, "same Yes / Try another / Cancel question");
      assert.ok(Array.isArray(out.proposal.changes) && out.proposal.days, "same shape the confirm step saves");
      for (const id of PROTECTED) assert.deepEqual(find(out.proposal.days, id), find(before, id), id);
      assert.ok(!out.proposal.changes.some((c) => PROTECTED.includes(c.id)));
    });

    test(`${kind}: after Yes, Undo restores the original plans`, () => {
      const before = fixture({ lunch: false });
      const out = proposeAlternative(before, request(kind), kind, OPTS);
      const settings = defaults();
      const undo = adjustmentRecord(before, out.proposal.days, {}, {}, "Try another: " + kind, settings);
      const undone = undoAdjustment({ days: structuredClone(out.proposal.days), settings, daySettings: {}, undo });
      assert.equal(undone.ok, true, undone.message);
      assert.deepEqual(undone.data.days, before, "Undo restores the original plans");
    });
  }

  test("reorder, usual-slot and unscheduled still show the current task in their proposals", () => {
    for (const kind of ["reorder", "usual-slot", "unscheduled"]) {
      const essay = find(proposeAlternative(fixture(), request(kind), kind, OPTS).proposal.days, "Essay");
      assert.ok(essay, kind + " still shows the current task");
      assert.equal(essay.title, "Essay");
    }
  });

  test("overflow from reorder and morning-replan goes to tomorrow or stays unscheduled without touching tomorrow's records", () => {
    for (const kind of ["reorder", "morning-replan"]) {
      const days = fixture();
      // Fill today's tail so Report cannot fit before 23:00, but tomorrow has a gap.
      days[date].push(task("Late", 1260, 60));
      days[date].find((t) => t.id === "Report").start = 1300;
      const moved = proposeAlternative(days, request("reorder"), kind, OPTS);
      const report = find(moved.proposal.days, "Report");
      assert.ok(report.deferred || moved.proposal.days[next].some((t) => t.id === "Report") || report.start < 1380, kind);
      for (const id of PROTECTED) assert.deepEqual(find(moved.proposal.days, id), find(days, id), `${kind}: ${id}`);

      // Tomorrow fully blocked: leave it unscheduled, never overlap tomorrow's fixed event.
      const full = fixture();
      full[date].push(task("Late", 1260, 60));
      full[next].push(task("Block", 660, 780, { type: "activity", locked: true }));
      const blocked = proposeAlternative(full, { date, taskId: "Essay", start: 1330 }, kind, OPTS);
      if (blocked.proposal) {
        for (const id of [...PROTECTED, "Block"]) assert.deepEqual(find(blocked.proposal.days, id), find(full, id), `${kind}: ${id}`);
      }
    }
  });

  test("part 2 of a split lands outside tomorrow's fixed-event buffer and completed record", () => {
    const out = proposeAlternative(fixture(), request("split"), "split", OPTS);
    assert.equal(out.kind, "split");
    const days = out.proposal.days, part2 = days[next].find((t) => t.id === "Essay-part2");
    assert.ok(part2, "part 2 is placed tomorrow");
    const gym = find(days, "TGym"), done = find(days, "TDone");
    assert.ok(part2.start + part2.duration + 60 <= gym.start || part2.start >= gym.start + gym.duration + 60,
      "60-minute buffer on both sides of tomorrow's fixed event");
    assert.ok(part2.start >= done.start + done.duration || part2.start + part2.duration <= done.start, "no overlap with the completed record");
  });

  test("the 60-minute fixed-event buffer applies to the next day when overflow moves there", () => {
    const days = fixture();
    days[date].push(task("Late", 1260, 60));
    days[next] = [task("TGym", 480, 60, { type: "activity", locked: true })];
    const out = proposeAlternative(days, { date, taskId: "Essay", start: 1330 }, "reorder", OPTS);
    for (const t of out.proposal.days[next].filter((x) => x.id !== "TGym")) {
      assert.ok(t.start >= 540 + 60 || t.start + t.duration + 60 <= 480, `${t.id} respects the buffer`);
    }
  });
});

describe("the Try another button", () => {
  const uiFixture = () => ({ [DAY]: [
    item("Done", 540, 30, { done: true, completedDate: DAY }), // completed, never moves
    item("Essay", 600, 60, { postponed: 3, idealStart: 960 }), // the task the user moves to 11:00
    item("Review", 720, 60, { deadline: "2026-10-20", priority: 1 }),
    item("Report", 800, 60, { deadline: "2026-10-14", priority: 1 }),
    item("Gym", 1000, 60, { type: "activity", locked: true }), // fixed, never moves
  ] });
  const uiRequest = { date: DAY, taskId: "Essay", start: 660 };
  const uiOptions = { choice: "archive", now: { date: DAY, minute: 480 } };
  const expectedDays = (kind) => proposeAlternative(uiFixture(), uiRequest, kind, uiOptions).proposal.days;
  // What the question must say about each alternative (the "Why" line).
  const SAYS = {
    reorder: /reordered by deadline and priority/,
    split: /split across today and tomorrow/,
    "usual-slot": /usually done/,
    unscheduled: /left unscheduled/,
    "drop-or-archive": /postponed 3 times\. Drop it, archive it, or keep it\? Yes archives it/,
    "morning-replan": /replanned once this morning/,
  };
  const sameProtected = (days) => {
    for (const id of ["Done", "Gym"]) assert.deepEqual(findTask(days, id), findTask(uiFixture(), id), `${id} is untouched`);
  };
  const newRig = () => uiRig({ days: uiFixture() });

  // Press "Try another" until the alternative at `position` (0-based) is on screen.
  function showAlternative(r, position) {
    for (let step = 0; step <= position; step++) r.click("another");
    const lines = r.lines();
    assert.match(r.output(), /<h2>Change it like this\?<\/h2>/);
    assert.deepEqual(r.buttons(), ["Yes", "Try another", "Cancel"]);
    assert.ok(lines.length >= 1 && lines.length <= 3, JSON.stringify(lines));
    assert.match(lines[2], SAYS[ALTERNATIVES[position]], lines.join(" | "));
    return lines;
  }

  for (const [position, kind] of ALTERNATIVES.entries()) {
    test(`alternative ${position + 1} (${kind}) is shown by Try another and Yes saves exactly that one`, async () => {
      const r = newRig();
      try {
        await r.open();
        const typed = r.nodes.get("wb-expression").value;
        const lines = showAlternative(r, position);
        // The current task context survives: same task, same input, nothing saved yet.
        assert.match(lines[0], /^Moves: Essay, Oct 13 10:00 → /);
        assert.equal(r.nodes.get("wb-expression").value, typed);
        assert.equal(r.saves, 0);
        assert.deepEqual(r.branch.days, uiFixture(), "previewing changes nothing");
        assert.deepEqual(r.proposal.result.days, expectedDays(kind), "the question describes the proposal Yes saves");
        r.click("confirm");
        assert.equal(r.saves, 1);
        assert.deepEqual(r.branch.days, expectedDays(kind));
        sameProtected(r.branch.days);
        assert.deepEqual(findTask(r.branch.days, "Done"), uiFixture()[DAY][0], "completed record kept");
      } finally { r.close(); }
    });
  }

  test("Try another walks the alternatives in the listed order and then runs out", async () => {
    const r = newRig();
    try {
      await r.open();
      for (const [position, kind] of ALTERNATIVES.entries()) {
        r.click("another"); // one press per step from the alternative on screen
        assert.match(r.lines()[2], SAYS[kind], `${position + 1}: ${kind}`);
        assert.deepEqual(r.buttons(), ["Yes", "Try another", "Cancel"]);
        assert.deepEqual(r.proposal.result.days, expectedDays(kind), kind);
        sameProtected(r.proposal.result.days);
      }
      assert.ok(r.nodes.get("wb-another").disabled, "nothing is left after the last alternative");
      assert.match(r.lines()[2], /No other options are left\.$/);
      assert.equal(r.saves, 0);
      assert.deepEqual(r.branch.days, uiFixture());
    } finally { r.close(); }
  });

  test("Cancel after Try another keeps the original plans", async () => {
    const r = newRig();
    try {
      await r.open();
      showAlternative(r, 0);
      r.click("back"); // Cancel
      assert.equal(r.saves, 0);
      assert.deepEqual(r.branch.days, uiFixture());
      assert.doesNotMatch(r.output(), /Change it like this\?/);
    } finally { r.close(); }
  });

  test("an alternative that leaves the task unscheduled still waits for Yes and never touches fixed or completed items", async () => {
    const r = newRig();
    try {
      await r.open();
      showAlternative(r, ALTERNATIVES.indexOf("unscheduled"));
      assert.equal(r.saves, 0);
      r.click("confirm");
      assert.equal(findTask(r.branch.days, "Essay").deferred, true);
      sameProtected(r.branch.days);
    } finally { r.close(); }
  });

  test("after a nearby time fits, Try another does not offer the leftover nearby time", async () => {
    // The planner's nearby times answer only the time that did not fit; once one of them gives a savable
    // proposal, the next proposal comes from the default-rules alternatives instead.
    const r = uiRig({ days: { [DAY]: [
      item("Reading", 540, 30, { done: true, completedDate: DAY }),
      item("Essay", 600, 60),
      item("Review", 720, 60),
      item("Gym", 840, 60, { type: "activity", locked: true }),
    ] } });
    try {
      r.click("task-actions");
      r.type("today at 2:30 pm"); // inside the fixed Gym event
      await tick();
      assert.match(r.output(), /<h2>This time does not fit yet<\/h2>/);
      assert.ok(r.offered >= 2, "the planner offers more than one nearby time");
      // Try another here checks the planner's nearest free time, and the question says so.
      assert.match(r.lines()[2], /^A nearby time is free\. Try another to check .+\.$/);
      r.click("another");
      await tick();
      assert.match(r.output(), /<h2>Change it like this\?<\/h2>/);
      assert.doesNotMatch(r.lines().join(" "), /Try another to check/);
      assert.doesNotMatch(r.lines().join(" "), /not built/);
    } finally { r.close(); }
  });

  test("Try another says why a skipped alternative is unavailable", () => {
    const days = { [DAY]: [item("Essay", 600, 60), item("Review", 720, 60, { deadline: "2026-10-20" })] };
    const entry = { date: DAY, task: days[DAY][0] };
    const alt = nextAlternative(days, entry, 660, 1, "", { now: { date: DAY, minute: 15 * 60 } });
    assert.ok(alt, "an alternative is offered");
    assert.match(alt.ruled.lead, /was skipped: /);
  });

  describe("on a request for another day", () => {
    const REASON = "Other options need a same-day time.";

    function crossDay(targetStart) {
      const days = demo().days;
      const sql = Object.values(days).flat().find((t) => t.title.startsWith("SQL practice"));
      const out = moveIntent(structuredClone(days), defaults(), { taskId: sql.id, targetDate: "2026-10-13", targetStart });
      const ruled = applyDefaultRules(out, days, { date: "2026-10-12", task: sql }, "2026-10-13", targetStart);
      return defaultRulesQuestion(ruled, days, sql.id, "2026-10-12", { noAlternative: true, otherDay: true });
    }

    test("the question says once, within three lines, why Try another is unavailable", () => {
      // 11:00 does not fit tomorrow, so the nearest time is offered; 18:00 takes the plain path.
      for (const at of [660, 1080]) {
        const question = crossDay(at);
        assert.ok(question.lines.length <= 3);
        assert.equal(question.lines.join(" ").split(REASON).length - 1, 1, `reason appears once for ${at}`);
        assert.match(question.lines[2], /Other options need a same-day time\.$/);
        assert.doesNotMatch(question.lines[2], /Why: Other options/);
        assert.deepEqual(question.buttons, ["Yes", "Try another", "Cancel"]);
      }
    });

    test("the workbench disables Try another and renders the reason for such a request", async () => {
      const src = await readFile(new URL("../workbench.js", import.meta.url), "utf8");
      assert.match(src, /disabled\("another", "Try another", !next && !preview\.nextAlt\)/);
      assert.match(src, /otherDay: !!askedEntry && askedEntry\.date !== whenText\.slice\(0, 10\)/);
    });
  });
});
