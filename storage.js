import { taskInputError, DAY_END } from "./scheduler.js";
import { normalizeLearningDays } from "./learning.js";
import { pruneSyncHistory } from "./sync-queue.js";
import { attributeError } from "./task-attributes.js";
import { validDate } from "./time.js";

export const STORAGE_KEY = "shunri.workspace.v2";
export const RECOVERY_KEY = "shunri.recovery.v1";
const PREVIOUS_KEY = "shunri.restore.previous";
const RULE_SOURCE = "user-spec-2026-10-10";
export const defaults = () => ({
  ruleSources: Object.fromEntries(["dayStart", "dayEnd", "timeZone", "learningCapacity", "learningMinGap", "learningPreferredStart", "fixedProtection"].map((field) => [field, RULE_SOURCE])),
  dayStart: 540,
  dayEnd: DAY_END,
  bufferBefore: 0,
  bufferAfter: 0,
  timeZone: "America/Los_Angeles",
  minGap: 0,
  capacity: null,
  learningCapacity: 150,
  learningMinGap: 20,
  learningPreferredStart: 660,
  learningDates: {},
  weekly: Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [i, [[540, DAY_END]]]),
  ),
  dates: {},
});
const clone = (value) => structuredClone(value);
const uid = () => crypto.randomUUID();
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const privateKeys = new Set(["accessToken", "refreshToken", "access_token", "refresh_token", "clientSecret", "client_secret", "csrfToken", "GOOGLE_CLIENT_SECRET"]);
function publicData(value) {
  if (Array.isArray(value)) return value.map(publicData);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKeys.has(key)).map(([key, item]) => [key, publicData(item)]));
}
function recoveryId(key, raw) {
  let hash = 2166136261;
  for (const character of raw || "") hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return key + ":" + (hash >>> 0).toString(36);
}

export function normalizeDays(days) {
  if (!record(days)) throw new Error("The schedule format is not recognized.");
  const result = {};
  const globalIds = new Set(),
    globalUids = new Set();
  for (const [date, items] of Object.entries(days)) {
    if (!validDate(date) || !Array.isArray(items))
      throw new Error("A schedule date or task list is invalid.");
    const ids = new Set();
    result[date] = items.map((task) => {
      const occupation = task.calendarOccupation;
      const externalLong =
        task.externalReadOnly &&
        occupation &&
        Number.isFinite(occupation.startInstant) &&
        Number.isFinite(occupation.endInstant) &&
        occupation.endInstant > occupation.startInstant &&
        Number.isInteger(task.duration) &&
        task.duration > 1440;
      const error = taskInputError(
        externalLong ? { ...task, duration: 1440 } : task,
      );
      if (
        occupation &&
        (!Number.isFinite(occupation.startInstant) ||
          !Number.isFinite(occupation.endInstant) ||
          occupation.endInstant <= occupation.startInstant)
      )
        throw new Error("A Calendar occupation time is invalid.");
      if (
        task.tags !== undefined &&
        (!Array.isArray(task.tags) ||
          task.tags.some((t) => typeof t !== "string"))
      )
        throw new Error("Task tags are invalid.");
      if (
        error ||
        ids.has(task.id) ||
        globalIds.has(task.id) ||
        (task.uid && globalUids.has(task.uid))
      )
        throw new Error(error || "Duplicate task IDs were found.");
      ids.add(task.id);
      globalIds.add(task.id);
      if (task.uid !== undefined && (typeof task.uid !== "string" || !task.uid))
        throw new Error("A task’s stable ID is invalid.");
      if (
        [task.bufferBefore ?? 0, task.bufferAfter ?? 0].some(
          (n) => !Number.isInteger(n) || n < 0 || n > 1440,
        )
      )
        throw new Error("A protection duration is invalid.");
      const stableUid = task.uid || uid();
      globalUids.add(stableUid);
      for (const field of ["done", "locked", "deferred"])
        if (task[field] !== undefined && typeof task[field] !== "boolean")
          throw new Error("A task status is invalid.");
      if (task.type !== undefined && !["task", "activity"].includes(task.type))
        throw new Error("A task type is invalid.");
      const attributeProblem = attributeError(task);
      if (attributeProblem) throw new Error(attributeProblem);
      if (task.counted !== undefined && typeof task.counted !== "boolean")
        throw new Error("A capacity setting is invalid.");
      if (
        task.dependencies !== undefined &&
        (!Array.isArray(task.dependencies) ||
          task.dependencies.some(
            (d) =>
              !d ||
              typeof d.id !== "string" ||
              !Number.isInteger(d.gap) ||
              d.gap < 0 ||
              d.gap > 525600,
          ))
      )
        throw new Error("A prerequisite or its gap is invalid.");
      return {
        ...task,
        uid: stableUid,
        type: task.type || (task.locked ? "activity" : "task"),
        counted: Boolean(task.counted),
        dependencies: task.dependencies || [],
        done: Boolean(task.done),
        locked: Boolean(task.locked),
        deferred: Boolean(task.deferred),
        bufferBefore: task.bufferBefore ?? 0,
        bufferAfter: task.bufferAfter ?? 0,
      };
    });
  }
  return normalizeLearningDays(result);
}

