import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createWorkbench } from "../workbench.js";
import { moveIntent } from "../intent-planner.js";
import { defaults } from "../storage.js";
import { uiRig } from "./helpers.mjs";

// The workbench is mounted on a tiny fake DOM; the app API is faked around the
// production planner. Browser layout and persistence are checked elsewhere.

describe("saved result flow", () => {
  const task = (id, date, order) => ({
    id, uid: id, title: id === "sql" ? "SQL practice" : "Python practice", start: 660, duration: 45, rest: 20,
    type: "task", tags: ["study"], planId: "synthetic-course", packageId: date, packageOriginDate: date,
    packageOrder: order, packageTaskOrder: 0, dependencies: [], done: false,
  });

  // A demo schedule with SQL on Oct 12 and Python on Oct 13; confirming saves the proposal and records an undo step.
  function savedRig() {
    const originalDays = { "2026-10-12": [task("sql", "2026-10-12", 0)], "2026-10-13": [task("python", "2026-10-13", 1)] };
    const branch = { exampleOrigin: "2026-10-12", days: structuredClone(originalDays), settings: defaults(), undo: null };
    let proposal, saves = 0, undoCalls = 0;
    const selections = [];
    const r = uiRig({ branch, date: "2026-10-12", selected: null, extraApi: (context) => {
      context.mode = "demo";
      context.calendarStatus = { mock: true };
      return {
        select(entry) { selections.push(entry.task.id); context.date = entry.date; context.ui.selection = { mode: context.mode, id: entry.task.id }; },
        confirm() {
          if (!proposal) return false;
          saves++; branch.days = structuredClone(proposal.result.days);
          branch.undo = { id: `save-${saves}`, presentation: { targetId: "sql" } }; context.revision++; proposal = null; return true;
        },
        undo() { undoCalls++; branch.days = structuredClone(originalDays); branch.undo = null; context.revision++; return true; },
      };
    } });
    // The workbench keeps focus across renders only when the stage is known and the element is laid out.
    const root = r.nodes.get("workbench"), query = root.querySelector, getById = globalThis.document.getElementById;
    root.querySelector = (selector) => (selector === "[data-stage]" ? { dataset: { stage: r.html().match(/data-stage="([^"]+)/)?.[1] } } : query(selector));
    globalThis.document.getElementById = (id) => { const found = getById(id); if (found) found.getClientRects ??= () => [{}]; return found; };
    Object.defineProperties(r, {
      saved: { get: () => saves },
      undoCalls: { get: () => undoCalls },
    });
    r.selections = selections;
    r.preview = (extra = {}) => {
      proposal = { result: moveIntent(branch.days, branch.settings, { taskId: "sql", targetDate: "2026-10-13", targetStart: 870 }),
        mode: r.context.mode, revision: r.context.revision, targetTaskId: "sql", ...extra };
      r.bench.preview(proposal);
    };
    return r;
  }
  const withRig = (run) => () => { const r = savedRig(); try { return run(r); } finally { r.close(); } };

  test("the final save shows the moved task and timeline at once; details are read-only", withRig((r) => {
    r.preview(); const confirm = r.nodes.get("wb-confirm").onclick; confirm(); confirm();
    assert.equal(r.saved, 1);
    assert.equal(r.bench.phase(), "home");
    assert.equal(r.context.date, "2026-10-13");
    assert.deepEqual(r.selections, ["sql"]);
    assert.match(r.html(), /class="day-axis/);
    assert.match(r.html(), /14:30/);
    assert.match(r.html(), /Time updated/);
    assert.doesNotMatch(r.html(), /View new plans/);
    assert.equal(r.bench.lifecycle().kind, "result");
    assert.ok(r.nodes.has("wb-undo")); assert.ok(r.nodes.has("wb-saved-details"));
    const snapshot = JSON.stringify(r.context.branch);
    r.click("saved-details");
    assert.equal(r.bench.phase(), "result-details");
    assert.match(r.html(), /Record of this change/);
    assert.ok(!r.nodes.has("wb-confirm"));
    r.click("result-back");
    assert.equal(r.bench.phase(), "home");
    assert.deepEqual(r.selections, ["sql"]);
    assert.equal(JSON.stringify(r.context.branch), snapshot);
    assert.equal(r.saved, 1);
    r.click("undo");
    assert.equal(r.undoCalls, 1);
    assert.equal(r.context.date, "2026-10-12");
    assert.ok(!r.nodes.has("wb-saved-details"));
  }));

  test("later edits keep the historical details but cannot undo another result or force its selection", withRig((r) => {
    r.preview(); r.click("confirm"); const obsoleteUndo = r.nodes.get("wb-undo").onclick;
    r.context.branch.days["2026-10-13"][0].start = 900;
    r.context.branch.undo = { id: "another-save", presentation: { targetId: "python" } }; r.context.revision++;
    r.context.date = "2026-10-14"; r.bench.render();
    assert.match(r.html(), /The schedule changed later/);
    assert.ok(!r.nodes.has("wb-undo"));
    obsoleteUndo();
    assert.equal(r.undoCalls, 0);
    r.click("saved-details");
    assert.match(r.html(), /14:30/);
    r.click("result-back");
    assert.equal(r.context.date, "2026-10-14");
    assert.deepEqual(r.selections, ["sql"]);
    r.context.mode = "personal"; r.bench.render();
    assert.match(r.html(), /viewing a different schedule/);
    assert.ok(!r.nodes.has("wb-undo"));
    assert.equal(r.saved, 1);
  }));

  test("a status or browsing refresh keeps the saved details without another selection or save", withRig((r) => {
    r.preview(); r.click("confirm"); const snapshot = JSON.stringify(r.context.branch);
    r.context.revision++; r.bench.render(); r.bench.refreshStatus();
    assert.match(r.html(), /Time updated/);
    assert.doesNotMatch(r.html(), /The schedule changed later/);
    assert.deepEqual(r.selections, ["sql"]);
    assert.equal(r.saved, 1);
    assert.equal(JSON.stringify(r.context.branch), snapshot);
  }));

  test("a confirmation with a pending action continues that action instead of entering the saved home", withRig((r) => {
    let continued = 0;
    r.preview({ afterConfirm() { continued++; } }); r.click("confirm");
    assert.equal(continued, 1);
    assert.equal(r.saved, 1);
    assert.deepEqual(r.selections, []);
    assert.ok(!r.nodes.has("wb-saved-details"));
    assert.notEqual(r.bench.phase(), "home");
  }));

  test("a rules-only save without a target keeps browsing and shows no missing-task warning", withRig((r) => {
    const days = structuredClone(r.context.branch.days);
    r.preview({ result: { status: "ok", days, changes: [], conflicts: [], warnings: [] }, targetTaskId: null, label: "Rule preview", allowRuleConflicts: true });
    r.click("confirm");
    assert.equal(r.bench.phase(), "home");
    assert.equal(r.saved, 1);
    assert.equal(r.context.date, "2026-10-12");
    assert.deepEqual(r.selections, []);
    assert.doesNotMatch(r.html(), /task is no longer in the current schedule/);
    assert.ok(r.nodes.has("wb-saved-details"));
  }));

  describe("Google learning events", () => {
    const googleEntry = (r, source) => {
      const entry = r.context.branch.days["2026-10-12"][0];
      Object.assign(entry, { externalReadOnly: true, locked: true,
        calendarLink: { source: "google", calendarId: "synthetic", eventId: "example" },
        calendarSource: source && { accessRole: "owner", organizer: { self: true }, ...source } });
      return entry;
    };

    test("management is offered only for eligible ordinary events", () => {
      for (const source of [
        { eventType: "default", canManage: true, expected: true },
        { eventType: "focusTime", expected: false },
        { eventType: "default", canManage: false, expected: false },
        { eventType: "default", organizer: null, creator: { self: true }, expected: false },
      ]) {
        const r = savedRig();
        try {
          const { expected, ...rest } = source;
          googleEntry(r, rest);
          r.bench.render();
          assert.equal(r.nodes.has("wb-from-now"), expected);
          assert.equal(r.html().includes(">Choose a time</button>"), expected);
        } finally { r.close(); }
      }
    });

    test("read-only explanations use known facts without hiding the purpose or opening management", () => {
      const cases = [
        [{ eventType: "focusTime" }, "Shunri cannot move focus-time events yet"],
        [{ eventType: "outOfOffice" }, "Shunri cannot move out-of-office events yet"],
        [{ eventType: "workingLocation" }, "Shunri cannot change working-location events yet"],
        [{ eventType: "<private-provider-type>" }, "Shunri cannot move this event type yet"],
        [{ allDay: true }, "All-day events keep their original dates"],
        [{ minutePrecision: false }, "This event uses seconds; Shunri currently schedules by the minute"],
        [{ accessRole: "reader" }, "Shunri can manage events only on calendars you own"],
        [{ organizer: { self: false, email: "synthetic-private@example.test" } }, "This event belongs to another organizer and keeps its original time"],
        [{ canManage: false }, "Shunri cannot move this event. Its original time is preserved"],
        [{ organizer: null, canManage: false }, "Shunri cannot move this event. Its original time is preserved"],
        [{ canManage: true }, "Read-only · You chose to keep this event outside Shunri management.", false],
        [{ canManage: false }, "Shunri cannot move this event. Its original time is preserved", false],
        [{ eventType: "focusTime" }, "Shunri cannot move focus-time events yet", false],
        [null, "This calendar event keeps its original time"],
      ];
      for (const [source, expected, manage] of cases) {
        const r = savedRig();
        try {
          const entry = googleEntry(r, source);
          Object.assign(entry, { semantic: { explanation: "This is course practice; keep the purpose note." },
            ...(typeof manage === "boolean" ? { calendarClassification: { kind: "learning", manage } } : {}) });
          const before = JSON.stringify(r.context.branch);
          r.bench.render();
          assert.match(r.html(), /class="purpose-note readonly-note"/);
          assert.ok(r.html().includes(expected), expected);
          if (manage === false && source.canManage === true) {
            const note = /<p class="purpose-note readonly-note">([^<]+)<\/p>/.exec(r.html())?.[1];
            assert.equal(note, "Read-only · You chose to keep this event outside Shunri management.");
            assert.doesNotMatch(note, /original time|current plans|sync|restore/);
          }
          assert.match(r.html(), /This is course practice; keep the purpose note/);
          assert.doesNotMatch(r.html(), /private-provider-type|synthetic-private@example/);
          assert.equal(r.nodes.has("wb-from-now"), false);
          assert.ok(!r.html().includes(">Choose a time</button>"));
          r.click("task-actions");
          assert.equal(r.nodes.has("wb-adjust"), false);
          r.click("selected-actions");
          assert.equal(r.nodes.has("wb-edit"), false);
          assert.equal(r.nodes.has("wb-delete"), false);
          assert.equal(r.nodes.has("wb-allow"), false);
          assert.equal(JSON.stringify(r.context.branch), before);
          assert.equal(r.saved, 0);
        } finally { r.close(); }
      }
    });

    test("explanations are rebuilt from the current item while eligible learning and local actions stay usable", withRig((r) => {
      const entry = googleEntry(r, { eventType: "focusTime" });
      r.bench.render();
      assert.match(r.html(), /cannot move focus-time/);
      entry.calendarSource = { accessRole: "owner", organizer: { self: true }, eventType: "default", canManage: true };
      for (const manage of [undefined, true]) {
        entry.calendarClassification = { kind: "learning", ...(manage === true ? { manage } : {}) };
        r.bench.render();
        assert.doesNotMatch(r.html(), /cannot move focus-time|outside Shunri management/);
        assert.match(r.html(), /Choose a time to review local management permission/);
        assert.ok(r.nodes.has("wb-from-now"));
        assert.ok(r.html().includes(">Choose a time</button>"));
      }
      entry.done = true; r.bench.render();
      assert.doesNotMatch(r.html(), /Choose a time to review/);
      assert.equal(r.nodes.has("wb-from-now"), false);
      entry.done = false; entry.externalReadOnly = false; entry.locked = false;
      delete entry.calendarLink; delete entry.calendarSource;
      r.bench.render();
      assert.doesNotMatch(r.html(), /readonly-note/);
      assert.ok(r.nodes.has("wb-from-now")); assert.ok(r.nodes.has("wb-complete"));
    }));
  });
});

