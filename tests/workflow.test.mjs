// Undo of confirmed schedule adjustments: what it restores, and when it must refuse
// because later changes would be overwritten or invalidated.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "../storage.js";
import { plan } from "../planner.js";
import { moveIntent, validateIntentDays } from "../intent-planner.js";
import { normalizeLearningDays } from "../learning.js";
import { adjustmentRecord, undoAdjustment } from "../workflow.js";
import { addDays } from "../time.js";

const MON = "2026-10-12", TUE = "2026-10-13", WED = "2026-10-14";

const task = (id, start = 660, extra = {}) => ({
  id, uid: `uid-${id}`, title: id, start, duration: 30, rest: 20, type: "task", done: false, locked: false,
  deferred: false, counted: false, bufferBefore: 0, bufferAfter: 0, dependencies: [], ...extra,
});
const study = (id, date, order, extra = {}) => task(id, 660, {
  tags: ["study"], planId: "job-prepare", packageId: `p-${order}`, packageOrder: order, packageTaskOrder: 0, packageOriginDate: date, ...extra,
});

// Three (or more) learning days; study-0 is moved from Monday to Tuesday, and the
// returned data is what would be saved and reloaded after confirming that move.
// Wednesday is a closed learning day, so the original schedule already holds a conflict.
function movedStudyFixture(count = 3) {
  const settings = defaults();
  settings.learningDates[WED] = { closed: true, source: "user-confirmed" };
  const days = {};
  for (let i = 0; i < count; i++) {
    const date = addDays(MON, i);
    days[date] = [
      study(`study-${i}`, date, i),
      study(`practice-${i}`, date, i, { start: 710, duration: 45, packageTaskOrder: 1, dependencies: [{ id: `uid-study-${i}`, gap: 0 }] }),
    ];
  }
  days[MON].unshift(study("done", MON, 0, { start: 540, done: true, packageTaskOrder: -1, doneAt: "2026-10-12T16:30:00Z", completedDate: MON }));
  days[TUE].push(task("medical", 840, { type: "activity", locked: true, purpose: "medical", bufferBefore: 60, rest: 0, duration: 45 }));
  days[WED].push(task("badminton", 1080, { type: "activity", locked: true, rest: 0, duration: 90 }));
  const original = normalizeLearningDays(days);
  const result = moveIntent(original, settings, { taskId: "study-0", targetDate: TUE, targetStart: 660 });
  assert.equal(result.status, "ok");
  const action = adjustmentRecord(original, result.days, {}, {}, "Move study", settings);
  return { original, data: JSON.parse(JSON.stringify({ days: result.days, settings, daySettings: {}, undo: action })) };
}

// A same-day move of one task from 11:00 to 12:00, recorded as an undoable action.
function sameDayMove() {
  const settings = defaults(), before = { [MON]: [task("a", 660)] }, after = { [MON]: [task("a", 720)] };
  return { settings, data: { days: after, settings, daySettings: {}, undo: adjustmentRecord(before, after, {}, {}, "same-day", settings) } };
}

