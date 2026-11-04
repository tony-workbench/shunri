import {
  addDays,
  dateParts,
  validDate,
  wallInstant,
  weekday,
  MINUTE,
} from "./time.js";
import { learningTask } from "./learning.js";

export function isActivity(task) {
  return task.type === "activity" || (task.type == null && task.locked);
}
export function necessaryRest(task, settings = {}) {
  return isActivity(task) ? 0 : Math.max(task.rest || 0,
    learningTask(task) ? (settings.learningMinGap ?? 20) : (settings.minGap || 0));
}
const keyOf = (task) => task.id;
const movable = (task) =>
  !task.done && !task.locked && !task.timeLocked && !task.deferred && !isActivity(task);
const intersects = (a, b) => a.start < b.end && b.start < a.end;
const allTasks = (days) =>
  Object.entries(days)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([date, tasks]) =>
      tasks.map((task, index) => ({ date, task, index })),
    );

export function rulesForDate(settings = {}, date) {
  const specific = settings.dates?.[date] || {};
  const boundaryStart = settings.dayStart ?? 540;
  const boundaryEnd = settings.dayEnd ?? 1380;
  const dayStart = Math.max(boundaryStart, specific.dayStart ?? boundaryStart);
  const dayEnd = Math.min(boundaryEnd, specific.dayEnd ?? boundaryEnd);
  const configured = specific.windows ??
    settings.weekly?.[weekday(date)] ?? [[dayStart, dayEnd]];
  const windows = specific.closed
    ? []
    : configured
        .map((window) => {
          const [start, end] = Array.isArray(window)
            ? window
            : [window.start, window.end];
          return [Math.max(start, dayStart), Math.min(end, dayEnd)];
        })
        .filter(([start, end]) => end > start)
        .sort((a, b) => a[0] - b[0]);
  return {
    windows,
    dayStart,
    dayEnd,
    capacity:
      specific.capacity !== undefined
        ? specific.capacity
        : (settings.capacity ?? null),
    closed: Boolean(specific.closed),
    timeZone: settings.timeZone || "America/Los_Angeles",
  };
}

function interval(entry, settings) {
  const { task, date } = entry;
  const start = wallInstant(
    date,
    task.start,
    settings.timeZone || "America/Los_Angeles",
  );
  if (isActivity(task))
    return {
      start:
        start - (task.bufferBefore ?? settings.bufferBefore ?? 0) * MINUTE,
      end:
        start +
        (task.duration + (task.bufferAfter ?? settings.bufferAfter ?? 0)) *
          MINUTE,
      actualStart: start,
      actualEnd: start + task.duration * MINUTE,
      entry,
    };
  return {
    start,
    end: start + (task.duration + necessaryRest(task, settings)) * MINUTE,
    actualStart: start,
    actualEnd: start + task.duration * MINUTE,
    entry,
  };
}