describe("selecting a task by typing", () => {
  // The production handlers on a small in-memory DOM that keeps focus across renders; this is not a native IME.
  function searchRig({ origin = "2026-10-12", selectedDate = "2026-10-13", nextDate = "2026-10-14", readDate = async () => {} } = {}) {
    const nodes = new Map();
    let html = "";
    const parse = (value) => { for (const m of value.matchAll(/id="([^"]+)"/g)) nodes.set(m[1], node(m[1])); };
    const node = (id) => ({ id, hidden: false, value: "", selectionStart: 0, selectionEnd: 0,
      set innerHTML(v) { this.html = v; parse(v); }, get innerHTML() { return this.html || ""; },
      setAttribute() {}, removeAttribute() {}, addEventListener(type, handler) { this["on" + type] = handler; },
      focus() { document.activeElement = this; this.onfocus?.(); }, getClientRects() { return [{}]; }, scrollIntoView() {} });
    const root = {
      get innerHTML() { return html; },
      set innerHTML(v) {
        html = v;
        for (const id of [...nodes.keys()]) if (!["workbench", "wb-calendar", "wb-calendar-label"].includes(id)) nodes.delete(id);
        parse(v);
      },
      querySelector: (s) => (s === "h1" ? node("heading") : s === ".photo-frame img" ? node("photo") : s === "[data-stage]" ? { dataset: { stage: html.match(/data-stage="([^"]+)/)?.[1] } } : null),
    };
    for (const id of ["wb-calendar", "wb-calendar-label"]) nodes.set(id, node(id));
    nodes.set("workbench", root);
    globalThis.document = { activeElement: null, getElementById: (id) => nodes.get(id) || null };
    const task = (id, title) => ({ id, title, start: 660, duration: 45, rest: 15, tags: ["study"], planId: "p", packageId: id });
    const branch = { exampleOrigin: origin, settings: { timeZone: "America/Los_Angeles", dayStart: 540, dayEnd: 1380 },
      days: { [selectedDate]: [task("a", "математика практика")], [nextDate]: [task("b", "английский практика")] } };
    const context = { mode: "demo", branch, date: selectedDate, revision: 1, ui: { selection: { mode: "demo", id: "a" } } }, selected = [];
    const bench = createWorkbench({ context: () => context, movable: () => true, clearNotice() {}, select: (e) => selected.push(e.task.id), ambiguous: () => [], readDate });
    bench.render();
    return { nodes, root, bench, selected, context, search() { nodes.get("wb-select").onclick(); return nodes.get("wb-search"); } };
  }
  const press = (input, key, extra = {}) => {
    let prevented = false;
    input.onkeydown({ key, preventDefault() { prevented = true; }, ...extra });
    return prevented;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1));

  test("Enter during text composition (including key code 229) does not navigate or select a task", () => {
    for (const e of [{ isComposing: true }, { keyCode: 229 }]) {
      const r = searchRig(), input = r.search();
      assert.equal(press(input, "Enter", e), false);
      assert.deepEqual(r.selected, []);
      assert.equal(r.bench.phase(), "select");
    }
  });

  test("the input node and caret survive composition and ordinary typing", () => {
    const r = searchRig(), input = r.search();
    input.oncompositionstart?.(); input.value = "м"; input.selectionStart = input.selectionEnd = 1;
    input.oninput({ target: input, isComposing: true });
    assert.equal(r.nodes.get("wb-search"), input);
    assert.equal(input.selectionStart, 1);
    for (const k of ["ArrowDown", "ArrowUp", "Escape", "Tab", "Enter"]) assert.equal(press(input, k), false);
    input.value = "мат"; input.selectionStart = input.selectionEnd = 3; input.oncompositionend?.({ target: input });
    assert.equal(r.nodes.get("wb-search"), input);
    assert.equal(input.value, "мат");
    assert.equal(input.selectionStart, 3);
    assert.match(r.nodes.get("wb-options").innerHTML, /математика практика/);
    assert.doesNotMatch(r.nodes.get("wb-options").innerHTML, /английский практика/);
  });

  test("an Enter that commits a composition is ignored and the next independent Enter selects", async () => {
    const r = searchRig(), input = r.search();
    input.oncompositionstart?.(); input.value = "англ"; input.oncompositionend?.({ target: input });
    assert.equal(press(input, "Enter"), false);
    assert.deepEqual(r.selected, []);
    await settle();
    assert.equal(press(input, "Enter"), true);
    assert.deepEqual(r.selected, ["b"]);
    assert.equal(r.bench.phase(), "home");
  });

  test("a date read that finishes during composition cannot replace the input or refresh candidates early", async () => {
    let finish;
    const r = searchRig({ readDate: () => new Promise((resolve) => { finish = resolve; }) }), input = r.search();
    input.value = "2026-10-14"; input.oninput({ target: input });
    const options = r.nodes.get("wb-options").innerHTML;
    input.oncompositionstart?.(); input.value = "мат"; input.oninput({ target: input, isComposing: true });
    finish(); await settle();
    assert.equal(r.nodes.get("wb-search"), input);
    assert.equal(r.nodes.get("wb-options").innerHTML, options);
    input.oncompositionend?.({ target: input });
    assert.match(r.nodes.get("wb-options").innerHTML, /математика практика/);
  });

  test("relative dates on the home screen use the demo clock, not the selected task date", () => {
    const cases = [
      ["2026-10-12", "2026-10-13", "2026-10-14", "Wed"], ["2026-10-12", "2026-10-12", "2026-10-13", "Tomorrow"],
      ["2026-10-12", "2026-10-19", "2026-10-20", "Tue"], ["2026-10-12", "2026-10-10", "2026-10-11", "Sun"],
      ["2026-10-31", "2026-10-30", "2026-11-01", "Tomorrow"], ["2026-12-31", "2026-12-30", "2027-01-01", "Tomorrow"],
    ];
    for (const [origin, selectedDate, nextDate, label] of cases) {
      const r = searchRig({ origin, selectedDate, nextDate });
      const before = structuredClone(r.context.branch.days);
      assert.match(r.root.innerHTML, new RegExp(`class="next-date">${label} · `));
      assert.deepEqual(r.context.branch.days, before);
    }
  });
});

