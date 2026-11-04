import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  WorkspaceStore, STORAGE_KEY, RECOVERY_KEY,
  defaults, freshWorkspace, normalizeWorkspace,
} from "../storage.js";
import {
  TERMINAL_HISTORY_LIMIT, enqueueChanges, markSyncing, pendingTasks, settleSync,
} from "../sync-queue.js";
import { presentError } from "../ui-messages.js";
import { localCalendarSignature } from "../calendar-data.js";
import { validateIntentDays } from "../intent-planner.js";
import { addDays } from "../time.js";
import { formatTime } from "../scheduler.js";

class MemoryStorage {
  data = new Map();
  failures = new Set();
  writes = [];
  afterWrite = null;
  afterRead = null;
  getItem(key) {
    const value = this.data.get(key) ?? null;
    this.afterRead?.(key, value);
    return value;
  }
  setItem(key, value) {
    if (this.failures.has(key))
      throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    this.data.set(key, value);
    this.writes.push(key);
    this.afterWrite?.(key, value);
  }
}
const date = "2026-10-12";
const task = (id, extra = {}) => ({
  id, uid: `uid-${id}`, title: id, start: 660, duration: 45, rest: 15,
  done: false, locked: false, deferred: false, bufferBefore: 0, bufferAfter: 0,
  ...extra,
});
const workspace = () => {
  const state = freshWorkspace();
  state.profileId = "storage-fixture";
  state.personal.days[date] = [task("mine")];
  state.ui.date = date;
  return state;
};
const seeded = (state = workspace()) => {
  const storage = new MemoryStorage();
  storage.data.set(STORAGE_KEY, JSON.stringify(state));
  const store = new WorkspaceStore(storage);
  store.load();
  assert.equal(store.error, null);
  return { storage, store };
};
const recoveryWorkspace = (storage) => {
  const index = JSON.parse(storage.getItem(RECOVERY_KEY));
  return index.workspace || JSON.parse(JSON.parse(storage.getItem(index.workspaceRef))[STORAGE_KEY]);
};

describe("default rules", () => {
  test("The default rules give a 09:00-23:00 day, 150 study minutes, a 20-minute gap and an 11:00 preferred start", () => {
    const settings = defaults();
    assert.equal(settings.ruleSources.dayStart, "user-spec-2026-10-10");
    assert.equal(settings.timeZone, "America/Los_Angeles");
    assert.equal(settings.dayStart, 540);
    assert.equal(settings.dayEnd, 1380);
    assert.equal(settings.learningCapacity, 150);
    assert.equal(settings.learningMinGap, 20);
    assert.equal(settings.learningPreferredStart, 660);
    assert.equal(settings.bufferBefore, 0);
    assert.equal(settings.bufferAfter, 0);
    for (const windows of Object.values(settings.weekly)) assert.deepEqual(windows, [[540, 1380]]);
    assert.deepEqual(settings.dates, {});
    assert.deepEqual(settings.learningDates, {});
  });

  test("Hard bounds constrain date overrides, daily rules and study-date capacity without rewriting external calendar times", () => {
    const state = workspace();
    state.personal.settings.dates[date] = { windows: [[0, 1440]], dayEnd: 1440 };
    state.personal.settings.learningDates[date] = { windows: [[0, 1440]], capacity: null };
    state.personal.daySettings[date] = { dayStart: 0, dayEnd: 1440, learningCapacity: null, learningMinGap: 0 };
    const external = task("outside", {
      start: 300, duration: 90, locked: true, externalReadOnly: true,
      calendarLink: { source: "google", eventId: "outside", calendarId: "primary", managed: false },
      calendarOccupation: { startInstant: 1791806400000, endInstant: 1791811800000 },
    });
    state.personal.days[date] = [external];
    const inputRaw = JSON.stringify(state);
    const normalized = normalizeWorkspace(state);
    assert.equal(JSON.stringify(state), inputRaw); // Pure normalization.
    assert.equal(normalized.personal.days[date][0].start, 300);
    assert.deepEqual(normalized.personal.days[date][0].calendarOccupation, external.calendarOccupation);
    assert.deepEqual(normalized.personal.settings.dates[date].windows, [[540, 1380]]);
    assert.equal(normalized.personal.settings.dates[date].dayEnd, 1380);
    assert.equal(normalized.personal.settings.learningDates[date].capacity, 150);
    assert.equal(normalized.personal.daySettings[date].dayStart, 540);
    assert.equal(normalized.personal.daySettings[date].dayEnd, 1380);
    assert.equal(normalized.personal.daySettings[date].learningCapacity, 150);
    assert.equal(normalized.personal.daySettings[date].learningMinGap, 20);
  });

  test("The 11:00 preferred start is soft and does not override an explicitly narrower morning window", () => {
    const state = workspace();
    state.personal.settings.dayEnd = 630;
    state.personal.settings.weekly = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [[540, 630]]]));
    const normalized = normalizeWorkspace(state);
    assert.equal(normalized.personal.settings.dayEnd, 630);
    assert.equal(normalized.personal.settings.learningPreferredStart, 660);
    assert.deepEqual(normalized.personal.settings.weekly[0], [[540, 630]]);
  });
});