function inputCheck(days, settings) {
  const conflicts = [];
  if (!days || typeof days !== "object" || Array.isArray(days))
    return [{ message: "The schedule data is invalid.", ids: [] }];
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return [{ message: "The scheduling rules are invalid.", ids: [] }];
  if (
    !Number.isInteger(settings.dayEnd ?? 1380) ||
    (settings.dayEnd ?? 1380) < 1 ||
    (settings.dayEnd ?? 1380) > 1440 ||
    !Number.isInteger(settings.minGap ?? 0) ||
    (settings.minGap ?? 0) < 0 ||
    (settings.minGap ?? 0) > 1440
  ) {
    conflicts.push({ message: "The daily end time or minimum gap is invalid.", ids: [] });
  }
  try {
    dateParts(Date.now(), settings.timeZone || "America/Los_Angeles");
  } catch {
    conflicts.push({ message: "The time zone is invalid.", ids: [] });
  }
  if (
    settings.weekly != null &&
    (typeof settings.weekly !== "object" || Array.isArray(settings.weekly))
  )
    conflicts.push({ message: "The weekly availability windows are invalid.", ids: [] });
  if (
    settings.dates != null &&
    (typeof settings.dates !== "object" || Array.isArray(settings.dates))
  )
    conflicts.push({ message: "The date-specific rules are invalid.", ids: [] });
  // Validate empty and future dates too: invalid configuration must never become a runtime crash.
  const ruleDates = new Set([
    ...Object.keys(days),
    ...Object.keys(settings.dates || {}),
    ...Array.from({ length: 7 }, (_, index) => addDays("2026-10-11", index)),
  ]);
  for (const date of ruleDates) {
    try {
      if (!validDate(date)) throw new Error("The date is invalid.");
      const specific = settings.dates?.[date] || {};
      if (typeof specific !== "object" || Array.isArray(specific))
        throw new Error("The date rules are invalid.");
      const rules = rulesForDate(settings, date);
      if (
        rules.capacity != null &&
        (!Number.isInteger(rules.capacity) || rules.capacity < 0)
      )
        throw new Error("Capacity must be zero or a positive whole number, or the limit must be disabled.");
      const original = specific.windows ??
        settings.weekly?.[weekday(date)] ?? [[0, rules.dayEnd]];
      if (!Array.isArray(original)) throw new Error("The availability windows are invalid.");
      const windows = original
        .map((w) => (Array.isArray(w) ? w : [w.start, w.end]))
        .sort((a, b) => a[0] - b[0]);
      if (
        windows.some(
          ([a, b], index) =>
            !Number.isInteger(a) ||
            !Number.isInteger(b) ||
            a < 0 ||
            b > 1440 ||
            a >= b ||
            (index && a < windows[index - 1][1]),
        )
      )
        throw new Error("Availability windows must be valid and must not overlap.");
      if (
        !Number.isInteger(rules.dayEnd) ||
        rules.dayEnd < 1 ||
        rules.dayEnd > 1440
      )
        throw new Error("The daily end time is invalid.");
    } catch (error) {
      conflicts.push({ message: `${date}: ${error.message}`, ids: [] });
    }
  }
  const ids = new Set(),
    uids = new Set();
  for (const [date, tasks] of Object.entries(days)) {
    if (!validDate(date) || !Array.isArray(tasks)) {
      conflicts.push({ message: `The date or task list is invalid: ${date}`, ids: [] });
      continue;
    }
    for (const task of tasks) {
      const bad =
        !task ||
        typeof task.id !== "string" ||
        !task.id ||
        typeof task.title !== "string" ||
        !task.title.trim() ||
        !Number.isInteger(task.start) ||
        task.start < 0 ||
        task.start > 1439 ||
        !Number.isInteger(task.duration) ||
        task.duration <= 0 ||
        task.duration > 1440 ||
        !Number.isInteger(task.rest ?? 0) ||
        (task.rest ?? 0) < 0 ||
        (task.rest ?? 0) > 1440 ||
        (task.type != null && !["task", "activity"].includes(task.type)) ||
        ["bufferBefore", "bufferAfter"].some(
          (field) =>
            task[field] != null &&
            (!Number.isInteger(task[field]) ||
              task[field] < 0 ||
              task[field] > 1440),
        );
      if (bad) {
        conflicts.push({
          message: "A task name, time, duration, or protection setting is invalid.",
          ids: [task?.id].filter(Boolean),
        });
        continue;
      }
      if (ids.has(task.id) || (task.uid && uids.has(task.uid)))
        conflicts.push({ message: `Duplicate task ID: ${task.title}`, ids: [task.id] });
      ids.add(task.id);
      if (task.uid) uids.add(task.uid);
      if (
        task.dependencies != null &&
        (!Array.isArray(task.dependencies) ||
          task.dependencies.some(
            (dep) =>
              !dep ||
              typeof dep !== "object" ||
              typeof dep.id !== "string" ||
              !dep.id,
          ))
      )
        conflicts.push({
          message: `Prerequisite settings are invalid: ${task.title}`,
          ids: [task.id],
        });
      if (
        ["done", "locked", "deferred", "counted"].some(
          (field) => task[field] != null && typeof task[field] !== "boolean",
        )
      )
        conflicts.push({
          message: `Task status are invalid: ${task.title}`,
          ids: [task.id],
        });
      try {
        interval({ date, task }, settings);
      } catch (error) {
        conflicts.push({
          message: `${task.title}: ${error.message}`,
          ids: [task.id],
        });
      }
    }
  }
  return conflicts;
}

