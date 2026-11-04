import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createWorkbench, applyMeaningLock, fixedBadge, isFixedTask, MEANING_LOCK_NOTE } from "../workbench.js";
import { moveIntent } from "../intent-planner.js";
import { lockManualMove, markManuallyMoved } from "../task-attributes.js";
import { proposeReschedule } from "../schedule-context.js";
import { isActivity } from "../planner.js";
import { normalizeDays } from "../storage.js";
import { validateMutation, adjustmentRecord, undoAdjustment } from "../workflow.js";
import { LOCK_DATE as date, lockSettings, lockTask as make, lockMovable as movable, lockHome } from "./helpers.mjs";

// A task the user locks keeps its time. Locks come from the purpose picker or from moving a task in the
// editor, and the home screen offers Unlock for them (never for fixed events).
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("the purpose lock", () => {
  const wb = read("workbench.js");

  test("the purpose picker offers 'Lock this time' without adding a fourth answer button", () => {
    assert.match(wb, /id="meaning-lock" type="checkbox">Lock this time/);
    assert.match(wb, /A purpose tag alone leaves the time movable/);
    assert.match(wb, /question\.choices\.slice\(0,3\)/);
  });

  test("ticking 'Lock this time' locks only the proposed copy, as a user lock, and the confirmation says so", () => {
    const live = { id: "i", title: "Interview", type: "task", purpose: "interview", start: 600, duration: 60 };
    const other = { id: "o", title: "Other", type: "task", start: 700, duration: 30 };
    const proposal = { semanticBranch: { days: { "2026-10-13": [structuredClone(live), structuredClone(other)] } },
      semanticDescription: "Interview: This purpose choice will be remembered. The original time stays unchanged. Confirmation saves the local rule." };
    assert.equal(applyMeaningLock(proposal, "i"), true);
    const [mine, rest] = proposal.semanticBranch.days["2026-10-13"];
    assert.equal(mine.locked, true);
    assert.equal(mine.lockSource, "user");
    assert.match(fixedBadge(mine), />Locked by you · will not move</);
    assert.equal(rest.locked, undefined);
    assert.equal(isFixedTask(live), false, "the live plan stays movable until confirmation");
    assert.ok(proposal.semanticDescription.includes(MEANING_LOCK_NOTE));
    assert.equal(applyMeaningLock(proposal, "i"), true);
    assert.equal(proposal.semanticDescription.split(MEANING_LOCK_NOTE).length, 2, "note added once");
    assert.equal(applyMeaningLock(proposal, "missing"), false);
  });
});

describe("locking a task by moving it", () => {
  const D = "2026-10-26";
  const t = (id, start, duration, extra = {}) => ({ id, uid: `u-${id}`, title: id, start, duration, type: "task", rest: 10, ...extra });

  test("an editor time change locks the task in the saved proposal only", () => {
    const days = { [D]: [t("a", 600, 30), t("b", 700, 30)] };
    const result = lockManualMove({ status: "ok", days: structuredClone(days) }, "a");
    const a = result.days[D].find((x) => x.id === "a");
    assert.equal(a.locked, true); assert.equal(a.lockSource, "user"); assert.equal(a.type, "task"); assert.equal(a.start, 600);
    assert.equal(result.days[D].find((x) => x.id === "b").locked, undefined);
    const refused = lockManualMove({ status: "conflict", days: structuredClone(days) }, "a");
    assert.equal(refused.days[D][0].locked, undefined, "nothing is locked when the move is not proposed");
    assert.equal(lockManualMove(null, "a"), null);
    // The task editor offers the lock, on by default, and routes a time change through it.
    assert.match(read("app.js"), /draft\.lockOnMove \? lockManualMove\(moved, task\.id\) : moved/);
    assert.match(read("workbench.js"), /lockOnMove: Boolean\(e\) && !e\.task\.locked/);
  });

  test("a manually moved task stays a task, is locked by the user, survives storage and is not moved by others", () => {
    const moved = markManuallyMoved(t("a", 600, 30), 700);
    assert.equal(moved.type, "task");
    assert.equal(moved.lockSource, "user");
    const back = normalizeDays(JSON.parse(JSON.stringify({ [D]: [moved] })))[D][0];
    assert.equal(back.type, "task");
    assert.equal(back.locked, true);
    assert.equal(back.lockSource, "user");
    const r = proposeReschedule({ [D]: [moved, t("b", 800, 30)] }, { date: D, taskId: "b", start: 720 });
    assert.equal(r.proposal.days[D].find((x) => x.id === "a").start, 700, "locked task does not move");
  });
});