function normalizeSettings(settings) {
  const value = { ...defaults(), ...settings };
  if (
    !Number.isInteger(value.dayStart) || value.dayStart < 540 || value.dayStart >= value.dayEnd ||
    !Number.isInteger(value.dayEnd) ||
    value.dayEnd <= 0 ||
    value.dayEnd > DAY_END ||
    [value.bufferBefore, value.bufferAfter].some(
      (v) => !Number.isInteger(v) || v < 0 || v > 1440,
    )
  )
    throw new Error("The schedule settings are invalid.");
  try {
    if (value.timeZone !== "America/Los_Angeles") throw new Error("The personal rules in this workspace use America/Los_Angeles.");
    new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
  } catch {
    throw new Error("The time-zone setting is invalid.");
  }
  const capacityValid = (n) =>
    n === null || (Number.isInteger(n) && n >= 0 && n <= 1440);
  if (
    !capacityValid(value.capacity) ||
    !capacityValid(value.learningCapacity) ||
    !Number.isInteger(value.learningMinGap) ||
    value.learningMinGap < 20 ||
    value.learningMinGap > 1440 ||
    !Number.isInteger(value.minGap) ||
    value.minGap < 0 ||
    value.minGap > 1440 ||
    !Number.isInteger(value.learningPreferredStart) || value.learningPreferredStart < 540 || value.learningPreferredStart >= DAY_END ||
    value.learningCapacity === null || value.learningCapacity > 150
  )
    throw new Error("The capacity or minimum gap is invalid.");
  const windowsValid = (windows) =>
    Array.isArray(windows) &&
    windows.every(
      (w) =>
        Array.isArray(w) &&
        w.length === 2 &&
        Number.isInteger(w[0]) &&
        Number.isInteger(w[1]) &&
        w[0] >= 0 &&
        w[1] <= 1440 &&
        w[0] < w[1],
    ) &&
    windows.every((w, i) => i === 0 || windows[i - 1][1] <= w[0]);
  if (
    !record(value.weekly) ||
    Array.from({ length: 7 }, (_, i) => i).some(
      (i) => !windowsValid(value.weekly[i]),
    )
  )
    throw new Error("The weekly windows are invalid or overlap.");
  if (!record(value.dates)) throw new Error("A date override is invalid.");
  for (const [date, rule] of Object.entries(value.dates))
    if (
      !validDate(date) ||
      !record(rule) ||
      (rule.windows !== undefined && !windowsValid(rule.windows)) ||
      (rule.capacity !== undefined && !capacityValid(rule.capacity)) ||
      (rule.closed !== undefined && typeof rule.closed !== "boolean") ||
      (rule.dayEnd !== undefined &&
        (!Number.isInteger(rule.dayEnd) ||
          rule.dayEnd < 1 ||
          rule.dayEnd > 1440))
    )
      throw new Error("The date-override rules are invalid.");
  if (
    value.learningWeekly !== undefined &&
    (!record(value.learningWeekly) ||
      Array.from({ length: 7 }, (_, i) => i).some(
        (i) => !windowsValid(value.learningWeekly[i]),
      ))
  )
    throw new Error("A study-day window is invalid.");
  if (!record(value.learningDates)) throw new Error("The study-date rules are invalid.");
  for (const [date, rule] of Object.entries(value.learningDates)) {
    if (
      !validDate(date) ||
      !record(rule) ||
      (rule.windows !== undefined && !windowsValid(rule.windows)) ||
      (rule.capacity !== undefined && !capacityValid(rule.capacity)) ||
      (rule.closed !== undefined && typeof rule.closed !== "boolean")
    )
      throw new Error("The study-date rules are invalid.");
  }
  const clip = (windows) => windows.map(([a, b]) => [Math.max(a, value.dayStart), Math.min(b, value.dayEnd)]).filter(([a, b]) => a < b);
  for (const week of [value.weekly, value.learningWeekly].filter(Boolean))
    for (const weekday of Object.keys(week)) week[weekday] = clip(week[weekday]);
  for (const rules of [value.dates, value.learningDates]) for (const rule of Object.values(rules)) {
    if (rule.windows) rule.windows = clip(rule.windows);
    if (rule.dayEnd != null) rule.dayEnd = Math.min(rule.dayEnd, value.dayEnd);
    if (rules === value.learningDates && rule.capacity !== undefined) rule.capacity = rule.capacity === null ? value.learningCapacity : Math.min(rule.capacity, value.learningCapacity);
  }
  return value;
}