function dependencyCheck(entries) {
  const conflicts = [],
    byId = new Map();
  for (const entry of entries) {
    byId.set(entry.task.id, entry);
    if (entry.task.uid) byId.set(entry.task.uid, entry);
  }
  for (const entry of entries)
    for (const dep of entry.task.dependencies || []) {
      const previous = byId.get(dep.id);
      if (!previous)
        conflicts.push({
          message: `A prerequisite for ${entry.task.title} is missing. Select it again.`,
          ids: [entry.task.id],
        });
      else if (previous === entry)
        conflicts.push({
          message: `${entry.task.title} cannot depend on itself.`,
          ids: [entry.task.id],
        });
      else if (previous.task.deferred && !entry.task.deferred)
        conflicts.push({
          message: `The prerequisite “${previous.task.title}” for ${entry.task.title} is deferred. Restore it or remove the dependency first.`,
          ids: [entry.task.id, previous.task.id],
        });
      if (
        !Number.isInteger(dep.gap ?? 0) ||
        (dep.gap ?? 0) < 0 ||
        (dep.gap ?? 0) > 525600
      )
        conflicts.push({
          message: `The prerequisite gap for ${entry.task.title} is invalid.`,
          ids: [entry.task.id],
        });
    }
  const visited = new Set(),
    visiting = new Set();
  function visit(entry) {
    if (visiting.has(entry)) {
      conflicts.push({
        message: `A dependency cycle includes ${entry.task.title}.`,
        ids: [entry.task.id],
      });
      return;
    }
    if (visited.has(entry)) return;
    visiting.add(entry);
    for (const dep of entry.task.dependencies || []) {
      const previous = byId.get(dep.id);
      if (previous && previous !== entry) visit(previous);
    }
    visiting.delete(entry);
    visited.add(entry);
  }
  entries.forEach(visit);
  return { conflicts, byId };
}

function totals(days, settings, extraDates = []) {
  return [...new Set([...Object.keys(days), ...extraDates])]
    .sort()
    .map((date) => ({
      date,
      focus: (days[date] || []).reduce(
        (sum, task) =>
          sum + (!task.deferred && task.counted ? task.duration : 0),
        0,
      ),
      capacity: rulesForDate(settings, date).capacity,
    }));
}

