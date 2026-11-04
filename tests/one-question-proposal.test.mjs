import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaults } from "../storage.js";
import { moveIntent } from "../intent-planner.js";
import { proposeMoveToDay, proposeReschedule } from "../default-rules.js";
import { applyDefaultRules, proposalQuestion, usesDefaultRules } from "../workbench.js";
import { validateMutation } from "../workflow.js";
import { DAY, tick, item, findTask, uiRig, PROPOSAL_TODAY, PROPOSAL_TOMORROW, proposalItem, proposalFixture } from "./helpers.mjs";

// A proposal is one question, "Change it like this?", answered with Yes, Try another or Cancel.
// It says in at most three lines what moves, what stays and why.
const TODAY = PROPOSAL_TODAY, TOMORROW = PROPOSAL_TOMORROW;
const BUTTONS = ["Yes", "Try another", "Cancel"];
const target = { title: "Essay", from: { date: TODAY, start: 600 }, to: { date: TODAY, start: 660 } };
const sansQuestion = (message) => message.replace(/\s*Change it like this\?$/, "");

describe("the question text", () => {
  test("says what moved, what stayed and why, in at most three lines", () => {
    const ask = proposalQuestion({ target: { title: "Essay", from: { date: DAY, start: 600 }, to: { date: DAY, start: 660 } },
      moved: 2, fixed: 1, done: 1, reference: DAY });
    assert.equal(ask.title, "Change it like this?");
    assert.deepEqual(ask.buttons, BUTTONS);
    assert.equal(ask.canSave, true);
    assert.ok(ask.lines.length <= 3);
    assert.match(ask.lines[0], /^Moves: Essay, Oct 13 10:00 → Oct 13 11:00, and 1 later task in the same order\.$/);
    assert.match(ask.lines[1], /^Stays: 1 fixed event and 1 completed task\. Fixed events and completed work never move\.$/);
    assert.match(ask.lines[2], /^Why: /);
  });

  test("a conflict cannot be saved and names the time Try another would check", () => {
    const conflict = proposalQuestion({ conflict: true, reason: "Gym is fixed at this time.", next: { date: DAY, start: 960 }, reference: DAY });
    assert.equal(conflict.canSave, false);
    assert.ok(conflict.lines.length <= 3);
    assert.match(conflict.lines[0], /^Nothing moves: Gym is fixed/);
    assert.match(conflict.lines[2], /Try another to check Oct 13 16:00\./);
  });

  test("the Moves line names the later tasks and says when one moves to tomorrow", () => {
    const ask = proposalQuestion({ target, moved: 3, reference: TODAY, later: [
      { title: "Review", from: { date: TODAY, start: 720 }, to: { date: TODAY, start: 780 } },
      { title: "Draft", from: { date: TODAY, start: 900 }, to: { date: TOMORROW, start: 550 } },
    ] });
    assert.equal(ask.lines.length, 3);
    assert.equal(ask.lines[0], "Moves: Essay, Oct 27 10:00 → Oct 27 11:00; Review follows in the same order; Draft moves to tomorrow 09:10.");
    assert.doesNotMatch(ask.lines.join(" "), /\bplans?\b/, "one word, task, for the item");
  });

  test("the Stays line counts breaks and the 10-minute rests that are part of the plan", () => {
    const ask = proposalQuestion({ target, moved: 1, later: [], fixed: 1, breaks: 1, done: 2, rest: 10, reference: TODAY });
    assert.equal(ask.lines[1], "Stays: 1 fixed event, 1 break and 2 completed tasks. 10-minute rests stay before and after each task; fixed events and completed work never move.");
  });

  test("the Why line keeps its label and gives the actual reason of this change, within three lines", () => {
    const warned = proposalQuestion({ target, moved: 1, later: [], note: "\"Essay\" does not fit before 23:00 today.", reference: TODAY });
    assert.equal(warned.lines.length, 3, "a warning replaces the default reason instead of adding a fourth line");
    assert.equal(warned.lines[2], "Why: \"Essay\" does not fit before 23:00 today.");
    const pushed = proposalQuestion({ target, moved: 2, reference: TODAY,
      later: [{ title: "Review", from: { date: TODAY, start: 720 }, to: { date: TODAY, start: 780 } }] });
    assert.equal(pushed.lines[2], "Why: at its new time Essay would run into Review, so later tasks move back in order with their lengths unchanged.");
    const free = proposalQuestion({ target, moved: 1, later: [], reference: TODAY });
    assert.equal(free.lines[2], "Why: Oct 27 11:00 is free, so nothing else has to move.");
  });

  test("a cause given as the note stays inside the three-line limit", () => {
    const q = proposalQuestion({ target: { title: "a", from: { date: TODAY, start: 540 }, to: { date: TODAY, start: 560 } },
      moved: 2, note: "Why: b moved because of its habit window." });
    assert.equal(q.lines.length, 3);
    assert.ok(q.lines[2].startsWith("Why: b moved because of its habit window."));
  });

  test("with no alternative left, the question says so, within three lines", () => {
    const ask = proposalQuestion({ target, moved: 1, later: [], noAlternative: true, reference: TODAY });
    assert.deepEqual(ask.buttons, BUTTONS);
    assert.equal(ask.canSave, true);
    assert.ok(ask.lines.length <= 3);
    assert.match(ask.lines[2], /^Why: .+ No other options are left\.$/);
    assert.doesNotMatch(ask.lines.join(" "), /No other proposal fits/);
  });

  test("for a move to another day, says why Try another is off", () => {
    const ask = proposalQuestion({ target: { id: "Essay", title: "Essay", from: { date: DAY, start: 600 }, to: { date: "2026-10-14", start: 600 } },
      moved: 1, later: [], noAlternative: true, otherDay: true, reference: DAY });
    assert.deepEqual(ask.buttons, BUTTONS);
    assert.ok(ask.lines.length <= 3);
    assert.match(ask.lines[2], /Other options need a same-day time\.$/);
  });
});