describe("Unlock on the home screen", () => {
  const UNLOCK_HINT = /Unlock the time to choose another one\./;

  // Runs the production `unlock` and `saveDays` from app.js against an in-memory branch.
  function appRig(task) {
    const source = read("app.js");
    const saveDays = source.slice(source.indexOf("function saveDays("), source.indexOf("const currentDay ="));
    const unlock = source.slice(source.indexOf("  unlock: (e) =>"), source.indexOf("  undoComplete:"));
    const branch = { days: { [date]: [task] }, settings: lockSettings(), daySettings: {}, calendar: {}, exampleOrigin: date, undo: null };
    const s = { demo: branch, ui: {} }, notices = [];
    const c = vm.createContext({ structuredClone, JSON, isActivity, validateMutation, adjustmentRecord, mode: "demo", state: { revision: 1 },
      data: () => s.demo, notice: (m, err) => notices.push({ m, err }), enqueueChanges: () => { throw new Error("demo never syncs"); },
      find: (id) => Object.entries(s.demo.days).flatMap(([d, ts]) => ts.map((x) => ({ date: d, task: x }))).find((e) => e.task.id === id),
      save: (mutator) => { mutator(s); return true; } });
    vm.runInContext(`${saveDays}\nvar api = {${unlock}};`, c);
    const undo = () => { const r = undoAdjustment(s.demo); if (!r.ok) { notices.push({ m: r.message, err: true }); return false; } s.demo = r.data; return true; };
    return { api: c.api, undo, data: () => s.demo, notices };
  }

  // Mounts the home screen on a locked, manually moved task backed by the production unlock and undo.
  function lockedHome() {
    const moved = markManuallyMoved(make("essay"), 780);
    const rig = appRig(moved);
    const calls = { unlock: 0 };
    const home = lockHome([], { branch: () => rig.data(), api: { unlock: (e) => { calls.unlock++; return rig.api.unlock(e); }, undo: () => rig.undo() } });
    return { moved, original: structuredClone(moved), rig, calls, home };
  }

  test("a task the user locked offers a visible Unlock action and says unlocking is needed to choose another time", () => {
    const { html, nodes } = lockHome([make("essay", { locked: true, lockSource: "user" })]);
    assert.ok(nodes.has("wb-unlock"), "unlock button present");
    assert.match(html(), /Unlock time/);
    assert.match(html(), UNLOCK_HINT);
  });

  test("fixed events and system locks get no Unlock and no unlock hint, even when marked as locked by the user", () => {
    for (const extra of [{ type: "activity", locked: true, lockSource: "user" }, { type: "activity", locked: true },
      { timeLocked: true, locked: true, lockSource: "user" }, {}]) {
      const { html, nodes } = lockHome([make("x", extra)]);
      assert.ok(!nodes.has("wb-unlock"), JSON.stringify(extra));
      assert.doesNotMatch(html(), /Unlock time/, JSON.stringify(extra));
      assert.doesNotMatch(html(), UNLOCK_HINT, JSON.stringify(extra));
    }
    const fixed = make("talk", { type: "activity", locked: true, lockSource: "user" });
    const rig = appRig(fixed);
    assert.equal(rig.api.unlock({ task: fixed }), false, "app refuses to unlock a fixed event");
    assert.deepEqual(rig.data().days[date][0], fixed);
    assert.equal(rig.data().undo, null);
  });

  test("clicking Unlock brings back the time-change buttons, and Undo restores the manually moved lock", () => {
    const { original, rig, calls, home } = lockedHome();
    assert.doesNotMatch(home.html(), />Choose a time<\/button>|>Plan from now<\/button>/, "locked task hides the time-change buttons");
    home.nodes.get("wb-unlock").onclick();
    assert.equal(calls.unlock, 1);
    assert.deepEqual(rig.notices, [], "unlock was not rejected");
    assert.match(home.html(), /Time unlocked/);

    const unlocked = rig.data().days[date][0];
    assert.equal(unlocked.locked, false);
    assert.equal(unlocked.lockSource, null);
    assert.equal("manuallyMoved" in unlocked, false);
    assert.equal(unlocked.start, 780, "the time itself did not change");

    home.nodes.get("wb-home").onclick();
    assert.match(home.html(), />Choose a time<\/button>/);
    assert.match(home.html(), />Plan from now<\/button>/);
    assert.doesNotMatch(home.html(), /Unlock time/);

    assert.ok(rig.undo(), "unlock is undoable");
    assert.deepEqual(rig.data().days[date][0], original, "undo restores locked, lockSource and manuallyMoved");
    assert.equal(rig.data().undo, null);
  });

  test("Undo on the unlocked screen restores the lock and hides the time-change buttons again", () => {
    const { original, rig, home } = lockedHome();
    home.nodes.get("wb-unlock").onclick();
    home.nodes.get("wb-undo-unlock").onclick();
    assert.deepEqual(rig.notices, [], "undo was not rejected");
    assert.deepEqual(rig.data().days[date][0], original);
    assert.match(home.html(), /Unlock time/);
    assert.doesNotMatch(home.html(), />Choose a time<\/button>|>Plan from now<\/button>/);
  });
});

