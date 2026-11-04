import { WorkspaceStore, defaults, normalizeWorkspace } from "./storage.js";
import { adjustmentRecord, undoAdjustment, validateMutation } from "./workflow.js";
import { isActivity } from "./planner.js";
import { addDays, today, wallInstant, validDate } from "./time.js";
import { parseTime, formatTime } from "./scheduler.js";
import {
  moveIntent,
  validateIntentDays as validatePlan,
} from "./intent-planner.js";
import {
  learningTask,
  normalizeLearningDays,
} from "./learning.js";
import {
  mergeCalendar,
  classifyCalendar,
  calendarRuleMatches,
  localCalendarSignature,
  canManageCalendarSource,
} from "./calendar-data.js";
import {
  enqueueChanges,
  pendingTasks,
  settleSync,
  markSyncing,
  syncResumeProposal,
  resumeSync,
  syncPresentation,
} from "./sync-queue.js";
import { createWorkbench, applyDefaultRules } from "./workbench.js";
import { presentError } from "./ui-messages.js";
import { needsCalendarCoverage, archivedTasks, proposeRestore } from "./schedule-context.js";
import { lockManualMove } from "./task-attributes.js";
import {
  interpretCalendar,
  interpretationSummary,
  ambiguousDecisions,
  applySemanticDecision,
  semanticCorrectionChoices,
} from "./calendar-semantics.js";
const $ = (id) => document.getElementById(id);
// Keep the service name readable if a local icon fails, without a broken-image glyph.
document.querySelectorAll("img").forEach((img) => {
  const hide = () => {
    img.style.visibility = "hidden";
  };
  img.addEventListener("error", hide);
  if (img.complete && !img.naturalWidth) hide();
});
const entryParams = new URLSearchParams(location.search);
if (entryParams.get("shunriOrigin") === "ip") {
  // Keep this outside the transient notice and workbench render regions.
  const hint = document.createElement("p");
  hint.id = "wb-origin-notice";
  hint.className = "reading-note";
  hint.textContent = "localhost and 127.0.0.1 keep separate browser schedules. Your schedule at the old address has not been copied or deleted. An empty schedule here does not mean it is lost. To transfer it, import an existing JSON backup in Backup and restore.";
  const recovery = document.createElement("a");
  const recoveryUrl = new URL(location.origin);
  recoveryUrl.hostname = "127.0.0.1";
  recoveryUrl.pathname = "/ip-recovery";
  recovery.href = recoveryUrl.href;
  recovery.textContent = "No backup? Download the original data from the old address";
  hint.append(" ", recovery);
  $("workbench").before(hint);
}
const store = new WorkspaceStore(localStorage);
store.load();
let bench = null;
let state = store.state,
  mode = state.ui.mode,
  date = state.ui.date || today(data().settings.timeZone),
  proposal = null,
  calendarStatus = null,
  syncBusy = false,
  lastActionError = "",
  readingCalendar = false,
  calendarReadError = "",
  readTimers = null,
  calendarReadWaiters = [],
  calendarRetryAttempts = 0,
  calendarRetryTimer = null,
  syncRetryTimer = null;
const EXAMPLE_DATE = "2026-10-12";
let syncGeneration = 0,
  syncRequestedGeneration = null;
function data() {
  return state[mode];
}
function all(days = data().days) {
  return Object.keys(days)
    .sort()
    .flatMap((date) => (days[date] || []).map((task) => ({ date, task })));
}
function find(id) {
  return all().find((e) => e.task.id === id || e.task.uid === id);
}
function movable(task) {
  return (
    !task.done &&
    !task.locked &&
    !task.timeLocked &&
    !task.externalReadOnly &&
    !task.calendarConflict &&
    !task.deferred &&
    !isActivity(task)
  );
}
function notice(text, error = false) {
  $("wb-notice").hidden = !text;
  $("wb-notice").textContent = text;
  $("wb-notice").className = error ? "error" : "saved-feedback";
  $("wb-notice").dataset.kind = error ? "error" : "info";
}
function actionError(message) {
  lastActionError = message;
  notice(message, true);
}
function clearWorkbenchNotice() {
  if ($("wb-notice").dataset.kind !== "error") notice("");
}
function save(mutator, revision = state.revision) {
  const result = store.save((s) => {
    mutator(s);
    s.ui.dayAtOpen = today(s[s.ui.mode].settings.timeZone);
  }, revision);
  state = store.state;
  mode = state.ui.mode;
  if (!result.ok) {
    notice(result.message, true);
    render();
    return false;
  }
  render();
  return true;
}
function saveDays(
  days,
  label,
  revision = state.revision,
  settings = data().settings,
  adjustmentContext = null,
  allowRuleConflicts = false,
) {
  const before = data();
  const check = validateMutation(before.days, days, before.settings, settings);
  if (!allowRuleConflicts && check.status !== "ok") { notice(check.conflicts[0].message, true); return false; }
  return save((s) => {
    const branch = s[mode];
    branch.undo = adjustmentRecord(
      before.days,
      days,
      before.daySettings,
      branch.daySettings,
      label,
      before.settings,
    );
    if (adjustmentContext) branch.undo.presentation = structuredClone(adjustmentContext);
    // The first-use guide stays hidden for good after one saved change.
    s.ui.rescheduledOnce = true;
    if (JSON.stringify(before.settings) !== JSON.stringify(settings))
      branch.undo.globalSettings = {
        before: structuredClone(before.settings),
        after: structuredClone(settings),
      };
    branch.days = days;
    branch.settings = settings;
    if (mode === "personal")
      s.personal = enqueueChanges(branch, before.days, days, {
        profileId: s.profileId,
        targetCalendarId: branch.calendar?.targetCalendarId,
        autoSync: branch.calendar?.autoSync,
      });
  }, revision);
}
const currentDay = today(data().settings.timeZone);
if (
  state.ui.dayAtOpen &&
  state.ui.dayAtOpen !== currentDay &&
  date === state.ui.dayAtOpen
)
  date = currentDay;
function render() {
  state = store.state;
  bench?.render();
  if (store.error) notice(store.error, true);
}
function demoOrigin() {
  return data().exampleOrigin || EXAMPLE_DATE;
}
function demoData() {
  const day = EXAMPLE_DATE,
    id = () => crypto.randomUUID();
  const make = (title, start, duration, extra = {}) => ({
    id: id(),
    uid: id(),
    title,
    start,
    duration,
    rest: 15,
    done: false,
    locked: false,
    deferred: false,
    type: "task",
    counted: false,
    dependencies: [],
    bufferBefore: 60,
    bufferAfter: 60,
    ...extra,
  });
  const meta = (letter, order) => ({
    tags: ["study"],
    planId: "example-study",
    packageId: "demo-package-" + letter,
    packageOrder: order,
    packageOriginDate: addDays(day, order),
    packageTaskOrder: 0,
  });
  const done = make("SQL · ROW_NUMBER lesson (completed)", 600, 30, {
    ...meta("A", 0),
    done: true,
    doneAt: day + "T17:30:00Z",
    completedDate: day,
    rest: 0,
  });
  const a = make("SQL practice · ROW_NUMBER", 660, 45, {
    ...meta("A", 0),
    packageTaskOrder: 1,
    dependencies: [{ id: done.id, gap: 0 }],
  });
  const b = make("Python practice · lists and loops", 660, 60, {
    ...meta("B", 1),
    dependencies: [{ id: a.id, gap: 0 }],
  });
  const c = make("Study review · organize this week’s notes", 660, 60, {
    ...meta("C", 2),
    dependencies: [{ id: b.id, gap: 0 }],
  });
  const fixed = make("Badminton · fixed event", 1020, 60, {
    type: "activity",
    locked: true,
    counted: false,
    rest: 0,
  });
  const settings = defaults();
  settings.weekly = Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [i, [[540, 1380]]]),
  );
  settings.learningCapacity = 150;
  settings.learningWeekly = structuredClone(settings.weekly);
  settings.learningDates[addDays(day, 2)] = { closed: true };
  // C originally occupies a later learning day. Third day is a holiday in both before/after.
  c.packageOriginDate = addDays(day, 3);
  return {
    days: {
      [day]: [done, a, fixed],
      [addDays(day, 1)]: [b],
      [addDays(day, 3)]: [c],
    },
    settings,
    daySettings: {},
    undo: null,
    exampleOrigin: day,
  };
}
function switchMode(next) {
  const ok = save((s) => {
    if (next === "demo" && s.ui.mode !== "demo")
      s.ui.personalDateBeforeDemo = s.ui.date;
    if (
      next === "demo" &&
      (!Object.keys(s.demo.days).length || !s.demo.exampleOrigin)
    )
      s.demo = demoData();
    s.ui.mode = next;
    s.ui.date =
      next === "demo"
        ? s.demo.exampleOrigin || EXAMPLE_DATE
        : s.ui.personalDateBeforeDemo || today(s[next].settings.timeZone);
    if (next === "personal") delete s.ui.personalViewBeforeDemo;
  });
  if (!ok) return false;
  date = state.ui.date;
  mode = state.ui.mode;
  render();
  return true;
}
function confirm(title, description, action) {
  bench.confirm(title, description, () => void action());
}
function changeList(before, after) {
  const entries = Object.keys(before).flatMap((date) =>
    before[date].map((task) => ({ date, task })),
  );
  return Object.keys(after)
    .flatMap((date) =>
      after[date].map((task) => {
        const old = entries.find((e) => e.task.id === task.id);
        return !old ||
          old.date !== date ||
          JSON.stringify(old.task) !== JSON.stringify(task)
          ? {
              id: task.id,
              title: task.title,
              from: {
                date: old?.date || "Add",
                start: old?.task.start ?? task.start,
                duration: old?.task.duration ?? task.duration,
              },
              to: { date, start: task.start, duration: task.duration },
              rest: task.rest,
              reason: "Change task",
            }
          : null;
      }),
    )
    .filter(Boolean);
}
function removeTask(e) {
  const entry = find(e.task.id);
  if (!entry) return;
  const id = entry.task.id,
    dependents = all().filter((x) =>
      x.task.dependencies.some((d) => d.id === id || d.id === entry.task.uid),
    );
  confirm(
    "Delete: " + entry.task.title,
    dependents.length
      ? "Prerequisite links will be removed from these tasks: " +
          dependents.map((x) => x.task.title).join(", ") +
          ". The tasks stay in place. Google events will not be deleted."
      : "Delete the local task. You can undo this. Google events will not be deleted.",
    () => {
      const days = structuredClone(data().days);
      days[entry.date] = days[entry.date].filter((t) => t.id !== id);
      for (const tasks of Object.values(days))
        for (const t of tasks)
          t.dependencies = t.dependencies.filter(
            (d) => d.id !== id && d.id !== entry.task.uid,
          );
      saveDays(days, "Delete task");
    },
  );
}

