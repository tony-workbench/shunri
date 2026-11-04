import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { archivedTasks, proposeRestore, proposeAlternative } from "../schedule-context.js";
import { validateMutation, adjustmentRecord, undoAdjustment } from "../workflow.js";
import { defaults } from "../storage.js";
import { uiRig } from "./helpers.mjs";

const date = "2026-10-12", next = "2026-10-13";
const task = (id, start, duration, extra = {}) => ({ id, title: id, start, duration, type: "task", done: false, rest: 10, tags: [], dependencies: [], bufferBefore: 0, bufferAfter: 0, ...extra });
const archivedEssay = () => task("Essay", 600, 60, { deferred: true, archived: true, postponed: 3 });

describe("archived tasks and restore proposals", () => {
  test("archived tasks are listed from every day, oldest first", () => {
    const days = { [next]: [archivedEssay()], [date]: [task("A", 540, 30, { deferred: true, archived: true }), task("B", 600, 30, { deferred: true })] };
    assert.deepEqual(archivedTasks(days).map((e) => e.task.id + "@" + e.date), ["A@" + date, "Essay@" + next]);
  });

  test("archiving through Try another produces a task the Archived list shows", () => {
    const days = { [date]: [task("Essay", 600, 60, { postponed: 3 })], [next]: [] };
    const out = proposeAlternative(days, { date, taskId: "Essay", start: 630 }, "drop-or-archive", { postponements: 3, choice: "archive" });
    assert.deepEqual(archivedTasks(out.proposal.days).map((e) => e.task.id), ["Essay"]);
  });

  test("restore puts the task in the first free gap from its old time", () => {
    const days = { [date]: [archivedEssay(), task("Other", 600, 60)], [next]: [] };
    const out = proposeRestore(days, "Essay", { date, minute: 540 });
    assert.equal(out.status, "ok");
    assert.equal(out.to.date, date);
    assert.ok(out.to.start >= 670, "after Other plus the 10-minute rest");
    const restored = out.days[date].find((t) => t.id === "Essay");
    assert.ok(!restored.archived && !restored.deferred);
    assert.ok(days[date][0].archived, "input is not mutated");
  });

  test("restore never goes before now and looks past a full day, within two weeks", () => {
    const full = task("Full", 540, 840, { locked: true });
    const days = { [date]: [archivedEssay(), full], [next]: [] };
    assert.equal(proposeRestore(days, "Essay", { date, minute: 540 }).to.date, next);
    const late = proposeRestore({ [date]: [archivedEssay()], [next]: [] }, "Essay", { date, minute: 900 });
    assert.equal(late.to.date, date);
    assert.ok(late.to.start >= 900);
    const busy = {};
    for (let i = 0; i <= 14; i++) busy[`2026-10-${12 + i}`] = [task("Full" + i, 540, 840, { locked: true })];
    busy[date].push(archivedEssay());
    const none = proposeRestore(busy, "Essay", { date, minute: 540 });
    assert.equal(none.status, "none");
    assert.match(none.message, /stays archived/);
    assert.equal(proposeRestore(days, "Nope").status, "none");
  });

  test("restore finds a gap when the old day is long past, and the saved restore is undoable", () => {
    const old = "2026-09-01", now = { date: "2026-10-20", minute: 600 };
    const settings = defaults();
    const days = { [old]: [archivedEssay()], [now.date]: [] };
    const out = proposeRestore(days, "Essay", now, settings);
    assert.equal(out.status, "ok");
    assert.ok(out.to.date >= now.date && out.to.date <= "2026-11-03");
    if (out.to.date === now.date) assert.ok(out.to.start >= now.minute);
    // The same steps as the app's save: validate, record the adjustment, save, then undo.
    assert.equal(validateMutation(days, out.days, settings).status, "ok");
    const undo = adjustmentRecord(days, out.days, {}, {}, "Restore task", settings);
    const back = undoAdjustment({ days: structuredClone(out.days), settings, undo, calendar: {} });
    assert.equal(back.ok, true, back.message);
    assert.deepEqual(archivedTasks(back.data?.days || back.days).map((e) => e.task.id + "@" + e.date), ["Essay@" + old]);
  });
});

