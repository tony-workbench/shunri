import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE_BUTTON_LABEL, FIRST_USE_EXAMPLE_TIME, FIRST_USE_STEPS, firstUseGuide, showsFirstUseGuide } from "../workbench.js";
import { defaults } from "../storage.js";
import { normalizeLearningDays, packageSummary } from "../learning.js";
import { DAY, tick, item, emptyBranch, uiRig } from "./helpers.mjs";

// The app must be usable on first open: a brand-new user has an empty personal schedule and nothing saved yet.
// Fictional example data stands in for the app's independent example branch.
const example = () => ({ [DAY]: [
  item("Practice", 780, 45),
  item("Badminton", 960, 60, { type: "activity", locked: true }),
] });

const firstUseRig = () => uiRig({ branch: emptyBranch(), selected: null, saveKeepsUndo: true, extraApi: (context) => ({
  switchMode(mode) {
    if (mode !== "demo") return false;
    context.mode = "demo"; context.date = DAY; context.revision++;
    context.branch = { ...emptyBranch(example()), exampleOrigin: DAY };
    return true;
  },
}) });

const guideSteps = (html) => [...html.matchAll(/<section class="first-use-guide"[^>]*>[\s\S]*?<\/section>/g)]
  .flatMap((m) => [...m[0].matchAll(/<li>([^<]*)<\/li>/g)].map((li) => li[1].replace(/&quot;/g, '"')));