describe("answering the question on the screen", () => {
  const dayWithFixedEvent = () => ({ [DAY]: [
    item("Reading", 540, 30, { done: true, completedDate: DAY }), // completed, stays
    item("Essay", 600, 60),
    item("Review", 720, 60),
    item("Gym", 840, 60, { type: "activity", locked: true }), // fixed, stays
  ] });

  test("saves a new time within 3 clicks and leaves fixed and completed work alone", async () => {
    const r = uiRig({ days: dayWithFixedEvent() });
    try {
      await r.open(); // opens "When would you like to move it?" and types a time
      assert.deepEqual(r.buttons(), BUTTONS);
      const lines = r.lines();
      assert.ok(lines.length >= 1 && lines.length <= 3, JSON.stringify(lines));
      assert.equal(r.textLines(), lines.length + 1, "only the question lines and the empty error slot");
      assert.match(lines[0], /^Moves: Essay, Oct 13 10:00 → Oct 13 11:00/);
      assert.match(lines[1], /^Stays: 1 fixed event and 1 completed task\./);
      assert.equal(r.saves, 0, "previewing does not save");
      r.click("confirm"); // Yes
      assert.equal(r.saves, 1);
      assert.ok(r.clicks <= 3, `${r.clicks} clicks`);
      const saved = new Map(r.branch.days[DAY].map((t) => [t.id, t]));
      assert.equal(saved.get("Essay").start, 660);
      assert.deepEqual(saved.get("Gym"), dayWithFixedEvent()[DAY][3], "the fixed event did not move");
      assert.deepEqual(saved.get("Reading"), dayWithFixedEvent()[DAY][0], "completed work did not move");
    } finally { r.close(); }
  });

  test("Cancel keeps the original plans, also after Try another showed an alternative", async () => {
    const r = uiRig({ days: dayWithFixedEvent() }), before = structuredClone(r.branch.days);
    try {
      await r.open();
      assert.doesNotMatch(r.lines().join(" "), /not built/);
      if (!r.nodes.get("wb-another").disabled) r.click("another");
      assert.equal(r.saves, 0);
      assert.deepEqual(r.buttons(), BUTTONS);
      assert.ok(r.lines().length <= 3);
      r.click("back"); // Cancel
      assert.equal(r.saves, 0);
      assert.deepEqual(r.branch.days, before);
      assert.doesNotMatch(r.output(), /Change it like this\?/);
    } finally { r.close(); }
  });

  test("a time that does not fit cannot be saved; Try another shows the next proposal, then Yes saves it", async () => {
    const r = uiRig({ days: dayWithFixedEvent() });
    try {
      r.click("task-actions");
      r.type("today at 2:30 pm"); // inside the fixed Gym event
      await tick();
      assert.match(r.output(), /<h2>This time does not fit yet<\/h2>/);
      assert.deepEqual(r.buttons(), BUTTONS);
      assert.ok(r.nodes.get("wb-confirm").disabled, "Yes is not offered for a plan that breaks the rules");
      assert.ok(r.lines().length <= 3);
      assert.match(r.lines()[0], /^Nothing moves: /);
      const offered = r.lines()[2].match(/Try another to check (.+)\./)?.[1];
      assert.ok(offered, r.lines().join(" | "));
      r.click("another");
      await tick();
      assert.match(r.output(), /<h2>Change it like this\?<\/h2>/);
      assert.deepEqual(r.buttons(), BUTTONS);
      assert.ok(r.lines()[0].includes(`→ ${offered}`), r.lines()[0]);
      r.click("confirm");
      assert.equal(r.saves, 1);
      assert.ok(r.clicks <= 3, `${r.clicks} clicks`);
      assert.deepEqual(findTask(r.branch.days, "Gym"), dayWithFixedEvent()[DAY][3]);
    } finally { r.close(); }
  });
});