export function freshWorkspace() {
  return {
    version: 2,
    revision: 0,
    profileId: uid(),
    personal: { days: {}, settings: defaults(), daySettings: {}, undo: null },
    demo: { days: {}, settings: defaults(), daySettings: {}, undo: null },
    ui: { mode: "personal", date: null },
  };
}

export function normalizeWorkspace(input) {
  if (
    !record(input) ||
    input.version !== 2 ||
    !Number.isInteger(input.revision) ||
    input.revision < 0 ||
    typeof input.profileId !== "string" ||
    !input.profileId
  )
    throw new Error("The saved data version or ID is invalid.");
  const result = clone(input);
  for (const mode of ["personal", "demo"]) {
    const data = result[mode];
    if (!record(data)) throw new Error("The personal or example schedule format is invalid.");
    // Imports, saves and reloads share this boundary. Reject malformed queue
    // containers before they can reach array-based rendering or sync readers.
    const queue = data.calendar?.syncQueue;
    if (queue !== undefined && (
      !record(queue) || !Array.isArray(queue.jobs) ||
      queue.jobs.some((job) => !record(job) || !Array.isArray(job.items) ||
        job.items.some((item) => !record(item))) ||
      !Number.isSafeInteger(queue.nextId) || queue.nextId < 1
    )) throw new Error("Invalid sync queue format");
    data.days = normalizeDays(data.days);
    pruneSyncHistory(data);
    validateDependencyGraph(data.days);
    data.settings = normalizeSettings(data.settings);
    data.daySettings ||= {};
    if (!record(data.daySettings)) throw new Error("The daily settings format is invalid.");
    for (const [date, settings] of Object.entries(data.daySettings)) {
      if (!validDate(date)) throw new Error("A daily-settings date is invalid.");
      data.daySettings[date] = normalizeSettings({
        ...data.settings,
        ...settings,
        // Per-day rules cannot reopen midnight or remove the personal hard
        // limits. Tighter explicit day rules are retained.
        dayStart: Math.max(data.settings.dayStart, settings.dayStart ?? data.settings.dayStart),
        dayEnd: Math.min(data.settings.dayEnd, settings.dayEnd ?? data.settings.dayEnd),
        timeZone: data.settings.timeZone,
        learningCapacity: settings.learningCapacity == null ? data.settings.learningCapacity : Math.min(data.settings.learningCapacity, settings.learningCapacity),
        learningMinGap: Math.max(data.settings.learningMinGap, settings.learningMinGap ?? data.settings.learningMinGap),
      });
    }
  }
  if (
    !record(result.ui) ||
    !["personal", "demo"].includes(result.ui.mode) ||
    (result.ui.date !== null && !validDate(result.ui.date))
  )
    throw new Error("The display settings are invalid.");
  return result;
}