describe("the first-use guide", () => {
  test("has exactly three short steps that never send a new user into Advanced fields, and the example button says its data is fictional", () => {
    assert.equal(FIRST_USE_STEPS.length, 3);
    for (const step of FIRST_USE_STEPS) assert.ok(step.split(/\s+/).length <= 10, step);
    assert.ok(!/advanced|tag|priority|deadline|habit|tiring|lock/i.test(FIRST_USE_STEPS.join(" ")), FIRST_USE_STEPS.join(" "));
    assert.deepEqual(guideSteps(firstUseGuide()), FIRST_USE_STEPS);
    assert.match(EXAMPLE_BUTTON_LABEL, /fictional/i);
    assert.equal(showsFirstUseGuide({ branch: { undo: null } }), true);
    assert.equal(showsFirstUseGuide({ branch: { undo: { id: "x" } } }), false, "hidden once a change is saved");
    assert.equal(showsFirstUseGuide({ branch: {}, error: "broken" }), false, "recovery screen stays focused");
  });

  test("is shown on the first screen with a fictional-data example button", () => {
    const r = firstUseRig();
    try {
      assert.deepEqual(guideSteps(r.html()), FIRST_USE_STEPS, "three-step guide on the first screen");
      assert.equal(r.label("try-demo"), EXAMPLE_BUTTON_LABEL);
      assert.match(r.label("try-demo"), /Fictional data/);
      assert.match(r.html(), /made-up tasks/);
    } finally { r.close(); }
  });

  test("lets a new user complete one reschedule within 90 seconds by following only the on-screen guide", async () => {
    const started = performance.now();
    const r = firstUseRig();
    try {
      r.click("try-demo"); // enter the fictional example
      assert.equal(r.context.mode, "demo");
      assert.deepEqual(guideSteps(r.html()), FIRST_USE_STEPS, "the guide stays while practising");
      // Step 1 is already done: the example opens with a task picked. Step 2 names the button on screen.
      assert.match(r.html(), /<h1>Practice<\/h1>/);
      assert.equal(r.label("task-actions"), "Choose a time");
      assert.ok(FIRST_USE_STEPS[1].includes(r.label("task-actions")), "step 2 names the visible button");
      r.click("task-actions");
      r.type("tomorrow at 11 am");
      await tick();
      assert.match(r.output(), /<h2>Change it like this\?<\/h2>/);
      assert.equal(r.label("confirm"), "Yes");
      assert.ok(FIRST_USE_STEPS[2].includes('"Yes"'), "step 3 names the answer button");
      r.click("confirm");
      assert.equal(r.saves, 1, "one reschedule saved");
      const moved = r.context.branch.days["2026-10-14"]?.find((t) => t.id === "Practice");
      assert.equal(moved?.start, 660);
      const badminton = r.context.branch.days[DAY].find((t) => t.id === "Badminton");
      assert.deepEqual(badminton, example()[DAY][1], "the fixed event did not move");
      // Time budget: a deliberately slow first-time user (20 s to read the guide,
      // 15 s per click, 20 s to type a time) stays under 90 seconds.
      assert.ok(r.clicks <= 3, `${r.clicks} clicks`);
      const budget = 20 + r.clicks * 15 + r.typed * 20;
      assert.ok(budget <= 90, `${budget} s estimated`);
      assert.ok(performance.now() - started < 90_000);
      r.bench.home();
      assert.deepEqual(guideSteps(r.html()), [], "the guide steps aside after the first saved change");
    } finally { r.close(); }
  });

  test("gives a phrase to type in step 2, and stays hidden after Undo or switching schedules", async () => {
    assert.match(FIRST_USE_STEPS[1], /"tomorrow at 11 am"/, "step 2 shows the exact phrase the first-use test types");
    assert.equal(showsFirstUseGuide({ branch: { undo: null }, ui: { rescheduledOnce: true } }), false, "remembered across reloads");
    const r = firstUseRig();
    try {
      r.click("try-demo");
      r.click("task-actions");
      assert.match(r.html(), /placeholder="For example: tomorrow at 11 am"/, "the input suggests the same phrase");
      r.type(FIRST_USE_STEPS[1].match(/"([^"]+)"/)[1]);
      await tick();
      r.click("confirm");
      assert.equal(r.saves, 1);
      // Undo the change: the branch has no undo record left, but the guide must not return.
      r.context.branch.undo = null;
      r.context.branch.days = example();
      r.bench.home();
      assert.deepEqual(guideSteps(r.html()), [], "hidden after Undo");
      // Switch to the untouched personal schedule.
      r.context.mode = "personal";
      r.context.branch = emptyBranch();
      r.context.revision++;
      r.bench.home();
      assert.deepEqual(guideSteps(r.html()), [], "hidden after switching to the personal schedule");
    } finally { r.close(); }
  });

  test("keeps the same three steps one tap away once the full guide hides", async () => {
    const r = firstUseRig();
    try {
      assert.doesNotMatch(r.html(), /first-use-reminder/, "no duplicate while the full guide shows");
      r.click("try-demo");
      r.click("task-actions");
      r.type(FIRST_USE_EXAMPLE_TIME);
      await tick();
      r.click("confirm");
      r.context.mode = "personal";
      r.context.branch = emptyBranch();
      r.context.revision++;
      r.bench.home();
      const reminder = r.html().match(/<details class="first-use-reminder">[\s\S]*?<\/details>/)?.[0] || "";
      assert.match(reminder, /<summary>How to reschedule<\/summary>/, "the personal schedule can reopen the steps");
      assert.deepEqual([...reminder.matchAll(/<li>([^<]*)<\/li>/g)].map((li) => li[1].replace(/&quot;/g, '"')), FIRST_USE_STEPS);
      assert.doesNotMatch(reminder, /<details[^>]*\bopen\b/, "collapsed, so the screen stays clean");
    } finally { r.close(); }
  });
});

describe("saved study plans after an upgrade", () => {
  test("a plan without an identity gets the default one, and a custom plan identity is not rewritten", () => {
    const day = "2026-10-12";
    const saved = (planId) => ({ id: "old", uid: "old", title: "Previously saved study", start: 660, duration: 30, rest: 0, type: "task",
      tags: ["study"], planId, packageId: "existing-package", packageOriginDate: day, packageOrder: 20261012, packageTaskOrder: 0,
      dependencies: [], done: false, locked: false });
    const days = normalizeLearningDays({ [day]: [
      { ...saved(undefined), packageId: undefined },
      { ...saved("Default study plan"), id: "custom", uid: "custom", packageId: undefined },
    ] });
    assert.equal(days[day][0].planId, "study-default");
    assert.equal(days[day][1].planId, "Default study plan");
    assert.equal(packageSummary(days).length, 2);
  });
});