describe("the question for the five default rules", () => {
  const rigFor = (days) => uiRig({ days, date: TODAY, selected: "t2", now: "2026-10-27T15:00:00Z" });
  const chosen = { date: TODAY, taskId: "t2", delay: 40 };

  test("postponing task 2 by 40 minutes asks about the default-rules proposal, and Yes saves exactly it", async () => {
    const before = proposalFixture();
    const expected = proposeReschedule(proposalFixture(), chosen);
    assert.equal(expected.status, "warning");
    const r = rigFor(proposalFixture());
    try {
      await r.open("today at 10:50 am");
      assert.deepEqual(r.buttons(), BUTTONS);
      const lines = r.lines();
      assert.equal(lines.length, 3, JSON.stringify(lines));
      // What moves: t2 to its new time, then t3 and t4 (t4 to tomorrow), as the proposal says.
      assert.deepEqual(expected.proposal.changes.map((c) => c.id), ["t2", "t3", "t4"]);
      const t4 = expected.proposal.changes[2].to;
      assert.equal(t4.date, TOMORROW);
      assert.equal(lines[0], `Moves: t2, Oct 27 10:10 → Oct 27 10:50; t3 follows in the same order; t4 moves to tomorrow ${String(t4.start / 60 | 0).padStart(2, "0")}:${String(t4.start % 60).padStart(2, "0")}.`);
      // What stays: the proposal's unchanged fixed events and completed work, and the 10-minute rests.
      assert.equal(lines[1], "Stays: 2 fixed events and 1 completed task. 10-minute rests stay before and after each task; fixed events and completed work never move.");
      // Why: the proposal's own warning, not a generic reason.
      assert.ok(lines[2].startsWith(`Why: ${sansQuestion(expected.message)}`), lines[2]);
      assert.doesNotMatch(lines[2], /not built/);
      assert.match(lines[2], /"t4" does not fit before 23:00 today\. It moves to tomorrow\./);
      assert.equal(r.saves, 0, "previewing does not save");

      r.click("confirm"); // Yes
      assert.equal(r.saves, 1);
      assert.ok(r.clicks <= 3, `${r.clicks} clicks`);
      assert.deepEqual(r.branch.days, expected.proposal.days, "Yes saves exactly the proposal");
      // The app's own save gate accepts this proposal.
      assert.equal(validateMutation(before, expected.proposal.days, defaults()).status, "ok");
    } finally { r.close(); }
  });

  test("a task no gap tomorrow holds is reported as unscheduled and saved as such", async () => {
    const blocked = () => ({ ...proposalFixture(), [TOMORROW]: [proposalItem("offsite", 480, 960, { locked: true, type: "activity" })] });
    const expected = proposeReschedule(blocked(), chosen);
    assert.deepEqual(expected.proposal.unscheduled, ["t4"]);
    const r = rigFor(blocked());
    try {
      await r.open("today at 10:50 am");
      const lines = r.lines();
      assert.ok(lines.length <= 3, JSON.stringify(lines));
      assert.equal(lines[0], "Moves: t2, Oct 27 10:10 → Oct 27 10:50; t3 follows in the same order; t4 stays unscheduled.");
      assert.ok(lines[2].startsWith(`Why: ${sansQuestion(expected.message)}`), lines[2]);
      assert.doesNotMatch(lines[2], /not built/);
      assert.match(lines[2], /It stays unscheduled\./);
      r.click("confirm");
      assert.equal(r.saves, 1);
      assert.deepEqual(r.branch.days, expected.proposal.days);
      assert.equal(findTask(r.branch.days, "t4").deferred, true);
    } finally { r.close(); }
  });
});