export function validatePlan(days, settings = {}) {
  const conflicts = inputCheck(days, settings);
  if (conflicts.length)
    return { status: "error", conflicts, daily: [], unscheduled: [] };
  const entries = allTasks(days),
    dependency = dependencyCheck(entries);
  conflicts.push(...dependency.conflicts);
  const active = entries.filter((entry) => !entry.task.deferred);
  const intervals = active.map((entry) => interval(entry, settings));
  for (let i = 0; i < intervals.length; i++) {
    const current = intervals[i],
      { task, date } = current.entry;
    if (!isActivity(task)) {
      const rest = necessaryRest(task, settings),
        end = dateParts(
          current.end,
          settings.timeZone || "America/Los_Angeles",
        );
      const rules = rulesForDate(settings, date);
      const fits = rules.windows.some(
        ([a, b]) => task.start >= a && task.start + task.duration + rest <= b,
      );
      const clockMismatch =
        end.minute !== (task.start + task.duration + rest) % 1440;
      if (
        !fits ||
        task.start + task.duration + rest > 1440 ||
        (end.date !== date &&
          !(end.date === addDays(date, 1) && end.minute === 0)) ||
        clockMismatch
      ) {
        conflicts.push({
          message: clockMismatch
            ? `${task.title} crosses a daylight-saving change and cannot retain its full local task and rest duration. Choose a start after the change.`
            : `The full task and required rest for ${task.title} do not fit an available window (daily end: minute ${rules.dayEnd}).`,
          ids: [task.id],
        });
      }
    }
    for (let j = i + 1; j < intervals.length; j++) {
      const other = intervals[j];
      // Empty buffer-only overlap is allowed, actual activities must respect each other's protection.
      const collision =
        isActivity(task) && isActivity(other.entry.task)
          ? intersects(
              { start: current.actualStart, end: current.actualEnd },
              other,
            ) ||
            intersects(
              { start: other.actualStart, end: other.actualEnd },
              current,
            )
          : intersects(current, other);
      if (collision)
        conflicts.push({
          message: `${task.title} conflicts with ${other.entry.task.title}, including task time, rest, or fixed protection periods.`,
          ids: [task.id, other.entry.task.id],
        });
    }
    for (const dep of task.dependencies || []) {
      const previous = dependency.byId.get(dep.id);
      if (!previous || previous.task.deferred) continue;
      const earliest =
        interval(previous, settings).actualEnd + (dep.gap || 0) * MINUTE;
      if (current.actualStart < earliest)
        conflicts.push({
          message: `${task.title} must start at least ${dep.gap || 0} minutes after “${previous.task.title}” ends.`,
          ids: [task.id, previous.task.id],
        });
    }
  }
  const daily = totals(days, settings);
  for (const day of daily)
    if (day.capacity != null && day.focus > day.capacity)
      conflicts.push({
        message: `${day.date}: ${day.focus} minutes of focus exceeds the ${day.capacity}-minute capacity.`,
        ids: (days[day.date] || [])
          .filter((task) => task.counted && !task.deferred)
          .map(keyOf),
      });
  return {
    status: conflicts.length ? "conflict" : "ok",
    conflicts,
    daily,
    unscheduled: [],
  };
}