describe("restore points and recovery", () => {
  test("The restore point taken before saving restores content, package, completion records, Calendar identity and undo", () => {
    const state = workspace();
    state.personal.days[date] = [task("study", {
      tags: ["study"], planId: "job-prepare", packageId: "A", packageOrder: 1,
      packageTaskOrder: 0, packageOriginDate: date,
      done: true, completedAt: "2026-10-12T11:45:00-07:00", actualCompletedDate: date,
      calendarLink: { source: "google", calendarId: "primary", eventId: "original", etag: "v1", managed: true },
    })];
    state.personal.undo = { kind: "adjustment", data: { preserved: true } };
    const { storage, store } = seeded(state);
    const before = structuredClone(store.state.personal);
    const saved = store.save((draft) => { draft.personal.days[date][0].title = "Changed"; });
    assert.equal(saved.ok, true);
    const candidates = store.recoveryCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].taskCount, 1);
    assert.equal(candidates[0].reason, "Before saving changes");
    const restored = store.restoreRecovery(candidates[0].id, { expectedRevision: store.state.revision });
    assert.equal(restored.ok, true);
    assert.deepEqual(store.state.personal, before);
    assert.equal(store.state.revision, 2);
    const reloaded = new WorkspaceStore(storage);
    reloaded.load();
    assert.deepEqual(reloaded.state, store.state);
    assert.equal(recoveryWorkspace(storage).personal.days[date][0].title, "Changed");
  });

  test("A damaged read is never restored automatically, only an explicit restore takes effect, and the damaged raw value can still be exported", () => {
    const { storage, store } = seeded();
    store.save((draft) => { draft.personal.days[date][0].title = "new"; });
    const bad = "{unfinished-important-data";
    storage.data.set(STORAGE_KEY, bad);
    const damaged = new WorkspaceStore(storage);
    damaged.load();
    assert.match(damaged.error, /original data is retained/);
    assert.equal(storage.getItem(STORAGE_KEY), bad);
    assert.equal(damaged.save(() => {}).code, "readonly");
    assert.equal(damaged.exportData().original[STORAGE_KEY], bad);
    const candidate = damaged.recoveryCandidates()[0];
    assert.equal(candidate.taskCount, 1);
    const restored = damaged.restoreRecovery({ id: candidate.id, expectedRevision: damaged.state.revision, expectedRaw: bad });
    assert.equal(restored.ok, true);
    assert.equal(damaged.error, null);
    assert.equal(damaged.state.personal.days[date][0].title, "mine");
    assert.equal(JSON.parse(storage.getItem("shunri.restore.previous"))[STORAGE_KEY], bad);
    assert.equal(damaged.recoveryCandidates().length, 1); // Corrupt raw never offered as a valid second recovery point.
  });

  test("When the backup key is full the main save is refused, and when the main key is full the old valid data and a usable restore point are kept", () => {
    for (const failureKey of ["shunri.restore.previous", RECOVERY_KEY, STORAGE_KEY]) {
      const { storage, store } = seeded();
      const before = structuredClone(store.state);
      const raw = storage.getItem(STORAGE_KEY);
      storage.failures.add(failureKey);
      const result = store.save((draft) => { draft.personal.days[date][0].title = "must-not-apply"; });
      assert.equal(result.ok, false);
      assert.equal(result.code, "save_failed");
      assert.match(result.message, /storage is full/);
      assert.equal(storage.getItem(STORAGE_KEY), raw);
      assert.deepEqual(store.state, before);
      if (failureKey === STORAGE_KEY) assert.equal(store.recoveryCandidates()[0].taskCount, 1);
      storage.failures.clear();
      assert.equal(store.save((draft) => { draft.personal.days[date][0].title = "retry"; }).ok, true);
    }
  });

  test("A restore point is kept before an import, and an invalid import or a failed main write leaves existing data unchanged", () => {
    const { storage, store } = seeded();
    const imported = workspace();
    imported.personal.days[date][0].title = "Imported";
    assert.equal(store.restore({ workspace: imported }).ok, true);
    const candidate = store.recoveryCandidates()[0];
    assert.equal(candidate.reason, "Before import or restore");
    assert.equal(store.restoreRecovery(candidate.id).ok, true);
    assert.equal(store.state.personal.days[date][0].title, "mine");
    const before = storage.getItem(STORAGE_KEY);
    const writes = storage.writes.length;
    assert.equal(store.restore({ workspace: { version: 99 } }).ok, false);
    const noData = store.restore({ format: "shunri-raw-recovery", original: {} });
    assert.equal(noData.ok, false);
    assert.match(noData.message, /no recognized schedule data/);
    assert.equal(storage.getItem(STORAGE_KEY), before);
    assert.equal(storage.getItem(STORAGE_KEY), before);
    assert.equal(storage.writes.length, writes);
    storage.failures.add(STORAGE_KEY);
    assert.equal(store.restore({ workspace: imported }).ok, false);
    assert.equal(storage.getItem(STORAGE_KEY), before);
    assert.equal(store.state.personal.days[date][0].title, "mine");
  });

  test("An old save or old restore confirmation from another tab cannot overwrite a newer save", () => {
    const { storage, store } = seeded();
    store.save((draft) => { draft.personal.days[date][0].title = "first"; });
    const other = new WorkspaceStore(storage);
    other.load();
    const oldRevision = store.state.revision;
    const oldRaw = store.raw;
    const candidate = store.recoveryCandidates()[0];
    assert.equal(other.save((draft) => { draft.personal.days[date][0].title = "other latest"; }).ok, true);
    const latest = storage.getItem(STORAGE_KEY);
    assert.equal(store.save((draft) => { draft.personal.days[date][0].title = "stale"; }, oldRevision).code, "stale");
    assert.equal(storage.getItem(STORAGE_KEY), latest);
    assert.equal(store.restoreRecovery(candidate.id, { expectedRevision: oldRevision, expectedRaw: oldRaw }).ok, false);
    assert.equal(storage.getItem(STORAGE_KEY), latest);
    const currentCandidate = store.recoveryCandidates()[0];
    assert.equal(store.restoreRecovery(currentCandidate.id, { expectedRevision: oldRevision, expectedRaw: oldRaw }).ok, false);
    assert.equal(storage.getItem(STORAGE_KEY), latest);
  });

  test("A version written between the backup and the main write is not overwritten, and a restore candidate changed after listing is refused", () => {
    const { storage, store } = seeded();
    const newer = structuredClone(store.state);
    newer.revision = 5;
    newer.personal.days[date][0].title = "concurrent";
    storage.afterWrite = (key) => {
      if (key === RECOVERY_KEY) storage.data.set(STORAGE_KEY, JSON.stringify(newer));
    };
    assert.equal(store.save((draft) => { draft.personal.days[date][0].title = "old"; }).code, "stale");
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).personal.days[date][0].title, "concurrent");
    storage.afterWrite = null;
    const candidate = store.recoveryCandidates()[0];
    let reads = 0;
    storage.afterRead = (key) => {
      if (key === RECOVERY_KEY && ++reads === 1) {
        const snapshot = JSON.parse(storage.data.get(key));
        snapshot.reason = "changed-after-list";
        storage.data.set(key, JSON.stringify(snapshot));
      }
    };
    const result = store.restoreRecovery(candidate.id);
    assert.equal(result.code, "recovery_missing");
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).personal.days[date][0].title, "concurrent");
  });

  test("Backups and exports contain no OAuth secret fields, and the restore point always holds a single version", () => {
    const state = workspace();
    state.personal.calendar = {
      accessToken: "FAKE_ACCESS", refresh_token: "FAKE_REFRESH", csrfToken: "FAKE_CSRF",
      calendarId: "primary", queue: [{ uid: "uid-mine", nested: { clientSecret: "FAKE_SECRET", safe: "keep" } }],
    };
    const { storage, store } = seeded(state);
    store.save((draft) => { draft.ui.mode = "demo"; });
    for (const serialized of [JSON.stringify(store.exportData()), JSON.stringify(recoveryWorkspace(storage))]) {
      for (const secret of ["FAKE_ACCESS", "FAKE_REFRESH", "FAKE_CSRF", "FAKE_SECRET"]) assert.equal(serialized.includes(secret), false);
      assert.equal(serialized.includes('"safe":"keep"'), true);
    }
    for (let count = 0; count < 6; count++) store.save((draft) => { draft.ui.mode = count % 2 ? "personal" : "demo"; });
    assert.equal(store.recoveryCandidates().length, 1);
    assert.equal(recoveryWorkspace(storage).revision, store.state.revision - 1);
    assert.equal(storage.data.size, 3);
    const index = JSON.parse(storage.getItem(RECOVERY_KEY));
    assert.equal(index.workspace, undefined);
    assert.equal(index.workspaceRef, "shunri.restore.previous");
    assert.equal(storage.getItem(RECOVERY_KEY).includes('"calendar"'), false); // Lightweight index, not duplicated payload.
  });

  test("A pre-import backup can be restored explicitly, and a corrupted candidate is not offered as restorable", () => {
    const { storage, store } = seeded();
    const earlier = workspace();
    earlier.personal.days[date] = [task("earlier")];
    storage.data.set("shunri.restore.previous", JSON.stringify({ [STORAGE_KEY]: JSON.stringify(earlier) }));
    storage.data.set(RECOVERY_KEY, "{broken");
    store.load();
    const candidates = store.recoveryCandidates();
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates.map((item) => item.key), ["shunri.restore.previous"]);
    assert.equal(store.restoreRecovery(candidates[0].id).ok, true);
    assert.equal(store.state.personal.days[date][0].id, "earlier");
    const empty = new WorkspaceStore(new MemoryStorage());
    empty.load();
    assert.equal(empty.restoreRecovery().code, "recovery_missing");
  });

  test("Loading rejects missing prerequisites and dependency cycles without touching storage", () => {
    for (const tasks of [
      [task("missing", { dependencies: [{ id: "not-present", gap: 0 }] })],
      [task("a", { dependencies: [{ id: "b", gap: 0 }] }), task("b", { dependencies: [{ id: "a", gap: 0 }] })],
    ]) {
      const storage = new MemoryStorage();
      const stored = workspace();
      stored.personal.days[date] = tasks;
      const raw = JSON.stringify(stored);
      storage.data.set(STORAGE_KEY, raw);
      const store = new WorkspaceStore(storage);
      store.load();
      assert.match(store.error, /prerequisite for .* is missing|dependency cycle/);
      assert.equal(storage.getItem(STORAGE_KEY), raw);
      assert.equal(storage.getItem(RECOVERY_KEY), null);
    }
  });
});