describe("evidence behind an open draft", () => {
  // The storage-event handler of app.js compares this basis to decide whether a draft is still valid.
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const guard = source.slice(source.indexOf("function proposalBasis("), source.indexOf('window.addEventListener("storage"'));
  const basis = vm.runInNewContext(guard + ";proposalBasis");
  const branch = () => ({
    days: { "2026-10-12": [{ id: "a", start: 660, title: "SQL", calendarSource: { description: "practice" } }] },
    settings: { dayEnd: 1380 }, daySettings: {},
    calendar: { learningCatalogs: { p: { complete: true } }, readRanges: [{ from: "2026-10-01", to: "2026-10-31", partial: false }],
      semanticManagedPlans: { p: true }, syncQueue: { jobs: [] } },
  });

  test("a queue status change alone does not change the draft evidence", () => {
    const b = branch(), key = basis(b);
    b.calendar.syncQueue.jobs.push({ status: "syncing" });
    assert.equal(basis(b), key);
  });

  test("catalog and read coverage, semantic management, task facts and permission changes invalidate the draft", () => {
    for (const mutate of [
      (b) => { b.calendar.learningCatalogs.p.complete = false; }, (b) => { b.calendar.learningCatalogs = {}; },
      (b) => { b.calendar.readRanges[0].partial = true; }, (b) => { b.calendar.semanticManagedPlans = {}; },
      (b) => { b.calendar.classificationRules = { x: "fixed" }; },
      (b) => { b.days["2026-10-12"][0].calendarSource.description = "Assignment due TBD"; },
      (b) => { b.settings.dayEnd = 1200; }, (b) => { b.calendar.autoSync = false; },
      (b) => { b.calendar.syncDisplayRefs = { a: { intentId: 2 } }; },
    ]) {
      const b = branch(), key = basis(b);
      mutate(b);
      assert.notEqual(basis(b), key);
    }
  });
});
