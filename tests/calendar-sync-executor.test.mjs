// Tests of the real sync executor from app.js (runSyncQueue and friends), run in an isolated
// VM against the real durable queue, Google merge and validation. Network, timers and storage
// are in-memory fakes; no OAuth, user storage or real Google access is involved.
// An in-flight execute must drain a newer confirmed intent serially; cancellation, conflicts
// and backoff must never produce a hot loop.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { presentError } from "../ui-messages.js";
import { freshWorkspace, normalizeWorkspace } from "../storage.js";
import { mergeCalendar, classifyCalendar, localCalendarSignature } from "../calendar-data.js";
import { enqueueChanges, pendingTasks, markSyncing, settleSync, syncPresentation } from "../sync-queue.js";
import { createWorkbench } from "../workbench.js";
import { validateIntentDays } from "../intent-planner.js";
import { calendarSignature, googleEventSignature } from "../calendar-service.mjs";
import { addDays, wallInstant } from "../time.js";
import { formatTime } from "../scheduler.js";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const begin = appSource.indexOf("function invalidateSync()"),
  end = appSource.indexOf('window.addEventListener("online"', begin);
assert.ok(begin >= 0 && end > begin, "the executor is extracted from the real app.js, never copied");
const executorSource = appSource.slice(begin, end);
const zone = "America/Los_Angeles", originalDate = "2026-10-12", firstDate = "2026-10-13";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function eventually(predicate, message) {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await turn();
  }
  assert.ok(predicate(), message);
}

// Options: failFirst (first execute throws a 503), genuineRemoteEdit (a third party edits Google after
// the first write), localCreate (the task has no Calendar event yet), holdRead / holdPreview (the first
// read / preview waits for releaseRead / releasePreview), failSecondRead, varyPreview (every preview
// changes saved state, so every plan is obsolete at once).
function rig({ failFirst = false, genuineRemoteEdit = false, localCreate = false, holdRead = false,
  holdPreview = false, failSecondRead = false, varyPreview = false } = {}) {
  const state = freshWorkspace();
  state.profileId = "SYNTHETIC-PROFILE";
  const event = {
    calendarId: "mine", calendarName: "Simulated own calendar", accessRole: "owner", calendarTimeZone: zone,
    eventId: "original-study-event", summary: "SQL ROW_NUMBER lesson", status: "confirmed",
    organizer: { self: true }, etag: '"initial"', managed: true, managedUid: "original-study-uid",
    managedProfileId: state.profileId, baselineEtag: '"initial"',
    start: { dateTime: new Date(wallInstant(originalDate, 660, zone)).toISOString(), timeZone: zone },
    end: { dateTime: new Date(wallInstant(originalDate, 705, zone)).toISOString(), timeZone: zone },
  };
  state.personal = mergeCalendar(state.personal, { events: [event] }, { profileId: state.profileId }).data;
  if (localCreate) {
    const task = Object.values(state.personal.days).flat()[0];
    delete task.calendarLink;
    delete task.calendarSource;
    delete task.calendarOccupation;
    task.externalReadOnly = false;
    task.locked = false;
  }
  state.personal.calendar.autoSync = true;
  state.personal.calendar.targetCalendarId = "mine";
  const before = structuredClone(state.personal.days), originalDays = structuredClone(before);
  state.personal.days = { [firstDate]: structuredClone(before[originalDate]) };
  state.personal.days[firstDate][0].calendarOccupation = {
    startInstant: wallInstant(firstDate, 660, zone), endInstant: wallInstant(firstDate, 705, zone),
  };
  state.personal = enqueueChanges(state.personal, before, state.personal.days, { profileId: state.profileId });
  const held = deferred(), firstStarted = deferred(), heldRead = deferred(), readStarted = deferred(),
    heldPreview = deferred(), previewStarted = deferred(), calls = [], plans = new Map(), timers = new Map();
  let clock = Date.now(), timerId = 0, executeInFlight = 0, maxExecuteInFlight = 0, created = !localCreate;
  const snapshot = () => structuredClone(context.state);
  const context = vm.createContext({
    state, mode: "personal", syncBusy: false, syncGeneration: 0, syncDrainRequested: false,
    syncRequestedGeneration: null, syncRunningGeneration: null, lastActionError: "",
    actionError: (message) => { context.lastActionError = message; },
    syncRetryTimer: null, calendarStatus: { state: "connected", writesEnabled: true },
    structuredClone, presentError, pendingTasks, markSyncing, settleSync, localCalendarSignature,
    validatePlan: validateIntentDays, addDays, formatTime,
    Date: class extends Date { static now() { return clock; } },
    all: (days) => Object.entries(days).flatMap(([date, tasks]) => tasks.map((task) => ({ date, task }))),
    save: (mutator) => { mutator(context.state); context.state.revision++; return true; },
    renderCalendarState: () => {},
    clearTimeout: (id) => timers.delete(id),
    setTimeout: (callback, wait) => { const id = ++timerId; timers.set(id, { callback, due: clock + wait, wait }); return id; },
    readCalendar: async (date, options) => {
      calls.push({ kind: "read", date, options: structuredClone(options), generation: context.syncGeneration });
      if (failSecondRead && calls.filter((c) => c.kind === "read").length === 2)
        return { ok: false, complete: false, message: "503 network read failed" };
      const merged = mergeCalendar(context.state.personal, { events: created ? [structuredClone(event)] : [] },
        { profileId: state.profileId });
      context.state.personal = merged.data;
      context.state.personal.calendar.readRanges = [...(context.state.personal.calendar.readRanges || []),
        { from: options.rangeFrom, to: options.rangeTo, timeZone: zone, partial: false, loadedAt: new Date(clock).toISOString() }];
      context.state.revision++;
      if (holdRead && calls.filter((c) => c.kind === "read").length === 1) {
        readStarted.resolve();
        await heldRead.promise;
      }
      return { ok: true, complete: true };
    },
    calendarRequest: async (kind, payload) => {
      calls.push({ kind, payload: structuredClone(payload), generation: context.syncGeneration });
      if (kind === "preview") {
        assert.ok(payload.tasks.every((task) => !Object.hasOwn(task, "syncJobId")),
          "the internal intent version must not leak into Google task payloads");
        const planId = `mock-${plans.size + 1}`, task = payload.tasks[0], instant = wallInstant(task.date, task.start, zone);
        const action = !created ? "create"
          : Date.parse(event.start.dateTime) === instant && Date.parse(event.end.dateTime) === instant + task.duration * 60000
              && event.summary === task.title ? "skip" : "update";
        plans.set(planId, { ...structuredClone(payload), mockAction: action });
        if (holdPreview && plans.size === 1) {
          previewStarted.resolve();
          await heldPreview.promise;
        }
        if (varyPreview) context.save((s) => (s.personal.settings.minGap = plans.size));
        const denied = (context.state.personal.calendar.calendars || []).some(
          (c) => c.id === payload.tasks[0].calendarLink?.calendarId && c.accessRole !== "owner");
        return {
          planId, writesEnabled: true, canExecute: !denied,
          items: payload.tasks.map((t) => ({ title: t.title, date: t.date, start: t.start, action: denied ? "error" : action,
            ...(denied ? { reason: "Your Calendar management permission was withdrawn. Nothing was written. Reconnect Google Calendar and preview again." } : {}) })),
        };
      }
      assert.equal(kind, "execute");
      const plan = plans.get(payload.planId);
      assert.ok(plan);
      calls.at(-1).mockAction = plan.mockAction;
      executeInFlight++;
      maxExecuteInFlight = Math.max(maxExecuteInFlight, executeInFlight);
      try {
        if (plans.size === 1) {
          firstStarted.resolve();
          await held.promise;
          if (failFirst) throw Error("503 network temporarily failed");
        }
        const task = plan.tasks[0], instant = wallInstant(task.date, task.start, zone);
        if (plan.mockAction !== "skip") {
          created = true;
          event.start.dateTime = new Date(instant).toISOString();
          event.end.dateTime = new Date(instant + task.duration * 60000).toISOString();
          event.etag = `"written-${plans.size}"`;
          event.baselineEtag = event.etag;
        }
        const response = { results: plan.tasks.map((t) => ({ uid: t.uid, id: t.id, ok: true, calendarLink: {
          source: "google", managed: true, calendarId: "mine", eventId: event.eventId, etag: event.etag,
          signature: calendarSignature(t), remoteSignature: googleEventSignature(event), profileId: state.profileId } })) };
        if (genuineRemoteEdit && plans.size === 1) {
          // A third party changes Google after our actual write and receipt.
          event.start.dateTime = new Date(wallInstant(firstDate, 810, zone)).toISOString();
          event.end.dateTime = new Date(wallInstant(firstDate, 855, zone)).toISOString();
          event.etag = '"genuine-third-party-update"';
        }
        return response;
      } finally { executeInFlight--; }
    },
  });
  vm.runInContext(executorSource, context, { filename: "app.js:sync-executor" });
  const run = () => vm.runInContext("runSyncQueue()", context);
  const change = (date, start) => {
    const branch = structuredClone(context.state.personal), prior = structuredClone(branch.days),
      task = Object.values(branch.days).flat()[0];
    task.start = start;
    task.calendarOccupation = { startInstant: wallInstant(date, start, zone), endInstant: wallInstant(date, start + task.duration, zone) };
    branch.days = { [date]: [task] };
    context.state.personal = enqueueChanges(branch, prior, branch.days, { profileId: state.profileId });
    context.state.revision++;
    return run();
  };
  return {
    context, calls, timers, snapshot, run, change,
    firstStarted: firstStarted.promise, release: held.resolve,
    readStarted: readStarted.promise, releaseRead: heldRead.resolve,
    previewStarted: previewStarted.promise, releasePreview: heldPreview.resolve,
    undo: () => change(originalDate, originalDays[originalDate][0].start),
    off: () => {
      vm.runInContext("invalidateSync()", context);
      context.state.personal.calendar.autoSync = false;
      context.state.personal.calendar.syncRetry = null;
      context.state.revision++;
    },
    on: () => {
      vm.runInContext("invalidateSync()", context);
      context.state.personal.calendar.autoSync = true;
      context.state.revision++;
      return run();
    },
    advance: async (milliseconds) => {
      clock += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); }
      await turn();
    },
    maxInFlight: () => maxExecuteInFlight,
    error: () => context.lastActionError,
  };
}