describe("undoing a move across learning days", () => {
  for (const count of [3, 60, 90]) {
    test(`restores ${count} whole learning days after confirmation and reload despite an original closed-day conflict`, () => {
      const { original, data } = movedStudyFixture(count), saved = structuredClone(data);
      assert.ok(validateIntentDays(original, data.settings).conflicts.some((c) => c.ids.includes("study-2")));
      assert.equal(validateIntentDays(data.days, data.settings).status, "ok");
      const result = undoAdjustment(data);
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(result.data.days, original);
      assert.equal(result.data.undo, null);
      assert.deepEqual(data, saved, "undo does not mutate its input");
    });
  }

  test("keeps later non-conflicting additions, Calendar links and completed evidence", () => {
    const { data, original } = movedStudyFixture();
    data.days[MON].push(task("new", 1000));
    data.days[TUE].find((t) => t.id === "study-0").calendarLink = { source: "google", eventId: "verified-event", managed: true };
    const result = undoAdjustment(data);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.data.days[MON].find((t) => t.id === "done"), original[MON].find((t) => t.id === "done"));
    assert.equal(result.data.days[MON].find((t) => t.id === "study-0").calendarLink.eventId, "verified-event");
    assert.ok(result.data.days[MON].some((t) => t.id === "new"));
  });

  test("keeps harmless later Calendar metadata instead of replacing the whole task", () => {
    const { data } = movedStudyFixture(), moved = data.days[TUE].find((t) => t.id === "study-0");
    moved.calendarSource = { summary: moved.title, remoteMetadataRevision: 2 };
    const result = undoAdjustment(data);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.data.days[MON].find((t) => t.id === "study-0").calendarSource, moved.calendarSource);
  });

  test("is not frozen by an unchanged conflict in an unrelated plan", () => {
    const { data } = movedStudyFixture(), later = "2026-12-01";
    data.days[later] = [task("unrelated-x", 660), task("unrelated-y", 670)];
    assert.equal(validateIntentDays(data.days, data.settings).status, "conflict");
    const result = undoAdjustment(data);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.data.days[later], data.days[later]);
  });

  test("refuses when a new task collides, even though another original conflict is tolerated", () => {
    const { data } = movedStudyFixture();
    data.days[MON].push(task("new", 660));
    const saved = structuredClone(data);
    assert.equal(undoAdjustment(data).ok, false);
    assert.deepEqual(data, saved);
  });

  test("refuses when a later setting closed the destination day instead of treating it as an old conflict", () => {
    const { data } = movedStudyFixture();
    data.settings.learningDates[MON] = { closed: true, source: "calendar-description" };
    assert.equal(undoAdjustment(data).ok, false);
  });

  test("refuses after a later completion change and leaves its timestamps alone", () => {
    const { data } = movedStudyFixture(), moved = data.days[TUE].find((t) => t.id === "study-0");
    Object.assign(moved, { done: true, doneAt: "2026-10-13T19:00:00Z", completedDate: TUE });
    const saved = structuredClone(data);
    assert.equal(undoAdjustment(data).ok, false);
    assert.deepEqual(data, saved);
  });

  test("refuses when new learning would push the restored day over the 150-minute daily capacity", () => {
    const { data } = movedStudyFixture();
    data.days[MON].push(study("new-course", MON, 100, { start: 1000, duration: 80, planId: "independent-course", packageId: "other" }));
    assert.equal(validateIntentDays(data.days, data.settings).status, "ok");
    const saved = structuredClone(data);
    assert.equal(undoAdjustment(data).ok, false);
    assert.deepEqual(data, saved);
  });

  test("refuses records saved without a conflict baseline", () => {
    const { data } = movedStudyFixture();
    delete data.undo.validationBaseline;
    assert.equal(undoAdjustment(data).ok, false);
  });

  test("refuses an enlarged clash whose pair and message are identical to the original one", () => {
    const settings = defaults();
    const before = { [MON]: [task("a", 660), task("fixed", 680, { type: "activity", locked: true, rest: 0 })] };
    const after = { [MON]: [task("fixed", 680, { type: "activity", locked: true, rest: 0 })], [TUE]: [task("a", 660)] };
    const data = { days: after, settings, daySettings: {}, undo: adjustmentRecord(before, after, {}, {}, "cross-day", settings) };
    const old = validateIntentDays(before, settings).conflicts[0].message;
    data.days[MON][0].start = 670;
    const reverted = { ...data.days, [MON]: [before[MON][0], data.days[MON][0]], [TUE]: [] };
    assert.equal(validateIntentDays(reverted, settings).conflicts[0].message, old);
    const saved = structuredClone(data);
    assert.equal(undoAdjustment(data).ok, false);
    assert.deepEqual(data, saved);
  });

  describe("with a single moved task", () => {
    const buffered = (id, start, extra = {}) => task(id, start, { uid: id, duration: 45, rest: 15, bufferBefore: 60, bufferAfter: 60, ...extra });

    test("restores the full order of both dates and keeps a later Calendar link and a later new task", () => {
      const first = "2026-10-09", next = "2026-10-10", settings = defaults();
      const days = {
        [first]: [buffered("done", 600, { done: true }), buffered("a", 720), buffered("b", 800),
          buffered("fixed", 1020, { type: "activity", locked: true }), buffered("backlog", 840, { deferred: true })],
        [next]: [buffered("future", 660)],
      };
      const result = plan(days, settings, { anchorId: "a", date: first, start: 1350, mode: "cross-day", searchDays: 5 });
      assert.equal(result.status, "ok");
      const data = { days: result.days, settings, daySettings: {}, undo: adjustmentRecord(days, result.days, {}, {}, "cross-day") };
      Object.values(data.days).flat().find((t) => t.id === "a").calendarLink = { eventId: "stable-event", signature: "after" };
      const newDate = "2026-10-15";
      data.days[newDate] = [buffered("later-new", 900)];
      const undone = undoAdjustment(data);
      assert.equal(undone.ok, true, undone.message);
      assert.deepEqual(undone.data.days[first].map((t) => t.id), days[first].map((t) => t.id));
      assert.deepEqual(undone.data.days[next].map((t) => t.id), days[next].map((t) => t.id));
      assert.equal(undone.data.days[first].find((t) => t.id === "a").calendarLink.eventId, "stable-event");
      assert.equal(undone.data.days[newDate][0].id, "later-new");
    });

    test("refuses when the moved task was completed afterwards", () => {
      const settings = defaults(), days = { "2026-10-09": [buffered("a", 720)] };
      const result = plan(days, settings, { anchorId: "a", start: 1350, mode: "cross-day" });
      const data = { days: result.days, settings, daySettings: {}, undo: adjustmentRecord(days, result.days, {}, {}, "cross-day") };
      Object.values(data.days).flat().find((t) => t.id === "a").done = true;
      assert.equal(undoAdjustment(data).ok, false);
    });
  });
});

