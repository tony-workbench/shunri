// The durable calendar sync queue (sync-queue.js): enqueueing, settling, history pruning and resuming.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  TERMINAL_HISTORY_LIMIT, RECEIPT_RETENTION_MS, enqueueChanges, pendingTasks, markSyncing, settleSync, retrySync,
  syncPresentation, syncPresentationRefs, syncResumeProposal, resumeSync,
} from "../sync-queue.js";
import { localCalendarSignature } from "../calendar-data.js";
import { WorkspaceStore, STORAGE_KEY, freshWorkspace, normalizeWorkspace } from "../storage.js";

describe("queueing and settling", () => {
  const makeTask = (id, overrides = {}) => ({ id, uid: `uid-${id}`, title: `Study ${id}`, start: 660, duration: 60, rest: 20,
    done: false, locked: false, deferred: false, type: "task", ...overrides });
  const branch = () => ({
    settings: { timeZone: "America/Los_Angeles" },
    calendar: { autoSync: true, targetCalendarId: "personal" },
    days: { "2026-10-12": [makeTask("a"), makeTask("b", { start: 740 })] },
  });
  const moved = (source, date = "2026-10-13") => ({ [date]: structuredClone(source.days["2026-10-12"]) });
  function enqueue(source, days = moved(source)) {
    return enqueueChanges({ ...structuredClone(source), days }, source.days, days, { profileId: "profile", createdAt: "2026-10-10T20:00:00Z" });
  }
  // Enqueues a newer arrangement on top of an existing queue whose tasks sit on 2026-10-13.
  function enqueueNewer(queued, date) {
    const days = { [date]: structuredClone(queued.days["2026-10-13"]) };
    return enqueueChanges({ ...queued, days }, queued.days, days, { profileId: "profile" });
  }
  const link = (id) => ({ calendarId: "personal", eventId: `event-${id}`, signature: `sha-${id}`, etag: `etag-${id}`, syncedAt: "2026-10-10T20:00:01Z" });
  const succeed = (...ids) => ({ results: ids.map((id) => ({ uid: `uid-${id}`, ok: true, calendarLink: link(id) })) });
  const queueJobs = (data) => data.calendar.syncQueue.jobs;

  test("one confirmation forms a single durable batch for all affected events", () => {
    const original = branch(), queued = enqueue(original);
    assert.equal(queueJobs(queued).length, 1);
    assert.equal(queueJobs(queued)[0].items.length, 2);
    assert.equal(queueJobs(queued)[0].status, "queued");
    assert.deepEqual(pendingTasks(queued).map((entry) => entry.date), ["2026-10-13", "2026-10-13"]);
    assert.equal(original.calendar.syncQueue, undefined);
  });

  test("changing only done, notes or dependencies queues no Calendar write", () => {
    const original = branch(), after = structuredClone(original.days);
    after["2026-10-12"][0].done = true;
    after["2026-10-12"][1].dependencies = [{ id: "a", gap: 20 }];
    after["2026-10-12"][1].notes = "Notes";
    assert.equal(queueJobs(enqueueChanges(original, original.days, after, { autoSync: true })).length, 0);
  });

  test("nothing is queued when auto-sync is off, and turning it off does not execute the existing queue", () => {
    const source = branch();
    source.calendar.autoSync = false;
    assert.equal(enqueue(source).calendar.syncQueue, undefined);
    const queued = enqueue(branch());
    queued.calendar.autoSync = false;
    assert.deepEqual(pendingTasks(queued), []);
    assert.deepEqual(retrySync(queued), queued);
  });

  test("fixed, locked, completed, deferred, read-only, unmanaged and conflicting tasks never enter the write queue", () => {
    const source = branch();
    source.days["2026-10-12"] = [
      makeTask("fixed", { type: "activity" }),
      makeTask("locked", { locked: true }),
      makeTask("time-locked", { timeLocked: true }),
      makeTask("done", { done: true }),
      makeTask("deferred", { deferred: true }),
      makeTask("readonly", { externalReadOnly: true }),
      makeTask("imported", { calendarLink: { source: "google", managed: false, calendarId: "personal", eventId: "remote" } }),
      makeTask("conflict", { calendarConflict: { kind: "both_changed" } }),
    ];
    assert.equal(queueJobs(enqueue(source)).length, 0);
  });

  test("an explicitly managed imported event keeps its original calendar and event link", () => {
    const source = branch();
    source.days["2026-10-12"][0].calendarLink = { source: "google", managed: true, calendarId: "imported-calendar", eventId: "original-event" };
    const queued = enqueue(source);
    assert.equal(pendingTasks(queued)[0].task.calendarLink.eventId, "original-event");
    assert.equal(queueJobs(queued)[0].items[0].calendarId, "imported-calendar");
  });

  test("pending and syncing survive a refresh, and an offline result can be retried with the same uid", () => {
    const queued = enqueue(branch()), snapshot = pendingTasks(queued);
    const syncing = markSyncing(queued, snapshot);
    assert.equal(queueJobs(syncing)[0].status, "syncing");
    const refreshed = JSON.parse(JSON.stringify(syncing));
    assert.deepEqual(pendingTasks(refreshed), snapshot);
    const failed = settleSync(refreshed, { error: "Offline" }, snapshot);
    assert.equal(queueJobs(failed)[0].status, "partial");
    assert.equal(queueJobs(failed)[0].items[0].message, "Offline");
    const retry = retrySync(failed);
    assert.equal(queueJobs(retry)[0].status, "queued");
    assert.equal(pendingTasks(retry)[0].task.uid, "uid-a");
  });

  test("a partial success saves the successful mapping and retries only the failed items", () => {
    const queued = enqueue(branch()), snapshot = pendingTasks(queued);
    const partial = settleSync(queued, { results: [
      { uid: "uid-a", ok: true, calendarLink: link("a") },
      { uid: "uid-b", ok: false, message: "503" },
    ] }, snapshot);
    const first = partial.days["2026-10-13"][0].calendarLink;
    assert.equal(queueJobs(partial)[0].status, "partial");
    assert.equal(first.eventId, "event-a");
    assert.equal(first.adoptedEtag, "etag-a");
    assert.equal(first.localFingerprint, localCalendarSignature(snapshot[0].task, snapshot[0].date));
    assert.deepEqual(pendingTasks(partial).map((entry) => entry.task.uid), ["uid-b"]);
    const complete = settleSync(partial, succeed("b"), pendingTasks(partial));
    assert.equal(queueJobs(complete)[0].status, "success");
    assert.deepEqual(pendingTasks(complete), []);
  });

  test("confirming a new position again replaces the old pending target for the same uid without duplicating the task", () => {
    const first = enqueue(branch()), oldDays = structuredClone(first.days);
    const newDays = { "2026-10-15": structuredClone(first.days["2026-10-13"]) };
    first.days = newDays;
    const second = enqueueChanges(first, oldDays, newDays, { profileId: "profile" });
    assert.equal(queueJobs(second).length, 2);
    assert.ok(queueJobs(second)[0].items.every((item) => item.status === "superseded"));
    assert.equal(pendingTasks(second).length, 2);
    assert.ok(pendingTasks(second).every((entry) => entry.date === "2026-10-15"));
  });

  test("enqueueing the same target twice does not duplicate the pending job", () => {
    const source = branch(), first = enqueue(source);
    const second = enqueueChanges(first, source.days, first.days, { profileId: "profile" });
    assert.equal(queueJobs(second).length, 1);
    assert.equal(pendingTasks(second).length, 2);
  });

  test("undo queues a new payload at the original position while the synced record stays linked to the same event", () => {
    const queued = enqueue(branch());
    const synced = settleSync(queued, succeed("a", "b"), pendingTasks(queued));
    const before = structuredClone(synced.days), restored = { "2026-10-12": structuredClone(synced.days["2026-10-13"]) };
    synced.days = restored;
    const undone = enqueueChanges(synced, before, restored, { profileId: "profile" });
    assert.equal(pendingTasks(undone)[0].date, "2026-10-12");
    assert.equal(pendingTasks(undone)[0].task.calendarLink.eventId, "event-a");
  });

  test("a late receipt of an old create records the identity actually written without moving or settling the newer position", () => {
    const first = enqueue(branch()), snapshot = pendingTasks(first);
    const newer = enqueueNewer(first, "2026-10-16");
    const late = settleSync(newer, succeed("a", "b"), snapshot);
    assert.equal(late.days["2026-10-16"][0].calendarLink.eventId, "event-a");
    assert.equal(late.days["2026-10-16"][0].calendarLink.localFingerprint, localCalendarSignature(snapshot[0].task, snapshot[0].date));
    assert.equal(queueJobs(late).at(-1).status, "queued");
    assert.equal(queueJobs(late)[0].items[0].receipt.eventId, "event-a");
    assert.equal(pendingTasks(late).length, 2);
    assert.ok(pendingTasks(late).every((entry) => entry.date === "2026-10-16"));
  });

  test("a late failure of an old arrangement does not reactivate it once superseded", () => {
    const first = enqueue(branch()), snapshot = pendingTasks(first);
    const failed = settleSync(enqueueNewer(first, "2026-10-16"), { error: "Offline" }, snapshot);
    assert.equal(queueJobs(failed)[0].items[0].status, "superseded");
    assert.equal(pendingTasks(failed).length, 2);
  });

  test("blocking real writes blocks the job, and after recovery the retry uses the original uid", () => {
    const queued = enqueue(branch());
    const blocked = settleSync(queued, { blocked: true, error: "Real writes off" }, pendingTasks(queued));
    assert.equal(queueJobs(blocked)[0].status, "blocked");
    const retried = retrySync(blocked);
    assert.equal(queueJobs(retried)[0].status, "queued");
    assert.equal(pendingTasks(retried)[0].task.uid, "uid-a");
  });

  test("deleting or completing a task cancels its pending job and never produces a delete", () => {
    const queued = enqueue(branch()), before = structuredClone(queued.days), after = structuredClone(queued.days);
    after["2026-10-13"].pop();
    after["2026-10-13"][0].done = true;
    const cancelled = enqueueChanges({ ...queued, days: after }, before, after);
    assert.deepEqual(pendingTasks(cancelled), []);
    assert.ok(queueJobs(cancelled)[0].items.every((item) => item.status === "superseded"));
  });

  test("without a target calendar the job is blocked and sends nothing; it resumes once a target is set", () => {
    const source = branch();
    delete source.calendar.targetCalendarId;
    const queued = enqueue(source);
    assert.equal(queueJobs(queued)[0].status, "blocked");
    assert.deepEqual(pendingTasks(queued), []);
    queued.calendar.targetCalendarId = "personal";
    assert.equal(pendingTasks(retrySync(queued)).length, 2);
  });

  test("a result without a snapshot does not claim the current queue", () => {
    const result = settleSync(enqueue(branch()), succeed("a"));
    assert.equal(result.days["2026-10-13"][0].calendarLink, undefined);
    assert.equal(queueJobs(result)[0].items[0].status, "queued");
  });

  // Confirmed intents have a job identity even when an edit returns to identical Calendar content:
  // a payload fingerprint is not a version.
  describe("returning to an identical payload (version ABA)", () => {
    function abaQueue() {
      const source = branch();
      source.days["2026-10-12"] = [makeTask("a")];
      const first = enqueue(source), snapshot = pendingTasks(first);
      const modify = (data, start) => {
        const before = structuredClone(data.days), after = structuredClone(before);
        after["2026-10-13"][0].start = start;
        return enqueueChanges({ ...data, days: after }, before, after, { profileId: "profile" });
      };
      return { snapshot, latest: modify(modify(first, 720), 660) };
    }

    test("an old success settles only the old job, and a later job with the same payload stays queued", () => {
      const { snapshot, latest } = abaQueue();
      assert.equal(queueJobs(latest).length, 3);
      assert.equal(queueJobs(latest)[0].items[0].signature, queueJobs(latest)[2].items[0].signature);
      const settled = settleSync(latest, succeed("a"), snapshot);
      assert.deepEqual(queueJobs(settled).map((job) => job.items[0].status), ["success", "superseded", "queued"]);
      assert.equal(pendingTasks(settled).length, 1);
      assert.equal(settled.days["2026-10-13"][0].start, 660);
      assert.equal(settled.days["2026-10-13"][0].calendarLink.eventId, "event-a");
    });

    test("markSyncing with an old snapshot cannot mark a later job with the same payload", () => {
      const { snapshot, latest } = abaQueue();
      const marked = markSyncing(latest, snapshot);
      assert.equal(queueJobs(marked)[0].items[0].status, "superseded");
      assert.equal(queueJobs(marked)[2].items[0].status, "queued");
    });

    test("a late old failure does not fail a later job with the same payload", () => {
      const { snapshot, latest } = abaQueue();
      const settled = settleSync(latest, { error: "503" }, snapshot);
      assert.equal(queueJobs(settled)[0].items[0].status, "superseded");
      assert.equal(queueJobs(settled)[2].items[0].status, "queued");
      assert.equal(pendingTasks(settled).length, 1);
    });

    test("a manual snapshot without job identity conservatively does not claim a later version", () => {
      const { snapshot, latest } = abaQueue();
      const unversioned = snapshot.map(({ date, task }) => ({ date, task }));
      assert.deepEqual(queueJobs(markSyncing(latest, unversioned)), queueJobs(latest));
      const settled = settleSync(latest, succeed("a"), unversioned);
      assert.deepEqual(queueJobs(settled), queueJobs(latest));
      assert.equal(settled.days["2026-10-13"][0].calendarLink, undefined);
      assert.equal(pendingTasks(settled).length, 1);
    });
  });
});