// scenario(title, [rigOptions,] body): runs body with a fresh rig.
function scenario(name, options, body) {
  if (typeof options === "function") [options, body] = [{}, options];
  test(name, () => body(rig(options)));
}

const executions = (r) => r.calls.filter((c) => c.kind === "execute");
const previews = (r) => r.calls.filter((c) => c.kind === "preview");
const reads = (r) => r.calls.filter((c) => c.kind === "read");
const branchOf = (r) => r.context.state.personal;
const theTask = (r) => Object.values(branchOf(r).days).flat()[0];
const pending = (r) => pendingTasks(branchOf(r));
const jobs = (r) => branchOf(r).calendar.syncQueue.jobs;
const settled = (r) => eventually(() => !r.context.syncBusy, "the sync run finishes");
const completeCatalog = (extra = {}) => ({ calendarId: "mine", from: originalDate, to: "2027-02-01", timeZone: zone, partial: false, ...extra });
const withCatalog = (r, catalogs = [completeCatalog()]) => { branchOf(r).calendar.learningCatalogs = catalogs; };
const bump = (r) => r.context.state.revision++;
const finishPreview = async (r, first) => { r.release(); r.releasePreview(); await first; };
const otherCalendarLink = (task) => ({ ...task.calendarLink, calendarId: "other-calendar",
  eventId: "other-user-chosen-event", etag: '"other-baseline"' });
const CATALOG_MISSING = /study catalog is incomplete or a required catalog is missing/;

