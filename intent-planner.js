import {
  addDays,
  dateParts,
  validDate,
  wallInstant,
  weekday,
  MINUTE,
} from "./time.js";
import { isActivity, rulesForDate } from "./planner.js";
import {
  learningTask,
  normalizeLearningDays,
  packageSummary,
} from "./learning.js";

const MAX_DAYS = 3660; // A safety bound, not a user-facing search option or 30-day cap.
const active = (task) => !task.done && !task.deferred;
const movable = (task) =>
  active(task) &&
  !task.locked &&
  !task.timeLocked &&
  !task.externalReadOnly &&
  !task.calendarConflict &&
  !isActivity(task);
const identity = (task) =>
  `${task.planId || "study-default"}\u0000${task.packageId}`;
const studyWorkload = (task) => learningTask(task) || task.learningWorkload === true;
const globalLearningCapacity = (settings) => Math.min(150, settings.learningCapacity ?? 150);
const spacing = (earlier, later) => Math.max(earlier.after, later.before,
  studyWorkload(earlier.entry.task) || studyWorkload(later.entry.task)
    ? Math.max(earlier.learningGap, later.learningGap) : 0);
const overlap = (a, b) => {
  if (a.nonBlocking || b.nonBlocking) return false;
  if (a.actualStart < b.actualEnd && b.actualStart < a.actualEnd) return true;
  const [earlier, later] = a.actualStart <= b.actualStart ? [a, b] : [b, a];
  // Protection, rest and a learning gap describe the same empty interval.
  // Use the greatest requirement rather than adding overlapping buffers.
  const gap = spacing(earlier, later);
  return earlier.actualEnd + gap * MINUTE > later.actualStart;
};
const failMessage = (message, ids = []) => ({ message, ids });

// Presentation reads the same occupancy and daily accounting as scheduling.
export { occupied as taskOccupation, dailyTotals };

function rest(task, settings) {
  if (isActivity(task) || task.externalReadOnly) return 0;
  return Math.max(
    task.rest || 0,
    learningTask(task)
      ? (settings.learningMinGap ?? 20)
      : settings.minGap || 0,
  );
}

function occupied(entry, settings) {
  const { task, date } = entry;
  const external = task.calendarOccupation;
  const actualStart =
    external?.startInstant ?? wallInstant(date, task.start, settings.timeZone);
  const actualEnd =
    external?.endInstant ?? actualStart + task.duration * MINUTE;
  const activity = isActivity(task);
  const medical = task.purpose === "medical" || task.calendarClassification?.purpose === "medical";
  const before = activity ? (medical ? Math.max(60, task.bufferBefore ?? 0) : (task.bufferBefore ?? settings.bufferBefore ?? 0)) : 0;
  const after = activity ? (task.bufferAfter ?? (settings.bufferAfter ?? 0)) : rest(task, settings);
  // Google "Available" annotations remain visible but do not reserve time.
  // Importers lock unknown records for write safety; that flag alone is not
  // a user decision to make an Available annotation into a fixed activity.
  const nonBlocking = Boolean(
    task.externalReadOnly &&
      task.calendarLink?.source === "google" &&
      task.calendarSource?.transparency === "transparent" &&
      !["fixed", "learning", "task"].includes(task.calendarClassification?.kind) &&
      !task.timeLocked &&
      task.type !== "activity" &&
      !learningTask(task),
  );
  return {
    start: actualStart - before * MINUTE,
    end: actualEnd + after * MINUTE,
    before,
    after,
    learningGap: settings.learningMinGap ?? 20,
    actualStart,
    actualEnd,
    nonBlocking,
    entry,
  };
}

function relocated(entry, date, start, settings) {
  const task = { ...entry.task, start };
  if (task.calendarOccupation && !task.externalReadOnly) {
    const instant = wallInstant(date, start, settings.timeZone);
    task.calendarOccupation = {
      ...task.calendarOccupation,
      startInstant: instant,
      endInstant: instant + task.duration * MINUTE,
    };
  }
  return { date, task };
}

function predecessorEnd(entry, settings) {
  if (entry.task.done) {
    const recorded =
      entry.task.doneAt ??
      entry.task.completedAt ??
      entry.task.actualCompletedAt;
    const instant =
      typeof recorded === "number"
        ? recorded
        : typeof recorded === "string" &&
            /(?:Z|[+-]\d{2}:\d{2})$/i.test(recorded)
          ? Date.parse(recorded)
          : NaN;
    if (Number.isFinite(instant)) return instant;
  }
  // A completion checkbox without a timestamp is not an invented completion time.
  return occupied(entry, settings).actualEnd;
}

function intersection(first, second) {
  const out = [];
  for (const [a, b] of first)
    for (const [c, d] of second)
      if (Math.max(a, c) < Math.min(b, d))
        out.push([Math.max(a, c), Math.min(b, d)]);
  return out.sort((a, b) => a[0] - b[0]);
}

function learningRules(settings, date) {
  const base = rulesForDate(settings, date);
  const specific = settings.learningDates?.[date] || {};
  const configured =
    specific.windows ?? settings.learningWeekly?.[weekday(date)];
  const studyWindows = configured?.map((window) =>
    Array.isArray(window) ? window : [window.start, window.end],
  );
  const closed =
    base.closed || specific.closed || settings.learningClosed?.includes(date);
  return {
    ...base,
    windows: closed
      ? []
      : studyWindows
        ? intersection(base.windows, studyWindows)
        : base.windows,
    // A narrower date rule is allowed, but neither a stale null nor a date
    // override may disable the shared 150-minute learning ceiling.
    learningCapacity: Math.min(
      globalLearningCapacity(settings),
      specific.capacity ?? settings.learningCapacity ?? 150,
    ),
    closed,
  };
}

function entriesOf(days) {
  return Object.entries(days)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([date, tasks]) =>
      tasks.map((task, index) => ({ date, task, index })),
    )
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.task.start - b.task.start ||
        a.index - b.index,
    );
}

