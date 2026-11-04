// What the app tells the user about a sync: syncPresentation() state and wording for the home screen,
// the result screen and saved presentation references.
import test from "node:test";
import assert from "node:assert/strict";
import { enqueueChanges, pendingTasks, markSyncing, settleSync, syncPresentation, syncPresentationRefs } from "../sync-queue.js";
import { normalizeWorkspace, freshWorkspace } from "../storage.js";

const DAY = "2026-10-12";
const task = (id, extra = {}) => ({ id, uid: id, title: id, start: 660, duration: 30, rest: 0, type: "task", done: false,
  locked: false, deferred: false, ...extra });
const initial = () => ({ settings: { timeZone: "America/Los_Angeles" }, calendar: { autoSync: true, targetCalendarId: "cal" },
  days: { [DAY]: [task("u"), task("untouched")] } });
const edit = (branch, start, options = {}) => {
  const days = structuredClone(branch.days);
  days[DAY][0].start = start;
  return enqueueChanges({ ...branch, days }, branch.days, days, options);
};
const view = (branch, refs) => syncPresentation(branch, { writesEnabled: true, ids: ["u"], refs });
// Marks the pending work as syncing and settles it with an exact success receipt.
const succeed = (branch) => {
  const snapshot = pendingTasks(branch);
  return settleSync(markSyncing(branch, snapshot), { results: snapshot.map((entry) => ({ uid: entry.task.uid, ok: true,
    calendarLink: { calendarId: "cal", eventId: entry.task.calendarLink?.eventId || "created-event", managed: true } })) }, snapshot);
};

test("an exact create receipt connects its first event ID, and home, result and Calendar agree without untouched tasks", () => {
  const queued = edit(initial(), 720), refs = syncPresentationRefs(queued, ["u"]);
  assert.equal(view(queued).queueState, "queued");
  assert.equal(view(markSyncing(queued)).queueState, "syncing");
  const done = succeed(queued);
  assert.equal(view(done).queueState, "success");
  assert.equal(view(done, refs).queueState, "success");
  assert.equal(syncPresentation(done, { writesEnabled: true }).queueState, "success");
  assert.equal(syncPresentation(done).state, "write_disabled");
});

test("the same uid and payload cannot transfer success across event or calendar identity", () => {
  const queued = edit(initial(), 720), refs = syncPresentationRefs(queued, ["u"]), done = succeed(queued);
  for (const link of [{ calendarId: "cal", eventId: "replacement" }, { calendarId: "other", eventId: "created-event" }]) {
    const altered = structuredClone(done);
    altered.days[DAY][0].calendarLink = { ...altered.days[DAY][0].calendarLink, ...link };
    assert.equal(view(altered).queueState, "superseded");
    assert.equal(view(altered, refs).queueState, "superseded");
  }
});

test("an ABA edit with auto-sync off stays unverified and the old saved receipt is marked replaced, also after persistence", () => {
  const queued = edit(initial(), 720), refs = syncPresentationRefs(queued, ["u"]);
  let branch = succeed(queued);
  branch = edit(branch, 780, { autoSync: false });
  branch = edit(branch, 720, { autoSync: false });
  assert.equal(view(branch).queueState, "local");
  assert.equal(view(branch, refs).queueState, "superseded");
  const workspace = freshWorkspace();
  workspace.personal = branch;
  const restored = normalizeWorkspace(JSON.parse(JSON.stringify(workspace))).personal;
  assert.equal(view(restored).queueState, "local");
  assert.equal(view(restored, refs).queueState, "superseded");
});

test("a new exact job replaces the saved snapshot, and a late old success cannot claim the current operation", () => {
  const queued = edit(initial(), 720), refs = syncPresentationRefs(queued, ["u"]), snapshot = pendingTasks(queued);
  let branch = edit(edit(queued, 780), 720);
  branch = settleSync(branch, { results: [{ uid: "u", ok: true, calendarLink: { calendarId: "cal", eventId: "created-event" } }] }, snapshot);
  assert.notEqual(view(branch).queueState, "success");
  assert.equal(view(branch, refs).queueState, "superseded");
});

test("a failed item reports its own reason and ignores an unrelated old retry or a historical legacy success", () => {
  let branch = edit(initial(), 720);
  branch.calendar.syncRetry = { message: "unrelated stale error" };
  assert.equal(view(branch).text.includes("unrelated"), false);
  branch = settleSync(branch, { error: "Required study catalog missing" }, pendingTasks(branch));
  assert.equal(view(branch).queueState, "partial");
  assert.match(view(branch).text, /Required study catalog missing/);
  const legacy = initial();
  legacy.calendar.syncQueue = { jobs: [{ id: "old", status: "success", items: [] }] };
  assert.equal(view(legacy).queueState, "local");
});