/** Atomic single-key writes with optimistic concurrency; corrupt reads are read-only. */
export class WorkspaceStore {
  constructor(storage) {
    this.storage = storage;
    this.state = freshWorkspace();
    this.raw = null;
    this.error = null;
    this.original = {};
    this.loaded = false;
  }
  _matchesCurrent(expectedRevision = this.state.revision, expectedRaw = this.original[STORAGE_KEY]) {
    return expectedRevision === this.state.revision && this.storage.getItem(STORAGE_KEY) === expectedRaw;
  }
  _backup(reason, raw = this.raw, state = this.state) {
    let workspace;
    if (raw !== null) {
      // Validate before treating anything as a usable recovery point.
      workspace = JSON.parse(raw); normalizeWorkspace(workspace);
    } else workspace = clone(state);
    const snapshot = { version: 1, id: uid(), savedAt: new Date().toISOString(), reason,
      revision: workspace.revision };
    const previousRaw = JSON.stringify({ ...snapshot, [STORAGE_KEY]: JSON.stringify(publicData(workspace)) });
    this.storage.setItem(PREVIOUS_KEY, previousRaw);
    this.storage.setItem(RECOVERY_KEY, JSON.stringify({ ...snapshot,
      workspaceRef: PREVIOUS_KEY, sourceId: recoveryId(PREVIOUS_KEY, previousRaw) }));
    return snapshot;
  }
  _recoveryDetails(key, raw) {
    const input = JSON.parse(raw);
    let workspace, reason = input.reason || "Before an earlier import", savedAt = input.savedAt || null;
    let sourceKey = key;
    if (key === RECOVERY_KEY) {
      if (input.workspace) workspace = input.workspace;
      else if (input.workspaceRef === PREVIOUS_KEY) {
        const sourceRaw = this.storage.getItem(PREVIOUS_KEY);
        if (!sourceRaw || recoveryId(PREVIOUS_KEY, sourceRaw) !== input.sourceId)
          throw new Error("The recovery point’s contents have changed.");
        const previous = JSON.parse(sourceRaw);
        workspace = JSON.parse(previous[STORAGE_KEY]);
        sourceKey = PREVIOUS_KEY;
      } else throw new Error("The recovery-point format is invalid.");
    } else if (input[STORAGE_KEY]) workspace = JSON.parse(input[STORAGE_KEY]);
    else throw new Error("The recovery point contains no recognized schedule.");
    return { workspace, reason, savedAt, sourceKey };
  }
  _preserveRecoveryInline() {
    // A corrupt original needs the previous key for its exact bad raw. Move the
    // one valid rollback payload inline before reusing it.
    for (const key of [RECOVERY_KEY, PREVIOUS_KEY]) {
      const raw = this.storage.getItem(key);
      if (!raw) continue;
      let details;
      try { details = this._recoveryDetails(key, raw); normalizeWorkspace(details.workspace); }
      catch { continue; }
      this.storage.setItem(RECOVERY_KEY, JSON.stringify({ version: 1, id: uid(),
        savedAt: details.savedAt, reason: details.reason, revision: details.workspace.revision,
        workspace: publicData(details.workspace) }));
      return;
    }
  }
  load() {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      this.original = { [STORAGE_KEY]: raw };
      if (this.loaded && raw === this.raw && !this.error) return this.state;
      this.state = raw === null ? normalizeWorkspace(freshWorkspace()) : normalizeWorkspace(JSON.parse(raw));
      this.raw = raw;
      this.loaded = true;
      this.error = null;
    } catch (error) {
      this.error = `Read failed: ${error.message} The original data is retained and saving is paused. Export a backup or read again.`;
    }
    return this.state;
  }
  save(mutator, expectedRevision = this.state.revision) {
    if (this.error) return { ok: false, code: "readonly", message: this.error };
    try {
      if (this.storage.getItem(STORAGE_KEY) !== this.raw) {
        this.load();
        return {
          ok: false,
          code: "stale",
          message: "Another page updated the schedule. The old preview has expired; check it again.",
        };
      }
      if (expectedRevision !== this.state.revision)
        return {
          ok: false,
          code: "stale",
          message: "The schedule changed after this preview. Calculate it again.",
        };
      const draft = clone(this.state);
      mutator(draft);
      draft.revision++;
      const normalized = normalizeWorkspace(draft);
      const raw = JSON.stringify(normalized);
      this._backup("Before saving changes");
      if (!this._matchesCurrent(expectedRevision, this.raw)) {
        this.load();
        return { ok: false, code: "stale", message: "Another page updated the schedule while saving. It was not overwritten; check it again." };
      }
      this.storage.setItem(STORAGE_KEY, raw);
      this.raw = raw;
      this.state = normalized;
      this.original = { [STORAGE_KEY]: raw };
      return { ok: true, state: this.state };
    } catch (error) {
      return {
        ok: false,
        code: "save_failed",
        message: `Save failed; the changes did not take effect: ${error.name === "QuotaExceededError" ? "The browser’s storage is full" : error.message}.`,
      };
    }
  }
  exportData() {
    return this.error
      ? { format: "shunri-raw-recovery", original: this.original }
      : {
          format: "shunri-backup",
          savedAt: new Date().toISOString(),
          workspace: publicData(clone(this.state)),
        };
  }
  recoveryCandidates() {
    const candidates = [];
    const offeredSources = new Set();
    for (const key of [RECOVERY_KEY, PREVIOUS_KEY]) {
      try {
        const raw = this.storage.getItem(key);
        if (!raw) continue;
        const { workspace, reason, savedAt, sourceKey } = this._recoveryDetails(key, raw);
        if (offeredSources.has(sourceKey)) continue;
        const normalized = normalizeWorkspace(workspace);
        candidates.push({ id: recoveryId(key, raw), key, savedAt, reason,
          revision: normalized.revision, taskCount: Object.values(normalized.personal.days).flat().length });
        offeredSources.add(sourceKey);
      } catch { /* A corrupt snapshot is never offered as a successful backup. */ }
    }
    return candidates;
  }
  restoreRecovery(idOrOptions = null, options = {}) {
    if (record(idOrOptions)) options = { ...idOrOptions, ...options };
    else if (typeof idOrOptions === "number") options.expectedRevision = idOrOptions;
    else if (typeof idOrOptions === "string") options.id = idOrOptions;
    const candidate = this.recoveryCandidates().find((item) => !options.id || item.id === options.id);
    if (!candidate) return { ok: false, code: "recovery_missing", message: "The recovery point changed or is no longer available. Check again." };
    try {
      const raw = this.storage.getItem(candidate.key);
      if (raw === null || recoveryId(candidate.key, raw) !== candidate.id)
        return { ok: false, code: "recovery_missing", message: "The recovery point changed after confirmation. Check again." };
      const { workspace } = this._recoveryDetails(candidate.key, raw);
      return this.restore({ workspace }, options);
    } catch (error) { return { ok: false, code: "restore_failed", message: "Restore did not take effect: " + error.message }; }
  }
  restore(
    input,
    {
      expectedRaw = this.original[STORAGE_KEY],
      expectedRevision = this.state.revision,
    } = {},
  ) {
    try {
      let workspace = input.workspace || input;
      if (input.format === "shunri-raw-recovery") {
        if (
          input.original?.[STORAGE_KEY] !== null &&
          input.original?.[STORAGE_KEY] !== undefined
        )
          workspace = JSON.parse(input.original[STORAGE_KEY]);
        else throw new Error("The recovery file contains no recognized schedule data.");
      }
      const normalized = normalizeWorkspace(workspace);
      const snapshot = { [STORAGE_KEY]: this.storage.getItem(STORAGE_KEY) };
      if (
        expectedRevision !== this.state.revision ||
        snapshot[STORAGE_KEY] !== expectedRaw
      ) {
        this.load();
        return {
          ok: false,
          message: "The data changed during import confirmation. Preview the import again.",
        };
      }
      if (snapshot[STORAGE_KEY] !== this.original[STORAGE_KEY]) {
        this.load();
        return { ok: false, message: "Another page updated the data. Import it again." };
      }
      // Corrupt raw values remain exportable, but do not replace the last valid
      // recovery point. No automatic restoration occurs on load failure.
      if (this.error) {
        this._preserveRecoveryInline();
        this.storage.setItem(PREVIOUS_KEY, JSON.stringify(snapshot));
      }
      else this._backup("Before import or restore");
      if (!this._matchesCurrent(expectedRevision, expectedRaw)) {
        this.load();
        return { ok: false, code: "stale", message: "Another page updated the schedule during restore. The newer schedule was not overwritten." };
      }
      normalized.revision =
        Math.max(normalized.revision, this.state.revision) + 1;
      const raw = JSON.stringify(normalized);
      this.storage.setItem(STORAGE_KEY, raw);
      this.state = normalized;
      this.raw = raw;
      this.error = null;
      this.loaded = true;
      this.original = { [STORAGE_KEY]: raw };
      return { ok: true, state: normalized };
    } catch (error) {
      return { ok: false, message: `Import did not take effect: ${error.message}` };
    }
  }
}

function validateDependencyGraph(days) {
  const tasks = Object.values(days).flat(),
    map = new Map();
  for (const task of tasks) {
    for (const id of [task.id, task.uid].filter(Boolean)) {
      if (map.has(id) && map.get(id) !== task)
        throw new Error("A task ID conflicts with another stable ID.");
      map.set(id, task);
    }
  }
  const visited = new Set(),
    visiting = new Set();
  function visit(task) {
    if (visiting.has(task))
      throw new Error("A dependency cycle exists. Correct it before importing or saving.");
    if (visited.has(task)) return;
    visiting.add(task);
    for (const dep of task.dependencies || []) {
      const parent = map.get(dep.id);
      if (!parent) throw new Error(`A prerequisite for ${task.title} is missing.`);
      if (parent === task) throw new Error(`${task.title} cannot depend on itself.`);
      if (parent.deferred && !task.deferred)
        throw new Error(`A prerequisite for ${task.title} is deferred.`);
      visit(parent);
    }
    visiting.delete(task);
    visited.add(task);
  }
  tasks.forEach(visit);
}