describe("history pruning and late receipts", () => {
  const DATE = "2026-10-12";
  const initial = () => ({
    settings: { timeZone: "America/Los_Angeles" },
    calendar: { autoSync: true, targetCalendarId: "synthetic" },
    days: { [DATE]: [{ id: "task", uid: "task", title: "Synthetic task", start: 660, duration: 30, rest: 0, type: "task",
      done: false, locked: false, deferred: false }] },
  });
  function edit(branch, start) {
    const days = structuredClone(branch.days);
    days[DATE][0].start = start;
    return enqueueChanges({ ...branch, days }, branch.days, days);
  }
  function addHistory(branch, prefix = "history") {
    branch.calendar.syncQueue.jobs.push(...Array.from({ length: TERMINAL_HISTORY_LIMIT + 12 }, (_, i) => ({
      id: `${prefix}-${i}`, status: "success", items: [{ uid: `removed-${i}`, status: "success", signature: `synthetic-${i}` }] })));
    return branch;
  }
  function reload(branch) {
    const workspace = freshWorkspace();
    workspace.personal = branch;
    return normalizeWorkspace(JSON.parse(JSON.stringify(workspace))).personal;
  }
  const ids = (branch) => branch.calendar.syncQueue.jobs.map((job) => job.id);
  const jobById = (branch, id) => branch.calendar.syncQueue.jobs.find((job) => job.id === id);
  const appReceipt = { source: "app", managed: true, calendarId: "synthetic", eventId: "synthetic-event" };
  const receiptFor = (calendarLink) => ({ results: [{ uid: "task", ok: true, calendarLink }] });

  function withClock(run) {
    const originalNow = Date.now;
    let now = Date.parse("2026-10-20T12:00:00Z");
    Date.now = () => now;
    try { run((milliseconds) => { now += milliseconds; }); } finally { Date.now = originalNow; }
  }
  // An in-flight create whose job was superseded and then pruned from the history by another page.
  function prunedFlight(advance, mapped = false, wrapper = false) {
    let branch = initial();
    if (mapped) branch.days[DATE][0].calendarLink = { source: "app", managed: true, calendarId: "synthetic", eventId: "original-event" };
    branch = edit(branch, 720);
    const entries = pendingTasks(branch), snapshot = wrapper ? { tasks: entries } : entries;
    branch = markSyncing(branch, snapshot);
    const oldId = entries[0].syncJobId;
    branch = edit(branch, 780);
    const newId = pendingTasks(branch)[0].syncJobId;
    addHistory(branch);
    advance(RECEIPT_RETENTION_MS + 1);
    branch = reload(branch);
    assert.equal(ids(branch).includes(oldId), false, "the expired old terminal job was pruned");
    return { branch, snapshot, entries, newId };
  }
  const actualReceipt = (eventId) => receiptFor({ source: "app", managed: true, calendarId: "synthetic", eventId, etag: "actual-old-version" });

  test("repeated local edits bound superseded history without reusing job IDs", () => {
    let branch = initial();
    const count = TERMINAL_HISTORY_LIMIT + 15;
    for (let i = 0; i < count; i++) branch = edit(branch, i % 2 ? 780 : 720);
    assert.equal(branch.calendar.syncQueue.jobs.length, TERMINAL_HISTORY_LIMIT + 1);
    assert.equal(new Set(ids(branch)).size, TERMINAL_HISTORY_LIMIT + 1);
    assert.equal(branch.calendar.syncQueue.nextId, count + 1);
    assert.equal(pendingTasks(branch).length, 1);
    assert.equal(pendingTasks(branch)[0].syncJobId, `sync-local-${count}`);
  });

  test("normalization bounds terminal history while preserving unresolved batches and its input", () => {
    const branch = addHistory(edit(initial(), 720));
    const statuses = ["queued", "syncing", "failed", "blocked", "partial"];
    for (const status of statuses) branch.calendar.syncQueue.jobs.push({
      id: `protected-${status}`, status, items: [{ uid: status, status: status === "partial" ? "failed" : status }] });
    const original = structuredClone(branch), restored = reload(branch);
    assert.deepEqual(branch, original);
    assert.equal(ids(restored).filter((id) => id.startsWith("history-")).length, TERMINAL_HISTORY_LIMIT);
    assert.equal(ids(restored).includes("history-0"), false);
    assert.equal(ids(restored).includes(`history-${TERMINAL_HISTORY_LIMIT + 11}`), true);
    for (const status of statuses) assert.ok(ids(restored).includes(`protected-${status}`));
    assert.equal(pendingTasks(restored).length, 1);
    assert.deepEqual(reload(restored), restored);
  });

  test("imported counters cannot recycle a retained job ID for a recurring payload", () => {
    let branch = edit(initial(), 720);
    const snapshot = pendingTasks(branch), oldId = snapshot[0].syncJobId;
    branch = markSyncing(branch, snapshot);
    for (const [nextId, message] of [[1, /reuse an existing job ID/], [undefined, /Duplicate sync job ID/]]) {
      const forged = structuredClone(branch);
      if (nextId) forged.calendar.syncQueue.nextId = nextId;
      else forged.calendar.syncQueue.jobs.push(structuredClone(forged.calendar.syncQueue.jobs[0]));
      const before = structuredClone(forged);
      assert.throws(() => reload(forged), message);
      assert.throws(() => edit(forged, 780), message);
      assert.deepEqual(forged, before);
    }
    // The same payload recurring later still receives a fresh identity.
    branch = edit(edit(branch, 780), 720);
    const newId = pendingTasks(branch)[0].syncJobId;
    assert.notEqual(newId, oldId);
    assert.equal(new Set(ids(branch)).size, ids(branch).length);
    branch = settleSync(branch, receiptFor(appReceipt), snapshot);
    const newer = jobById(branch, newId).items[0];
    assert.equal(newer.status, "queued", "an old receipt cannot settle a newer intent");
    assert.equal(newer.receipt, undefined);
  });

  test("a superseded in-flight create survives pruning and maps only its late receipt", () => {
    let branch = edit(initial(), 720);
    const snapshot = pendingTasks(branch), oldId = snapshot[0].syncJobId;
    branch = edit(markSyncing(branch, snapshot), 780);
    const newId = pendingTasks(branch)[0].syncJobId;
    branch = reload(addHistory(branch));
    assert.ok(ids(branch).includes(oldId));
    branch = settleSync(branch, receiptFor(appReceipt), snapshot);
    assert.equal(branch.days[DATE][0].start, 780);
    assert.equal(branch.days[DATE][0].calendarLink.eventId, appReceipt.eventId);
    assert.equal(pendingTasks(branch)[0].syncJobId, newId);
    assert.equal(ids(branch).includes(oldId), false);
    assert.equal(branch.calendar.syncQueue.nextId, 3);
  });

  test("abandoned superseded receipts do not survive every persisted reload forever", () => withClock((advance) => {
    let branch = initial();
    for (let i = 0; i < TERMINAL_HISTORY_LIMIT + 15; i++) {
      branch = edit(branch, 720);
      branch = markSyncing(branch, pendingTasks(branch));
      branch = edit(branch, 780);
      // The old tab closes: only durable JSON remains and no callback ever arrives.
      advance(10 * 60 * 1000);
      branch = reload(branch);
    }
    assert.equal(branch.calendar.syncQueue.jobs.length, TERMINAL_HISTORY_LIMIT + 1);
    assert.equal(branch.calendar.syncQueue.jobs.flatMap((job) => job.items).filter((item) => item.awaitingReceipt).length, 0);
    assert.equal(pendingTasks(branch).length, 1);
    assert.equal(pendingTasks(branch)[0].task.start, 780);
  }));

  test("receipt leases survive ordinary saves and reloads without sliding and cannot be forged into forever", () => withClock((advance) => {
    let branch = edit(initial(), 720);
    const snapshot = pendingTasks(branch), oldId = snapshot[0].syncJobId;
    branch = edit(markSyncing(branch, snapshot), 780);
    const expires = jobById(branch, oldId).items[0].receiptPendingUntil;
    for (let i = 0; i < 3; i++) {
      advance(60000);
      branch = reload(branch);
      const item = jobById(branch, oldId).items[0];
      assert.equal(item.receiptPendingUntil, expires);
      assert.equal(item.awaitingReceipt, true);
    }
    for (const bad of [null, "forever", Number.MAX_SAFE_INTEGER]) {
      const forged = structuredClone(branch);
      jobById(forged, oldId).items[0].receiptPendingUntil = bad;
      assert.equal(ids(reload(addHistory(forged))).includes(oldId), false);
    }
    // Legacy flags carry no timestamp and cannot mint a new lease on every load.
    delete jobById(branch, oldId).items[0].receiptPendingUntil;
    branch = reload(addHistory(branch));
    assert.equal(ids(branch).includes(oldId), false);
    assert.equal(pendingTasks(branch).length, 1);
  }));

  test("an exact live create snapshot recovers only its late receipt after another page prunes history", () => withClock((advance) => {
    const { branch, snapshot, newId } = prunedFlight(advance);
    const before = structuredClone(branch), settled = settleSync(branch, actualReceipt("actual-created"), snapshot);
    assert.equal(settled.days[DATE][0].start, 780);
    assert.equal(settled.days[DATE][0].calendarLink.eventId, "actual-created");
    assert.equal(settled.days[DATE][0].calendarLink.localFingerprint, jobById(before, newId).items[0].signature.replace("780", "720"));
    assert.equal(pendingTasks(settled)[0].syncJobId, newId);
    assert.equal(settled.calendar.syncQueue.jobs.length, TERMINAL_HISTORY_LIMIT + 1);
    assert.deepEqual(branch, before);
    assert.deepEqual(settleSync(settled, actualReceipt("different-replayed-event"), snapshot), settled, "the runtime receipt proof is consumed once");
  }));

  test("an exact tasks-wrapper snapshot also recovers a late mapped update without moving newer work", () => withClock((advance) => {
    const { branch, snapshot, newId } = prunedFlight(advance, true, true);
    const settled = settleSync(branch, actualReceipt("original-event"), snapshot);
    assert.equal(settled.days[DATE][0].start, 780);
    assert.equal(settled.days[DATE][0].calendarLink.eventId, "original-event");
    assert.equal(settled.days[DATE][0].calendarLink.etag, "actual-old-version");
    assert.equal(pendingTasks(settled)[0].syncJobId, newId);
  }));

  test("cloned, imported or mutated snapshots cannot authorize a pruned receipt fallback", () => {
    for (const attack of ["clone", "mutated-link", "wrong-uid", "foreign-queue", "foreign-profile", "different-target"]) withClock((advance) => {
      const fixture = prunedFlight(advance);
      const { branch } = fixture;
      let { snapshot } = fixture;
      if (attack === "clone") snapshot = JSON.parse(JSON.stringify(snapshot));
      if (attack === "mutated-link") snapshot[0].task.calendarLink = { calendarId: "synthetic", eventId: "invented" };
      if (attack === "wrong-uid") snapshot[0].task.uid = "someone-else";
      if (attack === "foreign-queue") delete branch.calendar.syncQueue.receiptScopeId;
      if (attack === "foreign-profile") jobById(branch, fixture.newId).id = "sync-foreign-profile-2";
      if (attack === "different-target") jobById(branch, fixture.newId).items[0].calendarId = "another-calendar";
      const before = structuredClone(branch);
      assert.deepEqual(settleSync(branch, actualReceipt("forbidden"), snapshot), before, attack);
    });
  });

  test("late receipts cannot restore a changed mapping or revoked eligibility after pruning", () => {
    for (const change of [
      { calendarLink: { source: "app", managed: true, calendarId: "synthetic", eventId: "new-event" } },
      { calendarLink: { source: "google", managed: false, calendarId: "synthetic", eventId: "original-event" } },
      { done: true }, { locked: true }, { deferred: true }, { externalReadOnly: true },
    ]) withClock((advance) => {
      const { branch, snapshot } = prunedFlight(advance);
      Object.assign(branch.days[DATE][0], change);
      const before = structuredClone(branch);
      assert.deepEqual(settleSync(branch, actualReceipt("old-create"), snapshot), before);
    });
  });

  test("a late failure and an expired active desired sync never turn into dropped or successful work", () => withClock((advance) => {
    const { branch, snapshot, newId } = prunedFlight(advance);
    const before = structuredClone(branch);
    assert.deepEqual(settleSync(branch, { error: "actual failure" }, snapshot), before);
    const active = markSyncing(branch, pendingTasks(branch));
    advance(RECEIPT_RETENTION_MS + 1);
    // A second batch of unrelated history needs distinct IDs: duplicates are rejected.
    const restored = reload(addHistory(active, "later-history"));
    assert.ok(ids(restored).includes(newId));
    assert.equal(pendingTasks(restored)[0].syncJobId, newId);
    assert.equal(pendingTasks(restored).length, 1);
  }));

  test("repeated load-only reads of unchanged legacy bytes cannot renew abandoned protection", () => withClock((advance) => {
    let branch = edit(initial(), 720);
    const snapshot = pendingTasks(branch), oldId = snapshot[0].syncJobId;
    branch = edit(markSyncing(branch, snapshot), 780);
    branch = reload(branch);
    delete jobById(branch, oldId).items[0].receiptPendingUntil;
    addHistory(branch);
    const workspace = freshWorkspace();
    workspace.personal = branch;
    const raw = JSON.stringify(workspace), writes = [];
    const storage = { getItem: (key) => (key === STORAGE_KEY ? raw : null), setItem: (...args) => writes.push(args) };
    for (let i = 0; i < 4; i++) {
      const store = new WorkspaceStore(storage);
      store.load();
      assert.equal(store.error, null);
      assert.equal(ids(store.state.personal).includes(oldId), false);
      assert.equal(pendingTasks(store.state.personal).length, 1);
      advance(60000);
    }
    assert.equal(writes.length, 0, "a read-only load does not rewrite the raw history");
  }));

  test("current and saved presentation references retain their exact successful receipt", () => {
    let branch = edit(initial(), 720);
    const snapshot = pendingTasks(branch), refs = syncPresentationRefs(branch);
    branch = settleSync(markSyncing(branch, snapshot), receiptFor({ calendarId: "synthetic", eventId: "synthetic-event", managed: true }), snapshot);
    branch = reload(addHistory(branch));
    assert.ok(ids(branch).includes(snapshot[0].syncJobId));
    assert.equal(syncPresentation(branch, { writesEnabled: true }).queueState, "success");
    assert.equal(syncPresentation(branch, { writesEnabled: true, refs }).queueState, "success");
    branch = edit(branch, 780);
    assert.equal(syncPresentation(branch, { writesEnabled: true, refs }).queueState, "superseded");
  });
});

