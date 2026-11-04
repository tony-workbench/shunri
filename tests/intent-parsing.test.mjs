// Typed time expressions ("tomorrow at 2pm", "in half an hour", "now"): parsing,
// clarification questions, and how the editor reacts to a changing clock.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseTimeExpression as parse, wallInstant, dateParts } from "../time.js";
import { createWorkbench } from "../workbench.js";
import { moveIntent } from "../intent-planner.js";
import { defaults } from "../storage.js";
import { tick } from "./helpers.mjs";

describe("parsing", () => {
  const options = { timeZone: "America/Los_Angeles", now: { date: "2026-10-12", minute: 840 }, task: { date: "2026-10-13", start: 660 } };

  describe("accepted expressions", () => {
    const accepted = [
      ["tomorrow2pm", "2026-10-13", 840], ["tomorrow at 2:30pm", "2026-10-13", 870],
      ["today at 09:00", "2026-10-12", 540], ["today 09:00", "2026-10-12", 540], ["today at 9pm", "2026-10-12", 1260],
      ["15:00", "2026-10-12", 900], ["next day at 11:00", "2026-10-13", 660],
      ["tomorrow at 1pm", "2026-10-13", 780], ["tomorrow at 12am", "2026-10-13", 0], ["tomorrow at 12pm", "2026-10-13", 720],
      ["day after tomorrow at 11:00", "2026-10-14", 660], ["day after tomorrow at noon", "2026-10-14", 720],
      ["the day after tomorrow at midnight", "2026-10-14", 0],
      ["2026-10-15 14:30", "2026-10-15", 870], ["2026-10-15T14:30", "2026-10-15", 870],
      ["2026-10-15 at 2pm", "2026-10-15", 840], ["2026-10-15 at 2:30pm", "2026-10-15", 870],
      [" Tomorrow  at  2:30 PM. ", "2026-10-13", 870], [" tomorrow  at  2:30 p.m. ", "2026-10-13", 870],
      ["in 30 minutes", "2026-10-12", 870], ["in half an hour", "2026-10-12", 870], ["30 mins from now", "2026-10-12", 870],
      ["in 2 hours", "2026-10-12", 960], ["in 1 hour and 30 minutes", "2026-10-12", 930],
      ["30 minutes after the saved time", "2026-10-13", 690], ["30 minutes later than scheduled", "2026-10-13", 690],
      ["half an hour later than scheduled", "2026-10-13", 690], ["1 hour later than scheduled", "2026-10-13", 720],
    ];
    for (const [text, date, minute] of accepted) {
      test(`"${text}" becomes ${date} at minute ${minute}`, () => {
        const result = parse(text, options);
        assert.equal(result.status, "target", result.message);
        assert.deepEqual([result.date, result.minute, result.startFromNow], [date, minute, false]);
        assert.deepEqual(result.basis.clock, options.now);
        assert.deepEqual(result.basis.task, options.task);
      });
    }

    test('"now" keeps the plan-from-now intent so the planner picks the nearest feasible time', () => {
      const result = parse("now", options);
      assert.deepEqual([result.status, result.date, result.minute, result.startFromNow], ["target", options.now.date, options.now.minute, true]);
    });
  });

  describe("clarification", () => {
    test("an hour without am or pm gets one question and the answer decides, never the scheduling window", () => {
      const question = parse("tomorrow at 2", options);
      assert.equal(question.status, "clarify");
      assert.match(question.question, /02:00.*14:00/);
      for (const [choice, minute] of [["am", 120], ["pm", 840]]) {
        const result = parse("tomorrow at 2", { ...options, answer: { question: question.id, choice } });
        assert.deepEqual([result.status, result.date, result.minute], ["target", "2026-10-13", minute]);
      }
    });

    test("a time that has already passed today needs an explicit choice of day", () => {
      for (const text of ["11:00", "11am"]) {
        const question = parse(text, options);
        assert.equal(question.status, "clarify", text);
        assert.equal(parse(text, { ...options, answer: { question: question.id, choice: "tomorrow" } }).date, "2026-10-13");
      }
    });

    test("the confirmed date is mentioned in the explanation instead of saying no date was specified", () => {
      const question = parse("11:00", options);
      const result = parse("11:00", { ...options, answer: { question: question.id, choice: "tomorrow" } });
      assert.equal(result.date, "2026-10-13");
      assert.doesNotMatch(result.explanation, /No date was specified/);
      assert.match(result.explanation, /Confirmed the date/);
    });

    test("a second ambiguity asks for fuller input instead of another question", () => {
      const question = parse("2", options);
      assert.equal(question.status, "clarify");
      assert.equal(parse("2", { ...options, answer: { question: question.id, choice: "am" } }).status, "input");
    });

    test("answers to an unknown or stale question are rejected", () => {
      assert.equal(parse("at 2", { ...options, answer: { question: "english-period:at 2", choice: "am" } }).status, "input");
      assert.equal(parse("tomorrow at 2", { ...options, answer: { question: "stale", choice: "pm" } }).status, "input");
    });
  });

  test("incomplete, unsupported or invalid expressions never become targets", () => {
    const rejected = ["", "tomorrow", "tomorrow afternoon", "2026-10-13", "2026-02-30 11:00", "2026-02-30T14:00",
      "today 25:00", "today 12:60", "today at 13pm", "tomorrow at 13pm", "tomorrow at 0am", "tomorrow at 2pm and 3pm",
      "next week at 2pm", "next week sometime", "yesterday at 2pm", "tomorrow at 2pm PST", "after I finish", "when I finish",
      "in -5 minutes", "in 10081 minutes", "in 99999 minutes", "in 1.5 hours", "in 30 minutes or 2 hours"];
    for (const text of rejected) assert.equal(parse(text, options).status, "input", text);
    assert.equal(parse("tomorrow2pm", { ...options, now: null }).status, "input", "no clock, no relative target");
    assert.equal(parse("in 30 minutes", { ...options, now: { date: "2026-10-12", minute: 1440 } }).status, "input");
    assert.equal(parse("30 minutes after the saved time", { ...options, task: null }).status, "input", "no saved task time");
  });

  test("relative times use the application time zone and the saved task time as baseline across month and year ends", () => {
    const now = { date: "2026-12-31", minute: 1420, instant: wallInstant("2026-12-31", 1420, "Asia/Tokyo") };
    for (const text of ["in half an hour", "in 30 minutes"]) {
      const relative = parse(text, { ...options, now, timeZone: "Asia/Tokyo" });
      assert.deepEqual([relative.date, relative.minute], ["2027-01-01", 10]);
    }
    for (const text of ["tomorrow at 11am", "tomorrow at noon"]) assert.equal(parse(text, { ...options, now }).date, "2027-01-01");
    const saved = parse("30 minutes later than scheduled", { ...options, task: { date: "2026-11-30", start: 1420 } });
    assert.deepEqual([saved.date, saved.minute], ["2026-12-01", 10]);
    assert.equal(dateParts(now.instant, "America/Los_Angeles").date, "2026-12-31");
  });

  test("clock times inside a daylight-saving gap or repeated hour are rejected, and elapsed minutes cross the spring gap correctly", () => {
    for (const text of ["2026-03-08 02:30", "2026-03-08T02:30", "2026-11-01 01:30", "2026-11-01 1:30am"]) {
      const result = parse(text, options);
      assert.equal(result.status, "input", text);
      assert.match(result.message, /unavailable or ambiguous/);
    }
    for (const text of ["in half an hour", "in 30 minutes"]) {
      const spring = { date: "2026-03-08", minute: 110, instant: wallInstant("2026-03-08", 110) };
      const result = parse(text, { ...options, now: spring });
      assert.equal(result.status, "target");
      assert.equal(result.minute, 200);
      const fold = { date: "2026-11-01", minute: 50, instant: wallInstant("2026-11-01", 50) };
      assert.equal(parse(text, { ...options, now: fold }).status, "input");
    }
  });

  test("a parsed expression previews a move that keeps the source task and the fixed event intact and saves nothing", () => {
    const task = { id: "read", uid: "read", title: "Read notes", start: 660, duration: 45, rest: 15, type: "task", done: false, locked: false, counted: true, dependencies: [] };
    const fixed = { ...task, id: "fixed", uid: "fixed-provider-id", title: "Fixed appointment", start: 840, duration: 60, rest: 0, type: "activity", locked: true, counted: false };
    const days = { "2026-10-12": [task], "2026-10-13": [fixed] }, before = structuredClone(days);
    const settings = { timeZone: options.timeZone, dayEnd: 1380, minGap: 0, capacity: null, weekly: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [[540, 1380]]])) };
    const preview = (text) => {
      const target = parse(text, options);
      assert.equal(target.status, "target");
      return moveIntent(days, settings, { taskId: task.id, targetDate: target.date, targetStart: target.minute, startFromNow: target.startFromNow });
    };
    const success = preview("tomorrow at 4pm");
    assert.equal(success.status, "ok");
    assert.equal(success.days["2026-10-13"].find((t) => t.id === "read").start, 960);
    assert.deepEqual(success.days["2026-10-13"].find((t) => t.id === "fixed"), fixed);
    assert.equal(preview("tomorrow at 2pm").status, "conflict");
    assert.deepEqual(days, before, "previewing must not change the schedule");
  });
});