describe("undoing a same-day move", () => {
  test("refuses after completion evidence was added, even if the checkbox went back to unchecked", () => {
    const { data } = sameDayMove();
    data.days[MON][0].completedDate = MON;
    data.days[MON][0].doneAt = "2026-10-12T19:00:00Z";
    assert.equal(undoAdjustment(data).ok, false);
  });

  test("refuses after the user edited the same task and keeps the edit", () => {
    const { data } = sameDayMove();
    data.days[MON][0].notes = "Later personal note";
    assert.equal(undoAdjustment(data).ok, false);
    assert.equal(data.days[MON][0].notes, "Later personal note");
  });

  test("refuses when restoring a predecessor would invalidate a dependent task added later", () => {
    const settings = defaults(), before = { [MON]: [task("a", 720)] }, after = { [MON]: [task("a", 660)] };
    const data = { days: after, settings, daySettings: {}, undo: adjustmentRecord(before, after, {}, {}, "same-day", settings) };
    data.days[MON].push(task("new-child", 710, { dependencies: [{ id: "uid-a", gap: 0 }] }));
    assert.equal(validateIntentDays(data.days, settings).status, "ok");
    assert.equal(undoAdjustment(data).ok, false);
  });
});

describe("undoing a settings change", () => {
  test("restores capacity and windows as one action", () => {
    const settings = defaults(), next = { ...settings, capacity: 150 }, days = { "2026-10-09": [task("a", 720)] };
    const action = adjustmentRecord(days, days, {}, {}, "settings");
    action.globalSettings = { before: settings, after: next };
    const result = undoAdjustment({ days, settings: next, daySettings: {}, undo: action });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.settings, settings);
  });

  test("refuses to undo wider rules when a new activity needs the widened window", () => {
    const beforeSettings = { ...defaults(), weekly: { 1: [[540, 720]] } }, afterSettings = defaults(), days = { [MON]: [task("a", 660)] };
    const action = adjustmentRecord(days, days, {}, {}, "widen rules", beforeSettings);
    action.globalSettings = { before: beforeSettings, after: afterSettings };
    const data = { days: structuredClone(days), settings: afterSettings, daySettings: {}, undo: action };
    data.days[MON].push(task("new", 800));
    assert.equal(validateIntentDays(data.days, data.settings).status, "ok");
    assert.equal(undoAdjustment(data).ok, false);
  });
});