describe("saving the personal and example workspaces", () => {
  test("Personal and example data are saved separately, and resetting the example does not change the personal schedule", () => {
    const memory = new MemoryStorage(), store = new WorkspaceStore(memory);
    store.load();
    store.save((state) => {
      state.personal.days[date] = [task("mine")];
      state.demo.days[date] = [task("sample", { start: 800 })];
    });
    const original = structuredClone(store.state.personal);
    store.save((state) => {
      state.ui.mode = "demo";
      state.demo.days = {};
    });
    assert.deepEqual(store.state.personal, original);
    const reload = new WorkspaceStore(memory);
    reload.load();
    assert.deepEqual(reload.state.personal, original);
    assert.equal(reload.state.ui.mode, "demo");
  });

  test("A quota failure on a store that never saved changes nothing in memory and writes nothing", () => {
    const memory = new MemoryStorage(), store = new WorkspaceStore(memory);
    store.load();
    const original = structuredClone(store.state);
    memory.failures.add(STORAGE_KEY);
    assert.equal(store.save((state) => { state.personal.days[date] = [task("a")]; }).code, "save_failed");
    assert.deepEqual(store.state, original);
    assert.equal(memory.getItem(STORAGE_KEY), null);
  });
});

describe("importing a backup", () => {
  const importTask = (id, start = 600, extra = {}) => ({
    id, uid: "uid-" + id, title: id, start, duration: 30, rest: 0,
    done: false, locked: false, deferred: false, dependencies: [], ...extra,
  });

  test("An imported sync queue persists and reloads, and malformed queue replacements leave all storage and state intact", () => {
    const memory = new MemoryStorage();
    const store = new WorkspaceStore(memory);
    store.load();
    const input = freshWorkspace();
    input.personal.calendar = { autoSync: true, targetCalendarId: "synthetic-target" };
    input.personal.days["2026-10-10"] = [importTask("queued")];
    input.personal = enqueueChanges(input.personal, {}, input.personal.days, {
      profileId: "synthetic", createdAt: "2026-10-10T12:00:00Z",
    });
    const original = structuredClone(input);
      assert.equal(store.restore(JSON.parse(JSON.stringify({ workspace: input }))).ok, true);
    assert.deepEqual(input, original);
    assert.deepEqual(JSON.parse(memory.getItem(STORAGE_KEY)).personal.calendar.syncQueue,
      input.personal.calendar.syncQueue);
    const reloaded = new WorkspaceStore(memory);
    reloaded.load();
    assert.equal(reloaded.error, null);
    assert.deepEqual(reloaded.state, store.state);
    assert.equal(pendingTasks(reloaded.state.personal).length, 1);

    for (const mode of ["personal", "demo"]) {
      for (const queue of [null, "x", { jobs: "x" }, { jobs: {} },
        { jobs: [null] }, { jobs: [{ items: "x" }] },
        { jobs: [{ items: [null] }] }, { jobs: [], nextId: "2" }]) {
        const malformed = structuredClone(input);
        malformed[mode].calendar = { syncQueue: queue };
        const beforeState = structuredClone(reloaded.state);
        const beforeStorage = [...memory.data];
        assert.equal(reloaded.restore({ workspace: malformed }).ok, false);
        assert.deepEqual(reloaded.state, beforeState);
        assert.deepEqual([...memory.data], beforeStorage);
        const after = new WorkspaceStore(memory);
        after.load();
        assert.equal(after.error, null);
        assert.deepEqual(after.state, beforeState);
        assert.equal(pendingTasks(after.state.personal).length, 1);
      }
    }
  });
  test("Each import backs up the data saved just before it", () => {
    const memory = new MemoryStorage(),
      store = new WorkspaceStore(memory);
    store.load();
    store.save((s) => (s.personal.days["2026-10-10"] = [importTask("saved")]));
    const current = memory.getItem(STORAGE_KEY);
    assert.equal(store.restore(freshWorkspace()).ok, true);
    assert.equal(
      JSON.parse(memory.getItem("shunri.restore.previous"))[STORAGE_KEY],
      current,
    );
    const second = memory.getItem(STORAGE_KEY);
    assert.equal(store.restore(freshWorkspace()).ok, true);
    assert.equal(
      JSON.parse(memory.getItem("shunri.restore.previous"))[STORAGE_KEY],
      second,
    );
  });
  test("A reader of corrupt data cannot overwrite a recovery another tab already wrote", () => {
    const memory = new MemoryStorage();
    memory.setItem(STORAGE_KEY, "broken");
    const old = new WorkspaceStore(memory);
    old.load();
    const recovered = freshWorkspace();
    recovered.personal.days["2026-10-10"] = [importTask("newer")];
    memory.setItem(STORAGE_KEY, JSON.stringify(recovered));
    const raw = memory.getItem(STORAGE_KEY);
    assert.equal(old.restore(freshWorkspace()).ok, false);
    assert.equal(memory.getItem(STORAGE_KEY), raw);
  });
  test("An explicit import replaces unchanged corrupt data and keeps the corrupt original as the backup", () => {
    const memory = new MemoryStorage();
    memory.setItem(STORAGE_KEY, "broken");
    const store = new WorkspaceStore(memory);
    store.load();
    assert.equal(store.restore(freshWorkspace()).ok, true);
    assert.equal(
      JSON.parse(memory.getItem("shunri.restore.previous"))[STORAGE_KEY],
      "broken",
    );
  });
  test("Import rejects missing, self and cyclic dependencies without writing", () => {
    const memory = new MemoryStorage(),
      store = new WorkspaceStore(memory);
    store.load();
    store.save(() => {});
    const raw = memory.getItem(STORAGE_KEY);
    for (const tasks of [
      [importTask("a", 600, { dependencies: [{ id: "missing", gap: 0 }] })],
      [importTask("a", 600, { dependencies: [{ id: "a", gap: 0 }] })],
      [
        importTask("a", 600, { dependencies: [{ id: "b", gap: 0 }] }),
        importTask("b", 660, { dependencies: [{ id: "a", gap: 0 }] }),
      ],
    ]) {
      const input = freshWorkspace();
      input.personal.days["2026-10-10"] = tasks;
      assert.equal(store.restore(input).ok, false);
      assert.equal(memory.getItem(STORAGE_KEY), raw);
    }
  });
  test("UID dependencies stay valid and the previous backup can be imported in the raw recovery format", () => {
    const memory = new MemoryStorage(),
      store = new WorkspaceStore(memory);
    store.load();
    store.save(
      (s) =>
        (s.personal.days["2026-10-10"] = [
          importTask("parent"),
          importTask("child", 660, { dependencies: [{ id: "uid-parent", gap: 0 }] }),
        ]),
    );
    const old = store.state.personal.days;
    store.restore(freshWorkspace());
    const recovery = {
      format: "shunri-raw-recovery",
      original: JSON.parse(memory.getItem("shunri.restore.previous")),
    };
    assert.equal(store.restore(recovery).ok, true);
    assert.deepEqual(store.state.personal.days, old);
  });
  test("Import rejects an invalid counted flag, a negative fixed-activity buffer and a non-string uid", () => {
    const memory = new MemoryStorage(),
      store = new WorkspaceStore(memory);
    store.load();
    for (const extra of [
      { counted: "true" },
      { type: "activity", bufferBefore: -1 },
      { uid: 7 },
    ]) {
      const input = freshWorkspace();
      input.personal.days["2026-10-10"] = [importTask("invalid", 600, extra)];
      assert.equal(store.restore(input).ok, false);
    }
  });
  test("An import confirmation is stale after the state was refreshed, even with the same revision number", () => {
    const memory = new MemoryStorage(),
      store = new WorkspaceStore(memory);
    store.load();
    store.save(() => {});
    const expected = {
      expectedRaw: store.original[STORAGE_KEY],
      expectedRevision: store.state.revision,
    };
    const newer = structuredClone(store.state);
    newer.personal.days["2026-10-10"] = [importTask("new-tab")];
    memory.setItem(STORAGE_KEY, JSON.stringify(newer));
    store.load();
    assert.equal(store.restore(freshWorkspace(), expected).ok, false);
    assert.equal(store.state.personal.days["2026-10-10"][0].id, "new-tab");
  });
});