function validateInputs(days, settings) {
  const conflicts = [],
    entries = [],
    byId = new Map();
  const windowError = (windows) =>
    !Array.isArray(windows) ||
    windows.some((w, i) => {
      const [a, b] = Array.isArray(w) ? w : [w?.start, w?.end];
      const previous = windows[i - 1];
      const last = Array.isArray(previous) ? previous[1] : previous?.end;
      return (
        !Number.isInteger(a) ||
        !Number.isInteger(b) ||
        a < 0 ||
        b > 1440 ||
        a >= b ||
        (i > 0 && a < last)
      );
    });
  try {
    dateParts(Date.now(), settings.timeZone);
    for (const field of [
      "dayStart",
      "minGap",
      "learningMinGap",
      "learningPreferredStart",
      "bufferBefore",
      "bufferAfter",
    ])
      if (
        settings[field] != null &&
        (!Number.isInteger(settings[field]) ||
          settings[field] < 0 ||
        settings[field] > 1440)
      )
        throw new Error("The rest or protection duration is invalid.");
    for (const field of ["capacity", "learningCapacity"])
      if (
        settings[field] != null &&
        (!Number.isInteger(settings[field]) || settings[field] < 0)
      )
        throw new Error("The daily capacity is invalid.");
    for (const field of ["weekly", "learningWeekly"])
      if (
        settings[field] != null &&
        (typeof settings[field] !== "object" || Array.isArray(settings[field]))
      )
        throw new Error("The weekly availability is invalid.");
    for (const field of ["dates", "learningDates"])
      if (
        settings[field] != null &&
        (typeof settings[field] !== "object" || Array.isArray(settings[field]))
      )
        throw new Error("The date-specific settings are invalid.");
    const dates = new Set([
      ...Object.keys(days),
      ...Object.keys(settings.dates || {}),
      ...Object.keys(settings.learningDates || {}),
      ...Array.from({ length: 7 }, (_, i) => addDays("2026-10-11", i)),
    ]);
    for (const date of dates) {
      if (!validDate(date)) throw new Error(`Invalid date: ${date}`);
      const rules = rulesForDate(settings, date),
        study = learningRules(settings, date);
      for (const specific of [
        settings.dates?.[date],
        settings.learningDates?.[date],
      ]) {
        if (
          specific != null &&
          (typeof specific !== "object" || Array.isArray(specific))
        )
          throw new Error(`${date}: date rules are invalid.`);
        if (specific?.windows != null && windowError(specific.windows))
          throw new Error(`${date}: availability is invalid.`);
        if (
          specific?.capacity != null &&
          (!Number.isInteger(specific.capacity) || specific.capacity < 0)
        )
          throw new Error(`${date}: capacity is invalid.`);
      }
      for (const windows of [
        settings.weekly?.[weekday(date)],
        settings.learningWeekly?.[weekday(date)],
      ])
        if (windows != null && windowError(windows))
          throw new Error("The weekly availability windows are invalid or overlap.");
      if (
        !Number.isInteger(rules.dayStart) || rules.dayStart < 0 || rules.dayStart >= rules.dayEnd ||
        !Number.isInteger(rules.dayEnd) ||
        rules.dayEnd < 1 ||
        rules.dayEnd > 1440 ||
        (rules.capacity != null &&
          (!Number.isInteger(rules.capacity) || rules.capacity < 0)) ||
        (study.learningCapacity != null &&
          (!Number.isInteger(study.learningCapacity) ||
            study.learningCapacity < 0))
      )
        throw new Error(`${date}: daily end time or capacity is invalid.`);
    }
    if (
      settings.learningClosed != null &&
      (!Array.isArray(settings.learningClosed) ||
        settings.learningClosed.some((d) => !validDate(d)))
    )
      throw new Error("A non-study date is invalid.");
  } catch (error) {
    conflicts.push(failMessage(error.message));
  }
  for (const [date, tasks] of Object.entries(days)) {
    if (!validDate(date) || !Array.isArray(tasks)) {
      conflicts.push(failMessage("A schedule date or task list is invalid."));
      continue;
    }
    for (const task of tasks) {
      const entry = { date, task };
      const validExternal =
        task?.externalReadOnly &&
        Number.isFinite(task.calendarOccupation?.startInstant) &&
        Number.isFinite(task.calendarOccupation?.endInstant) &&
        task.calendarOccupation.endInstant >
          task.calendarOccupation.startInstant;
      if (
        !task ||
        typeof task.id !== "string" ||
        !task.id ||
        typeof task.title !== "string" ||
        !task.title.trim() ||
        !Number.isInteger(task.start) ||
        task.start < 0 ||
        task.start >= 1440 ||
        !Number.isFinite(task.duration) ||
        task.duration <= 0 ||
        (!validExternal &&
          (!Number.isInteger(task.duration) || task.duration > 1440)) ||
        !Number.isInteger(task.rest ?? 0) ||
        (task.rest ?? 0) < 0 ||
        (task.rest ?? 0) > 1440 ||
        (task.type != null && !["task", "activity"].includes(task.type)) ||
        [
          "done",
          "deferred",
          "locked",
          "timeLocked",
          "externalReadOnly",
        "counted",
        "learningWorkload",
        ].some((f) => task[f] != null && typeof task[f] !== "boolean") ||
        ["bufferBefore", "bufferAfter"].some(
          (f) =>
            task[f] != null &&
            (!Number.isInteger(task[f]) || task[f] < 0 || task[f] > 1440),
        )
      ) {
        conflicts.push(
          failMessage(
            "A task name, time, duration, or status is invalid.",
            [task?.id].filter(Boolean),
          ),
        );
        continue;
      }
      if (
        task.calendarOccupation &&
        (!Number.isFinite(task.calendarOccupation.startInstant) ||
          !Number.isFinite(task.calendarOccupation.endInstant) ||
          task.calendarOccupation.endInstant <=
            task.calendarOccupation.startInstant)
      )
        conflicts.push(
          failMessage(`The actual Calendar occupation for ${task.title} is invalid.`, [task.id]),
        );
      if (
        learningTask(task) &&
        (typeof task.planId !== "string" ||
          !task.planId ||
          typeof task.packageId !== "string" ||
          !task.packageId ||
          !Number.isInteger(task.packageOrder) ||
          !Number.isInteger(task.packageTaskOrder))
      )
        conflicts.push(
          failMessage(`The study-plan or day-package identity for ${task.title} is invalid.`, [
            task.id,
          ]),
        );
      if (
        task.dependencies != null &&
        (!Array.isArray(task.dependencies) ||
          task.dependencies.some(
            (dep) =>
              !dep ||
              typeof dep.id !== "string" ||
              !dep.id ||
              !Number.isInteger(dep.gap ?? 0) ||
              (dep.gap ?? 0) < 0 ||
              (dep.gap ?? 0) > 525600,
          ))
      )
        conflicts.push(
          failMessage(`The prerequisites for ${task.title} are invalid.`, [task.id]),
        );
      for (const id of new Set([task.id, task.uid].filter(Boolean))) {
        if (byId.has(id))
          conflicts.push(failMessage(`Duplicate task ID: ${task.title}`, [task.id]));
        byId.set(id, entry);
      }
      try {
        occupied(entry, settings);
      } catch (error) {
        conflicts.push(
          failMessage(`${task.title}: ${error.message}`, [task.id]),
        );
      }
      entries.push(entry);
    }
  }
  const visiting = new Set(),
    visited = new Set();
  function visit(entry) {
    if (visiting.has(entry)) {
      conflicts.push(
        failMessage(`A dependency cycle includes ${entry.task.title}.`, [entry.task.id]),
      );
      return;
    }
    if (visited.has(entry)) return;
    visiting.add(entry);
    for (const dep of Array.isArray(entry.task.dependencies)
      ? entry.task.dependencies
      : []) {
      const previous = byId.get(dep?.id);
      if (!previous)
        conflicts.push(
          failMessage(`A prerequisite for ${entry.task.title} is missing.`, [
            entry.task.id,
          ]),
        );
      else if (previous === entry)
        conflicts.push(
          failMessage(`${entry.task.title} cannot depend on itself.`, [entry.task.id]),
        );
      else {
        if (previous.task.deferred && !entry.task.deferred)
          conflicts.push(
            failMessage(
              `The prerequisite “${previous.task.title}” for ${entry.task.title} is deferred.`,
              [entry.task.id, previous.task.id],
            ),
          );
        visit(previous);
      }
    }
    visiting.delete(entry);
    visited.add(entry);
  }
  entries.forEach(visit);
  const orders = new Map(),
    taskOrders = new Map(),
    packageOrders = new Map();
  for (const entry of entries.filter((e) => learningTask(e.task))) {
    const task = entry.task,
      key = `${task.planId}/${task.packageOrder}`;
    if (orders.has(key) && orders.get(key) !== task.packageId)
      conflicts.push(
        failMessage(
          `Two days of the study plan containing “${task.title}” use the same order. Confirm the original study order first.`,
          [task.id],
        ),
      );
    orders.set(key, task.packageId);
    const packageKey = identity(task);
    if (
      packageOrders.has(packageKey) &&
      packageOrders.get(packageKey) !== task.packageOrder
    )
      conflicts.push(
        failMessage(`The study order within one day is inconsistent: ${task.title}`, [task.id]),
      );
    packageOrders.set(packageKey, task.packageOrder);
    const inner = `${identity(task)}/${task.packageTaskOrder}`;
    if (taskOrders.has(inner))
      conflicts.push(
        failMessage(`Study tasks on this day have a duplicate order: ${task.title}`, [task.id]),
      );
    taskOrders.set(inner, task.id);
  }
  return { conflicts, byId };
}