async function calculateMove(taskId, targetDate, targetStart, rebuild = null, intent = {}) {
  const requestedMode = mode,
    readSince = Date.now(),
    warnings = [];
  let settings = structuredClone(data().settings);
  const conflict = (message) => ({
    status: "conflict",
    days: structuredClone(data().days),
    changes: [],
    conflicts: [{ ids: [taskId], message }],
    unscheduled: [],
  });
  const covered = (from, to, fresh = false) =>
    (data().calendar?.readRanges || []).some(
      (r) =>
        !r.partial &&
        r.timeZone === settings.timeZone &&
        r.from <= from &&
        r.to >= to &&
        (!fresh || Date.parse(r.loadedAt) >= readSince),
    );
  const checkRange = async (from, to) => {
    const read = await readCalendar(targetDate, {
      required: true,
      force: true,
      rangeFrom: from,
      rangeTo: to,
    });
    if (read?.ok && read.complete) return null;
    if (covered(from, to) && !read?.complete && !read?.ok) {
      if (!warnings.length)
        warnings.push(
          "The latest Calendar data is unavailable offline. This preview uses a fully read schedule snapshot. Confirmation saves locally; sync waits for reconnection and a fresh conflict check. Unread dates cannot be scheduled.",
        );
      return null;
    }
    return (
      "Could not fully check " +
      from +
      " — " +
      to +
      " in Google Calendar: " +
      (read?.message || "Read incomplete") +
      ". The original schedule has not moved. Unknown time cannot be treated as free."
    );
  };
  const needsCalendar = needsCalendarCoverage({ branch: data(), mode, calendarStatus });
  if (needsCalendar) {
    // Unsaved editor tasks belong to the rebuilt intent too. They must pass
    // the same necessary catalogue check before any next-date alternative.
    const intentEntries = all(rebuild ? rebuild(structuredClone(data().days)) : data().days);
    const source = intentEntries.find((e) => e.task.id === taskId);
    if (
      source &&
      learningTask(source.task) &&
      source.task.planId === "job-prepare"
    ) {
      const available = await calendarRequest("calendars");
      const calendars = new Set(
        (available.calendars || [])
          .filter((c) => c.accessRole === "owner")
          .map((c) => c.id),
      );
      for (const e of intentEntries.filter(
        (e) =>
          learningTask(e.task) &&
          e.task.planId === source.task.planId &&
          e.task.calendarSource?.accessRole === "owner",
      ))
        if (e.task.calendarLink?.calendarId)
          calendars.add(e.task.calendarLink.calendarId);
      if (source.task.calendarLink?.calendarId)
        calendars.add(source.task.calendarLink.calendarId);
      const earliest =
        intentEntries
          .filter(
            (e) => learningTask(e.task) && e.task.planId === source.task.planId,
          )
          .map((e) => e.date)
          .sort()[0] || source.date;
      for (const calendarId of calendars) {
        const catalog = await readCalendar(targetDate, {
          force: true,
          catalog: true,
          calendarId,
          rangeFrom: addDays(earliest, -1),
          rangeTo: addDays(earliest, 3650),
        });
        if (mode !== requestedMode || intent.isCurrent?.() === false) return null;
        if (!catalog?.ok || !catalog.complete)
          return conflict(
            "Could not fully read the remaining study catalog: " +
              (catalog?.message || "Read incomplete") +
              ". The original plan has not moved. Unloaded future study tasks must not be omitted.",
          );
      }
    }
    for (const day of [
      ...new Set([source?.date, targetDate].filter(Boolean)),
    ]) {
      const message = await checkRange(addDays(day, -1), addDays(day, 1));
      if (mode !== requestedMode || intent.isCurrent?.() === false) return null;
      if (message) return conflict(message);
    }
    settings = structuredClone(data().settings);
  }
  for (let pass = 0; pass < 20; pass++) {
    if (mode !== requestedMode || intent.isCurrent?.() === false) return null;
    const days = rebuild ? rebuild(structuredClone(data().days)) : data().days;
    const result = moveIntent(days, settings, {
      taskId,
      targetDate,
      targetStart,
      startFromNow: intent.startFromNow === true,
    });
    result.warnings = warnings;
    if (result.status !== "ok" || !needsCalendar) return result;
    const from = addDays(targetDate, -1),
      to = addDays(result.summary?.lastDate || targetDate, 1);
    if (covered(from, to, !warnings.length)) return result;
    const message = await checkRange(from, to);
    if (message) return conflict(message);
    settings = structuredClone(data().settings);
  }
  return conflict(
    "New Calendar events keep expanding the affected range, so a fully checked proposal is not available yet. The original schedule has not moved. Refresh Calendar and try again.",
  );
}
function confirmProposal() {
  const p = proposal;
  if (!p) return;
  if (p.mode !== mode || p.revision !== state.revision) {
    notice("This preview is out of date. Calculate it again.", true);
    return;
  }
  if (!p.allowRuleConflicts) {
    const check = validateMutation(data().days, p.semanticBranch?.days || p.result.days || data().days, data().settings, p.semanticBranch?.settings || p.settings || data().settings);
    if (check.status !== "ok") { notice(check.conflicts[0].message, true); return; }
  }
  const ok = p.semanticBranch
    ? save((s) => {
        const before = s[mode],
          next = structuredClone(p.semanticBranch);
        next.undo = adjustmentRecord(
          before.days,
          next.days,
          before.daySettings,
          next.daySettings,
          "Correct purpose",
          before.settings,
          { captureSemantic: true },
        );
        next.undo.globalSettings = {
          before: structuredClone(before.settings),
          after: structuredClone(next.settings),
        };
        next.undo.semanticMetadata = Object.fromEntries(
          ["semanticDecisions", "semanticCorrections", "semanticPackages"].map(
            (key) => [
              key,
              {
                before: structuredClone(before.calendar?.[key] || {}),
                after: structuredClone(next.calendar?.[key] || {}),
              },
            ],
          ),
        );
        s[mode] = next;
        s.ui.rescheduledOnce = true;
      }, p.revision)
    : saveDays(p.result.days || data().days, p.label, p.revision, p.settings, p.adjustmentContext, p.allowRuleConflicts);
  if (ok) {
    proposal = null;
    notice(
      mode === "demo"
        ? "Example saved. No real Calendar sync occurred."
        : "Saved locally. You can undo the latest adjustment.",
    );
    void runSyncQueue();
  }
}
function undoLast() {
  const semanticOnly = Boolean(data().undo?.semanticMetadata);
  const result = undoAdjustment(data());
  if (!result.ok) return notice(result.message, true);
  const before = structuredClone(data().days);
  if (
    save((s) => {
      s[mode] = result.data;
      if (mode === "personal" && !semanticOnly)
        s.personal = enqueueChanges(s.personal, before, result.data.days, {
          profileId: s.profileId,
          targetCalendarId: s.personal.calendar?.targetCalendarId,
          autoSync: s.personal.calendar?.autoSync,
        });
    })
  ) {
    notice(mode === "demo" ? "The original example schedule is restored. Your personal schedule is unchanged." : "Adjustment undone. If auto-sync is enabled, the restored times join the same sync queue.");
    void runSyncQueue();
  }
};
function downloadBackup(value, name = "Shunri-backup") {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
      type: "application/json",
    }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name + "-" + date + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importBackup(file) {
  try {
    if (file.size > 5e6) throw new Error("Backups larger than 5 MB are not supported.");
    const input = JSON.parse(await file.text());
    const importExpected = {
      expectedRaw: store.original["shunri.workspace.v2"],
      expectedRevision: state.revision,
    };
    confirm(
      "Replace all local data",
      "This replaces personal and example data and their rules. The original data is backed up in this browser first. Only complete Shunri JSON backups are supported; data is not merged.",
      () => {
        const result = store.restore(input, importExpected);
        state = store.state;
        if (result.ok) {
          mode = state.ui.mode;
          date = state.ui.date || today(data().settings.timeZone);
          bench.home();
          render();
          notice("Backup imported and saved.");
        } else actionError(result.message);
      },
    );
  } catch (error) {
    actionError(error.message);
  }
}
// Presentation-only saves can advance a draft revision without certifying new
// scheduling/semantic evidence. This is separate from syncPreviewValidity.
function proposalBasis(branch) {
  return JSON.stringify({days:branch.days,settings:branch.settings,daySettings:branch.daySettings,
    calendar:Object.fromEntries(Object.entries(branch.calendar || {}).filter(([key])=>key !== 'syncQueue'))});
}
window.addEventListener("storage", (e) => {
  if (e.key === "shunri.workspace.v2") {
    const before = bench?.lifecycle(), hadProposal = Boolean(proposal), oldMode = mode, oldBasis = proposalBasis(data()), oldBranch = proposal?.semanticBranch ? JSON.stringify(data()) : null;
    invalidateSync();
    store.load();
    state = store.state;
    mode = state.ui.mode;
    const retained = hadProposal && mode === oldMode && !store.error && oldBasis === proposalBasis(data()) && (!oldBranch || oldBranch === JSON.stringify(data()));
    if (mode !== oldMode || oldBasis !== proposalBasis(data())) bench?.invalidatePending?.();
    if (retained) proposal.revision = state.revision;
    else proposal = null;
    render();
    if (store.error) return notice(store.error, true);
    if ($("wb-notice").dataset.kind === "error") return;
    const view = bench?.lifecycle();
    const switched = before?.mode !== view?.mode;
    const changed = !switched && before?.scheduleKey !== view?.scheduleKey;
    if (!switched && !changed) {
      clearWorkbenchNotice();
      return;
    }
    notice(view?.kind === "pending" && view.stale
      ? switched ? "Another tab switched schedules. Check the pending preview again." : changed ? "Another tab changed the schedule. The pending preview is out of date; check it again." : "Browsing or status updates from another tab have loaded. Check the pending preview again."
      : view?.kind === "result"
        ? switched ? "The schedule switch from another tab has loaded. This saved adjustment remains a read-only record." : changed ? "The schedule update from another tab has loaded. This adjustment is saved, and its details remain a record of that adjustment." : "Browsing or status updates from another tab have loaded. This saved adjustment remains a read-only record."
        : switched ? "The schedule switch from another tab has loaded." : changed ? "The schedule update from another tab has loaded." : "Browsing or status updates from another tab have loaded.");
  }
});