// A move to another day that breaks the 60-minute fixed-event buffer must not end on the rule alone:
// the closest free time that keeps the buffer is the next step, in the same line the same-day case uses.
describe("a cross-day move inside the fixed-event buffer", () => {
  const fixture = () => ({
    [TODAY]: [item("t1", 540, 60, { done: true, completedDate: TODAY }), item("t2", 610, 60)],
    [TOMORROW]: [item("visit", 720, 60, { locked: true, type: "activity" })],
  });
  // The planner's answer for a time it cannot give, with no next step of its own.
  function ask(start, days = fixture()) {
    const before = structuredClone(days);
    const out = { status: "conflict", days: structuredClone(days), changes: [], alternatives: [], warnings: [], unscheduled: [],
      conflicts: [{ message: "Too close to a fixed event.", ids: ["t2"] }] };
    const ruled = applyDefaultRules(out, days, { date: TODAY, task: days[TODAY][1] }, TOMORROW, start);
    assert.deepEqual(days, before, "nothing is changed by the check");
    return { days, out, ruled };
  }
  const nearestFor = (days, start) => proposeMoveToDay(days, { date: TODAY, taskId: "t2", targetDate: TOMORROW, start }).nearest;
  // 11:30 is 30 minutes before the 12:00 event.

  test("offers the closest time that keeps the buffer", () => {
    const { days, out, ruled } = ask(690);
    const nearest = nearestFor(days, 690);
    assert.ok(Number.isInteger(nearest) && nearest >= 780 + 60, "the buffer after the event is kept");
    assert.equal(ruled, null);
    assert.equal(out.status, "conflict");
    assert.deepEqual(out.alternatives.map((a) => [a.targetDate, a.targetStart]), [[TOMORROW, nearest]]);
    const q = proposalQuestion({ conflict: true, reason: out.conflicts[0].message, next: { date: TOMORROW, start: nearest }, reference: TODAY });
    assert.deepEqual(q.buttons, BUTTONS);
    assert.ok(q.lines.length <= 3);
    assert.match(q.lines[2], /^A nearby time is free\. Try another to check .+\.$/);
    assert.equal(q.canSave, false);
  });

  test("the offered time is itself savable", () => {
    const { days, out } = ask(690);
    const next = out.alternatives[0];
    assert.ok(next, "a next step is offered");
    const planned = moveIntent(structuredClone(days), defaults(), { taskId: "t2", targetDate: next.targetDate, targetStart: next.targetStart });
    const again = applyDefaultRules(planned, days, { date: TODAY, task: days[TODAY][1] }, next.targetDate, next.targetStart);
    assert.equal(planned.status, "ok");
    assert.equal(again.status, "ok");
  });

  test("with the real planner's answer, the nearest time comes first and the planner's own alternatives stay behind it", () => {
    const days = fixture(), entry = { date: TODAY, task: days[TODAY][1] };
    const out = moveIntent(structuredClone(days), defaults(), { taskId: "t2", targetDate: TOMORROW, targetStart: 690 });
    assert.notEqual(out.status, "ok");
    const own = (out.alternatives || []).map((a) => [a.targetDate, a.targetStart]);
    assert.equal(applyDefaultRules(out, days, entry, TOMORROW, 690), null);
    const nearest = nearestFor(days, 690);
    assert.deepEqual([out.alternatives[0].targetDate, out.alternatives[0].targetStart], [TOMORROW, nearest]);
    assert.match(out.alternatives[0].label, /^Move to /);
    const rest = out.alternatives.slice(1).map((a) => [a.targetDate, a.targetStart]);
    assert.deepEqual(rest, own.filter(([d, s]) => !(d === TOMORROW && s === nearest)));
  });

  test("on the screen, shows the nearby-time line, and Try another reaches that time", async () => {
    const r = uiRig({ days: fixture(), date: TODAY, selected: "t2", now: "2026-10-27T00:00:00Z" });
    try {
      r.click("task-actions");
      r.type("2026-10-28 11:30");
      await tick();
      assert.match(r.output(), /<h2>This time does not fit yet<\/h2>/);
      assert.deepEqual(r.buttons(), BUTTONS);
      const lines = r.lines();
      assert.ok(lines.length <= 3, JSON.stringify(lines));
      assert.match(lines[2], /^A nearby time is free\. Try another to check Oct 28 \d\d:\d\d\.$/);
      assert.equal(r.nodes.get("wb-confirm").disabled, true, "Yes waits for a time that fits");
      assert.equal(r.nodes.get("wb-another").disabled, false, "Try another is enabled");
      const nearest = lines[2].match(/(\d\d:\d\d)\./)[1];
      r.click("another");
      await tick();
      assert.equal(r.nodes.get("wb-expression").value, `2026-10-28 ${nearest}`, "Try another reaches the nearest time");
      assert.match(r.output(), /<h2>Change it like this\?<\/h2>/);
      assert.deepEqual(r.buttons(), BUTTONS);
      assert.equal(r.nodes.get("wb-confirm").disabled, false);
    } finally { r.close(); }
  });

  test("offers no nearby time when the next day has none that keeps the buffer", () => {
    const days = fixture();
    days[TOMORROW] = [360, 480, 600, 720, 840, 960, 1080, 1200].map((s, i) => item("e" + i, s, 60, { locked: true, type: "activity" }));
    const { out, ruled } = ask(690, days);
    assert.equal(ruled, null);
    assert.deepEqual(out.alternatives, []);
    assert.equal(proposalQuestion({ conflict: true, reason: "x", reference: TODAY }).lines[2], "Type another time, or Cancel.");
  });

  test("the editor's cross-day move goes through the same step", async () => {
    const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
    const start = source.indexOf("const result = draft.lockOnMove ? lockManualMove(moved, task.id) : moved;");
    assert.ok(start > 0 && /applyDefaultRules\(result, data\(\)\.days, entry, newDate, start\)/.test(source.slice(start, start + 600)));
  });
});