// After an old execution, one serial fresh run of the latest confirmed queue follows.
async function expectLatest(r, date, start) {
  await eventually(() => executions(r).length === 2 && !r.context.syncBusy,
    "the old execution triggers a serial fresh run of the latest queue");
  assert.equal(reads(r).length, 2, "the new desired state re-reads the current Calendar constraints");
  assert.equal(previews(r).length, 2, "the new desired state uses a fresh preview, not the old plan ID");
  assert.equal(previews(r)[1].payload.tasks[0].date, date);
  assert.equal(previews(r)[1].payload.tasks[0].start, start);
  assert.equal(previews(r)[1].payload.tasks[0].calendarLink.eventId, "original-study-event");
  assert.equal(pending(r).length, 0);
  assert.equal(r.maxInFlight(), 1);
  assert.equal(r.timers.size, 0);
  assert.ok(!theTask(r).calendarConflict, "our own old write receipt is not misread as a concurrent external edit");
}

describe("a newer confirmation while a write is in flight", () => {
  scenario("a second confirmation during execution automatically continues with a fresh read and preview of the same event", async (r) => {
    const first = r.run();
    await r.firstStarted;
    await r.change(firstDate, 720);
    assert.equal(executions(r).length, 1);
    r.release();
    await first;
    await expectLatest(r, firstDate, 720);
  });

  scenario("undoing during execution restores the target, and the old success does not overwrite the undo", async (r) => {
    const first = r.run();
    await r.firstStarted;
    await r.undo();
    r.release();
    await first;
    await expectLatest(r, originalDate, 660);
  });

  scenario("editing during the first create keeps the latest target and continues the same event with the same uid", { localCreate: true }, async (r) => {
    const first = r.run();
    await r.firstStarted;
    await r.change(firstDate, 720);
    r.release();
    await first;
    await expectLatest(r, firstDate, 720);
    assert.equal(theTask(r).start, 720);
  });

  scenario("turning auto-sync off and on during a second move cannot continue from the old flight; a new run can", async (r) => {
    const first = r.run();
    await r.firstStarted;
    await r.change(firstDate, 720);
    r.off();
    await r.on();
    r.release();
    await first;
    await turn();
    assert.equal(executions(r).length, 1);
    assert.equal(previews(r).length, 1);
    assert.equal(r.timers.size, 0);
    assert.equal(pending(r)[0].task.start, 720);
    await r.run();
    await expectLatest(r, firstDate, 720);
  });

  scenario("a failed old execute does not hot-loop; the new queue is kept until a bounded backoff", { failFirst: true }, async (r) => {
    const first = r.run();
    await r.firstStarted;
    await r.change(firstDate, 720);
    r.release();
    await first;
    await turn();
    assert.equal(executions(r).length, 1);
    assert.equal(previews(r).length, 1);
    assert.equal(r.timers.size, 1);
    assert.equal([...r.timers.values()][0].wait, 2000);
    assert.equal(pending(r)[0].task.start, 720);
    await r.advance(1999);
    assert.equal(executions(r).length, 1);
    await r.advance(1);
    await expectLatest(r, firstDate, 720);
  });

  scenario("several quick confirmations continue serially with only the final one; superseded ones are not executed", async (r) => {
    const first = r.run();
    await r.firstStarted;
    for (const start of [720, 780, 840, 900]) await r.change(firstDate, start);
    assert.equal(executions(r).length, 1);
    r.release();
    await first;
    await expectLatest(r, firstDate, 900);
    assert.deepEqual(previews(r).map((c) => c.payload.tasks[0].start), [660, 900]);
  });

  scenario("a genuine third-party remote update is still a two-sided conflict and stops the continuation", { genuineRemoteEdit: true }, async (r) => {
    const first = r.run();
    await r.firstStarted;
    await r.change(firstDate, 720);
    r.release();
    await first;
    await settled(r);
    const task = theTask(r);
    assert.equal(task.start, 720);
    assert.equal(task.calendarConflict.kind, "both_changed");
    assert.equal(task.calendarConflict.remote.start, 810);
    assert.equal(reads(r).length, 2);
    assert.equal(previews(r).length, 1);
    assert.equal(executions(r).length, 1);
    assert.equal(r.timers.size, 0);
    assert.equal(jobs(r).at(-1).status, "queued");
  });

  scenario("with writes switched off nothing continues, and re-enabling needs a new read and preview", async (r) => {
    const first = r.run();
    await r.firstStarted;
    await r.change(firstDate, 720);
    r.context.calendarStatus.writesEnabled = false;
    r.release();
    await first;
    await turn();
    assert.equal(previews(r).length, 1);
    assert.equal(executions(r).length, 1);
    assert.equal(pending(r)[0].task.start, 720);
    r.context.calendarStatus.writesEnabled = true;
    await r.run();
    await expectLatest(r, firstDate, 720);
  });
});

describe("a late receipt after the user changed the mapping", () => {
  for (const moved of [true, false]) {
    scenario(`an old success does not overwrite an event the user linked later${moved ? ", even after a newer move" : " with unchanged content and position"}`, async (r) => {
      const first = r.run();
      await r.firstStarted;
      if (moved) await r.change(firstDate, 720);
      const task = theTask(r);
      task.calendarLink = otherCalendarLink(task);
      const chosenLink = structuredClone(task.calendarLink);
      r.off();
      r.release();
      await first;
      assert.deepEqual(theTask(r).calendarLink, chosenLink);
      assert.equal(theTask(r).start, moved ? 720 : 660);
      if (moved) {
        assert.equal(jobs(r)[0].items[0].receipt.eventId, "original-study-event");
        assert.equal(jobs(r).at(-1).status, "queued");
        assert.equal(executions(r).length, 1);
      }
    });
  }

  scenario("an old receipt cannot restore management the user revoked", async (r) => {
    const first = r.run();
    await r.firstStarted;
    theTask(r).calendarLink.managed = false;
    r.release();
    await first;
    assert.equal(theTask(r).calendarLink.managed, false);
    assert.equal(executions(r).length, 1);
  });

  scenario("a response with the right id but the wrong uid cannot claim the request's success or overwrite metadata", async (r) => {
    const snapshot = pending(r), originalLink = structuredClone(snapshot[0].task.calendarLink);
    r.context.state.personal = settleSync(branchOf(r), { results: [{ id: snapshot[0].task.id, uid: "wrong-task-uid", ok: true,
      calendarLink: { ...originalLink, etag: '"wrong-uid-receipt"' } }] }, snapshot);
    assert.deepEqual(theTask(r).calendarLink, originalLink);
    assert.notEqual(jobs(r)[0].status, "success");
  });

  scenario("with the required read pending, swapping the mapping with the same content must not preview the old event", { holdRead: true }, async (r) => {
    const first = r.run();
    await r.readStarted;
    const task = theTask(r);
    task.calendarLink = otherCalendarLink(task);
    const chosenLink = structuredClone(task.calendarLink);
    bump(r);
    r.release(); // an unsafe old execute would finish rather than hang
    r.releaseRead();
    await first;
    assert.equal(previews(r).length, 0);
    assert.equal(executions(r).length, 0);
    assert.deepEqual(theTask(r).calendarLink, chosenLink);
    assert.equal(pending(r)[0].task.start, 660);
    assert.equal(r.timers.size, 0);
  });

  scenario("with the required read pending, revoking management previews and executes nothing", { holdRead: true }, async (r) => {
    const first = r.run();
    await r.readStarted;
    theTask(r).calendarLink.managed = false;
    bump(r);
    r.release();
    r.releaseRead();
    await first;
    assert.equal(previews(r).length, 0);
    assert.equal(executions(r).length, 0);
    assert.equal(pending(r).length, 0);
    assert.equal(theTask(r).calendarLink.managed, false);
    assert.equal(r.timers.size, 0);
  });
});