async function calendarRequest(path, body) {
  const response = await fetch("/api/calendar/" + path, {
    signal: AbortSignal.timeout(path.startsWith("events") ? 60000 : 45000),
    method: body ? "POST" : "GET",
    headers: body
      ? {
          "Content-Type": "application/json",
          "X-Shunri-CSRF": calendarStatus?.csrfToken || "",
        }
      : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "Calendar request failed.");
  return value;
}
function renderCalendarState() {
  bench?.refreshStatus();
}
async function refreshCalendar() {
  try {
    calendarStatus = await calendarRequest("status");
  } catch (error) {
    calendarStatus = { state: "network", message: error.message };
  }
  renderCalendarState();
}
function scheduleCalendarRead(day = date) {
  clearTimeout(readTimers);
  if (mode !== "personal") return;
  readTimers = setTimeout(() => void readCalendar(day), 250);
}
const ruleMatches = calendarRuleMatches;
async function acceptManaged(branch, rules) {
  const entries = all(branch.days).filter(
    (e) =>
      e.task.calendarLink?.source === "google" &&
      !e.task.calendarConflict &&
      !e.task.done &&
      !e.task.calendarSource?.allDay &&
      e.task.duration <= 1440 &&
      canManageCalendarSource(e.task.calendarSource) &&
      e.task.calendarClassification?.manage !== false &&
      rules.find((r) => ruleMatches(e.task, r))?.manage !== false &&
      (!e.task.calendarLink.managed ||
        e.task.calendarLink.adoptedEtag !== e.task.calendarLink.etag) &&
      (rules.find((r) => ruleMatches(e.task, r))?.manage ||
        (learningTask(e.task) &&
          branch.calendar?.semanticManagedPlans?.includes(e.task.planId))) &&
      rules.find((r) => ruleMatches(e.task, r))?.kind !== "fixed" &&
      e.task.calendarLink.localFingerprint ===
        localCalendarSignature(e.task, e.date, branch.settings.timeZone),
  );
  if (!entries.length) return { data: branch, failures: [] };
  const value = await calendarRequest("adopt", {
    mode: "personal",
    profileId: state.profileId,
    tasks: entries.map((e) => ({
      ...e.task,
      date: e.date,
      timeZone: branch.settings.timeZone,
    })),
  });
  for (const r of value.results || []) {
    const e = entries.find((e) => e.task.uid === r.uid);
    if (e && r.ok)
      e.task.calendarLink = {
        ...e.task.calendarLink,
        ...r.calendarLink,
        adoptedEtag: r.calendarLink.etag,
        localFingerprint: localCalendarSignature(
          e.task,
          e.date,
          branch.settings.timeZone,
        ),
      };
  }
  return {
    data: classifyCalendar(branch, { rules }).data,
    failures: (value.results || []).filter((r) => !r.ok),
  };
}
async function readCalendar(
  day = date,
  {
    force = false,
    initial = false,
    rangeFrom = null,
    rangeTo = null,
    required = false,
    catalog = false,
    calendarId = null,
  } = {},
) {
  if (mode === "personal" && !store.error && calendarStatus?.state === "storage_error" && calendarStatus.storageRetryable)
    await refreshCalendar();
  if (
    mode !== "personal" ||
    store.error ||
    calendarStatus?.state !== "connected"
  )
    return {
      ok: false,
      message: "Google events cannot be checked without a connection and writable local storage.",
    };
  if (readingCalendar) {
    await new Promise((resolve) => calendarReadWaiters.push(resolve));
    return readCalendar(day, {
      force,
      initial,
      rangeFrom,
      rangeTo,
      required,
      catalog,
      calendarId,
    });
  }
  const from = rangeFrom || addDays(day, initial ? -7 : -3),
    to = rangeTo || addDays(day, initial ? 35 : 14),
    zone = state.personal.settings.timeZone;
  if (
    !force &&
    !catalog &&
    (state.personal.calendar?.readRanges || []).some(
      (r) => r.from <= from && r.to >= to && !r.partial && r.timeZone === zone,
    ) &&
    !initial
  )
    return { ok: true, complete: true };
  const refreshView = bench?.captureCalendarRead();
  readingCalendar = true;
  calendarReadError = "";
  renderCalendarState();
  try {
    const params = { from, to, timeZone: zone };
    if (catalog) {
      params.purpose = "job-prepare-catalog";
      params.calendarId = calendarId;
    }
    const response = await calendarRequest(
      "events?" + new URLSearchParams(params),
    );
    if (
      catalog &&
      (!response.range?.catalog ||
        response.complete !== true ||
        response.partial ||
        !response.completedCalendarIds?.includes(calendarId))
    )
      throw Error("The study catalog was not fully read. Unread catalog dates are not treated as available time.");
    const mergeRevision = state.revision;
    // Rebase the data snapshot after the fetch, but retain the initiating view.
    const refreshSnapshot = bench?.captureCalendarRead(refreshView);
    let merged = mergeCalendar(state.personal, response, {
      profileId: state.profileId,
      timeZone: zone,
    });
    merged.data = interpretCalendar(merged.data, { date: day }).data;
    merged.data.calendar ||= {};
    const rangeKey = catalog ? "learningCatalogs" : "readRanges";
    merged.data.calendar[rangeKey] = [
      ...(merged.data.calendar[rangeKey] || []).slice(-19),
      {
        from,
        to,
        timeZone: zone,
        loadedAt: new Date().toISOString(),
        partial: Boolean(response.partial || merged.errors.length),
        ...(catalog ? { calendarId, catalog: true } : {}),
      },
    ];
    merged.data.calendar.calendars = catalog
      ? [
          ...new Map(
            [
              ...(merged.data.calendar.calendars || []),
              ...(response.calendars || []),
            ].map((c) => [c.id, c]),
          ).values(),
        ]
      : response.calendars || merged.data.calendar.calendars || [];
    const adopted = await acceptManaged(
      merged.data,
      merged.data.calendar.classificationRules || [],
    );
    const errors = [
      ...(response.errors || []),
      ...(merged.errors || []),
      ...adopted.failures,
    ];
    calendarReadError = errors
      .map((e) => (e.calendarName ? e.calendarName + ": " : "") + e.message)
      .join("; ");
    if (!save((s) => (s.personal = adopted.data), mergeRevision))
      throw Error("Calendar data was read, but the local save failed. Original data is preserved.");
    bench?.completeCalendarRead(refreshSnapshot, {
      complete: response.complete !== false && !response.partial && !errors.length,
    });
    if (merged.conflicts.length)
      notice(
        "Google Calendar and the local schedule have " +
          merged.conflicts.length +
          " conflicts. Neither version was overwritten. Choose a version in the Google Calendar panel.",
        true,
      );
    if (!response.partial && !merged.errors.length) {
      calendarRetryAttempts = 0;
      clearTimeout(calendarRetryTimer);
    } else
      scheduleCalendarRetry(day, {
        rangeFrom: from,
        rangeTo: to,
        catalog,
        calendarId,
      });
    return {
      ok: true,
      complete: !response.partial && !merged.errors.length,
      message: calendarReadError,
    };
  } catch (error) {
    calendarReadError = error.message;
    scheduleCalendarRetry(day, {
      rangeFrom: from,
      rangeTo: to,
      catalog,
      calendarId,
    });
    return { ok: false, complete: false, message: error.message };
  } finally {
    readingCalendar = false;
    const waiters = calendarReadWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
    renderCalendarState();
  }
}
function scheduleCalendarRetry(day, options = {}) {
  clearTimeout(calendarRetryTimer);
  if (calendarRetryAttempts >= 5 || mode !== "personal" || store.error) return;
  const wait = Math.min(60000, 2000 * 2 ** calendarRetryAttempts++);
  calendarRetryTimer = setTimeout(
    () => void readCalendar(day, { ...options, force: true }),
    wait,
  );
}
async function changeAutoSync(enabled) {
  const generation = invalidateSync();
  if (!enabled) {
    if (!save(s => {
      s.personal.calendar ||= {};
      s.personal.calendar.autoSync = false;
      s.personal.calendar.syncPreferenceEpoch = (s.personal.calendar.syncPreferenceEpoch || 0) + 1;
      s.personal.calendar.syncRetry = null;
    })) throw Error("Sync preferences were not saved. Try again.");
    return null;
  }
  await refreshCalendar();
  if (generation !== syncGeneration || mode !== "personal") throw Error("The schedule or sync settings changed. Review the catch-up scope again.");
  if (calendarStatus?.state !== "connected") throw Error("Connect your own Google Calendar before reviewing catch-up changes.");
  let target = state.personal.calendar?.targetCalendarId;
  if (!target) {
    const response = await calendarRequest("calendars");
    if (generation !== syncGeneration || mode !== "personal") throw Error("The schedule or sync settings changed. Review the catch-up scope again.");
    target = response.calendars.find(c => c.accessRole === "owner")?.id;
    if (!target) throw Error("No writable calendar owned by you was found. Auto-sync is still off.");
  }
  return { ...syncResumeProposal(state.personal, { targetCalendarId: target }), generation };
}
function confirmAutoSync(proposal) {
  if (mode !== "personal") throw Error("Sync settings changed. Review the catch-up scope again.");
  const resumed = resumeSync(state.personal, proposal, { profileId: state.profileId });
  if (resumed.status !== "ok") throw Error("The schedule or management eligibility changed. Go back and review the catch-up scope again.");
  invalidateSync();
  if (!save(s => { s.personal = resumed.data; })) throw Error("Sync preferences were not saved. Try again.");
  void runSyncQueue();
}
function resolveConflict(id, keepLocal) {
  const entry = all(state.personal.days).find((e) => e.task.id === id);
  if (!entry?.task.calendarConflict?.remote) return;
  const remote = entry.task.calendarConflict.remote;
  confirm(
    "Resolve conflicting versions",
    entry.task.title +
      ": " +
      (keepLocal
        ? "Keep the local time and use the current Google version as the sync baseline. Future writes still require sync to be enabled."
        : "Use the current Google time. Completed records will not move."),
    async () => {
      try {
        const revision = state.revision,
          branch = structuredClone(state.personal),
          current = all(branch.days).find((e) => e.task.id === id);
        const baselineTask = {
          ...current.task,
          title: remote.title,
          start: remote.start,
          duration: remote.duration,
          date: remote.date,
          timeZone: branch.settings.timeZone,
          calendarLink: { ...current.task.calendarLink, etag: remote.etag },
        };
        let managedLink = current.task.calendarLink;
        if (current.task.calendarLink.managed) {
          const response = await calendarRequest("adopt", {
            mode: "personal",
            profileId: state.profileId,
            tasks: [baselineTask],
          });
          if (!response.results?.[0]?.ok)
            throw Error(
              response.results?.[0]?.message || "Could not accept the current remote version.",
            );
          managedLink = { ...managedLink, ...response.results[0].calendarLink };
        }
        if (!keepLocal) {
          branch.days[current.date] = branch.days[current.date].filter(
            (t) => t.id !== id,
          );
          Object.assign(current.task, {
            title: remote.title,
            start: remote.start,
            duration: remote.duration,
            calendarSource: remote.calendarSource,
            calendarOccupation: remote.calendarOccupation,
          });
          (branch.days[remote.date] ||= []).push(current.task);
        }
        current.task.calendarLink = {
          ...managedLink,
          etag: remote.etag,
          localFingerprint: remote.localFingerprint,
        };
        delete current.task.calendarConflict;
        if (keepLocal && branch.calendar?.autoSync) {
          const baselineDays = structuredClone(branch.days),
            be = all(baselineDays).find((e) => e.task.id === id);
          baselineDays[be.date] = baselineDays[be.date].filter(
            (t) => t.id !== id,
          );
          (baselineDays[remote.date] ||= []).push(baselineTask);
          const queued = enqueueChanges(branch, baselineDays, branch.days, {
            profileId: state.profileId,
            targetCalendarId: branch.calendar.targetCalendarId,
            autoSync: true,
          });
          if (save((s) => (s.personal = queued), revision)) void runSyncQueue();
        } else save((s) => (s.personal = branch), revision);
      } catch (error) {
        actionError(error.message);
      }
    },
  );
}
function invalidateSync() {
  ++syncGeneration;
  syncRequestedGeneration = null;
  clearTimeout(syncRetryTimer);
  return syncGeneration;
}
function syncRangeValidity(ranges, from, to, zone) {
  const relevant = ranges.filter(
      (r) => r.timeZone === zone && r.from < to && r.to > from,
    ),
    boundaries = [
      ...new Set([
        from,
        to,
        ...relevant.flatMap((r) => [
          r.from < from ? from : r.from,
          r.to > to ? to : r.to,
        ]),
      ]),
    ].sort(),
    segments = [];
  for (let i = 0; i < boundaries.length - 1; ++i) {
    const start = boundaries[i],
      end = boundaries[i + 1],
      latest = relevant.findLast((r) => r.from <= start && r.to >= end),
      complete = latest ? !latest.partial : null,
      previous = segments.at(-1);
    if (previous && previous.complete === complete) previous.to = end;
    else segments.push({ from: start, to: end, complete });
  }
  return segments;
}
function syncCatalogValidity(snapshot) {
  const branch = state.personal,
    calendar = branch.calendar || {},
    plans = [
      ...new Set(snapshot.map((e) => e.task.planId).filter(Boolean)),
    ].sort(),
    zone = branch.settings.timeZone;
  return plans.flatMap((planId) => {
    const related = all(branch.days).filter((e) => e.task.planId === planId);
    if (!related.length) return [];
    const dates = related
        .flatMap((e) => [e.date, e.task.packageOriginDate].filter(Boolean))
        .sort(),
      ids = [
        ...new Set(
          [
            ...snapshot
              .filter((e) => e.task.planId === planId)
              .map(
                (e) =>
                  e.task.calendarLink?.calendarId || calendar.targetCalendarId,
              ),
            // Completed/unmoved packages in the same plan still establish its
            // directory and order, even when none of their tasks is queued.
            ...related
              .filter(
                (e) =>
                  e.task.calendarSource?.accessRole === "owner" ||
                  e.task.calendarLink?.managed === true ||
                  calendar.calendars?.some(
                    (c) =>
                      c.id === e.task.calendarLink?.calendarId &&
                      c.accessRole === "owner",
                  ),
              )
              .map((e) => e.task.calendarLink?.calendarId),
          ].filter(Boolean),
        ),
      ].sort();
    return ids.map((calendarId) => {
      const known = (calendar.syncCatalogRequirements || []).filter(
          (r) =>
            r.planId === planId &&
            r.calendarId === calendarId &&
            typeof r.timeZone === "string" &&
            typeof r.from === "string" &&
            typeof r.to === "string",
        ),
        from = [dates[0], ...known.map((r) => r.from)].sort()[0],
        to = [addDays(dates.at(-1), 1), ...known.map((r) => r.to)]
          .sort()
          .at(-1);
      return {
        planId,
        calendarId,
        timeZone: zone,
        from,
        to,
        // Changing the display/planning zone cannot forget that this source
        // needs a directory. Its completeness is still checked in the NEW
        // zone below; an old-zone complete read is never borrowed as evidence.
        required: known.length > 0,
        coverage: syncRangeValidity(
          (calendar.learningCatalogs || []).filter(
            (r) => r.calendarId === calendarId,
          ),
          from,
          to,
          zone,
        ),
      };
    });
  });
}
function rememberSyncCatalogRequirements(snapshot) {
  // These local read facts are not write permission or queue acknowledgements.
  // Plan/source scope survives retries, reloads and a newly confirmed job ID.
  const calendar = state.personal.calendar,
    previous = calendar.syncCatalogRequirements || [],
    next = structuredClone(previous);
  for (const scope of syncCatalogValidity(snapshot)) {
    if (!scope.coverage.every((r) => r.complete === true)) continue;
    const index = next.findIndex(
        (r) =>
          r.planId === scope.planId &&
          r.calendarId === scope.calendarId &&
          r.timeZone === scope.timeZone,
      ),
      record = {
        planId: scope.planId,
        calendarId: scope.calendarId,
        timeZone: scope.timeZone,
        from: scope.from,
        to: scope.to,
      };
    if (index < 0) next.push(record);
    else next[index] = record;
  }
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  if (
    !save((s) => {
      s.personal.calendar.syncCatalogRequirements = next;
    })
  )
    throw Error("Could not save the study-catalog read evidence. Nothing was sent. Try again.");
}
function requireSyncCatalogCompleteness(snapshot) {
  if (
    syncCatalogValidity(snapshot).some((c) =>
      c.coverage.some(
        (r) => r.complete === false || (c.required && r.complete !== true),
      ),
    )
  )
    throw Error(
      "The related study catalog is incomplete or a required catalog is missing. Nothing was written. Preview this study adjustment again to read the complete catalog, then retry sync. Unread time cannot be treated as free.",
    );
}
function syncPreviewValidity(snapshot) {
  const branch = state.personal,
    calendar = branch.calendar || {},
    zone = branch.settings.timeZone;
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  const days = Object.fromEntries(
    Object.entries(branch.days).map(([day, tasks]) => [
      day,
      tasks.map((task) => {
        const facts = structuredClone(task);
        if (facts.calendarLink) delete facts.calendarLink.syncedAt;
        return facts;
      }),
    ]),
  );
  // Cover the same protected +/-1-day interval as the required read. Equal
  // complete coverage, extra unrelated ranges and loadedAt are not plan edits.
  const dates = snapshot.map((entry) => entry.date).sort(),
    coverage = syncRangeValidity(
      calendar.readRanges || [],
      addDays(dates[0], -1),
      addDays(dates.at(-1), 1),
      zone,
    ),
    calendarIds = new Set([
      calendar.targetCalendarId,
      ...snapshot.map((e) => e.task.calendarLink?.calendarId),
    ]);
  const decisionFacts = (values) =>
    Object.fromEntries(
      Object.entries(values || {}).map(([key, value]) => {
        const facts = structuredClone(value);
        if (facts && typeof facts === "object") {
          delete facts.label;
          delete facts.explanation;
        }
        return [key, facts];
      }),
    );
  return JSON.stringify(
    canonical({
      profileId: state.profileId,
      days,
      settings: branch.settings,
      daySettings: branch.daySettings,
      targetCalendarId: calendar.targetCalendarId,
      classificationRules: calendar.classificationRules,
      semanticDecisions: decisionFacts(calendar.semanticDecisions),
      semanticCorrections: decisionFacts(calendar.semanticCorrections),
      calendars: (calendar.calendars || [])
        .filter((c) => calendarIds.has(c.id))
        .map((c) => ({
          id: c.id,
          accessRole: c.accessRole,
          timeZone: c.timeZone,
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
      coverage,
      catalogs: syncCatalogValidity(snapshot),
      pending: pendingTasks(branch).map((entry) => ({
        uid: entry.task.uid,
        date: entry.date,
        syncJobId: entry.syncJobId,
      })),
    }),
  );
}
async function runSyncQueue({ validityRechecks = 0 } = {}) {
  if (
    mode !== "personal" ||
    !state.personal.calendar?.autoSync ||
    calendarStatus?.state !== "connected"
  )
    return;
  // A confirmation during I/O is a request to drain the latest queue, not a
  // second executor. A permission-generation change can never revive this run.
  if (syncBusy) {
    if (calendarStatus.writesEnabled) syncRequestedGeneration = syncGeneration;
    return;
  }
  syncRequestedGeneration = null;
  const snapshot = structuredClone(pendingTasks(state.personal));
  if (!snapshot.length) return;
  const generation = syncGeneration;
  const permitted = () =>
    generation === syncGeneration &&
    mode === "personal" &&
    state.personal.calendar?.autoSync &&
    calendarStatus?.state === "connected";
  const sameEventIdentity = (active, requested) => {
    const a = active.calendarLink,
      b = requested.calendarLink;
    return !a && !b
      ? true
      : Boolean(
          a &&
            b &&
            a.calendarId === b.calendarId &&
            a.eventId === b.eventId &&
            a.managed === b.managed,
        );
  };
  const stillPending = () => {
    const current = pendingTasks(state.personal);
    return snapshot.every((entry) =>
      current.some(
        (pending) =>
          pending.task.uid === entry.task.uid &&
          pending.syncJobId === entry.syncJobId &&
          sameEventIdentity(pending.task, entry.task) &&
          localCalendarSignature(
            pending.task,
            pending.date,
            state.personal.settings.timeZone,
          ) ===
            localCalendarSignature(entry.task, entry.date, entry.task.timeZone),
      ),
    );
  };
  const retry = state.personal.calendar?.syncRetry;
  if (retry?.exhausted) return;
  if (calendarStatus.writesEnabled && retry?.nextAt > Date.now()) {
    clearTimeout(syncRetryTimer);
    syncRetryTimer = setTimeout(
      () => void runSyncQueue(),
      Math.min(300000, retry.nextAt - Date.now()),
    );
    return;
  }
  let mayDrainLatest = false,
    obsolete = false;
  const discardPreview = () => {
    obsolete = true;
    mayDrainLatest = true;
    const identityChanged = snapshot.some((entry) => {
      const current = all(state.personal.days).find(
        (e) => e.task.uid === entry.task.uid,
      );
      return current && !sameEventIdentity(current.task, entry.task);
    });
    if (identityChanged) {
      // A read can rediscover an old managed UID. Do not use it to resurrect a
      // changed association or revoked management without new authorization.
      mayDrainLatest = false;
      actionError("The original event link or management eligibility changed. Queued changes are preserved. Review the management scope and try again.");
      return;
    }
    syncRequestedGeneration = generation;
  };
  syncBusy = true;
  try {
    if (!permitted() || !stillPending()) return;
    // Remember known complete scope before the first I/O can replace/evict it.
    rememberSyncCatalogRequirements(snapshot);
    if (calendarStatus.writesEnabled) {
      const dates = snapshot.map((e) => e.date).sort(),
        requiredRead = await readCalendar(dates[0], {
          required: true,
          force: true,
          rangeFrom: addDays(dates[0], -1),
          rangeTo: addDays(dates.at(-1), 1),
        });
      if (!permitted()) return;
      if (!requiredRead?.ok || !requiredRead.complete)
        throw Error(
          "The queued plan has not been fully checked against the latest Google Calendar data: " +
            (requiredRead?.message || "Read incomplete"),
        );
      if (!stillPending()) {
        discardPreview();
        return;
      }
      rememberSyncCatalogRequirements(snapshot);
      requireSyncCatalogCompleteness(snapshot);
      const affected = new Set(snapshot.map((e) => e.task.id)),
        check = validatePlan(state.personal.days, state.personal.settings);
      const issues = check.conflicts.filter((c) =>
        c.ids.some((id) => affected.has(id)),
      );
      const remoteConflicts = all(state.personal.days).filter(
        (e) => affected.has(e.task.id) && e.task.calendarConflict,
      );
      if (issues.length || remoteConflicts.length)
        throw Error(
          "Conflicts were found after refreshing Calendar. Nothing was written. Preview again: " +
            [
              ...issues.map((c) => c.message),
              ...remoteConflicts.map((e) => e.task.calendarConflict.message),
            ].join("; "),
        );
      if (
        snapshot.some((e) => {
          const current = all(state.personal.days).find(
            (c) => c.task.uid === e.task.uid,
          );
          return (
            !current ||
            !sameEventIdentity(current.task, e.task) ||
            localCalendarSignature(
              current.task,
              current.date,
              state.personal.settings.timeZone,
            ) !== localCalendarSignature(e.task, e.date, e.task.timeZone)
          );
        })
      )
        throw Error("The plan changed while Calendar was being read. The queue is preserved. Preview again.");
    }
    if (!permitted()) return;
    if (!stillPending()) {
      discardPreview();
      return;
    }
    rememberSyncCatalogRequirements(snapshot);
    requireSyncCatalogCompleteness(snapshot);
    const validity = syncPreviewValidity(snapshot),
      payload = {
        mode: "personal",
        profileId: state.profileId,
        calendarId: state.personal.calendar?.targetCalendarId,
        tasks: snapshot.map((e) => ({
          ...e.task,
          date: e.date,
          timeZone: state.personal.settings.timeZone,
        })),
      };
    const value = await calendarRequest("preview", payload);
    if (!permitted()) return;
    if (!stillPending()) {
      discardPreview();
      return;
    }
    if (syncPreviewValidity(snapshot) !== validity) {
      discardPreview();
      return;
    }
    if (!value.writesEnabled) {
      save(
        (s) =>
          (s.personal = settleSync(
            s.personal,
            {
              blocked: true,
              error: "Calendar writes are disabled. Local changes are preserved; nothing was sent to Google.",
            },
            snapshot,
          )),
      );
      return;
    }
    if (!value.canExecute)
      throw Error(
        value.items
          .filter((x) => x.action === "error")
          .map((x) => x.reason)
          .join("; ") || "The plan still has conflicts. Nothing was written.",
      );
    if (!permitted() || !calendarStatus.writesEnabled || !stillPending())
      return;
    if (!save((s) => (s.personal = markSyncing(s.personal, snapshot))))
      throw Error("Could not save the sync queue. Nothing was sent.");
    const result = await calendarRequest("execute", { planId: value.planId });
    save((s) => (s.personal = settleSync(s.personal, result, snapshot)));
    const fullySucceeded =
      result.results?.length === snapshot.length &&
      snapshot.every((entry) =>
        result.results.some(
          (r) =>
            r.ok && (r.uid ? r.uid === entry.task.uid : r.id === entry.task.id),
        ),
      );
    if (fullySucceeded) {
      save((s) => {
        s.personal.calendar.syncRetry = null;
      });
      mayDrainLatest = true;
    } else {
      const failures = (result.results || [])
        .filter((r) => !r.ok)
        .map((r) => r.message || "Sync incomplete")
        .join("; ");
      scheduleSyncRetry(failures);
    }
    renderCalendarState();
  } catch (error) {
    if (!permitted()) return;
    save(
      (s) =>
        (s.personal = settleSync(
          s.personal,
          { error: error.message },
          snapshot,
        )),
    );
    actionError(presentError(error.message));
    scheduleSyncRetry(error.message);
    renderCalendarState();
  } finally {
    const requested = syncRequestedGeneration === generation;
    if (requested) syncRequestedGeneration = null;
    syncBusy = false;
    // Only a successful/obsolete normal run may drain a newer confirmed
    // intent. Failures use the persisted bounded backoff; opt-out clears the
    // latch, and reopening cannot continue an old generation or plan ID.
    const retry = state.personal.calendar?.syncRetry;
    if (
      mayDrainLatest &&
      requested &&
      permitted() &&
      calendarStatus.writesEnabled &&
      !retry?.exhausted &&
      !(retry?.nextAt > Date.now()) &&
      pendingTasks(state.personal).length
    ) {
      if (obsolete && validityRechecks >= 2) {
        actionError("The schedule or constraints kept changing. Sync paused after three checks. Retry once the schedule is stable. Queued changes are preserved.");
        return;
      }
      void runSyncQueue({
        validityRechecks: obsolete ? validityRechecks + 1 : 0,
      });
    }
  }
}
function scheduleSyncRetry(message) {
  // Retry only transient failures, never conflicts/auth; persist a bounded budget across reloads.
  if (
    !state.personal.calendar?.autoSync ||
    !calendarStatus?.writesEnabled ||
    !/fetch|timeout|503|502|429|network|connection|failed|failure|temporar(?:y|ily)|sync (?:incomplete|did not complete)/i.test(
      message,
    ) ||
    /conflict|version|authoriz|permission|changed|mismatch/i.test(message)
  )
    return;
  const attempt = (state.personal.calendar?.syncRetry?.attempt || 0) + 1;
  const exhausted = attempt > 6,
    wait = Math.min(300000, 2000 * 2 ** (attempt - 1));
  if (
    save((s) => {
      s.personal.calendar.syncRetry = {
        attempt,
        exhausted,
        nextAt: exhausted ? null : Date.now() + wait,
        message: exhausted
          ? "Automatic retries are paused. Failed items are preserved. Retry from Sync preferences."
          : "Network failure. Failed items are preserved and will retry automatically with increasing delays.",
      };
    })
  ) {
    clearTimeout(syncRetryTimer);
    if (!exhausted)
      syncRetryTimer = setTimeout(() => void runSyncQueue(), wait);
  }
}
window.addEventListener("online", () => {
  void refreshCalendar().then(() => runSyncQueue());
});
window.addEventListener("focus", () => {
  if (mode === "personal") void readCalendar(date, { force: true });
});
setInterval(() => {
  if (bench?.phase() === "home") {
    render();
    if (mode === "personal") void readCalendar(date, { force: true });
  }
}, 120000);
function prepareWorkbenchProposal(
  result,
  label = "Adjustment preview",
  settings = data().settings,
  allowRuleConflicts = false,
) {
  proposal = {
    result,
    label,
    settings: structuredClone(settings),
    revision: state.revision,
    mode,
    allowRuleConflicts,
  };
  return proposal;
}
async function adoptLearning(planId, isCurrent = () => true) {
  const revision = state.revision,
    branch = structuredClone(state.personal);
  const entries = all(branch.days).filter(
    (e) =>
      learningTask(e.task) &&
      e.task.planId === planId &&
      e.task.calendarClassification?.manage !== false &&
      branch.calendar?.classificationRules?.find((r) => ruleMatches(e.task, r))?.manage !== false &&
      !e.task.done &&
      !e.task.timeLocked &&
      e.task.type !== "activity" &&
      canManageCalendarSource(e.task.calendarSource) &&
      !e.task.calendarSource.allDay &&
      e.task.duration <= 1440 &&
      !e.task.calendarConflict,
  );
  if (!entries.length) throw Error("No study events are currently eligible for Shunri to manage. Check again.");
  const response = await calendarRequest("adopt", {
    mode: "personal",
    profileId: state.profileId,
    tasks: entries.map((e) => ({
      ...e.task,
      date: e.date,
      timeZone: branch.settings.timeZone,
    })),
  });
  if (!isCurrent()) return;
  const failures = response.results?.filter((r) => !r.ok) || [];
  if (failures.length)
    throw Error(
      "These study events cannot yet be fully managed here: " + failures.map((r) => presentError(r.message)).join("; "),
    );
  for (const r of response.results || []) {
    const e = entries.find((e) => e.task.uid === r.uid);
    if (e && r.ok) {
      e.task.calendarLink = {
        ...e.task.calendarLink,
        ...r.calendarLink,
        adoptedEtag: r.calendarLink.etag,
      };
      delete e.task.calendarRestrictionLock;
      e.task.calendarLink.localFingerprint = localCalendarSignature(
        e.task,
        e.date,
        branch.settings.timeZone,
      );
    }
  }
  branch.calendar ||= {};
  branch.calendar.semanticManagedPlans ||= [];
  if (!branch.calendar.semanticManagedPlans.includes(planId))
    branch.calendar.semanticManagedPlans.push(planId);
  // Reconcile restored management through the same rules as automatic adoption;
  // joining a plan does not release independently owned or pre-existing locks.
  const interpreted = classifyCalendar(branch, { date }).data;
  if (!save((s) => (s.personal = interpreted), revision))
    throw Error("The local schedule changed. The original schedule is preserved. Try again.");
  notice("The local management scope for this kind of study is saved. Nothing was written to Google.");
}
async function saveWorkbenchTask(draft, entry, revision, alternative = null) {
  if (revision !== state.revision)
    throw Error("The schedule changed during editing. Your draft is preserved. Go back and open the editor again.");
  const [newDate, time] = draft.when.split("T"),
    start = parseTime(time);
  if (
    !validDate(newDate) ||
    !Number.isInteger(start) ||
    !draft.title.trim() ||
    ![draft.duration, draft.rest].every(Number.isInteger) ||
    draft.duration < 1 ||
    draft.duration > 1440 ||
    draft.rest < 0 ||
    draft.rest > 1440
  )
    throw Error("Check the title, date, duration, and rest time.");
  if (entry?.task.externalReadOnly)
    throw Error("Google events cannot be changed until management is authorized.");
  const task = {
    ...structuredClone(entry?.task || {}),
    id: entry?.task.id || crypto.randomUUID(),
    uid: entry?.task.uid || crypto.randomUUID(),
    title: draft.title.trim(),
    start,
    duration: draft.duration,
    rest: draft.rest,
    dependencies: draft.dependencies || [],
    bufferBefore: draft.bufferBefore,
    bufferAfter: draft.bufferAfter,
    locked: draft.kind === "fixed" || draft.locked,
    lockSource: draft.locked ? "user" : entry?.task.lockSource === "user" ? null : entry?.task.lockSource,
    ...(entry?.task.calendarRestrictionLock ? { calendarRestrictionLock: false } : {}),
    type: draft.kind === "fixed" ? "activity" : "task",
    done: entry?.task.done || false,
    deferred: entry?.task.deferred || false,
    counted: draft.kind === "learning" ? true : Boolean(entry?.task.counted),
    tags:
      draft.kind === "learning"
        ? [...new Set([...(entry?.task.tags || []), "study"])]
        : [...(entry?.task.tags || [])].filter((t) => t !== "study"),
    learning: draft.kind === "learning",
    planId:
      draft.kind === "learning"
        ? entry?.task.planId || "job-prepare"
        : entry?.task.planId,
  };
  if (!draft.locked && task.calendarClassification?.locked)
    delete task.calendarClassification.locked;
  if (task.calendarOccupation && !task.externalReadOnly) {
    const instant = wallInstant(newDate, start, data().settings.timeZone);
    task.calendarOccupation = {
      ...task.calendarOccupation,
      startInstant: instant,
      endInstant: instant + task.duration * 60000,
    };
  }
  if (alternative) {
    const result = await calculateMove(task.id, alternative.targetDate, alternative.targetStart, source => {
      for (const date of Object.keys(source)) source[date] = source[date].filter(t=>t.id!==task.id);
      (source[newDate] ||= []).push(task);
      return normalizeLearningDays(source);
    });
    if (result?.status === 'ok')result.changes=changeList(data().days,result.days);
    const p=prepareWorkbenchProposal(result, 'Edit and reschedule related tasks');p.targetTaskId=task.id;p.editorConflict=result?.status!=='ok';return p;
  }
  let days = structuredClone(data().days);
  if (
    entry &&
    (entry.date !== newDate || entry.task.start !== start) &&
    movable(task)
  ) {
    // Manually moved = locked: the edited task keeps the user's new time from now on.
    const moved = await calculateMove(task.id, newDate, start, (source) => {
      const e = all(source).find((e) => e.task.id === task.id);
      if (!e) throw Error("The task changed. Nothing was saved.");
      Object.assign(e.task, task, { start: entry.task.start });
      return normalizeLearningDays(source);
    });
    const result = draft.lockOnMove ? lockManualMove(moved, task.id) : moved;
    // A move to another day that breaks the fixed-event buffer gets the closest free time that keeps it first.
    if (entry.date !== newDate && result?.status !== "ok" && movable(entry.task))
      applyDefaultRules(result, data().days, entry, newDate, start);
    const p = prepareWorkbenchProposal(result, "Edit and reschedule related tasks");
    p.targetTaskId = task.id;
    p.editorConflict = result?.status !== "ok";
    return p;
  }
  if (entry)
    days[entry.date] = days[entry.date].filter((t) => t.id !== task.id);
  (days[newDate] ||= []).push(task);
  days = normalizeLearningDays(days);
  const check = validateMutation(data().days, days, data().settings);
  if (check.status !== 'ok') {
    const nextDate=addDays(newDate,1),nextStart=learningTask(task)?data().settings.learningPreferredStart ?? 660:start;
    const candidate=movable(task)?moveIntent(days,data().settings,{taskId:task.id,targetDate:nextDate,targetStart:nextStart}):null;
    const options=candidate?.status==='ok' && !candidate.noEffect
      ? [{label:`Move to ${nextDate} ${formatTime(nextStart)}`,targetDate:nextDate,targetStart:nextStart,summary:candidate.summary}]
      : candidate?.alternatives || [];
    const p=prepareWorkbenchProposal({...check,days:structuredClone(data().days),changes:[],alternatives:options},entry?'Edit task':'Add task');
    p.editorConflict=true;p.targetTaskId=task.id;return p;
  }
  if (entry)
    return prepareWorkbenchProposal(
      { ...check, status: "ok", days, changes: changeList(data().days, days) },
      "Edit task",
    );
  const before = structuredClone(data().days);
  const ok = save((s) => {
    s[mode].days = days;
    if (mode === "personal")
      s.personal = enqueueChanges(s.personal, before, days, {
        profileId: s.profileId,
        targetCalendarId: s.personal.calendar?.targetCalendarId,
        autoSync: s.personal.calendar?.autoSync,
      });
  }, revision);
  if (ok) {
    notice("Task saved.");
    void runSyncQueue();
  }
  return { ok, id: task.id, message: store.error };
}
bench = createWorkbench({
  context: () => {
    const c = data().calendar || {},
      readRange = c.readRanges?.at(-1);
    return {
      branch: data(),
      ui: state.ui,
      mode,
      date,
      revision: state.revision,
      proposalKey: proposalBasis(data()),
      error: store.error,
      calendarStatus,
      reading: readingCalendar,
      readError: calendarReadError,
      lastReadAt: [...(c.readRanges || [])].reverse().find((r) => !r.partial)
        ?.loadedAt,
      readRange,
      dayStartInstant: wallInstant(date, 0, data().settings.timeZone),
      dayEndInstant: wallInstant(addDays(date, 1), 0, data().settings.timeZone),
    };
  },
  movable,
  clearNotice: clearWorkbenchNotice,
  select: (e) => {
    date = e.date;
    save((s) => { s.ui.date = date; s.ui.selection = { mode, id: e.task.id, uid: e.task.uid, date }; });
    if (mode === "personal") scheduleCalendarRead(date);
  },
  selectDate: (day) => {
    if(!validDate(day))return false;
    date=day;
    const ok=save(s=>{s.ui.date=day;s.ui.selection=null;});
    if(ok && mode==='personal')scheduleCalendarRead(day);
    return ok;
  },
  readDate: (day) => readCalendar(day, { force: true }),
  move: async (id, day, time, intent = {}) => {
    const result = await calculateMove(id, day, parseTime(time), null, intent);
    if (!result || intent.isCurrent?.() === false) return null;
    const p = prepareWorkbenchProposal(result);
    p.targetTaskId = id; return p;
  },
  cancel: () => {
    proposal = null;
  },
  confirm: () => {
    if (!proposal) return false;
    confirmProposal();
    return proposal === null;
  },
  undo: () => {
    const before = data().undo;
    undoLast();
    return before && !data().undo;
  },
  switchMode: (next, reset = false, personalView = null) => {
    if (next === "demo") {
      if (
        !save((s) => {
          if (s.ui.mode !== "demo") {
            s.ui.personalDateBeforeDemo = s.ui.date;
            s.ui.personalViewBeforeDemo = structuredClone(personalView);
          }
          if (reset || !Object.keys(s.demo.days).length || !s.demo.exampleOrigin)
            s.demo = demoData();
          s.ui.mode = "demo";
          s.ui.date = s.demo.exampleOrigin;
        })
      )
        return false;
      mode = "demo";
      date = state.ui.date;
      render();
      return true;
    } else return switchMode(next);
  },
  complete: (e) => {
    const current = find(e.task.id);
    if (!current || current.task.externalReadOnly || isActivity(current.task))
      return false;
    const beforeDays = structuredClone(data().days),
      before = structuredClone(current.task),
      task = structuredClone(before);
    task.done = !task.done;
    if (task.done) {
      task.doneAt = new Date().toISOString();
      task.completedDate =
        mode === "demo" ? demoOrigin() : today(data().settings.timeZone);
    }
    const nextDays=structuredClone(beforeDays);
    nextDays[current.date]=nextDays[current.date].map(t=>t.id===task.id?task:t);
    const check=validateMutation(beforeDays,nextDays,data().settings);
    if(check.status!=='ok'){notice(check.conflicts[0].message,true);return false;}
    const ok = save((s) => {
      const branch = s[mode];
      const t = all(branch.days).find((x) => x.task.id === task.id);
      t.task = task;
      branch.days[t.date] = branch.days[t.date].map((x) =>
        x.id === task.id ? task : x,
      );
      branch.completionUndo = {
        id: task.id,
        date: t.date,
        before,
        after: task,
      };
      if (mode === "personal")
        s.personal = enqueueChanges(branch, beforeDays, branch.days, {
          profileId: s.profileId,
          autoSync: branch.calendar?.autoSync,
          targetCalendarId: branch.calendar?.targetCalendarId,
        });
    });
    if (ok) notice(task.done ? "Actual completion saved." : "Marked as incomplete.");
    return ok;
  },
  // Release a lock the user set (never a fixed event). Saved as an adjustment, so Undo applies.
  unlock: (e) => {
    const current = find(e.task.id);
    if (!current || isActivity(current.task) || current.task.timeLocked || !current.task.locked || current.task.lockSource !== "user")
      return false;
    const days = structuredClone(data().days);
    days[current.date] = days[current.date].map((t) => {
      if (t.id !== current.task.id) return t;
      const { manuallyMoved, ...rest } = t;
      const next = { ...rest, locked: false, lockSource: null };
      if (next.calendarClassification?.locked) delete next.calendarClassification.locked;
      return next;
    });
    return saveDays(days, "Unlock time", state.revision, data().settings, { targetId: current.task.id });
  },
  // Put an archived task back in its first free gap (within two weeks). Saved as an adjustment, so Undo applies.
  restoreProposal: (e, now) => {
    const out = proposeRestore(data().days, e.task.id, now, data().settings);
    if (out.status !== "ok") { notice(out.message, true); return false; }
    return out.to;
  },
  restore: (e, now) => {
    const out = proposeRestore(data().days, e.task.id, now, data().settings);
    if (out.status !== "ok") { notice(out.message, true); return false; }
    return saveDays(out.days, "Restore task", state.revision, data().settings, { targetId: e.task.id }) ? out.to : false;
  },
  previewRestore: (e, now) => {
    const out = proposeRestore(data().days, e.task.id, now, data().settings);
    return out.status === "ok" ? out.to : null;
  },
  archived: () => archivedTasks(data().days),
  undoComplete: () => {
    const u = data().completionUndo;
    if (!u) return false;
    const e = find(u.id);
    if (!e || JSON.stringify(e.task) !== JSON.stringify(u.after)) {
      notice("This content has changed since then. The newer record cannot be overwritten.", true);
      return false;
    }
    const nextDays=structuredClone(data().days);
    nextDays[e.date]=nextDays[e.date].map(t=>t.id===u.id?u.before:t);
    const check=validateMutation(data().days,nextDays,data().settings);
    if(check.status!=='ok'){notice(check.conflicts[0].message,true);return false;}
    const baselineDays = structuredClone(data().days);
    const hadPending = data().calendar?.syncQueue?.jobs?.some((j) =>
      j.items?.some((i) => i.uid === u.before.uid && i.status === "superseded"),
    );
    if (hadPending)
      baselineDays[e.date] = baselineDays[e.date].filter((t) => t.id !== u.id);
    return save((s) => {
      s[mode].days[e.date] = s[mode].days[e.date].map((t) =>
        t.id === u.id ? u.before : t,
      );
      s[mode].completionUndo = null;
      if (mode === "personal" && hadPending)
        s.personal = enqueueChanges(s.personal, baselineDays, s.personal.days, {
          profileId: s.profileId,
          autoSync: s.personal.calendar?.autoSync,
          targetCalendarId: s.personal.calendar?.targetCalendarId,
        });
    });
  },
  saveTask: saveWorkbenchTask,
  remove: removeTask,
  saveRules: (s, revision) => {
    const old = data().settings;
    const next = structuredClone(s);
    const excluded = (next._exclusions || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    delete next._exclusions;
    for (const d of excluded)
      if (!validDate(d)) throw Error("Use YYYY-MM-DD for excluded study dates.");
    for (const [d, r] of Object.entries(next.learningDates || {}))
      if (r.closed && !excluded.includes(d))
        next.learningDates[d] = {
          ...r,
          closed: false,
          source: "user-confirmed",
          semanticEventIds: undefined,
        };
    for (const d of excluded)
      next.learningDates[d] = {
        ...next.learningDates[d],
        closed: true,
        source: "user-confirmed",
      };
    next.ruleSources = {
      ...(next.ruleSources || {}),
      window: "user-confirmed",
      learningCapacity: "user-confirmed",
      learningGap: "user-confirmed",
    };
    for (const [k, w] of Object.entries(next.weekly || {}))
      if (
        w.length === 1 &&
        w[0][0] === (old.dayStart ?? 540) &&
        w[0][1] === old.dayEnd
      )
        next.weekly[k] = [[next.dayStart, next.dayEnd]];
    const test = structuredClone(state);
    test[mode].settings = next;
    const normalized = normalizeWorkspace(test)[mode].settings;
    const check = validatePlan(data().days, normalized);
    if (revision !== state.revision)
      throw Error("The rules changed during editing. Your draft is preserved. Check it again.");
    return prepareWorkbenchProposal(
      {
        ...check,
        days: structuredClone(data().days),
        changes: [],
        warnings: [
          "Only the confirmed rules change. No Calendar events are moved or deleted. Existing arrangements that do not meet the new rules stay in place.",
        ],
      },
      "Preview rule changes",
      normalized,
      true,
    );
  },
  recoveries: () => store.recoveryCandidates(),
  ipRecoveryUrl: () => {
    const url = new URL(location.origin);
    url.hostname = "127.0.0.1";
    url.pathname = "/ip-recovery";
    return url.href;
  },
  restoreRecovery: (id) => {
    const out = store.restoreRecovery(id, {
      expectedRevision: state.revision,
      expectedRaw: store.original["shunri.workspace.v2"],
    });
    state = store.state;
    mode = state.ui.mode;
    date = state.ui.date || today(data().settings.timeZone);
    render();
    if (out.ok) notice("The previous valid local version is restored.");
    return out;
  },
  export: () => downloadBackup(store.exportData()),
  import: importBackup,
  adoptLearning,
  refreshRead: () => readCalendar(date, { force: true }),
  connect: () => location.assign("/api/calendar/connect?includeGranted=true"),
  resolveConflict,
  interpretation: () => interpretationSummary(data(), date),
  ambiguous: () => ambiguousDecisions(data(), { limit: 3 }),
  ambiguityFor: (id) => {
    const e = find(id);
    return e
      ? ambiguousDecisions(
          { ...data(), days: { [e.date]: [e.task] } },
          { limit: 1 },
        )[0]
      : null;
  },
  questionFor: (e, group = "learning") => ({
    id: e.task.id,
    taskId: e.task.id,
    title: e.task.title,
    prompt: "How should this event be treated?",
    choices: semanticCorrectionChoices(e.task, e.date, group, { timeZone: data().settings.timeZone }),
  }),
  rememberMeaning: (question, choice) => {
    const revision = state.revision;
    const choiceObject =
      question.choices.find((c) => c.id === choice) || choice;
    const interpreted = applySemanticDecision(
      data(),
      question.id,
      choiceObject,
      {
        date,
        remember: true,
      },
    ).data;
    const validation = validatePlan(interpreted.days, interpreted.settings);
    const p = prepareWorkbenchProposal(
      {
        ...validation,
        status: "ok",
        days: interpreted.days,
        changes: changeList(data().days, interpreted.days),
        warnings: validation.conflicts.map((c) => c.message),
      },
      "Purpose correction preview",
      interpreted.settings,
      true,
    );
    p.revision = revision;
    p.semanticBranch = interpreted;
    p.semanticCorrection = true;
    p.semanticIntent = { question, choice };
    p.semanticDescription = `${question.decisionDate ? `${question.decisionDate} study limit · ` : ""}${typeof choiceObject === "object" ? choiceObject.label : choice}: ${typeof choiceObject === "object" ? choiceObject.explanation || "" : "This purpose choice will be remembered."} The original time stays unchanged. Confirmation saves the local rule; nothing has synced to Google yet.`;
    return p;
  },
  toggleSync: changeAutoSync,
  confirmSyncResume: confirmAutoSync,
  retrySync: () => {
    if (
      save((s) => {
        s.personal.calendar.syncRetry = null;
      })
    )
      void runSyncQueue();
  },
  syncSummary: () => {
    return mode === "personal" ? syncPresentation(data(), { writesEnabled: calendarStatus?.writesEnabled }).text : "Separate example. No real Calendar sync occurred.";
  },
});
render();
// A callback query only selects the view; /status still determines connection.
if (entryParams.get("calendar") === "connected") bench.calendar();
void refreshCalendar()
  .then(() =>
    readCalendar(
      mode === "personal" ? date : today(state.personal.settings.timeZone),
      { initial: true },
    ),
  )
  .then(() => runSyncQueue());