describe("sync queue persistence", () => {
  const DATE = "2026-10-12", ZONE = "America/Los_Angeles";
  const syncTask = (uid, changes = {}) => ({
    id: uid, uid, title: `Synthetic ${uid}`, start: 720, duration: 30,
    rest: 0, type: "task", done: false, locked: false, deferred: false,
    counted: false, dependencies: [], bufferBefore: 0, bufferAfter: 0, ...changes,
  });
  const terminal = (id, uid = `removed-${id}`) => ({
    id, status: "success", items: [{ uid, status: "success" }],
  });
  function appendHistory(branch) {
    branch.calendar.syncQueue.jobs.push(...Array.from(
      { length: TERMINAL_HISTORY_LIMIT + 12 }, (_, i) => terminal(`history-${i}`),
    ));
  }
  const jobIds = branch => branch.calendar.syncQueue.jobs.map(job => job.id);
  const windows = branch => structuredClone({ settings: branch.settings, daySettings: branch.daySettings });
  function combinedWorkspace() {
    const workspace = freshWorkspace();
    workspace.profileId = "synthetic-composition";
    for (const mode of ["personal", "demo"]) {
      const branch = workspace[mode];
      branch.days[DATE] = [syncTask("active"), syncTask("live", { start: 780 })];
      branch.settings.weekly[1] = [[600, 900], [960, 1260]];
      branch.settings.dates[DATE] = { windows: [[600, 1260]], capacity: 180 };
      branch.settings.learningDates[DATE] = { windows: [[660, 900]], capacity: 90 };
      branch.daySettings[DATE] = structuredClone(branch.settings);
      branch.daySettings[DATE].minGap = 10;
      branch.calendar = {
        autoSync: true, targetCalendarId: "synthetic-calendar",
        syncDisplayRefs: { saved: { syncJobId: "display-receipt" } },
        syncQueue: { nextId: 9001, jobs: [
          terminal("sync-synthetic-9000"),
          terminal("display-receipt"), terminal("live-receipt", "live"),
          { id: "sync-synthetic-7", status: "queued", items: [{
            uid: "active", id: "active", date: DATE, calendarId: "synthetic-calendar",
            signature: localCalendarSignature(branch.days[DATE][0], DATE, ZONE), status: "queued",
          }] },
          ...["syncing", "failed", "blocked", "partial"].map(status => ({
            id: `unresolved-${status}`, status,
            items: [{ uid: `unresolved-${status}`, status: status === "partial" ? "failed" : status }],
          })),
          { id: "late-receipt", status: "success", items: [{
            uid: "removed-in-flight", status: "superseded", awaitingReceipt: true,
            receiptPendingUntil: Date.now() + 5 * 60 * 1000,
          }] },
        ] },
      };
      appendHistory(branch);
    }
    return workspace;
  }

  test("Restore, save and reload validate and prune the sync queue of both branches without changing schedules or windows", () => {
    const memory = new MemoryStorage(), store = new WorkspaceStore(memory);
    store.load();
    const input = combinedWorkspace(), original = structuredClone(input);
    assert.equal(store.restore(JSON.parse(JSON.stringify({ workspace: input }))).ok, true);
    assert.deepEqual(input, original);
    for (const mode of ["personal", "demo"]) {
      const branch = store.state[mode], ids = jobIds(branch);
      assert.equal(branch.calendar.syncQueue.nextId, 9001, "the counter stays above the oldest, largest ID");
      assert.equal(ids.includes("sync-synthetic-9000"), false);
      assert.equal(ids.filter(id => id.startsWith("history-")).length, TERMINAL_HISTORY_LIMIT);
      assert.equal(ids.includes("history-0"), false);
      for (const id of ["display-receipt", "live-receipt", "sync-synthetic-7", "late-receipt",
        "unresolved-syncing", "unresolved-failed", "unresolved-blocked", "unresolved-partial"])
        assert.ok(ids.includes(id), `retain protected job ${id}`);
      assert.deepEqual(branch.days, original[mode].days);
      assert.deepEqual(windows(branch), windows(original[mode]));
      assert.equal(pendingTasks(branch).length, 1);
    }
    assert.equal(store.save(() => {}).ok, true);
    const reloaded = new WorkspaceStore(memory);
    reloaded.load();
    assert.equal(reloaded.error, null);
    assert.deepEqual(reloaded.state, store.state);
    assert.deepEqual(JSON.parse(memory.getItem(STORAGE_KEY)), store.state);
  });

  for (const mode of ["personal", "demo"]) {
    test(`Malformed ${mode} sync queues are rejected before any restore or save write`, () => {
      const memory = new MemoryStorage(), store = new WorkspaceStore(memory);
      store.load();
      assert.equal(store.restore({ workspace: combinedWorkspace() }).ok, true);
      const recycled = structuredClone(store.state[mode].calendar.syncQueue);
      recycled.nextId = 1;
      const belowRetained = structuredClone(store.state[mode].calendar.syncQueue);
      belowRetained.nextId = 7;
      const duplicate = structuredClone(store.state[mode].calendar.syncQueue);
      duplicate.jobs.push(structuredClone(duplicate.jobs.find(job => job.id === "sync-synthetic-7")));
      const cases = [
        [recycled, "Sync queue ID counter would reuse an existing job ID"],
        [belowRetained, "Sync queue ID counter would reuse an existing job ID"],
        [duplicate, "Duplicate sync job ID"],
        [null, "Invalid sync queue format"],
        [{ jobs: [null] }, "Invalid sync queue format"],
        [{ jobs: [{ items: [null] }] }, "Invalid sync queue format"],
        [{ jobs: [], nextId: Number.MAX_SAFE_INTEGER + 1 }, "Invalid sync queue format"],
        [{ jobs: [], nextId: 0 }, "Invalid sync queue format"],
        [{ jobs: [] }, "Invalid sync queue format"],
      ];
      for (const [queue, message] of cases) {
        const malformed = structuredClone(store.state);
        malformed[mode].calendar.syncQueue = queue;
        const inputBefore = structuredClone(malformed), stateBefore = structuredClone(store.state);
        const storageBefore = [...memory.data], writesBefore = memory.writes.length;
        assert.throws(() => normalizeWorkspace(malformed), { message });
        const imported = store.restore({ workspace: malformed });
        assert.equal(imported.ok, false);
        assert.ok(imported.message.includes(message));
        const saved = store.save(draft => { draft[mode].calendar.syncQueue = structuredClone(queue); });
        assert.equal(saved.ok, false);
        assert.ok(saved.message.includes(message));
        assert.deepEqual(malformed, inputBefore);
        assert.deepEqual(store.state, stateBefore);
        assert.deepEqual([...memory.data], storageBefore);
        assert.equal(memory.writes.length, writesBefore, "even recovery keys must remain untouched");
        const reloaded = new WorkspaceStore(memory);
        reloaded.load();
        assert.equal(reloaded.error, null);
        assert.deepEqual(reloaded.state, stateBefore);
      }
    });
  }

  test("The largest safe job counter round-trips without clamping or recycling IDs", () => {
    const input = combinedWorkspace();
    for (const mode of ["personal", "demo"]) {
      input[mode].calendar.syncQueue.jobs.unshift(terminal(`sync-synthetic-${Number.MAX_SAFE_INTEGER - 1}`));
      input[mode].calendar.syncQueue.nextId = Number.MAX_SAFE_INTEGER;
    }
    const memory = new MemoryStorage(), store = new WorkspaceStore(memory);
    store.load();
    assert.equal(store.restore({ workspace: input }).ok, true);
    assert.equal(store.save(() => {}).ok, true);
    const reloaded = new WorkspaceStore(memory);
    reloaded.load();
    assert.equal(reloaded.error, null);
    for (const mode of ["personal", "demo"]) {
      assert.equal(reloaded.state[mode].calendar.syncQueue.nextId, Number.MAX_SAFE_INTEGER);
      const before = structuredClone(reloaded.state), bytes = [...memory.data], writes = memory.writes.length;
      const allocation = reloaded.save(draft => {
        const prior = structuredClone(draft[mode].days);
        draft[mode].days[DATE][0].start += 15;
        draft[mode] = enqueueChanges(draft[mode], prior, draft[mode].days);
      });
      assert.equal(allocation.ok, false, "exhaustion must not persist an unsafe increment or recycle an ID");
      assert.deepEqual(reloaded.state, before);
      assert.deepEqual([...memory.data], bytes);
      assert.equal(memory.writes.length, writes);
    }
  });

  function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  }
  // Exercise the actual app executor with real storage and queue boundaries.
  const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const begin = appSource.indexOf("function invalidateSync()"),
    end = appSource.indexOf('window.addEventListener("online"', begin);
  assert.ok(begin >= 0 && end > begin, "locate the current app executor");

  for (const operation of ["create", "update"]) {
    test(`The app's ${operation} receipt survives persisted pruning and keeps the newer pending change`, { timeout: 5000 }, async t => {
      const memory = new MemoryStorage();
      let store = new WorkspaceStore(memory);
      store.load();
      const input = freshWorkspace();
      input.profileId = "synthetic-app-composition";
      input.personal.days[DATE] = [syncTask("app-task")];
      input.personal.calendar = { autoSync: true, targetCalendarId: "synthetic-calendar" };
      if (operation === "update") input.personal.days[DATE][0].calendarLink = {
        source: "app", managed: true, calendarId: "synthetic-calendar", eventId: "synthetic-event", etag: '"v0"',
      };
      input.personal = enqueueChanges(input.personal, {}, input.personal.days, { profileId: input.profileId });
      assert.equal(store.restore({ workspace: input }).ok, true);
      const entered = gate(), held = gate(), nodes = new Map(), calls = [], plans = new Map();
      t.after(() => held.release());
      const context = vm.createContext({
        state: store.state, mode: "personal", syncBusy: false, syncGeneration: 0,
        syncRequestedGeneration: null, syncPlan: null, syncRetryTimer: null,
        calendarStatus: { state: "connected", writesEnabled: true },
        structuredClone, presentError, pendingTasks, markSyncing, settleSync, localCalendarSignature,
        validatePlan: validateIntentDays, addDays, formatTime, escape: String,
        all: days => Object.entries(days).flatMap(([date, tasks]) => tasks.map(task => ({ date, task }))),
        $: id => {
          if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", disabled: false });
          return nodes.get(id);
        },
        clearTimeout() {},
        setTimeout() { assert.fail("successful synthetic sync must not schedule a retry"); },
        renderCalendarState() {},
        save(mutator) {
          const result = store.save(mutator);
          assert.equal(result.ok, true, result.message);
          context.state = store.state;
          return true;
        },
        async readCalendar(date, options) {
          context.save(draft => {
            draft.personal.calendar.readRanges = [{
              from: options.rangeFrom, to: options.rangeTo, timeZone: ZONE, partial: false,
            }];
          });
          return { ok: true, complete: true };
        },
        async calendarRequest(route, payload) {
          calls.push({ route, payload: structuredClone(payload) });
          if (route === "preview") {
            const planId = `synthetic-plan-${plans.size + 1}`;
            plans.set(planId, structuredClone(payload));
            return { planId, writesEnabled: true, canExecute: true, items: payload.tasks.map(item => ({
              title: item.title, date: item.date, start: item.start,
              action: item.calendarLink ? "update" : "create",
            })) };
          }
          assert.equal(route, "execute");
          const plan = plans.get(payload.planId), durable = JSON.parse(memory.getItem(STORAGE_KEY));
          const inFlight = durable.personal.calendar.syncQueue.jobs.find(job => job.items.some(item => item.status === "syncing"));
          assert.ok(inFlight, "persist markSyncing before execution");
          assert.equal(inFlight.items[0].awaitingReceipt, true);
          if (payload.planId === "synthetic-plan-1") { entered.release(); await held.promise; }
          return { results: plan.tasks.map(item => ({ uid: item.uid, ok: true, calendarLink: {
            source: "app", managed: true, calendarId: "synthetic-calendar", eventId: "synthetic-event",
            etag: payload.planId === "synthetic-plan-1" ? '"v1"' : '"v2"',
          } })) };
        },
      });
      vm.runInContext(appSource.slice(begin, end), context, { filename: "app.js:storage-composition" });
      const run = () => vm.runInContext("runSyncQueue()", context);
      const first = run();
      await entered.promise;
      try {
        const oldSnapshot = pendingTasks(store.state.personal), oldId = oldSnapshot[0].syncJobId;
        context.save(draft => {
          const before = structuredClone(draft.personal.days);
          draft.personal.days[DATE][0].start = 780;
          draft.personal = enqueueChanges(draft.personal, before, draft.personal.days, { profileId: draft.profileId });
          appendHistory(draft.personal);
        });
        const newId = pendingTasks(store.state.personal)[0].syncJobId;
        assert.notEqual(oldId, newId);
        // A new store reads only JSON bytes while the old request remains held.
        store = new WorkspaceStore(memory);
        store.load();
        assert.equal(store.error, null);
        context.state = store.state;
        const retained = store.state.personal.calendar.syncQueue.jobs.find(job => job.id === oldId);
        assert.ok(retained);
        assert.equal(retained.items[0].status, "superseded");
        assert.equal(retained.items[0].awaitingReceipt, true);
        assert.equal(jobIds(store.state.personal).filter(id => id.startsWith("history-")).length, TERMINAL_HISTORY_LIMIT);
        const desiredDays = structuredClone(store.state.personal.days), desiredWindows = windows(store.state.personal);
        held.release();
        await first;
        const branch = store.state.personal;
        assert.equal(branch.days[DATE][0].start, 780);
        assert.equal(branch.days[DATE][0].calendarLink.eventId, "synthetic-event");
        assert.equal(branch.days[DATE][0].calendarLink.etag, '"v1"');
        const expectedDays = structuredClone(desiredDays);
        expectedDays[DATE][0].calendarLink = branch.days[DATE][0].calendarLink;
        assert.deepEqual(branch.days, expectedDays);
        assert.deepEqual(windows(branch), desiredWindows);
        assert.equal(pendingTasks(branch)[0].syncJobId, newId);
        assert.equal(jobIds(branch).includes(oldId), false, "settled old receipts no longer consume protected slots");
        assert.equal(calls.filter(call => call.route === "execute").length, 1);
        store = new WorkspaceStore(memory);
        store.load();
        assert.equal(store.error, null);
        context.state = store.state;
        await run();
        const next = calls.filter(call => call.route === "preview")[1].payload.tasks[0];
        assert.equal(next.start, 780);
        assert.equal(next.calendarLink.eventId, "synthetic-event");
        assert.equal(next.calendarLink.etag, '"v1"');
        assert.equal(calls.filter(call => call.route === "execute").length, 2);
        assert.equal(pendingTasks(store.state.personal).length, 0);
        assert.equal(store.state.personal.calendar.syncQueue.nextId, 3);
        const final = new WorkspaceStore(memory);
        final.load();
        assert.equal(final.error, null);
        assert.deepEqual(final.state, store.state);
      } finally {
        held.release();
        await first;
      }
    });
  }
});