function completionDay(entry, settings) {
  if (!entry.task.done) return entry.date;
  if (validDate(entry.task.completedDate)) return entry.task.completedDate;
  const recorded = entry.task.doneAt ?? entry.task.completedAt ?? entry.task.actualCompletedAt;
  const instant = typeof recorded === "number" ? recorded :
    typeof recorded === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(recorded) ? Date.parse(recorded) : NaN;
  return Number.isFinite(instant) ? dateParts(instant, settings.timeZone).date : entry.date;
}

function packageOccupations(days, settings) {
  return entriesOf(days).filter(({ task }) => learningTask(task) && (!task.deferred || task.done))
    .map(entry => ({ ...entry, date: completionDay(entry, settings) }));
}

function otherPackage(days, settings, date, task) {
  return packageOccupations(days, settings).find(entry => entry.date === date &&
    entry.task.planId === task.planId && identity(entry.task) !== identity(task));
}

function semanticIssue(entry) {
  if (!active(entry.task) || !entry.task.semanticConflict) return null;
  const issue = entry.task.semanticConflict;
  return failMessage(
    issue.message || `The confirmed study order for “${entry.task.title}” conflicts with another item. Resolve the prerequisite arrangements first.`,
    [...new Set([entry.task.id, ...(Array.isArray(issue.ids) ? issue.ids : [])])],
  );
}

function focusFor(days, date, settings) {
  return entriesOf(days).reduce((sum, entry) => {
    const task = entry.task;
    if ((task.deferred && !task.done) || completionDay(entry, settings) !== date) return sum;
    return {
      focus: sum.focus + (task.counted ? task.duration : 0),
      learningFocus: sum.learningFocus + (studyWorkload(task) ? task.duration : 0),
    };
  }, { focus: 0, learningFocus: 0 });
}

function capacityIssue(days, settings, date, tasks) {
  const base = focusFor(days, date, settings),
    rules = learningRules(settings, date);
  const addedFocus = tasks.reduce(
    (n, t) => n + (t.counted ? t.duration : 0),
    0,
  );
  const addedLearning = tasks.reduce(
    (n, t) => n + (studyWorkload(t) ? t.duration : 0),
    0,
  );
  if (rules.capacity != null && base.focus + addedFocus > rules.capacity)
    return `Total focus of ${base.focus + addedFocus} minutes exceeds the daily capacity of ${rules.capacity} minutes.`;
  if (
    rules.learningCapacity != null &&
    base.learningFocus + addedLearning > rules.learningCapacity
  )
    return `Study of ${base.learningFocus + addedLearning} minutes exceeds the daily study limit of ${rules.learningCapacity} minutes.`;
  return null;
}

function dependencyFloor(
  entry,
  byId,
  placements,
  settings,
  ignore = new Set(),
) {
  let earliest = -Infinity;
  for (const dep of entry.task.dependencies || []) {
    const previous = byId.get(dep.id);
    if (!previous || ignore.has(previous.task.id)) continue;
    const placed = placements.get(previous.task.id) || previous;
    earliest = Math.max(
      earliest,
      predecessorEnd(placed, settings) + (dep.gap || 0) * MINUTE,
    );
  }
  return earliest;
}

function clockFit(entry, settings, rules) {
  const length = entry.task.duration + rest(entry.task, settings);
  if (
    entry.task.start + length > 1440 ||
    !rules.windows.some(
      ([a, b]) => entry.task.start >= a && entry.task.start + length <= b,
    )
  )
    return false;
  const end = dateParts(occupied(entry, settings).end, settings.timeZone);
  return (
    end.minute === (entry.task.start + length) % 1440 &&
    (end.date === entry.date ||
      (end.date === addDays(entry.date, 1) && end.minute === 0))
  );
}