describe("Archived screen", () => {
  // The workbench with an API whose restore uses the production restore planner.
  function archiveRig(days) {
    const branch = { exampleOrigin: date, days, settings: defaults(), undo: null };
    let restores = 0, undos = 0;
    const r = uiRig({ branch, date, selected: null, extraApi: (context) => {
      context.mode = "demo";
      context.calendarStatus = { mock: true };
      const plan = (e, now) => proposeRestore(branch.days, e.task.id, now, branch.settings);
      return {
        movable: () => false, select() {}, archived: () => archivedTasks(branch.days),
        restoreProposal: (e, now) => { const out = plan(e, now); return out.status === "ok" ? out.to : false; },
        previewRestore: (e, now) => { const out = plan(e, now); return out.status === "ok" ? out.to : null; },
        restore(e, now) {
          const out = plan(e, now);
          if (out.status !== "ok") return false;
          restores++; branch.days = out.days; branch.undo = { id: "restore", presentation: { targetId: e.task.id } }; context.revision++; return out.to;
        },
        undo() { undos++; branch.days[date] = [archivedEssay(), ...branch.days[date].filter((t) => t.id !== "Essay")]; branch.undo = null; return true; },
      };
    } });
    Object.defineProperties(r, { restores: { get: () => restores }, undos: { get: () => undos } });
    r.days = () => branch.days;
    return r;
  }
  const withRig = (days, run) => () => { const r = archiveRig(days); try { return run(r); } finally { r.close(); } };
  const withEssay = (run) => withRig({ [date]: [task("Keep", 540, 30), archivedEssay()], [next]: [] }, run);

  test("home offers Archived only when something is archived", withRig({ [date]: [task("Keep", 600, 30)] }, (r) => {
    r.bench.home();
    assert.ok(!r.nodes.has("wb-archived"));
  }));

  test("Restore then Undo works from the Archived list", withRig({ [date]: [task("Keep", 540, 30), archivedEssay()] }, (r) => {
    r.bench.home();
    assert.ok(r.nodes.has("wb-archived"));
    assert.match(r.html(), /Archived \(1\)/);
    r.click("archived");
    assert.equal(r.bench.phase(), "archived");
    assert.match(r.html(), /Essay/);
    r.click("restore-0");
    r.click("restore-yes");
    assert.equal(r.restores, 1);
    assert.equal(r.bench.phase(), "restored");
    assert.ok(r.days()[date].some((t) => t.id === "Essay" && !t.archived && !t.deferred));
    assert.ok(r.nodes.has("wb-undo-restore"));
    r.click("undo-restore");
    assert.equal(r.undos, 1);
    assert.equal(archivedTasks(r.days()).length, 1);
  }));

  test("Restore first shows the landing day and time and asks Change it like this?; nothing is saved yet", withEssay((r) => {
    r.bench.home(); r.click("archived"); r.click("restore-0");
    assert.equal(r.bench.phase(), "restore-proposal");
    assert.equal(r.restores, 0);
    assert.match(r.html(), /Change it like this\?/);
    assert.match(r.html(), /Essay would come back on .* at \d/);
    assert.ok(r.nodes.has("wb-restore-yes") && r.nodes.has("wb-restore-cancel"));
    assert.equal(archivedTasks(r.days()).length, 1);
    const lines = r.html().replace(/<button[\s\S]*?<\/button>/g, "").replace(/<p class="step-label">[\s\S]*?<\/p>/, "")
      .split(/<\/p>|<\/h1>|<br>/).filter((l) => l.replace(/<[^>]+>/g, "").trim());
    assert.ok(lines.length <= 3, "three-line limit: " + JSON.stringify(lines));
  }));

  test("Yes on the restore proposal saves it and Undo works; Cancel saves nothing", withEssay((r) => {
    r.bench.home(); r.click("archived"); r.click("restore-0"); r.click("restore-cancel");
    assert.equal(r.restores, 0);
    assert.equal(r.bench.phase(), "archived");
    assert.equal(archivedTasks(r.days()).length, 1);
    r.click("restore-0"); r.click("restore-yes");
    assert.equal(r.restores, 1);
    assert.equal(r.bench.phase(), "restored");
    r.click("undo-restore");
    assert.equal(r.undos, 1);
  }));

  test("each archived row says where Restore would put the task, before anything is saved", withRig({ [date]: [task("Keep", 540, 30), archivedEssay()] }, (r) => {
    r.bench.home();
    r.click("archived");
    assert.match(r.html(), /Would return [^<]+ at [^<]+/);
    assert.equal(r.restores, 0);
  }));
});