export function plan(days, settings = {}, options = {}) {
  const draft = structuredClone(days);
  const result = {
    status: "error",
    days: draft,
    changes: [],
    conflicts: [],
    unscheduled: [],
    daily: [],
    range: null,
  };
  const badInput = inputCheck(days, settings);
  if (badInput.length) return { ...result, conflicts: badInput };
  const entries = allTasks(days),
    dependency = dependencyCheck(entries);
  if (dependency.conflicts.length)
    return { ...result, conflicts: dependency.conflicts };
  const anchor = entries.find(
    (entry) =>
      entry.task.id === options.anchorId || entry.task.uid === options.anchorId,
  );
  if (!anchor || !movable(anchor.task))
    return {
      ...result,
      conflicts: [
        {
          message: "Select an unfinished ordinary task that is neither locked nor deferred.",
          ids: [options.anchorId].filter(Boolean),
        },
      ],
    };
  const anchorDate = options.date ?? anchor.date;
  const requested = options.start ?? anchor.task.start;
  const searchDays = options.searchDays ?? 30;
  if (
    !validDate(anchorDate) ||
    anchorDate !== anchor.date ||
    !Number.isInteger(requested) ||
    requested < 0 ||
    requested > 1439 ||
    !["same-day", "cross-day"].includes(options.mode ?? "same-day") ||
    !Number.isInteger(searchDays) ||
    searchDays < 0 ||
    searchDays > 366
  ) {
    return {
      ...result,
      conflicts: [
        {
          message: "The target date, start time, or search range is invalid. Use a range from 0 to 366 days.",
          ids: [anchor.task.id],
        },
      ],
    };
  }
  const cross = options.mode === "cross-day";
  const finalDate = cross ? addDays(anchorDate, searchDays) : anchorDate;
  result.range = { from: anchorDate, to: finalDate };
  const selected =
    options.selectedIds == null ? null : new Set(options.selectedIds);
  if (
    selected &&
    !selected.has(anchor.task.id) &&
    !selected.has(anchor.task.uid)
  )
    return {
      ...result,
      conflicts: [
        { message: "The adjustment must include the starting task.", ids: [anchor.task.id] },
      ],
    };
  const anchorIndex = entries.indexOf(anchor);
  const queue = entries.filter(
    (entry, index) =>
      index >= anchorIndex &&
      movable(entry.task) &&
      (cross || entry.date === anchorDate) &&
      (!selected ||
        selected.has(entry.task.id) ||
        selected.has(entry.task.uid)),
  );
  const positions = new Map(queue.map((entry, index) => [entry, index]));
  const originalPositions = new Map(
    entries.map((entry, index) => [entry, index]),
  );
  for (const entry of queue)
    for (const dep of entry.task.dependencies || []) {
      const previous = dependency.byId.get(dep.id);
      if (
        (positions.has(previous) &&
          positions.get(previous) >= positions.get(entry)) ||
        originalPositions.get(previous) >= originalPositions.get(entry)
      )
        result.conflicts.push({
          message: `The prerequisite for ${entry.task.title} comes after it, which conflicts with the original order. Adjust the order or the dependency first.`,
          ids: [entry.task.id, previous.task.id],
        });
    }
  if (result.conflicts.length) return result;
  let cursor;
  try {
    cursor = wallInstant(
      anchorDate,
      Math.max(requested, anchor.task.start),
      settings.timeZone || "America/Los_Angeles",
    );
  } catch (error) {
    return {
      ...result,
      conflicts: [{ message: error.message, ids: [anchor.task.id] }],
    };
  }
  for (const prior of entries.slice(0, anchorIndex))
    if (!prior.task.deferred && !isActivity(prior.task)) {
      cursor = Math.max(cursor, interval(prior, settings).end);
    }
  const movingIds = new Set(queue.map((entry) => entry.task.id));
  for (const date of Object.keys(draft))
    draft[date] = draft[date].filter((task) => !movingIds.has(task.id));
  const blocks = entries
    .filter((entry) => !entry.task.deferred && !movingIds.has(entry.task.id))
    .map((entry) => interval(entry, settings));
  const placements = new Map();
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const entry = queue[queueIndex],
      task = entry.task,
      zone = settings.timeZone || "America/Los_Angeles";
    let earliest = Math.max(cursor, wallInstant(entry.date, task.start, zone));
    let dependencyWait = false;
    for (const dep of task.dependencies || []) {
      const previous = dependency.byId.get(dep.id),
        previousPlacement = placements.get(previous.task.id) || previous;
      const required =
        interval(previousPlacement, settings).actualEnd +
        (dep.gap || 0) * MINUTE;
      if (required > earliest) dependencyWait = true;
      earliest = Math.max(earliest, required);
    }
    let placed = null,
      capacityBlocked = false,
      closedDays = 0,
      availableDays = 0,
      fixedBlocked = false;
    let date = dateParts(earliest, zone).date;
    if (date < anchorDate) date = anchorDate;
    for (; date <= finalDate; date = addDays(date, 1)) {
      const rules = rulesForDate(settings, date);
      if (!rules.windows.length) {
        closedDays++;
        continue;
      }
      availableDays++;
      const focus = (draft[date] || []).reduce(
        (sum, other) =>
          sum + (!other.deferred && other.counted ? other.duration : 0),
        0,
      );
      if (
        task.counted &&
        rules.capacity != null &&
        focus + task.duration > rules.capacity
      ) {
        capacityBlocked = true;
        continue;
      }
      for (const [windowStart, windowEnd] of rules.windows) {
        const length = task.duration + necessaryRest(task, settings);
        if (length > windowEnd - windowStart) continue;
        let startMinute = windowStart;
        if (date === dateParts(earliest, zone).date)
          startMinute = Math.max(startMinute, dateParts(earliest, zone).minute);
        for (; startMinute + length <= windowEnd; startMinute++) {
          let start;
          try {
            start = wallInstant(date, startMinute, zone);
          } catch {
            continue;
          }
          if (start < earliest) continue;
          const candidate = { date, task: { ...task, start: startMinute } };
          const occupied = interval(candidate, settings);
          const endParts = dateParts(occupied.end, zone);
          if (
            endParts.minute !== (startMinute + length) % 1440 ||
            (endParts.date !== date &&
              !(endParts.date === addDays(date, 1) && endParts.minute === 0))
          )
            continue;
          const collision = blocks.find((block) => intersects(occupied, block));
          if (collision) {
            if (isActivity(collision.entry.task)) fixedBlocked = true;
            const end = dateParts(collision.end, zone);
            if (end.date === date && end.minute > startMinute)
              startMinute = end.minute - 1;
            else if (end.date > date) startMinute = windowEnd;
            continue;
          }
          placed = candidate;
          break;
        }
        if (placed) break;
      }
      if (placed) break;
    }
    if (!placed) {
      const reason = capacityBlocked
        ? "Daily capacity is insufficient, including completed and unchanged tasks. Increase capacity or defer work, then try again."
        : dependencyWait && dateParts(earliest, zone).date > finalDate
          ? "The prerequisite and its required gap extend beyond the search range."
          : !availableDays && closedDays
            ? "No date in the search range is available."
            : fixedBlocked
              ? "There is no sufficiently long continuous gap between fixed events and their protection periods."
              : "No continuous gap in the search range can fit the full task and required rest.";
      for (const remaining of queue.slice(queueIndex)) {
        draft[remaining.date] ||= [];
        draft[remaining.date].push(structuredClone(remaining.task));
        result.unscheduled.push({
          id: remaining.task.id,
          title: remaining.task.title,
          reason:
            remaining === entry
              ? reason
              : `The earlier task “${task.title}” could not be scheduled. Its order was preserved and it was not skipped.`,
        });
      }
      break;
    }
    draft[placed.date] ||= [];
    draft[placed.date].push(placed.task);
    placements.set(task.id, placed);
    const occupied = interval(placed, settings);
    blocks.push(occupied);
    cursor = occupied.end;
    if (placed.date !== entry.date || placed.task.start !== task.start)
      result.changes.push({
        id: task.id,
        title: task.title,
        from: { date: entry.date, start: task.start },
        to: { date: placed.date, start: placed.task.start },
        rest: task.rest || 0,
        necessaryRest: necessaryRest(task, settings),
        reason: [
          dependencyWait ? "Waiting for a prerequisite" : "",
          capacityBlocked ? "Daily capacity is full" : "",
          closedDays ? "Skip unavailable dates" : "",
          fixedBlocked ? "Avoid fixed events and protection periods" : "",
          placed.date !== entry.date
            ? "No complete gap is available today; move to a later date"
            : "Move later in the original order",
        ]
          .filter(Boolean)
          .join("; "),
      });
  }
  // Preserve every ID exactly once; chronological order is stable for equal times.
  const originalOrder = new Map(
    entries.map((entry, index) => [entry.task.id, index]),
  );
  for (const tasks of Object.values(draft))
    tasks.sort(
      (a, b) =>
        a.start - b.start || originalOrder.get(a.id) - originalOrder.get(b.id),
    );
  const checked = validatePlan(draft, settings);
  result.conflicts = checked.conflicts;
  result.daily = checked.daily;
  result.status = result.unscheduled.length
    ? cross
      ? "conflict"
      : "overflow"
    : checked.status;
  return result;
}