/** Find a complete slot using obstacle boundaries, not minute-by-minute calendar scanning. */
function findSlot(
  entry,
  date,
  settings,
  blocks,
  earliest = -Infinity,
  latest = Infinity,
  backwards = false,
) {
  const rules = learningTask(entry.task)
    ? learningRules(settings, date)
    : rulesForDate(settings, date);
  const length = entry.task.duration + rest(entry.task, settings);
  const windows = backwards ? [...rules.windows].reverse() : rules.windows;
  for (const [a, b] of windows) {
    let minute = backwards ? b - length : a;
    if (Number.isFinite(earliest)) {
      const p = dateParts(earliest, settings.timeZone);
      if (p.date > date) continue;
      if (p.date === date) minute = Math.max(minute, p.minute);
    }
    if (Number.isFinite(latest)) {
      const p = dateParts(latest, settings.timeZone);
      if (p.date < date) continue;
      if (p.date === date) minute = Math.min(minute, p.minute - length);
    }
    for (
      let attempts = 0;
      minute >= a && minute + length <= b && attempts <= 1441;
      attempts++
    ) {
      let candidate, block;
      try {
        candidate = relocated(entry, date, minute, settings);
        block = occupied(candidate, settings);
      } catch {
        minute += backwards ? -1 : 1;
        continue;
      } // DST folds/gaps are rare and explicit.
      if (block.actualStart < earliest) {
        if (backwards) break;
        minute++;
        continue;
      }
      if (block.end > latest) {
        if (!backwards) break;
        minute--;
        continue;
      }
      if (!clockFit(candidate, settings, rules)) {
        minute += backwards ? -1 : 1;
        continue;
      }
      const collision = blocks.filter((other) => overlap(block, other));
      if (!collision.length) return candidate;
      const boundary = backwards
        ? Math.min(...collision.map((other) => other.actualStart - spacing(block, other) * MINUTE - entry.task.duration * MINUTE))
        : Math.max(...collision.map((other) => other.actualEnd + spacing(other, block) * MINUTE));
      const p = dateParts(boundary, settings.timeZone);
      if ((backwards && p.date < date) || (!backwards && p.date > date)) break;
      minute = backwards
        ? Math.min(minute - 1, p.minute)
        : Math.max(minute + 1, p.minute);
    }
  }
  return null;
}

function packageUnits(entries, anchor, byId) {
  const chosen = new Set(),
    anchorIndex = entries.indexOf(anchor);
  const includePackageTail = (entry) => {
    for (const other of entries)
      if (
        learningTask(other.task) &&
        other.task.planId === entry.task.planId &&
        other.task.packageOrder >= entry.task.packageOrder &&
        active(other.task)
      )
        chosen.add(other.task.id);
  };
  if (learningTask(anchor.task)) includePackageTail(anchor);
  else {
    const group = anchor.task.groupId || anchor.task.planId;
    for (let i = anchorIndex; i < entries.length; i++) {
      const other = entries[i];
      const related = group
        ? (other.task.groupId || other.task.planId) === group
        : other.date === anchor.date && !learningTask(other.task);
      if (related && movable(other.task)) chosen.add(other.task.id);
    }
    chosen.add(anchor.task.id);
  }
  let expanded;
  do {
    expanded = false;
    for (const entry of entries) {
      if (!active(entry.task) || chosen.has(entry.task.id)) continue;
      if (
        (entry.task.dependencies || []).some((dep) =>
          chosen.has(byId.get(dep.id)?.task.id),
        )
      ) {
        if (learningTask(entry.task)) includePackageTail(entry);
        else if (movable(entry.task)) chosen.add(entry.task.id);
        expanded = true;
      }
    }
  } while (
    expanded &&
    entries.some(
      (entry) =>
        movable(entry.task) &&
        !chosen.has(entry.task.id) &&
        (entry.task.dependencies || []).some((dep) =>
          chosen.has(byId.get(dep.id)?.task.id),
        ),
    )
  );
  const units = [],
    packages = new Map();
  for (const entry of entries) {
    if (!chosen.has(entry.task.id)) continue;
    if (!learningTask(entry.task))
      units.push({ key: entry.task.id, study: false, members: [entry] });
    else {
      const key = identity(entry.task);
      if (!packages.has(key)) {
        const unit = { key, study: true, members: [] };
        packages.set(key, unit);
        units.push(unit);
      }
      packages.get(key).members.push(entry);
    }
  }
  for (const unit of units)
    if (unit.study)
      unit.members.sort(
        (a, b) => a.task.packageTaskOrder - b.task.packageTaskOrder,
      );
  // Within a learning plan package order is immutable even after partially completed packages span dates.
  units.sort((a, b) => {
    if (
      a.study &&
      b.study &&
      a.members[0].task.planId === b.members[0].task.planId
    )
      return a.members[0].task.packageOrder - b.members[0].task.packageOrder;
    return entries.indexOf(a.members[0]) - entries.indexOf(b.members[0]);
  });
  const anchorUnit = units.find((unit) =>
    unit.members.some((entry) => entry.task.id === anchor.task.id),
  );
  return { units, chosen, anchorUnit };
}

function dailyTotals(days, settings, dates = []) {
  return [...new Set([...Object.keys(days), ...dates, ...entriesOf(days).filter(e=>e.task.done).map(e=>completionDay(e,settings))])].sort().map((date) => ({
    date,
    ...focusFor(days, date, settings),
    capacity: rulesForDate(settings, date).capacity,
    learningCapacity: learningRules(settings, date).learningCapacity,
  }));
}