describe("changing back to an identical payload during a write (version ABA)", () => {
  scenario("a new job with the same payload still needs fresh verification", async (r) => {
    const first = r.run();
    await r.firstStarted;
    const oldJob = r.snapshot().personal.calendar.syncQueue.jobs[0];
    await r.change(firstDate, 720);
    await r.change(firstDate, 660);
    const newJob = r.snapshot().personal.calendar.syncQueue.jobs.at(-1);
    assert.equal(jobs(r).length, 3);
    assert.notEqual(oldJob.id, newJob.id);
    assert.equal(oldJob.items[0].signature, newJob.items[0].signature);
    r.release();
    await first;
    await expectLatest(r, firstDate, 660);
    assert.equal(executions(r)[1].mockAction, "skip", "the same remote content still needs a fresh plan and skip receipt");
    assert.deepEqual(jobs(r).map((j) => j.items[0].status), ["success", "superseded", "success"]);
  });

  scenario("with the required read pending the old snapshot is discarded and a fresh read continues", { holdRead: true }, async (r) => {
    const first = r.run();
    await r.readStarted;
    await r.change(firstDate, 720);
    await r.change(firstDate, 660);
    r.release();
    r.releaseRead();
    await first;
    await settled(r);
    assert.equal(reads(r).length, 2);
    assert.equal(previews(r).length, 1);
    assert.equal(executions(r).length, 1);
    assert.equal(jobs(r)[0].items[0].status, "superseded");
    assert.equal(jobs(r)[0].items[0].receipt, undefined);
    assert.equal(jobs(r)[2].items[0].status, "success");
    assert.equal(pending(r).length, 0);
    assert.equal(r.timers.size, 0);
  });

  scenario("with the preview pending the old plan ID is not executed, and re-checking has no backoff", { holdPreview: true }, async (r) => {
    const first = r.run();
    await r.previewStarted;
    await r.change(firstDate, 720);
    await r.change(firstDate, 660);
    await finishPreview(r, first);
    await settled(r);
    assert.equal(reads(r).length, 2);
    assert.equal(previews(r).length, 2);
    assert.equal(executions(r).length, 1);
    assert.equal(executions(r)[0].payload.planId, "mock-2");
    assert.equal(pending(r).length, 0);
    assert.equal(r.timers.size, 0);
  });

  scenario("a failed old execute neither claims nor fails the new job, and a fresh verification follows after backoff", { failFirst: true }, async (r) => {
    const first = r.run();
    await r.firstStarted;
    await r.change(firstDate, 720);
    await r.change(firstDate, 660);
    r.release();
    await first;
    assert.equal(executions(r).length, 1);
    assert.equal(jobs(r)[0].items[0].status, "superseded");
    assert.equal(jobs(r)[2].items[0].status, "queued");
    assert.equal(r.timers.size, 1);
    await r.advance(2000);
    await expectLatest(r, firstDate, 660);
  });
});