// The Why line comes from the cause the planner recorded for each moved task.
describe("the Why line names what set the new slot", () => {
  const changesFor = (days, id, start) => proposeReschedule(days, { date: TODAY, taskId: id, start }).proposal.changes;
  const screenLines = async (days) => {
    const r = uiRig({ days, date: TODAY, selected: "a", now: "2026-10-27T15:00:00Z" });
    try {
      r.click("task-actions");
      r.type("today at 9:20 am");
      await tick();
      return r.lines();
    } finally { r.close(); }
  };
  const habit = { from: 780, to: 900, ideal: 840 };

  test("names tiring when recovery after a tiring task pushed the next task", () => {
    const days = { [TODAY]: [proposalItem("a", 540, 60), proposalItem("hard", 620, 60, { tiring: true }), proposalItem("b", 700, 30)] };
    const changes = changesFor(days, "a", 560);
    const b = changes.find((c) => c.id === "b");
    // The cause is the earlier tiring task, not b (which has no tiring tag).
    assert.equal(b?.cause, "tiring", JSON.stringify(changes));
    assert.equal(b.causeTitle, "hard", JSON.stringify(changes));
  });

  test("a tiring task pushed by spacing names the earlier tiring task, and a lone one names itself", () => {
    const days = { [TODAY]: [proposalItem("a", 540, 60), proposalItem("hard", 620, 60, { tiring: true }), proposalItem("t2", 700, 60, { tiring: true })] };
    const t2 = changesFor(days, "a", 560).find((c) => c.id === "t2");
    assert.ok(t2, "t2 moves");
    assert.equal(t2.cause, "tiring");
    assert.equal(t2.causeTitle, "hard");
    // A finished task right after "hard" leaves room for a 10-minute rest but not for tiring recovery.
    const self = changesFor({ [TODAY]: [proposalItem("a", 540, 60), proposalItem("hard", 620, 60, { tiring: true }),
      proposalItem("d", 700, 30, { done: true })] }, "a", 560).find((c) => c.id === "hard");
    assert.equal(self?.cause, "tiring", JSON.stringify(self));
    assert.equal(self.causeTitle, "hard");
    const alone = changesFor({ [TODAY]: [proposalItem("a", 540, 60), proposalItem("hard", 620, 60, { tiring: true })] }, "a", 560).find((c) => c.id === "hard");
    if (alone?.cause) assert.equal(alone.causeTitle, "hard");
  });

  test("names the habit window when it, not the plain order, set the slot", () => {
    const days = { [TODAY]: [proposalItem("a", 540, 60), proposalItem("run", 700, 30, { habit })] };
    const changes = changesFor(days, "a", 560);
    assert.equal(changes.find((c) => c.id === "run")?.cause, "habit window", JSON.stringify(changes));
  });

  test("names the habit window, not 'Day is full', for a habit task with no same-day slot", () => {
    const days = { [TODAY]: [proposalItem("a", 540, 60), proposalItem("run", 700, 30, { habit: { from: 700, to: 760, ideal: 720 } }),
      proposalItem("block", 710, 60, { locked: true, type: "activity" })] };
    const run = changesFor(days, "a", 560).find((c) => c.id === "run");
    assert.ok(run && (run.to === null || run.to.date !== TODAY), JSON.stringify(run));
    assert.equal(run.cause, "habit window", JSON.stringify(run));
    assert.ok(!/Day is full/.test(run.reason), run.reason);
  });

  test("names travel time when a commute, not plain order, set the slot", () => {
    const days = { [TODAY]: [proposalItem("a", 540, 60), proposalItem("trip", 640, 30, { commute: { before: 30, after: 30 } })] };
    const trip = changesFor(days, "a", 560).find((c) => c.id === "trip");
    assert.equal(trip?.cause, "travel time", JSON.stringify(trip));
  });

  test("claims no cause when plain order explains the move", () => {
    const tagged = { [TODAY]: [proposalItem("a", 540, 60), proposalItem("b", 620, 30), proposalItem("c", 700, 30, { tiring: true })] };
    const changes = changesFor(tagged, "a", 600);
    assert.ok(changes.length > 0);
    assert.ok(changes.every((c) => c.cause === undefined), JSON.stringify(changes));
    const plain = { [TODAY]: [proposalItem("a", 540, 60), proposalItem("b", 620, 30), proposalItem("c", 700, 30)] };
    assert.ok(changesFor(plain, "a", 600).every((c) => c.cause === undefined));
  });

  test("on the proposal screen, names the earlier tiring task in three lines", async () => {
    const lines = await screenLines({ [TODAY]: [proposalItem("a", 540, 60), proposalItem("hard", 620, 60, { tiring: true }), proposalItem("b", 700, 30)] });
    assert.equal(lines.length, 3, JSON.stringify(lines));
    assert.match(lines[2], /^Why: b moved because hard is tiring and needs recovery time\./, lines[2]);
  });

  test("on the proposal screen, names the habit window", async () => {
    const lines = await screenLines({ [TODAY]: [proposalItem("a", 540, 60), proposalItem("run", 700, 30, { habit })] });
    assert.equal(lines.length, 3, JSON.stringify(lines));
    assert.match(lines[2], /^Why: run moved because of its habit window\./, lines[2]);
  });

  test("on the proposal screen, names travel time", async () => {
    const lines = await screenLines({ [TODAY]: [proposalItem("a", 540, 60), proposalItem("trip", 640, 30, { commute: { before: 30, after: 30 } })] });
    assert.equal(lines.length, 3, JSON.stringify(lines));
    assert.match(lines[2], /^Why: trip moved because its travel time needs room\./, lines[2]);
  });
});