/** Express an intent once: the system selects related successors and learning packages. */
function calculateIntent(days, configured = {}, options = {}) {
  const settings = {
    ...configured,
    timeZone: configured.timeZone || "America/Los_Angeles",
  };
  let original;
  const blank = {
    status: "error",
    days: structuredClone(days),
    changes: [],
    conflicts: [],
    unscheduled: [],
    daily: [],
    range: null,
    exactTarget: { date: options.targetDate, start: options.targetStart },
    summary: {
      packagesMoved: 0,
      tasksMoved: 0,
      lastDate: null,
      unchangedFixed: 0,
      skippedDates: [],
    },
  };
  try {
    original = normalizeLearningDays(days);
  } catch (error) {
    return { ...blank, conflicts: [failMessage(error.message)] };
  }
  const result = { ...blank, days: original };
  const checked = validateInputs(original, settings);
  if (checked.conflicts.length)
    return { ...result, conflicts: checked.conflicts };
  const entries = entriesOf(original),
    byId = new Map();
  for (const entry of entries) {
    byId.set(entry.task.id, entry);
    if (entry.task.uid) byId.set(entry.task.uid, entry);
  }
  const anchor = byId.get(options.taskId);
  if (!anchor || !movable(anchor.task))
    return {
      ...result,
      conflicts: [
        failMessage(
          "Select an unfinished task that Shunri can manage and that is neither locked nor deferred.",
          [options.taskId].filter(Boolean),
        ),
      ],
    };
  if (
    !validDate(options.targetDate) ||
    !Number.isInteger(options.targetStart) ||
    options.targetStart < 0 ||
    options.targetStart > 1439
  )
    return {
      ...result,
      conflicts: [failMessage("Enter a valid target date and time.", [anchor.task.id])],
    };
  let requestedInstant;
  try {
    requestedInstant = wallInstant(
      options.targetDate,
      // Before opening, start the automatic search at the hard window. This
      // avoids converting a repeated/nonexistent DST clock minute into an
      // exact appointment; explicit user times still pass through unchanged.
      options.startFromNow ? Math.max(540, options.targetStart) : options.targetStart,
      settings.timeZone,
    );
  } catch (error) {
    return {
      ...result,
      conflicts: [failMessage(error.message, [anchor.task.id])],
    };
  }
  const { units, chosen, anchorUnit } = packageUnits(entries, anchor, byId);
  result.summary.unchangedFixed = entries.filter(
    (entry) =>
      isActivity(entry.task) ||
      entry.task.locked ||
      entry.task.timeLocked ||
      entry.task.externalReadOnly,
  ).length;
  if (!options.startFromNow && anchor.date === options.targetDate && anchor.task.start === options.targetStart) {
    return {
      ...result,
      status: "ok",
      noEffect: true,
      daily: dailyTotals(original, settings),
      range: { from: anchor.date, to: anchor.date },
      summary: { ...result.summary, lastDate: anchor.date },
      packages: packageSummary(original),
    };
  }
  const fail = (message, ids = [anchor.task.id], unit = anchorUnit) => ({
    ...result,
    status: "conflict",
    conflicts: [failMessage(message, ids)],
    unscheduled: unit
      ? unit.members.map((entry) => ({
          id: entry.task.id,
          title: entry.task.title,
          reason: message,
        }))
      : [],
  });
  const relevant = new Set(chosen);
  const includePredecessors = (entry) => {
    for (const dep of entry.task.dependencies || []) {
      const previous = byId.get(dep.id);
      if (!previous || relevant.has(previous.task.id)) continue;
      relevant.add(previous.task.id);
      includePredecessors(previous);
    }
  };
  entries.filter(entry => chosen.has(entry.task.id)).forEach(includePredecessors);
  for (const entry of entries.filter(entry => relevant.has(entry.task.id))) {
    const issue = semanticIssue(entry);
    if (issue) return fail(issue.message, issue.ids);
  }
  for (const unit of units) {
    const immovable = unit.members.find((entry) => !movable(entry.task));
    if (immovable)
      return fail(
        `“${immovable.task.title}” is locked or cannot be edited by Shunri, so this study day cannot move as a group. The event stays unchanged.`,
        [immovable.task.id],
        unit,
      );
    if (unit.study) {
      const total = unit.members.reduce((sum, entry) => sum + entry.task.duration, 0);
      const limit = globalLearningCapacity(settings);
      if (total > limit) return fail(
        `The remaining study on the original day containing “${unit.members[0].task.title}” totals ${total} minutes, above the ${limit}-minute daily study limit. The content will not be split and the limit will not be silently increased.`,
        unit.members.map(entry => entry.task.id), unit,
      );
    }
  }
  const ordered = units.flatMap((unit) => unit.members),
    positions = new Map(ordered.map((entry, index) => [entry.task.id, index]));
  for (const entry of ordered)
    for (const dep of entry.task.dependencies || []) {
      const previous = byId.get(dep.id);
      if (
        chosen.has(previous.task.id) &&
        positions.get(previous.task.id) >= positions.get(entry.task.id)
      )
        return fail(
          `The prerequisite “${previous.task.title}” comes after “${entry.task.title}”, which conflicts with the original study order. Nothing will be dropped or silently reordered.`,
          [entry.task.id, previous.task.id],
        );
    }
  const draft = structuredClone(original);
  for (const date of Object.keys(draft))
    draft[date] = draft[date].filter((task) => !chosen.has(task.id));
  const blocks = entries
    .filter((entry) => !entry.task.deferred && !chosen.has(entry.task.id))
    .map((entry) => occupied(entry, settings));
  const placements = new Map(),
    skipped = [],
    packageDay = new Map();
  let cursor = requestedInstant;
  const finalDate = addDays(options.targetDate, MAX_DAYS);
  result.range = { from: options.targetDate, to: finalDate };
  const quotaIssue = (unit, date) => {
    if (!unit.study) return null;
    const other = otherPackage(draft, settings, date, unit.members[0].task);
    return other
      ? `This study plan already has another original day package on this date, including completed work. Two days of study will not be merged.`
      : null;
  };
  const accept = (placed) => {
    draft[placed.date] ||= [];
    draft[placed.date].push(placed.task);
    placements.set(placed.task.id, placed);
    blocks.push(occupied(placed, settings));
  };
  function attemptPackage(unit, date, exact = false, fromNow = false) {
    const tasks = unit.members.map((entry) => entry.task),
      rules = learningRules(settings, date);
    if (!rules.windows.length)
      return { reason: "This is a non-study date or has no available study time." };
    const quota = quotaIssue(unit, date),
      capacity = capacityIssue(draft, settings, date, tasks);
    if (quota || capacity) return { reason: quota || capacity };
    const localBlocks = [...blocks],
      localPlacements = new Map(placements),
      out = [];
    const ownIds = new Set(unit.members.map((entry) => entry.task.id));
    const anchorIndex = exact ? unit.members.indexOf(anchor) : -1;
    let floor = exact
      ? requestedInstant
      : Math.max(
          cursor,
          !fromNow && unit.members[0].date === date
            ? wallInstant(date, unit.members[0].task.start, settings.timeZone)
            : -Infinity,
        );
    // An exact time or today’s explicit now intent may request a morning start.
    // Future automatic packages look from 11:00 (or a later saved preference), then advance to
    // the next allowed day instead of falling back into 09:00–11:00.
    const automaticStart = Math.max(660, settings.learningPreferredStart ?? 660);
    if (!exact && (!fromNow || date > options.targetDate)) floor = Math.max(floor,
      wallInstant(date, automaticStart, settings.timeZone));
    if (exact) {
      const exactEntry = relocated(anchor, date, options.targetStart, settings);
      const occupiedAnchor = occupied(exactEntry, settings);
      if (!clockFit(exactEntry, settings, rules))
        return {
          reason:
            "The requested time cannot fit the complete task and required rest, or crosses a daylight-saving or daily-end boundary.",
        };
      const collision = localBlocks.find((block) =>
        overlap(occupiedAnchor, block),
      );
      if (collision)
        return {
          reason: `The requested time conflicts with “${collision.entry.task.title}” or its protection period.`,
        };
      const required = dependencyFloor(
        anchor,
        byId,
        localPlacements,
        settings,
        ownIds,
      );
      if (requestedInstant < required)
        return { reason: "The requested time is before an external prerequisite and its required gap have finished." };
      out.push(exactEntry);
      localPlacements.set(anchor.task.id, exactEntry);
      localBlocks.push(occupiedAnchor);
      let upper = requestedInstant;
      for (let index = anchorIndex - 1; index >= 0; index--) {
        const entry = unit.members[index];
        let latest = upper;
        for (const next of unit.members)
          for (const dep of next.task.dependencies || []) {
            if (
              byId.get(dep.id)?.task.id !== entry.task.id ||
              !localPlacements.has(next.task.id)
            )
              continue;
            latest = Math.min(
              latest,
              occupied(localPlacements.get(next.task.id), settings)
                .actualStart -
                (dep.gap || 0) * MINUTE +
                rest(entry.task, settings) * MINUTE,
            );
          }
        const requiredBefore = dependencyFloor(
          entry,
          byId,
          localPlacements,
          settings,
          ownIds,
        );
        const placed = findSlot(
          entry,
          date,
          settings,
          localBlocks,
          requiredBefore,
          latest,
          true,
        );
        if (!placed)
          return {
            reason: `The prerequisite “${entry.task.title}” and its required gap do not fit before the requested time. The prerequisite will not be dropped and the requested time will not change.`,
          };
        localPlacements.set(entry.task.id, placed);
        localBlocks.push(occupied(placed, settings));
        out.push(placed);
        upper = occupied(placed, settings).actualStart;
      }
      const requiredAfterBefore = dependencyFloor(
        anchor,
        byId,
        localPlacements,
        settings,
      );
      if (requestedInstant < requiredAfterBefore)
        return { reason: "The requested time conflicts with a prerequisite and its required gap within this package." };
      floor = occupiedAnchor.end;
    }
    for (
      let index = exact ? anchorIndex + 1 : 0;
      index < unit.members.length;
      index++
    ) {
      const entry = unit.members[index];
      const required = dependencyFloor(entry, byId, localPlacements, settings);
      const oldFloor =
        entry.date === date && !exact && !fromNow
          ? wallInstant(date, entry.task.start, settings.timeZone)
          : -Infinity;
      const placed = findSlot(
        entry,
        date,
        settings,
        localBlocks,
        Math.max(floor, required, oldFloor),
      );
      if (!placed)
        return {
          reason: `There is no complete gap after ${exact ? "the requested time" : `${String(Math.floor(automaticStart / 60)).padStart(2, "0")}:${String(automaticStart % 60).padStart(2, "0")}`} for all of this day’s study, including “${entry.task.title}” and its required gap. It will not be split or squeezed into the next day.`,
        };
      localPlacements.set(entry.task.id, placed);
      localBlocks.push(occupied(placed, settings));
      out.push(placed);
      floor = occupied(placed, settings).end;
    }
    // Backward packing must satisfy every internal edge, not only the anchor's direct edges.
    for (const placed of out)
      if (
        occupied(placed, settings).actualStart <
        dependencyFloor(placed, byId, localPlacements, settings)
      )
        return {
          reason: `The required gap after the prerequisite “${placed.task.title}” does not fit before the requested time. Choose a later time.`,
        };
    return {
      placed: out.sort(
        (a, b) => a.task.packageTaskOrder - b.task.packageTaskOrder,
      ),
    };
  }
  let recommendationReason = "";
  for (const unit of units) {
    const isAnchor = unit === anchorUnit, fromNow = isAnchor && options.startFromNow;
    const exact = isAnchor && !fromNow;
    if (unit.study) {
      const planId = unit.members[0].task.planId;
      let date = isAnchor
        ? options.targetDate
        : packageDay.has(planId)
          ? addDays(packageDay.get(planId), 1)
          : dateParts(cursor, settings.timeZone).date;
      if (!isAnchor)
        date = [date, ...unit.members.map((entry) => entry.date)].sort().at(-1);
      if (fromNow) {
        recommendationReason = (options.targetStart < 540 ? "The daily scheduling window has not opened yet." : attemptPackage(unit, date, true).reason) ||
          (unit.members.indexOf(anchor) > 0 ? "Schedule the unfinished prerequisite study in this package from now first." : "");
      }
      let attempted = null;
      for (; date <= finalDate; date = addDays(date, 1)) {
        attempted = attemptPackage(unit, date, exact, fromNow);
        if (attempted.placed) break;
        if (exact)
          return fail(
            `The requested time on ${date} cannot be used: ${attempted.reason}`,
            unit.members.map((entry) => entry.task.id),
            unit,
          );
        skipped.push({
          date,
          reason: attempted.reason,
          packageId: unit.members[0].task.packageId,
        });
      }
      if (!attempted?.placed)
        return fail(
          `No date within the next ten years can fit all remaining study from this day: ${attempted?.reason || "No date is available."}`,
          unit.members.map((entry) => entry.task.id),
          unit,
        );
      attempted.placed.forEach(accept);
      packageDay.set(planId, date);
      cursor = Math.max(
        ...attempted.placed.map((entry) => occupied(entry, settings).end),
      );
    } else {
      const entry = unit.members[0];
      if (fromNow && options.targetStart < 540) recommendationReason = "The daily scheduling window has not opened yet.";
      else if (fromNow) {
        const block = occupied(relocated(entry, options.targetDate, options.targetStart, settings), settings);
        const collision = blocks.find(other => overlap(block, other));
        recommendationReason = collision ? `The current time conflicts with “${collision.entry.task.title}” or its protection period.` : "The current gap cannot fit the complete task and required gap.";
      }
      if (exact) {
        const placed = relocated(
          entry,
          options.targetDate,
          options.targetStart,
          settings,
        );
        const rules = rulesForDate(settings, placed.date),
          block = occupied(placed, settings);
        const issue = capacityIssue(draft, settings, placed.date, [entry.task]);
        const collision = blocks.find((other) => overlap(block, other));
        if (
          !clockFit(placed, settings, rules) ||
          issue ||
          collision ||
          requestedInstant < dependencyFloor(entry, byId, placements, settings)
        )
          return fail(
            issue ||
              (collision
                ? `The requested time conflicts with “${collision.entry.task.title}” or its protection period.`
                : "The requested time conflicts with availability, the end boundary, or a prerequisite. It will not be silently changed."),
          );
        accept(placed);
        cursor = block.end;
      } else {
        const earliest = Math.max(
          cursor,
          fromNow ? -Infinity : wallInstant(entry.date, entry.task.start, settings.timeZone),
          dependencyFloor(entry, byId, placements, settings),
        );
        let placed = null,
          reason = "There is no continuous gap for the complete task and required rest.";
        for (
          let date = dateParts(earliest, settings.timeZone).date;
          date <= finalDate;
          date = addDays(date, 1)
        ) {
          const issue = capacityIssue(draft, settings, date, [entry.task]);
          if (issue) {
            reason = issue;
            continue;
          }
          placed = findSlot(entry, date, settings, blocks, earliest);
          if (placed) break;
        }
        if (!placed)
          return fail(
            `“${entry.task.title}” could not be scheduled within the next ten years: ${reason}`,
            [entry.task.id],
            unit,
          );
        accept(placed);
        cursor = occupied(placed, settings).end;
      }
    }
  }
  // Recheck immutable descendants. Completed/locked/external events never get moved to hide a broken edge.
  const proposedById = new Map();
  for (const entry of entriesOf(draft)) {
    proposedById.set(entry.task.id, entry);
    if (entry.task.uid) proposedById.set(entry.task.uid, entry);
  }
  for (const entry of entriesOf(draft).filter(
    (entry) => !entry.task.deferred,
  )) {
    for (const dep of entry.task.dependencies || []) {
      const previous = proposedById.get(dep.id);
      if (!chosen.has(entry.task.id) && !chosen.has(previous.task.id)) continue;
      const required =
        predecessorEnd(previous, settings) + (dep.gap || 0) * MINUTE;
      if (occupied(entry, settings).actualStart < required)
        return fail(
          `“${entry.task.title}” must start at least ${dep.gap || 0} minutes after “${previous.task.title}” ends. ${movable(entry.task) ? "Keep the original order." : "It is completed, locked, or not editable and stays unchanged."}`,
          [entry.task.id, previous.task.id],
        );
    }
  }
  const originalPositions = new Map(
    entries.map((entry, index) => [entry.task.id, index]),
  );
  for (const tasks of Object.values(draft))
    tasks.sort(
      (a, b) =>
        a.start - b.start ||
        originalPositions.get(a.id) - originalPositions.get(b.id),
    );
  const changes = ordered.flatMap((entry) => {
    const placed = placements.get(entry.task.id);
    return placed &&
      (placed.date !== entry.date || placed.task.start !== entry.task.start)
      ? [
          {
            id: entry.task.id,
            title: entry.task.title,
            packageId: entry.task.packageId || null,
            from: { date: entry.date, start: entry.task.start },
            to: { date: placed.date, start: placed.task.start },
            rest: entry.task.rest || 0,
            necessaryRest: rest(entry.task, settings),
            reason: learningTask(entry.task)
              ? "Keep this day’s study content, order, and prerequisites together, and move it to an available study day."
              : "Adjust the related later items in their original order.",
          },
        ]
      : [];
  });
  const packageIds = new Set(
    changes
      .filter((change) => change.packageId)
      .map((change) => identity(byId.get(change.id).task)),
  );
  const lastDate = placements.size
    ? [...placements.values()]
        .map((entry) => entry.date)
        .sort()
        .at(-1)
    : options.targetDate;
  return {
    ...result,
    status: "ok",
    days: draft,
    changes,
    ...(options.startFromNow ? {
      noEffect: changes.length === 0,
      exactTarget: { date: placements.get(anchor.task.id).date, start: placements.get(anchor.task.id).task.start },
      recommendation: { requested: { date: options.targetDate, start: options.targetStart },
        reason: placements.get(anchor.task.id).date === options.targetDate && placements.get(anchor.task.id).task.start === options.targetStart ? "" : recommendationReason },
    } : {}),
    daily: dailyTotals(draft, settings),
    range: {
      from: [
        options.targetDate,
        ...changes.map((change) => change.from.date),
      ].sort()[0],
      to: lastDate,
    },
    summary: {
      packagesMoved: packageIds.size,
      tasksMoved: changes.length,
      lastDate,
      unchangedFixed: result.summary.unchangedFixed,
      skippedDates: skipped,
    },
    packages: packageSummary(draft),
  };
}