// Everything below changes the world while the first preview is still in flight.
describe("changes while a preview is pending", () => {
  // The workbench select callback saves only ui.date; a global revision bump from browsing is
  // not a change to an authorized sync plan.
  for (const otherTask of [false, true]) {
    scenario(`merely browsing ${otherTask ? "another task" : "other dates"} does not stop the sync`, { holdPreview: true }, async (r) => {
      if (otherTask) {
        r.context.state.ui.date = firstDate;
        branchOf(r).days[firstDate].push({ id: "other-browse-activity", uid: "other-browse-activity", title: "Read-only movie",
          start: 900, duration: 60, rest: 0, done: false, locked: true, externalReadOnly: true, type: "activity",
          dependencies: [], tags: [], bufferBefore: 60, bufferAfter: 60 });
      }
      const first = r.run();
      await r.previewStarted;
      const personalBefore = structuredClone(branchOf(r)), revision = r.context.state.revision;
      const selectedDay = otherTask ? firstDate : "2026-10-14";
      r.context.save((s) => (s.ui.date = selectedDay));
      assert.equal(r.context.state.ui.date, selectedDay);
      assert.ok(r.context.state.revision > revision);
      assert.deepEqual(branchOf(r), personalBefore);
      await finishPreview(r, first);
      assert.equal(executions(r).length, 1, "pure browsing does not invalidate the authorized preview");
      assert.equal(previews(r).length, 1);
      assert.equal(reads(r).length, 1);
      assert.equal(pending(r).length, 0);
      assert.equal(r.timers.size, 0);
    });
  }

  function addOtherActivity(r) {
    const task = { id: "fixed-movie", uid: "fixed-movie", title: "Fixed movie", start: 990, duration: 60, rest: 0,
      done: false, locked: true, externalReadOnly: true, type: "activity", dependencies: [], tags: [],
      bufferBefore: 60, bufferAfter: 60,
      calendarOccupation: { startInstant: wallInstant(firstDate, 990, zone), endInstant: wallInstant(firstDate, 1050, zone) },
      calendarLink: { source: "google", calendarId: "mine", eventId: "fixed-movie", managed: false, etag: '"movie-initial"' } };
    branchOf(r).days[firstDate].push(task);
    return task;
  }
  const movie = (r) => Object.values(branchOf(r).days).flat().find((t) => t.uid === "fixed-movie");
  async function expectRevalidated(r) {
    await eventually(() => !r.context.syncBusy && executions(r).length === 1,
      "a changed relevant context serially re-reads and previews the latest valid state");
    assert.equal(reads(r).length, 2);
    assert.equal(previews(r).length, 2);
    assert.equal(executions(r)[0].payload.planId, "mock-2");
    assert.equal(pending(r).length, 0);
    assert.equal(r.maxInFlight(), 1);
    assert.equal(r.timers.size, 0);
  }

  const contextChanges = [
    ["rules", (r) => (branchOf(r).settings.learningCapacity = 140)],
    ["real remote occupation", (r) => { movie(r).calendarOccupation.startInstant += 10 * 60000; movie(r).calendarOccupation.endInstant += 10 * 60000; }],
    ["another task content", (r) => { movie(r).title = "Fixed movie new content"; }],
    ["completion record", (r) => Object.assign(movie(r), { done: true, completedDate: firstDate, doneAt: "2026-10-13T23:30:00Z" })],
    ["target calendar", (r) => (branchOf(r).calendar.targetCalendarId = "other-owned")],
    ["classification decision", (r) => (branchOf(r).calendar.classificationRules = [
      { id: "new-once-rule", match: "description_contains", value: "unmatched-context", kind: "activity" }])],
    ["purpose decision", (r) => (branchOf(r).calendar.semanticDecisions = {
      '["mine","original-study-event"]': { purpose: "learning", source: "user-confirmed", scope: "purpose" } })],
    ["purpose correction rule", (r) => (branchOf(r).calendar.semanticCorrections = {
      "sql row_number lesson": { purpose: "learning", source: "user-confirmed", scope: "purpose" } })],
  ];
  for (const [label, mutate] of contextChanges) {
    scenario(`a non-conflicting ${label} change automatically re-reads fresh and then executes`, { holdPreview: true }, async (r) => {
      addOtherActivity(r);
      const first = r.run();
      await r.previewStarted;
      mutate(r);
      bump(r);
      await finishPreview(r, first);
      await expectRevalidated(r);
      assert.equal(previews(r)[1].payload.tasks[0].calendarLink.eventId, "original-study-event");
      if (label === "target calendar") assert.equal(previews(r)[1].payload.calendarId, "other-owned");
      if (label === "completion record") assert.equal(movie(r).doneAt, "2026-10-13T23:30:00Z");
    });
  }

  scenario("an unrelated complete range and timestamp refresh does not invalidate the plan", { holdPreview: true }, async (r) => {
    withCatalog(r, [completeCatalog({ loadedAt: "2026-10-10T10:00:00Z" })]);
    const first = r.run();
    await r.previewStarted;
    const branch = branchOf(r), unrelatedRange = { timeZone: zone, partial: false };
    for (const range of branch.calendar.readRanges) range.loadedAt = "new-complete-read-time";
    branch.calendar.readRanges.push({ ...unrelatedRange, from: "2026-10-20", to: "2026-10-21", loadedAt: "new-unrelated-date" });
    branch.calendar.learningCatalogs.push(
      { ...branch.calendar.learningCatalogs[0], loadedAt: "new-catalog-read-time" },
      { ...unrelatedRange, calendarId: "mine", from: "2027-03-01", to: "2027-04-01", loadedAt: "unrelated-catalog-date" },
      { ...unrelatedRange, calendarId: "unrelated-calendar", from: originalDate, to: "2027-04-01", loadedAt: "unrelated-catalog-id" });
    branch.calendar.calendars = [{ id: "unrelated-calendar", accessRole: "reader", timeZone: zone }];
    branch.days[firstDate][0].calendarLink.syncedAt = "metadata-only";
    bump(r);
    await finishPreview(r, first);
    assert.equal(executions(r).length, 1);
    assert.equal(previews(r).length, 1);
    assert.equal(reads(r).length, 1);
    assert.equal(r.timers.size, 0);
  });

  for (const failure of [false, true]) {
    scenario(`relevant coverage turning partial (${failure ? "second read fails" : "full re-read"}) never runs the old execute`,
      { holdPreview: true, failSecondRead: failure }, async (r) => {
      const first = r.run();
      await r.previewStarted;
      branchOf(r).calendar.readRanges.push({ from: originalDate, to: "2026-10-14", timeZone: zone, partial: true, loadedAt: "later-partial-read" });
      bump(r);
      await finishPreview(r, first);
      if (!failure) return expectRevalidated(r);
      await settled(r);
      assert.equal(reads(r).length, 2);
      assert.equal(previews(r).length, 1);
      assert.equal(executions(r).length, 0);
      assert.equal(r.timers.size, 1);
      assert.equal([...r.timers.values()][0].wait, 2000);
      assert.equal(pending(r).length, 1);
    });
  }

  scenario("the previous day's cross-day protection coverage turning partial is also re-checked fresh", { holdPreview: true }, async (r) => {
    const first = r.run();
    await r.previewStarted;
    branchOf(r).calendar.readRanges.push({ from: originalDate, to: firstDate, timeZone: zone, partial: true, loadedAt: "previous-day-partial" });
    bump(r);
    await finishPreview(r, first);
    await expectRevalidated(r);
  });

  for (const kind of ["occupation conflict", "rule conflict"]) {
    scenario(`a newly added real ${kind} is re-checked, stops, and runs zero executes`, { holdPreview: true }, async (r) => {
      addOtherActivity(r);
      const first = r.run();
      await r.previewStarted;
      if (kind === "rule conflict") branchOf(r).settings.dayEnd = 600;
      else {
        movie(r).calendarOccupation.startInstant = wallInstant(firstDate, 660, zone);
        movie(r).calendarOccupation.endInstant = wallInstant(firstDate, 720, zone);
      }
      bump(r);
      await finishPreview(r, first);
      await settled(r);
      assert.equal(reads(r).length, 2);
      assert.equal(previews(r).length, 1);
      assert.equal(executions(r).length, 0);
      assert.equal(r.timers.size, 0);
      assert.match(r.error(), /Conflicts were found after refreshing Calendar/);
      assert.equal(pending(r).length, 1);
    });
  }

  scenario("completing the target task keeps the record and runs zero executes", { holdPreview: true }, async (r) => {
    const first = r.run();
    await r.previewStarted;
    const task = branchOf(r).days[firstDate][0];
    Object.assign(task, { done: true, completedDate: firstDate, doneAt: "2026-10-13T19:00:00Z" });
    bump(r);
    await finishPreview(r, first);
    assert.equal(executions(r).length, 0);
    assert.equal(r.timers.size, 0);
    assert.equal(task.doneAt, "2026-10-13T19:00:00Z");
    assert.equal(pending(r).length, 0);
  });

  scenario("withdrawing calendar ownership never executes the old plan", { holdPreview: true }, async (r) => {
    branchOf(r).calendar.calendars = [{ id: "mine", accessRole: "owner", timeZone: zone }];
    const first = r.run();
    await r.previewStarted;
    branchOf(r).calendar.calendars[0].accessRole = "reader";
    bump(r);
    await finishPreview(r, first);
    await settled(r);
    assert.equal(executions(r).length, 0);
    assert.equal(previews(r).length, 2);
    assert.equal(r.timers.size, 0);
    assert.match(r.error(), /Calendar management permission was withdrawn/);
  });

  scenario("revoking management does not re-read or revive eligibility", { holdPreview: true }, async (r) => {
    const first = r.run();
    await r.previewStarted;
    branchOf(r).days[firstDate][0].calendarLink.managed = false;
    bump(r);
    await finishPreview(r, first);
    assert.equal(executions(r).length, 0);
    assert.equal(reads(r).length, 1);
    assert.equal(branchOf(r).days[firstDate][0].calendarLink.managed, false);
    assert.equal(r.timers.size, 0);
  });

  scenario("an explicit classification with manage:false blocks the old preview from executing", { holdPreview: true }, async (r) => {
    const first = r.run();
    await r.previewStarted;
    r.context.state.personal = classifyCalendar(branchOf(r), {
      rules: [{ calendarId: "mine", match: "calendar", kind: "learning", manage: false }] }).data;
    bump(r);
    await finishPreview(r, first);
    assert.equal(executions(r).length, 0);
    assert.equal(reads(r).length, 1);
    assert.equal(pending(r).length, 0);
    const task = theTask(r);
    assert.equal(task.calendarClassification.manage, false);
    assert.equal(task.calendarLink.managed, false);
    assert.equal(task.externalReadOnly, true);
    assert.equal(r.timers.size, 0);
  });

  scenario("turning auto-sync off and on again cannot revive the old automatic chain", { holdPreview: true }, async (r) => {
    const first = r.run();
    await r.previewStarted;
    r.off();
    await r.on();
    await finishPreview(r, first);
    assert.equal(executions(r).length, 0);
    assert.equal(previews(r).length, 1);
    assert.equal(r.timers.size, 0);
    assert.equal(pending(r).length, 1);
    await r.run();
    assert.equal(executions(r).length, 1);
    assert.equal(executions(r)[0].payload.planId, "mock-2");
  });

  scenario("consecutive state changes pause explicitly after the three-round budget without a hot loop",
    { holdPreview: true, varyPreview: true }, async (r) => {
    const first = r.run();
    await r.previewStarted;
    await finishPreview(r, first);
    await settled(r);
    assert.equal(previews(r).length, 3);
    assert.equal(executions(r).length, 0);
    assert.equal(reads(r).length, 3);
    assert.equal(r.timers.size, 0);
    assert.equal(pending(r).length, 1);
    assert.match(r.error(), /Sync paused after three checks/);
    assert.notEqual(jobs(r)[0].items[0].status, "success");
  });

  scenario("a partial relevant study catalog cannot count as free time", { holdPreview: true }, async (r) => {
    withCatalog(r);
    const first = r.run();
    await r.previewStarted;
    branchOf(r).calendar.learningCatalogs.push(completeCatalog({ to: "2026-10-14", partial: true }));
    bump(r);
    await finishPreview(r, first);
    await settled(r);
    assert.equal(reads(r).length, 2);
    assert.equal(previews(r).length, 1);
    assert.equal(executions(r).length, 0);
    assert.equal(r.timers.size, 0);
    assert.equal(pending(r).length, 1);
    assert.match(r.error(), /study catalog is incomplete/);
  });
});