describe("undoing a purpose correction", () => {
  test("restores the full classification metadata so a re-read cannot revive the undone study label", () => {
    const settings = defaults(), before = { [MON]: [task("ordinary", 660)] }, after = structuredClone(before);
    Object.assign(after[MON][0], {
      tags: ["study"], counted: true, purpose: "learning", learning: true,
      semantic: { purpose: "learning", source: "user-confirmed" },
      calendarClassification: { kind: "learning", source: "user-confirmed-purpose" },
      semanticLock: false, protectionSource: "semantic-medical",
    });
    const undo = adjustmentRecord(before, after, {}, {}, "Correct purpose", settings, { captureSemantic: true });
    const result = undoAdjustment({ days: after, settings, daySettings: {}, undo });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.data.days, before);
  });

  test("restores the local memory and keeps the Google mapping and other calendar data", () => {
    const settings = defaults(), before = { [MON]: [task("meaning", 660)] }, after = structuredClone(before);
    after[MON][0].purpose = "medical";
    const action = adjustmentRecord(before, after, {}, {}, "Correct purpose", settings);
    action.semanticMetadata = {
      semanticDecisions: { before: { old: { purpose: "life" } }, after: { old: { purpose: "life" }, meaning: { purpose: "medical" } } },
    };
    const data = {
      days: after, settings, daySettings: {},
      calendar: { semanticDecisions: action.semanticMetadata.semanticDecisions.after, calendars: [{ id: "keep" }] },
      undo: action,
    };
    const result = undoAdjustment(data);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.data.calendar.semanticDecisions, { old: { purpose: "life" } });
    assert.deepEqual(result.data.calendar.calendars, [{ id: "keep" }]);
    assert.equal(result.data.days[MON][0].purpose, undefined);
  });

  test("refuses when a newer confirmation was made after the correction, so it is never silently overwritten", () => {
    const settings = defaults(), days = { [MON]: [task("meaning", 660)] };
    const action = adjustmentRecord(days, days, {}, {}, "Correct purpose", settings);
    action.semanticMetadata = { semanticDecisions: { before: {}, after: { meaning: { purpose: "medical" } } } };
    const data = {
      days, settings, daySettings: {},
      calendar: { semanticDecisions: { meaning: { purpose: "medical" }, newer: { purpose: "life" } } },
      undo: action,
    };
    assert.equal(undoAdjustment(data).ok, false);
  });
});

describe("undoing a lock change", () => {
  test("a change of lock ownership is recorded even when the task stays locked, and a later ownership change invalidates the undo", () => {
    const settings = defaults(), before = { [MON]: [task("ownership", 660, { locked: true, calendarRestrictionLock: true })] };
    const after = structuredClone(before);
    after[MON][0].calendarRestrictionLock = false;
    const action = adjustmentRecord(before, after, {}, {}, "Explicit lock", settings);
    assert.equal(action.patches.length, 1);
    const data = JSON.parse(JSON.stringify({ days: after, settings, daySettings: {}, undo: action }));
    const restored = undoAdjustment(data);
    assert.equal(restored.ok, true, restored.message);
    assert.deepEqual(restored.data.days, before);
    delete data.days[MON][0].calendarRestrictionLock;
    assert.equal(undoAdjustment(data).ok, false, "a later provenance change invalidates the old undo");
  });

  test("user lock ownership is restored together with the restriction ownership, and later changes to either invalidate the undo", () => {
    const settings = defaults();
    const before = { [MON]: [task("ownership", 660, { locked: true, calendarRestrictionLock: true,
      calendarClassification: { kind: "task", locked: true, evidence: "original synthetic evidence" } })] };
    const after = structuredClone(before);
    Object.assign(after[MON][0], { calendarRestrictionLock: false, lockSource: "user" });
    delete after[MON][0].calendarClassification.locked;
    const action = adjustmentRecord(before, after, {}, {}, "Explicit lock", settings);
    const data = JSON.parse(JSON.stringify({ days: after, settings, daySettings: {}, undo: action }));
    const restored = undoAdjustment(data);
    assert.equal(restored.ok, true, restored.message);
    assert.deepEqual(restored.data.days, before);
    data.days[MON][0].calendarClassification.evidence = "refreshed synthetic evidence";
    assert.equal(undoAdjustment(data).ok, false, "changed classification metadata conservatively invalidates the undo");
    data.days[MON][0].calendarClassification.evidence = "original synthetic evidence";
    data.days[MON][0].lockSource = null;
    assert.equal(undoAdjustment(data).ok, false);
  });
});