/** A conflict offers at most two fully calculated options, never an implicit fallback. */
export function moveIntent(days, configured = {}, options = {}) {
  const result = calculateIntent(days, configured, options);
  if (options.startFromNow || result.status !== "conflict" || !validDate(options.targetDate) ||
    !Number.isInteger(options.targetStart)) return { ...result, alternatives: [] };
  const settings = { ...configured, timeZone: configured.timeZone || "America/Los_Angeles" };
  const normalized = result.days, entries = entriesOf(normalized), byId = new Map();
  for (const entry of entries) {
    byId.set(entry.task.id, entry);
    if (entry.task.uid) byId.set(entry.task.uid, entry);
  }
  const anchor = byId.get(options.taskId);
  if (!anchor || !movable(anchor.task)) return { ...result, alternatives: [] };
  const { units, chosen, anchorUnit } = packageUnits(entries, anchor, byId);
  if (!anchorUnit || anchorUnit.members.some(entry => !movable(entry.task)))
    return { ...result, alternatives: [] };
  if (units.some(unit => unit.study && unit.members.reduce((sum, entry) => sum + entry.task.duration, 0) > globalLearningCapacity(settings)))
    return { ...result, alternatives: [] };
  const blocks = entries.filter(entry => !entry.task.deferred && !chosen.has(entry.task.id))
    .map(entry => occupied(entry, settings));
  const draft = structuredClone(normalized);
  for (const date of Object.keys(draft)) draft[date] = draft[date].filter(task => !chosen.has(task.id));
  const prefix = anchorUnit.members.slice(0, anchorUnit.members.indexOf(anchor))
    .reduce((sum, entry) => sum + entry.task.duration + rest(entry.task, settings), 0);
  const candidates = [], seen = new Set();
  const add = (date, start) => {
    if (!validDate(date) || !Number.isInteger(start) || start < 0 || start >= 1440 ||
      (date === options.targetDate && start <= options.targetStart)) return;
    const key = `${date}/${start}`;
    if (seen.has(key)) return;
    seen.add(key); candidates.push({ date, start });
  };
  const rules = learningTask(anchor.task) ? learningRules(settings, options.targetDate) : rulesForDate(settings, options.targetDate);
  for (const [start] of rules.windows) add(options.targetDate, start + prefix);
  for (const extra of [20, 30, 60, 90, 120, 180]) add(options.targetDate, options.targetStart + extra);
  for (const block of blocks) {
    if (block.nonBlocking) continue;
    const candidate = occupied(relocated(anchor, options.targetDate, options.targetStart, settings), settings);
    const after = dateParts(block.actualEnd + spacing(block, candidate) * MINUTE, settings.timeZone);
    if (after.date === options.targetDate) add(after.date, after.minute + prefix);
  }
  const required = dependencyFloor(anchor, byId, new Map(), settings,
    new Set(anchorUnit.members.map(entry => entry.task.id)));
  if (Number.isFinite(required)) {
    const after = dateParts(required, settings.timeZone);
    if (after.date >= options.targetDate) add(after.date, after.minute + prefix);
  }
  // Look for allowed dates without invoking the scheduler on every closed or occupied day.
  // A fixed bound and a separate 18-calculation budget prevent recursive searches.
  for (let day = 1; day <= 366; day++) {
    const date = addDays(options.targetDate, day), available = learningTask(anchor.task)
      ? learningRules(settings, date) : rulesForDate(settings, date);
    if (!available.windows.length) continue;
    add(date, learningTask(anchor.task) ? (settings.learningPreferredStart ?? 660) : options.targetStart);
    for (const [start] of available.windows) add(date, start + prefix);
  }
  const preference = candidate => learningTask(anchor.task) && options.targetStart >= (settings.learningPreferredStart ?? 660) ? Math.abs(candidate.start - (settings.learningPreferredStart ?? 660)) : 0;
  candidates.sort((a,b)=>a.date.localeCompare(b.date)||preference(a)-preference(b)||a.start-b.start);
  const alternatives = [], sameDay = [], future = [];
  let trials = 0;
  for (const candidate of candidates) {
    if (trials >= 18 || (sameDay.length && future.length)) break;
    if (candidate.date === options.targetDate && sameDay.length) continue;
    const local = relocated(anchor, candidate.date, candidate.start, settings);
    const available = learningTask(anchor.task) ? learningRules(settings, candidate.date) : rulesForDate(settings, candidate.date);
    const block = occupied(local, settings);
    if (!clockFit(local, settings, available) || blocks.some(other=>overlap(block,other)) ||
      learningTask(anchor.task) && otherPackage(draft, settings, candidate.date, anchor.task) ||
      capacityIssue(draft, settings, candidate.date, anchorUnit.members.map(entry=>entry.task))) continue;
    trials++;
    const calculated = calculateIntent(days, configured, { ...options, targetDate: candidate.date, targetStart: candidate.start });
    if (calculated.status !== "ok" || calculated.noEffect) continue;
    const time = `${String(Math.floor(candidate.start/60)).padStart(2,"0")}:${String(candidate.start%60).padStart(2,"0")}`;
    const choice = { label: `Move to ${candidate.date} ${time}`, targetDate: candidate.date,
      targetStart: candidate.start, summary: calculated.summary };
    (candidate.date === options.targetDate ? sameDay : future).push(choice);
    if (future.length >= 2 && !sameDay.length) break;
  }
  alternatives.push(...sameDay.slice(0,1), ...future.slice(0,sameDay.length ? 1 : 2));
  return { ...result, alternatives: alternatives.slice(0,2) };
}