// A required study catalog, once observed complete, is provenance rather than optional browsing
// metadata; an ordinary event re-read cannot replace it.
describe("required study catalogs", () => {
  scenario("a previously complete catalog being lost keeps the job pending and runs zero executes", { holdPreview: true }, async (r) => {
    withCatalog(r);
    const first = r.run();
    await r.previewStarted;
    withCatalog(r, []);
    bump(r);
    await finishPreview(r, first);
    await settled(r);
    assert.equal(executions(r).length, 0);
    assert.equal(previews(r).length, 1);
    assert.equal(pending(r).length, 1);
    assert.equal(r.timers.size, 0);
    assert.match(r.error(), CATALOG_MISSING);
  });

  scenario("a partial catalog of another owner in the same plan also stops", { holdPreview: true }, async (r) => {
    const earlier = branchOf(r).days[firstDate][0];
    const sibling = { ...structuredClone(earlier), id: "completed-sibling-owner", uid: "completed-sibling-owner",
      done: true, completedDate: "2026-10-14", doneAt: "2026-10-14T19:00:00Z", packageId: "completed-sibling-package",
      packageOrder: 20261014, packageOriginDate: "2026-10-14",
      calendarSource: { ...earlier.calendarSource, accessRole: "owner" },
      calendarLink: { ...earlier.calendarLink, calendarId: "sibling-owner", eventId: "completed-sibling-event" },
      calendarOccupation: { startInstant: wallInstant("2026-10-14", 660, zone), endInstant: wallInstant("2026-10-14", 705, zone) } };
    branchOf(r).days["2026-10-14"] = [sibling];
    withCatalog(r, ["mine", "sibling-owner"].map((calendarId) => completeCatalog({ calendarId })));
    assert.equal(pending(r).length, 1);
    assert.equal(sibling.planId, earlier.planId);
    const first = r.run();
    await r.previewStarted;
    branchOf(r).calendar.learningCatalogs.push(completeCatalog({ calendarId: "sibling-owner", partial: true }));
    bump(r);
    await finishPreview(r, first);
    await settled(r);
    assert.equal(executions(r).length, 0);
    assert.equal(previews(r).length, 1);
    assert.equal(pending(r).length, 1);
    assert.equal(r.timers.size, 0);
    assert.match(r.error(), CATALOG_MISSING);
    assert.equal(branchOf(r).days["2026-10-14"][0].doneAt, "2026-10-14T19:00:00Z");
  });

  for (const local of [false, true]) {
    scenario(`with no initial catalog, ${local ? "a local first create" : "an older queue"} still syncs`, { localCreate: local }, async (r) => {
      assert.equal(branchOf(r).calendar.learningCatalogs, undefined);
      const first = r.run();
      await r.firstStarted;
      r.release();
      await first;
      assert.equal(executions(r).length, 1);
      assert.equal(previews(r).length, 1);
      assert.equal(pending(r).length, 0);
      assert.equal(r.timers.size, 0);
      assert.equal(executions(r)[0].mockAction, local ? "create" : "update");
    });
  }

  scenario("after the complete basis is lost, closing, reopening and a JSON restore still block the retry", { holdPreview: true }, async (r) => {
    withCatalog(r);
    const first = r.run();
    await r.previewStarted;
    withCatalog(r, []);
    r.off();
    await finishPreview(r, first);
    assert.equal(executions(r).length, 0);
    r.context.state = normalizeWorkspace(JSON.parse(JSON.stringify(r.context.state)));
    await r.on();
    assert.equal(executions(r).length, 0, "the persisted required catalog survives a new run and a JSON readback");
    await r.run();
    assert.equal(executions(r).length, 0);
    assert.equal(pending(r).length, 1);
    withCatalog(r);
    await r.run();
    assert.equal(executions(r).length, 1);
    assert.notEqual(executions(r)[0].payload.planId, "mock-1");
    assert.equal(pending(r).length, 0);
  });

  scenario("confirming a new job after the complete basis is lost cannot forget the plan range", { holdPreview: true }, async (r) => {
    withCatalog(r);
    const first = r.run();
    await r.previewStarted;
    const oldId = pending(r)[0].syncJobId;
    withCatalog(r, []);
    await r.change(firstDate, 720);
    assert.notEqual(pending(r)[0].syncJobId, oldId);
    await finishPreview(r, first);
    await settled(r);
    assert.equal(executions(r).length, 0);
    assert.equal(pending(r)[0].task.start, 720);
    await r.run();
    assert.equal(executions(r).length, 0);
    withCatalog(r);
    await r.run();
    assert.equal(executions(r).length, 1);
    assert.equal(previews(r).at(-1).payload.tasks[0].start, 720);
    assert.equal(pending(r).length, 0);
  });

  scenario("with writes off, a basis that goes missing after being observed complete still blocks the next run", async (r) => {
    withCatalog(r);
    r.context.calendarStatus.writesEnabled = false;
    await r.run();
    assert.equal(executions(r).length, 0);
    assert.equal(previews(r).length, 1);
    assert.equal(branchOf(r).calendar.syncCatalogRequirements.length, 1);
    assert.equal(reads(r).length, 0);
    assert.ok(previews(r)[0].payload.tasks.every((t) => !Object.hasOwn(t, "syncCatalogRequirements")));
    withCatalog(r, []);
    r.context.calendarStatus.writesEnabled = true;
    await r.run();
    assert.equal(executions(r).length, 0);
    assert.equal(previews(r).length, 1);
    assert.equal(pending(r).length, 1);
    assert.equal(r.timers.size, 0);
    assert.match(r.error(), /Preview this study adjustment again/);
  });

  scenario("after closing, an old flight with a pending read does not record a later complete basis", { holdRead: true }, async (r) => {
    const first = r.run();
    await r.readStarted;
    assert.equal(branchOf(r).calendar.syncCatalogRequirements, undefined);
    r.off();
    withCatalog(r);
    const afterOff = r.snapshot();
    r.releaseRead();
    await first;
    assert.deepEqual(r.snapshot(), afterOff, "a cancelled generation saves neither read provenance nor queue settlement");
    assert.equal(branchOf(r).calendar.syncCatalogRequirements, undefined);
    assert.equal(previews(r).length, 0);
    assert.equal(executions(r).length, 0);
    assert.equal(r.timers.size, 0);
  });

  scenario("requirements of unrelated plans or of a calendar no longer associated do not block the manual queue", async (r) => {
    const planId = branchOf(r).days[firstDate][0].planId, range = { timeZone: zone, from: originalDate, to: "2027-02-01" };
    branchOf(r).calendar.syncCatalogRequirements = [
      { ...range, planId: "unrelated-plan", calendarId: "mine" },
      { ...range, planId, calendarId: "no-longer-associated-calendar" },
      { ...range, planId: "unrelated-plan", calendarId: "mine", timeZone: "UTC" },
    ];
    const first = r.run();
    await r.firstStarted;
    r.release();
    await first;
    assert.equal(executions(r).length, 1);
    assert.equal(previews(r).length, 1);
    assert.equal(pending(r).length, 0);
    assert.equal(r.timers.size, 0);
  });

  scenario("a new job extending a known plan's date range beyond the catalog pauses until the catalog covers it", { holdPreview: true }, async (r) => {
    withCatalog(r, [completeCatalog({ to: "2026-10-14" })]);
    const first = r.run();
    await r.previewStarted;
    await r.change("2026-10-15", 660);
    await finishPreview(r, first);
    await settled(r);
    assert.equal(executions(r).length, 0);
    assert.equal(previews(r).length, 1);
    assert.equal(pending(r)[0].date, "2026-10-15");
    assert.match(r.error(), CATALOG_MISSING);
    assert.equal(r.timers.size, 0);
    branchOf(r).calendar.learningCatalogs.push(completeCatalog());
    await r.run();
    assert.equal(executions(r).length, 1);
    assert.equal(previews(r).at(-1).payload.tasks[0].date, "2026-10-15");
    assert.equal(pending(r).length, 0);
  });

  scenario("switching a known plan's time zone cannot forget the required catalog", { holdPreview: true }, async (r) => {
    withCatalog(r);
    const first = r.run();
    await r.previewStarted;
    branchOf(r).settings.timeZone = "UTC";
    bump(r);
    await r.change(firstDate, 720);
    branchOf(r).days[firstDate][0].calendarOccupation = {
      startInstant: wallInstant(firstDate, 720, "UTC"), endInstant: wallInstant(firstDate, 765, "UTC") };
    await finishPreview(r, first);
    await settled(r);
    assert.equal(executions(r).length, 0);
    assert.equal(pending(r).length, 1);
    assert.equal(r.timers.size, 0);
    assert.match(r.error(), CATALOG_MISSING);
  });
});