// Resuming after auto-sync was off: the user confirms one proposal that enqueues only the latest payload.
describe("resuming sync after it was turned off", () => {
  const DATE = "2026-10-12", zone = "America/Los_Angeles";
  const entries = (b) => Object.values(b.days).flat();
  function fixture() {
    const task = { id: "a", uid: "u-a", title: "SQL: LAG practice", start: 660, duration: 45, rest: 15, type: "task", done: false,
      locked: false, deferred: false, calendarSource: { accessRole: "owner", organizer: { self: true } },
      calendarLink: { source: "google", managed: true, calendarId: "owner", eventId: "old-event" } };
    task.calendarLink.localFingerprint = localCalendarSignature(task, DATE, zone);
    return { settings: { timeZone: zone }, calendar: { autoSync: false, targetCalendarId: "owner" }, days: { [DATE]: [task] } };
  }
  function edit(b, start) {
    const after = structuredClone(b.days);
    after[DATE][0].start = start;
    return enqueueChanges({ ...b, days: after }, b.days, after);
  }
  const resume = (b) => resumeSync(b, syncResumeProposal(b), { profileId: "TEST" });
  // A task that was never synced: no Calendar link yet.
  const unsynced = () => { const b = fixture(); delete entries(b)[0].calendarLink; delete entries(b)[0].calendarSource; return b; };
  const created = (eventId) => ({ source: "app", managed: true, calendarId: "owner", eventId });

  test("after several moves while off, confirming enqueues only the latest payload and cancelling changes nothing", () => {
    const b = edit(edit(fixture(), 720), 780), before = structuredClone(b), p = syncResumeProposal(b);
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].start, 780);
    assert.deepEqual(b, before);
    const result = resumeSync(b, p, { profileId: "TEST" });
    assert.equal(result.status, "ok");
    assert.equal(pendingTasks(result.data).length, 1);
    assert.equal(pendingTasks(result.data)[0].task.start, 780);
    assert.equal(result.data.calendar.syncQueue.jobs.length, 1);
    assert.equal(resumeSync(result.data, p).status, "stale");
    assert.equal(result.data.calendar.syncQueue.jobs.length, 1);
  });

  test("undoing back to the baseline while off voids the earlier queue and it cannot be revived later by ABA", () => {
    let b = fixture();
    b.calendar.autoSync = true;
    b = edit(b, 720);
    b.calendar.autoSync = false;
    b = edit(b, 660);
    const r = resume(b);
    assert.equal(r.status, "ok");
    assert.equal(pendingTasks(r.data).length, 0);
    assert.equal(r.data.calendar.syncQueue.jobs[0].items[0].status, "superseded");
  });

  test("an ABA edit while off with the content of an old pending job is a new job that the old exact receipt cannot settle", () => {
    let b = fixture();
    b.calendar.autoSync = true;
    b = edit(b, 720);
    const old = pendingTasks(b);
    b.calendar.autoSync = false;
    b = edit(edit(b, 780), 720);
    const r = resume(b).data, newPending = pendingTasks(r);
    assert.equal(newPending.length, 1);
    assert.notEqual(newPending[0].syncJobId, old[0].syncJobId);
    const after = settleSync(r, { results: [{ uid: "u-a", ok: true, calendarLink: { calendarId: "owner", eventId: "old-event" } }] }, old);
    assert.equal(pendingTasks(after)[0].syncJobId, newPending[0].syncJobId);
  });

  test("an original pending job without offline changes is kept and not enqueued again", () => {
    let b = fixture();
    b.calendar.autoSync = true;
    b = edit(b, 720);
    const id = pendingTasks(b)[0].syncJobId;
    b.calendar.autoSync = false;
    const r = resume(b).data;
    assert.equal(r.calendar.syncQueue.jobs.length, 1);
    assert.equal(pendingTasks(r)[0].syncJobId, id);
  });

  test("browsing or a revision change does not expire a resume, but a changed payload, event, target or permission does", () => {
    const b = edit(fixture(), 720), p = syncResumeProposal(b), browse = structuredClone(b);
    browse.revision = 99;
    browse.date = "2026-10-13";
    assert.equal(resumeSync(browse, p).status, "ok");
    for (const modify of [
      (x) => (entries(x)[0].start = 780),
      (x) => (entries(x)[0].calendarLink.eventId = "new-event"),
      (x) => (x.calendar.targetCalendarId = "another"),
      (x) => (entries(x)[0].calendarLink.managed = false),
      (x) => (entries(x)[0].calendarSource.accessRole = "reader"),
    ]) {
      const changed = structuredClone(b);
      modify(changed);
      assert.equal(resumeSync(changed, p).status, "stale");
    }
  });

  test("fixed, completed, unmanaged, other-organizer, remotely conflicting or deleted items cannot be enqueued by a resume", () => {
    for (const extra of [
      { locked: true }, { done: true }, { type: "activity" }, { externalReadOnly: true }, { calendarConflict: { kind: "both" } },
      { calendarLink: { source: "google", managed: false, calendarId: "owner", eventId: "old-event" } },
      { calendarLink: { source: "google", managed: true, remoteDeleted: true, calendarId: "owner", eventId: "old-event" } },
      { calendarSource: { accessRole: "owner", organizer: { self: false } } },
    ]) {
      const b = edit(fixture(), 720);
      Object.assign(entries(b)[0], extra);
      assert.equal(pendingTasks(resume(b).data).length, 0);
    }
  });

  test("without a baseline the resume asks to check first, and historical local tasks with no save intent are not bulk-imported", () => {
    const b = edit(fixture(), 720);
    delete entries(b)[0].calendarLink.localFingerprint;
    const p = syncResumeProposal(b);
    assert.equal(p.items.length, 0);
    assert.equal(p.blocked.length, 1);
    assert.equal(pendingTasks(resume(b).data).length, 0);
    const local = unsynced();
    assert.equal(syncResumeProposal(local).items.length, 0);
    const r = resume(edit(local, 720)).data;
    assert.equal(pendingTasks(r).length, 1);
    assert.equal(pendingTasks(r)[0].task.calendarLink, undefined);
  });

  test("a reload or turning writes off keeps the confirmed queue, and after an exact success receipt nothing is created twice", () => {
    const r = resume(edit(unsynced(), 720)).data, snapshot = pendingTasks(r);
    r.calendar.writesEnabled = false;
    assert.equal(pendingTasks(JSON.parse(JSON.stringify(r))).length, 1);
    const settled = settleSync(r, { results: [{ uid: "u-a", ok: true, calendarLink: created("created") }] }, snapshot);
    settled.calendar.autoSync = false;
    assert.equal(syncResumeProposal(settled).items.length, 0);
    assert.equal(pendingTasks(resume(settled).data).length, 0);
  });

  test("a task continuing after an app-created receipt also gets its offline edits filled in", () => {
    const b = fixture();
    entries(b)[0].calendarLink.source = "app";
    delete entries(b)[0].calendarSource;
    const r = resume(edit(b, 780)).data;
    assert.equal(pendingTasks(r).length, 1);
    assert.equal(pendingTasks(r)[0].task.calendarLink.eventId, "old-event");
  });

  test("a preference generation that was turned off and on again cannot reuse an earlier resume confirmation", () => {
    const b = edit(fixture(), 720), p = syncResumeProposal(b);
    b.calendar.syncPreferenceEpoch = 2;
    assert.equal(resumeSync(b, p).status, "stale");
    assert.equal(b.calendar.autoSync, false);
  });

  test("after a partial success, resuming retries only the failed items and does not recreate successful creates", () => {
    let b = unsynced();
    b.days[DATE].push({ ...entries(b)[0], id: "b", uid: "u-b", title: "SQL: review", start: 780 });
    const before = structuredClone(b.days);
    for (const t of entries(b)) t.start += 30;
    b = enqueueChanges(b, before, b.days);
    b = resume(b).data;
    const sent = pendingTasks(b);
    assert.equal(sent.length, 2);
    b = settleSync(b, { partial: true, results: [
      { uid: "u-a", ok: true, calendarLink: created("created-a") },
      { uid: "u-b", ok: false, message: "Synthetic failure" },
    ] }, sent);
    b.calendar.autoSync = false;
    const r = resume(b).data;
    assert.deepEqual(pendingTasks(r).map((e) => e.task.uid), ["u-b"]);
    assert.equal(entries(r)[0].calendarLink.eventId, "created-a");
  });
});