/** Validate a local draft while treating imported multi-day events as real, immutable occupations. */
export function validateIntentDays(days, configured = {}) {
  const settings = {
    ...configured,
    timeZone: configured.timeZone || "America/Los_Angeles",
  };
  let draft;
  try {
    draft = normalizeLearningDays(days);
  } catch (error) {
    return {
      status: "error",
      conflicts: [failMessage(error.message)],
      daily: [],
      unscheduled: [],
    };
  }
  const checked = validateInputs(draft, settings);
  if (checked.conflicts.length)
    return {
      status: "error",
      conflicts: checked.conflicts,
      daily: [],
      unscheduled: [],
    };
  const entries = entriesOf(draft),
    byId = new Map(),
    blocks = entries
      .filter((entry) => !entry.task.deferred)
      .map((entry) => occupied(entry, settings));
  for (const entry of entries) {
    byId.set(entry.task.id, entry);
    if (entry.task.uid) byId.set(entry.task.uid, entry);
  }
  const conflicts = [];
  for (const entry of entries) {
    const issue = semanticIssue(entry);
    if (issue) conflicts.push(issue);
  }
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index],
      { task, date } = block.entry;
    if (!task.done && !task.externalReadOnly && !isActivity(task)) {
      const rules = learningTask(task)
        ? learningRules(settings, date)
        : rulesForDate(settings, date);
      if (!clockFit(block.entry, settings, rules))
        conflicts.push(
          failMessage(
            `${task.title} and its required rest do not fit the day’s availability or cross a daily-end or daylight-saving boundary.`,
            [task.id],
          ),
        );
    }
    for (const other of blocks.slice(index + 1)) {
      // Existing read-only/fixed events may overlap each other in Google. Do not rewrite or reject them.
      if (!movable(task) && !movable(other.entry.task)) continue;
      if (overlap(block, other))
        conflicts.push(
          failMessage(
            `${task.title} conflicts with the actual occupation or protection period of “${other.entry.task.title}”.`,
            [task.id, other.entry.task.id],
          ),
        );
    }
    for (const dep of task.dependencies || []) {
      const previous = byId.get(dep.id);
      const required =
        predecessorEnd(previous, settings) + (dep.gap || 0) * MINUTE;
      if (block.actualStart < required)
        conflicts.push(
          failMessage(
            `${task.title} must start at least ${dep.gap || 0} minutes after “${previous.task.title}” ends.`,
            [task.id, previous.task.id],
          ),
        );
    }
  }
  const quota = new Map();
  for (const { date, task } of packageOccupations(draft, settings)) {
    const key = JSON.stringify([task.planId, date]);
    if (quota.has(key) && quota.get(key) !== task.packageId)
      conflicts.push(
        failMessage(
          `${date} contains two original day packages from the same study plan, including completed work. Two days of study cannot be merged.`,
          [task.id],
        ),
      );
    quota.set(key, task.packageId);
  }
  const daily = dailyTotals(draft, settings);
  for (const day of daily) {
    if (day.capacity != null && day.focus > day.capacity)
      conflicts.push(
        { ...failMessage(`${day.date}: ${day.focus} minutes of focus exceeds the ${day.capacity}-minute capacity.`), kind: 'daily-capacity', date: day.date, total: day.focus, limit: day.capacity },
      );
    if (
      day.learningCapacity != null &&
      day.learningFocus > day.learningCapacity
    )
      conflicts.push(
        { ...failMessage(`${day.date}: ${day.learningFocus} minutes of study exceeds the ${day.learningCapacity}-minute study limit.`), kind: 'learning-capacity', date: day.date, total: day.learningFocus, limit: day.learningCapacity },
      );
  }
  return {
    status: conflicts.length ? "conflict" : "ok",
    conflicts,
    daily,
    unscheduled: [],
  };
}