// A fake workbench renders the open Calendar panel while the real request/status code of app.js runs.
describe("an asynchronous Calendar error while the panel is open", () => {
  function errorWorkbench(r) {
    const oldDocument = globalThis.document, nodes = new Map();
    let html = "";
    const node = (id) => ({ id, dataset: {}, value: "", hidden: false,
      focus() { document.activeElement = this; }, getClientRects() { return [{}]; }, querySelector() { return node("span"); } });
    const root = { get innerHTML() { return html; }, set innerHTML(value) {
      html = value;
      for (const id of [...nodes.keys()]) if (!["workbench", "wb-calendar", "wb-calendar-label"].includes(id)) nodes.delete(id);
      for (const match of value.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], node(match[1]));
    }, querySelector(selector) {
      return selector === "[data-stage]" ? { dataset: { stage: html.match(/data-stage="([^"]+)/)?.[1] } } : node(selector);
    } };
    nodes.set("workbench", root); nodes.set("wb-calendar", node("wb-calendar")); nodes.set("wb-calendar-label", node("wb-calendar-label"));
    globalThis.document = { activeElement: null, getElementById: (id) => nodes.get(id) || null };
    const bench = createWorkbench({ context: () => ({ mode: r.context.mode, date: firstDate, branch: branchOf(r),
      revision: r.context.state.revision, ui: {}, calendarStatus: r.context.calendarStatus }),
      syncSummary: () => syncPresentation(branchOf(r), { writesEnabled: r.context.calendarStatus.writesEnabled }).text });
    const saved = r.context.save;
    r.context.save = (mutation) => { const ok = saved(mutation); bench.render(); return ok; }; // saving renders, as in the app
    Object.assign(r.context, { bench, readingCalendar: false, calendarReadError: "", AbortSignal });
    const requestStart = appSource.indexOf("async function calendarRequest("),
      statusStart = appSource.indexOf("const calendarNames =", requestStart),
      statusEnd = appSource.indexOf("async function refreshCalendar()", statusStart);
    assert.ok(requestStart >= 0 && statusEnd > statusStart);
    vm.runInContext(appSource.slice(requestStart, statusEnd), r.context, { filename: "app.js:request-and-status-render" });
    const started = deferred(), held = deferred();
    const message = "The operation session changed. Refresh the full page, preview again, and then confirm.";
    r.context.fetch = async (path, options) => {
      r.calls.push({ path, method: options.method });
      started.resolve();
      await held.promise;
      return Response.json({ error: message }, { status: 403 });
    };
    return { bench, nodes, message, started: started.promise, release: held.resolve,
      get html() { return html; }, close() { globalThis.document = oldDocument; } };
  }

  test("the error refresh updates the open panel without changing saved times, focus or controls", async () => {
    const r = rig({ localCreate: true }), ui = errorWorkbench(r), before = structuredClone(branchOf(r).days);
    try {
      r.context.calendarStatus.writesEnabled = false;
      const running = r.run();
      await ui.started;
      ui.bench.calendar();
      ui.nodes.get("wb-refresh").focus();
      const buttonIds = () => [...ui.html.matchAll(/<button\b[^>]*id="([^"]+)"/g)].map((match) => match[1]);
      const controls = buttonIds();
      assert.deepEqual(controls, ["wb-refresh", "wb-sync-settings", "wb-back"]);
      assert.match(ui.html, /Queued for sync/);
      assert.ok(!ui.html.includes(presentError(ui.message)));
      ui.release();
      await running;
      assert.ok(ui.html.includes(presentError(ui.message)), "the open panel shows the settled error in English");
      assert.match(ui.html, /Saved locally/);
      assert.equal(ui.bench.phase(), "calendar");
      assert.equal(document.activeElement.id, "wb-refresh");
      assert.deepEqual(buttonIds(), controls);
      assert.deepEqual(branchOf(r).days, before);
      assert.equal(pending(r).length, 1);
      assert.deepEqual(r.calls, [{ path: "/api/calendar/preview", method: "POST" }]);
      assert.equal(r.timers.size, 0);
    } finally { ui.close(); }
  });

  test("the error refresh leaves an open rules draft and its input focus intact", async () => {
    const r = rig({ localCreate: true }), ui = errorWorkbench(r), before = structuredClone(branchOf(r).days);
    try {
      r.context.calendarStatus.writesEnabled = false;
      const running = r.run();
      await ui.started;
      ui.bench.rules();
      const input = ui.nodes.get("wb-rule-start");
      input.value = "10:30";
      input.focus();
      const html = ui.html;
      ui.release();
      await running;
      assert.equal(r.error(), presentError(ui.message));
      assert.equal(ui.bench.phase(), "rules");
      assert.equal(ui.html, html);
      assert.equal(ui.nodes.get("wb-rule-start"), input);
      assert.equal(input.value, "10:30");
      assert.equal(document.activeElement, input);
      assert.deepEqual(branchOf(r).days, before);
      assert.deepEqual(r.calls, [{ path: "/api/calendar/preview", method: "POST" }]);
      assert.equal(r.timers.size, 0);
    } finally { ui.close(); }
  });
});