describe("editor lifecycle", () => {
  // Runs the production workbench handlers and planner on a minimal fake DOM with
  // API completions the test controls. It also models focus loss when the focused
  // element is replaced, which the shared uiRig does not.
  const buttonLabels = (html) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

  function rig() {
    const originalDocument = globalThis.document, originalNow = Date.now, nodes = new Map();
    let html = "";
    const node = (id) => ({
      id, value: "", validity: { valid: true }, childIds: new Set(), dataset: {},
      set innerHTML(value) {
        if (this.childIds.has(document.activeElement?.id) || document.activeElement === this.heading) document.activeElement = document.body;
        this.html = value;
        for (const child of this.childIds) nodes.delete(child);
        this.childIds = parse(value);
        this.heading = /<h2>/.test(value) ? node("") : null;
        if (this.heading) this.heading.tagName = "H2";
      },
      get innerHTML() { return this.html || ""; },
      setAttribute() {}, removeAttribute() {}, addEventListener(type, fn) { this["on" + type] = fn; },
      remove() { nodes.delete(id); }, focus() { document.activeElement = this; },
      querySelector(s) { return s === "h2" ? this.heading : s === "span" ? node("span") : null; },
    });
    const parse = (value) => {
      const ids = new Set();
      for (const m of value.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const n = node(m[1]);
        n.value = m[0].match(/\bvalue="([^"]*)"/)?.[1] || "";
        n.disabled = /\bdisabled\b/.test(m[0]);
        nodes.set(n.id, n);
        ids.add(n.id);
      }
      return ids;
    };
    const root = {
      get innerHTML() { return html; },
      set innerHTML(value) {
        html = value;
        for (const id of [...nodes.keys()]) if (!["workbench", "wb-calendar", "wb-calendar-label"].includes(id)) nodes.delete(id);
        parse(value);
      },
      querySelector: (s) => (s === "h1" ? node("h1") : s === ".photo-frame img" ? node("img") : null),
    };
    nodes.set("workbench", root);
    nodes.set("wb-calendar", node("wb-calendar"));
    nodes.set("wb-calendar-label", node("wb-calendar-label"));
    globalThis.document = { activeElement: null, body: { tagName: "BODY", id: "" }, getElementById: (id) => nodes.get(id) || null };

    const task = { id: "sql", uid: "sql", title: "SQL study", start: 660, duration: 45, rest: 20, type: "task", done: false, tags: ["study"], planId: "course", packageId: "2026-10-12", packageOriginDate: "2026-10-12", packageOrder: 0, packageTaskOrder: 0, dependencies: [] };
    const branch = { days: { "2026-10-12": [task] }, settings: defaults(), undo: null, calendar: { autoSync: true, syncQueue: { jobs: [] } } };
    const context = { mode: "personal", date: "2026-10-12", revision: 1, proposalKey: "initial", branch, ui: { selection: { mode: "personal", id: task.id } } };
    let proposal = null, saves = 0;
    const calls = [];
    const api = {
      context: () => context, movable: (t) => !t.done && !t.locked, clearNotice() {}, cancel() { proposal = null; },
      ambiguous: () => [],
      ambiguityFor: (id) => (id === "neighbor" ? { taskId: id, title: "Neighbor", prompt: "Confirm the purpose", choices: [{ id: "study", label: "study" }] } : null),
      rememberMeaning: async () => null,
      confirm() { if (!proposal) return false; saves++; proposal = null; return true; },
      // Every move waits until the test calls finish(kind): "ok", "error" or "meaning".
      move: (id, date, time, intent) => new Promise((resolve, reject) => calls.push({
        id, date, time, intent,
        finish(kind = "ok") {
          if (kind === "error") return reject(Error("mock failure"));
          if (!intent.isCurrent()) return resolve(null);
          const result = kind === "meaning"
            ? { status: "conflict", changes: [], conflicts: [{ ids: ["neighbor"], message: "Purpose not confirmed" }] }
            : moveIntent(branch.days, branch.settings, { taskId: id, targetDate: date, targetStart: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), startFromNow: intent.startFromNow });
          proposal = { result, revision: context.revision, mode: context.mode, targetTaskId: id };
          resolve(proposal);
        },
      })),
    };
    const bench = createWorkbench(api);
    const clock = (iso) => (Date.now = () => Date.parse(iso));
    const click = (id) => nodes.get("wb-" + id).onclick();
    const input = (text) => { nodes.get("wb-expression").value = text; nodes.get("wb-expression").oninput({ isComposing: false }); };
    clock("2026-10-12T21:00:00Z");
    bench.render();
    click("task-actions");
    return {
      nodes, task, branch, context, calls, clock, click, input,
      output: () => nodes.get("wb-custom-result")?.innerHTML || html,
      get saves() { return saves; },
      close() { bench.home(); Date.now = originalNow; globalThis.document = originalDocument; },
    };
  }
  const target = (r, i, date, time) => assert.deepEqual([r.calls[i].date, r.calls[i].time], [date, time]);
  const unchanged = (r, before) => { assert.equal(r.saves, 0); assert.deepEqual(r.branch, before); };

  test("returning home ends the old clock intent, and reopening uses the new clock, including the next day", async () => {
    const r = rig();
    try {
      const before = structuredClone(r.branch);
      r.input("in half an hour");
      await tick();
      target(r, 0, "2026-10-12", "14:30");
      r.calls[0].finish();
      await tick(0);
      r.click("back");
      r.clock("2026-10-12T23:00:00Z");
      r.click("task-actions");
      await tick();
      target(r, 1, "2026-10-12", "16:30");
      r.calls[1].finish();
      await tick(0);
      assert.match(r.output(), /app time.*16:00/);
      r.click("back");
      r.clock("2026-10-13T16:00:00Z");
      r.click("task-actions");
      await tick();
      target(r, 2, "2026-10-13", "09:30");
      unchanged(r, before);
    } finally { r.close(); }
  });

  test("a new task-relative expression uses the latest saved date and time, not an earlier snapshot", async () => {
    const r = rig();
    try {
      r.input("30 minutes later than scheduled");
      await tick();
      target(r, 0, "2026-10-12", "11:30");
      r.calls[0].finish();
      await tick(0);
      r.click("back");
      delete r.branch.days["2026-10-12"];
      r.task.start = 900;
      r.branch.days["2026-10-13"] = [r.task];
      r.context.revision++;
      r.context.proposalKey = "latest-saved";
      const before = structuredClone(r.branch);
      r.click("task-actions");
      await tick();
      target(r, 1, "2026-10-13", "15:30");
      r.calls[1].finish();
      await tick(0);
      assert.match(r.output(), /saved time.*2026-10-13 15:00/);
      unchanged(r, before);
    } finally { r.close(); }
  });

  test("after returning home a clarification asks again and the old answer callback is ignored", async () => {
    const r = rig();
    try {
      const before = structuredClone(r.branch);
      r.input("tomorrow at 2");
      await tick();
      const old = r.nodes.get("wb-time-choice-1").onclick;
      old();
      await tick(0);
      target(r, 0, "2026-10-13", "14:00");
      r.calls[0].finish();
      await tick(0);
      r.click("back");
      r.clock("2026-10-13T16:00:00Z");
      r.click("task-actions");
      await tick();
      assert.equal(r.calls.length, 1);
      assert.ok(r.nodes.get("wb-time-choice-0"));
      old();
      await tick(0);
      assert.equal(r.calls.length, 1);
      r.click("time-choice-0");
      await tick(0);
      target(r, 1, "2026-10-14", "02:00");
      unchanged(r, before);
    } finally { r.close(); }
  });

  test("the same intent keeps its original target time across a retry after an error and a purpose confirmation", async () => {
    const r = rig();
    try {
      const before = structuredClone(r.branch);
      r.input("in half an hour");
      await tick();
      r.clock("2026-10-12T22:00:00Z");
      r.calls[0].finish("error");
      await tick(0);
      r.click("retry-custom");
      await tick(20);
      target(r, 1, "2026-10-12", "14:30");
      r.calls[1].finish("meaning");
      await tick(0);
      r.clock("2026-10-12T23:00:00Z");
      await r.click("meaning-0");
      await tick(20);
      target(r, 2, "2026-10-12", "14:30");
      r.calls[2].finish();
      await tick(0);
      assert.match(r.output(), /app time.*14:00/);
      unchanged(r, before);
    } finally { r.close(); }
  });

  test("a late success, failure or purpose answer from an abandoned intent cannot replace a reopened one", async () => {
    for (const kind of ["ok", "error", "meaning"]) {
      const r = rig();
      try {
        const before = structuredClone(r.branch);
        r.input("in half an hour");
        await tick();
        r.click("back");
        r.clock("2026-10-12T23:00:00Z");
        r.click("task-actions");
        await tick();
        target(r, 1, "2026-10-12", "16:30");
        r.calls[1].finish();
        await tick(0);
        const output = r.output();
        r.calls[0].finish(kind);
        await tick(0);
        assert.equal(r.output(), output);
        unchanged(r, before);
      } finally { r.close(); }
    }
  });

  test("the preview asks one question with only Yes, Try another and Cancel, and keeps the typed input", async () => {
    const r = rig();
    try {
      const before = structuredClone(r.branch), input = r.nodes.get("wb-expression");
      input.focus();
      r.input("tomorrow at 2:30pm");
      await tick();
      r.calls[0].finish();
      await tick(0);
      assert.equal(document.activeElement, input);
      assert.match(r.output(), /<h2>Change it like this\?<\/h2>/);
      assert.deepEqual(buttonLabels(r.output()), ["Yes", "Try another", "Cancel"]);
      assert.ok(!r.nodes.has("wb-details"));
      assert.equal(r.nodes.get("wb-custom-inputs").inert, false);
      assert.equal(r.nodes.get("wb-expression"), input);
      assert.equal(input.value, "tomorrow at 2:30pm");
      unchanged(r, before);
    } finally { r.close(); }
  });

  test("typing a new expression after an automatic preview keeps the editing focus", async () => {
    const r = rig();
    try {
      const before = structuredClone(r.branch), input = r.nodes.get("wb-expression");
      for (const text of ["tomorrow at 2:30pm", "tomorrow at 3:30pm"]) {
        input.focus();
        r.input(text);
        assert.equal(document.activeElement, input);
        await tick();
        assert.equal(document.activeElement, input);
        r.calls.at(-1).finish();
        await tick(0);
        assert.equal(document.activeElement, input);
        assert.equal(input.value, text);
      }
      unchanged(r, before);
    } finally { r.close(); }
  });
});