describe("Unlock after a move in the task editor", () => {
  // The editor moves a task and locks it at the new time; the home screen after the save must offer Unlock.
  function rig() {
    const originalDocument = globalThis.document, nodes = new Map();
    let html = "", proposal = null, unlocks = 0;
    const node = (id) => ({ id, hidden: false, dataset: {}, focus() {}, getClientRects() { return [{}]; },
      querySelector() { return node("span"); }, setAttribute() {}, removeAttribute() {}, addEventListener() {} });
    const root = { get innerHTML() { return html; }, set innerHTML(value) {
      html = value;
      for (const id of [...nodes.keys()]) if (!["workbench", "wb-calendar", "wb-calendar-label"].includes(id)) nodes.delete(id);
      for (const m of value.matchAll(/id="([^"]+)"/g)) nodes.set(m[1], node(m[1]));
    }, querySelector: (s) => (s === "[data-stage]" ? { dataset: {} } : s === "h1" || s === ".photo-frame img" ? node(s) : null) };
    nodes.set("workbench", root); nodes.set("wb-calendar", node("wb-calendar")); nodes.set("wb-calendar-label", node("wb-calendar-label"));
    globalThis.document = { activeElement: null, getElementById: (id) => nodes.get(id) || null };
    const essay = make("essay", { start: 660, bufferBefore: 0, bufferAfter: 0 });
    const branch = { exampleOrigin: date, days: { [date]: [essay] }, settings: lockSettings(), undo: null };
    const context = { mode: "demo", date, branch, revision: 1, ui: {}, calendarStatus: { mock: true } };
    const api = { context: () => context, movable, clearNotice() {}, ambiguous: () => [],
      select(e) { context.date = e.date; context.ui.selection = { mode: context.mode, id: e.task.id }; },
      confirm() { branch.days = structuredClone(proposal.result.days); branch.undo = { id: "move", presentation: { targetId: "essay" } }; context.revision++; return true; },
      unlock(e) {
        const task = branch.days[date].find((x) => x.id === e.task.id);
        if (!task || isActivity(task) || task.lockSource !== "user") return false;
        unlocks++; task.locked = false; task.lockSource = null; delete task.manuallyMoved;
        branch.undo = { id: "unlock", presentation: { targetId: "essay" } }; context.revision++; return true;
      },
      undo() { branch.days[date][0].locked = true; branch.days[date][0].lockSource = "user"; branch.undo = null; context.revision++; return true; },
    };
    // An already-locked task is planned from an unlocked copy, keeping the other flags.
    const unlockedCopy = () => { const d = structuredClone(branch.days); d[date][0].locked = false; d[date][0].timeLocked = false; return d; };
    const bench = createWorkbench(api);
    return { bench, nodes, branch, get html() { return html; }, get unlocks() { return unlocks; },
      // The editor's save path: move, then lock the moved task (lockOnMove is on by default).
      editorMove(start = 900, lock = true) {
        const planned = moveIntent(lock ? branch.days : unlockedCopy(), branch.settings, { taskId: "essay", targetDate: date, targetStart: start });
        const result = lock ? lockManualMove(planned, "essay") : planned;
        proposal = { result, mode: context.mode, revision: context.revision, targetTaskId: "essay" };
        bench.preview(proposal);
      },
      click(id) { const h = nodes.get("wb-" + id)?.onclick; assert.equal(typeof h, "function", id); h(); },
      close() { globalThis.document = originalDocument; },
    };
  }

  test("after an editor move is saved the locked task shows Unlock, and unlocking brings the time-change button back", () => {
    const r = rig(); try {
      r.editorMove(); r.click("confirm");
      assert.equal(r.bench.phase(), "home");
      assert.equal(r.branch.days[date][0].lockSource, "user");
      assert.match(r.html, /Time updated/);
      assert.match(r.html, /Your move also locked this task at its new time/);
      assert.ok(r.nodes.has("wb-unlock"), "Unlock is visible right after the locking save");
      assert.doesNotMatch(r.html, /id="wb-task-actions"[^>]*>Choose a time</);
      r.click("unlock");
      assert.equal(r.unlocks, 1);
      assert.equal(r.bench.phase(), "unlocked");
      assert.ok(r.nodes.has("wb-undo-unlock"), "unlocking offers Undo");
      r.click("home");
      assert.ok(!r.nodes.has("wb-unlock"));
      assert.match(r.html, /id="wb-task-actions"[^>]*>Choose a time</, "the time-change button is back");
    } finally { r.close(); }
  });

  test("a later save on an already-locked task does not claim the move locked it", () => {
    const r = rig(); try {
      r.editorMove(); r.click("confirm");
      r.editorMove(960, false); // no new lock is set by this save
      r.click("confirm");
      assert.doesNotMatch(r.html, /Your move also locked this task/);
    } finally { r.close(); }
  });
});