// The home note promises what "Plan from now" previews, so the wording is tied to what really moves.
describe("the home note and Plan from now on another day", () => {
  const ORIGIN = "2026-10-12", NEXT_DAY = "2026-10-13";
  const study = (id, start) => item(id, start, 45, { rest: 10, tags: ["study"] });

  // The home screen of the example schedule, with the selected task "a" and optionally a later study task.
  function homeNote(selectedDate, laterStudy) {
    const a = { ...study("a", 660), rest: 15, planId: "p", packageId: "a" };
    const b = { ...study("b", 780), rest: 15, planId: "p", packageId: "b" };
    const branch = { exampleOrigin: ORIGIN, settings: { timeZone: "America/Los_Angeles", dayStart: 540, dayEnd: 1380 },
      days: { [selectedDate]: laterStudy ? [a, b] : [a] } };
    const r = uiRig({ branch, date: selectedDate, selected: "a", extraApi: (context) => {
      context.mode = "demo"; context.ui.selection.mode = "demo";
      return { movable: () => true, readDate: async () => {} };
    } });
    try { return r.html(); } finally { r.close(); }
  }

  test("with no later study, the note says only this task moves (any day)", () => {
    for (const selectedDate of [ORIGIN, NEXT_DAY]) {
      const html = homeNote(selectedDate, false);
      assert.match(html, /Only this task moves; later study stays where it is\./);
      assert.doesNotMatch(html, /Later study is included in the preview/);
    }
  });

  test("with later study, the note says it is included in the preview (any day)", () => {
    for (const selectedDate of [ORIGIN, NEXT_DAY]) {
      const html = homeNote(selectedDate, true);
      assert.match(html, /Later study is included in the preview\./);
      assert.doesNotMatch(html, /Only this task moves/);
    }
  });

  test("Plan from now moves later study even when the task starts on another day", () => {
    const r = moveIntent({ [ORIGIN]: [study("x", 600)], [NEXT_DAY]: [study("a", 600), study("b", 700), study("c", 800)] },
      defaults(), { taskId: "a", targetDate: ORIGIN, targetStart: 660, startFromNow: true });
    assert.equal(r.status, "ok");
    assert.deepEqual((r.changes || []).map((c) => c.id).sort(), ["a", "b", "c"]);
  });

  test("Plan from now with no later study moves only the chosen task", () => {
    const r = moveIntent({ [ORIGIN]: [study("x", 600)], [NEXT_DAY]: [study("a", 600)] },
      defaults(), { taskId: "a", targetDate: ORIGIN, targetStart: 660, startFromNow: true });
    assert.deepEqual((r.changes || []).map((c) => c.id), ["a"]);
  });

  test("Plan from now to another day uses the one-task rules; on the same day the planner keeps its answer", () => {
    assert.equal(usesDefaultRules(true, NEXT_DAY, ORIGIN), true);
    assert.equal(usesDefaultRules(true, ORIGIN, ORIGIN), false);
    assert.equal(usesDefaultRules(false, ORIGIN, ORIGIN), true);
  });
});
