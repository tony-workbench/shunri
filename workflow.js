import {
  taskInputError,
} from "./scheduler.js";
import { validateIntentDays as validatePlan } from "./intent-planner.js";
import { rulesForDate } from "./planner.js";
import { dateParts, validDate, weekday } from "./time.js";

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const coreFields = [
  "uid",
  "workId",
  "part",
  "parts",
  "title",
  "start",
  "duration",
  "rest",
  "done",
  "locked",
  "lockSource",
  "manuallyMoved",
  "calendarClassification",
  "calendarRestrictionLock",
  "deferred",
  "archived",
  "bufferBefore",
  "bufferAfter",
  "type",
  "counted",
  "dependencies",
  "tags",
  "planId",
  "packageId",
  "packageOrder",
  "packageOriginDate",
  "packageTaskOrder",
  "calendarOccupation",
  "timeLocked",
  "externalReadOnly",
  "learningWorkload",
  "purpose",
  "notes",
  "note",
  "description",
  "doneAt",
  "completedAt",
  "actualCompletedAt",
  "completedDate",
  "actualCompletedDate",
];
const taskCore = (task) =>
  Object.fromEntries(coreFields.map((field) => [field, task[field]]));
const conflictKey = (conflict) =>
  JSON.stringify([conflict.message, [...(conflict.ids || [])].sort()]);

function completionDate(task, date, settings) {
  if (!task.done) return date;
  if (validDate(task.completedDate)) return task.completedDate;
  const recorded = task.doneAt ?? task.completedAt ?? task.actualCompletedAt;
  const instant =
    typeof recorded === "number"
      ? recorded
      : typeof recorded === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(recorded)
        ? Date.parse(recorded)
        : NaN;
  return Number.isFinite(instant)
    ? dateParts(instant, settings.timeZone || "America/Los_Angeles").date
    : date;
}

/** A matching message alone is insufficient: the same clash can become worse. */
function conflictEvidence(conflict, days, settings) {
  const ids = new Set(conflict.ids || []);
  const mentionedDates = new Set(
    conflict.message.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [],
  );
  const rows = Object.entries(days)
    .flatMap(([date, tasks]) => tasks.map((task) => ({ date, task })))
    .filter(({ date, task }) =>
      ids.size
        ? ids.has(task.id) || ids.has(task.uid)
        : !mentionedDates.size ||
          mentionedDates.has(date) ||
          mentionedDates.has(completionDate(task, date, settings)),
    )
    .sort((a, b) => a.task.id.localeCompare(b.task.id));
  const dates = [
    ...new Set([
      ...mentionedDates,
      ...rows.map((row) => row.date),
      ...rows.map((row) => completionDate(row.task, row.date, settings)),
    ]),
  ].sort();
  return JSON.stringify({
    tasks: rows.map(({ date, task }) => ({
      date,
      id: task.id,
      ...taskCore(task),
    })),
    // Ignore changing Calendar evidence/source metadata, but retain every effective constraint.
    global: Object.fromEntries(
      [
        "dayStart",
        "dayEnd",
        "bufferBefore",
        "bufferAfter",
        "minGap",
        "capacity",
        "learningCapacity",
        "learningMinGap",
        "timeZone",
      ].map((field) => [field, settings[field]]),
    ),
    dates: dates.map((date) => ({
      date,
      base: rulesForDate(settings, date),
      studyWindows:
        settings.learningDates?.[date]?.windows ??
        settings.learningWeekly?.[weekday(date)] ??
        null,
      studyCapacity:
        settings.learningDates?.[date]?.capacity ??
        settings.learningCapacity ??
        150,
      studyClosed: Boolean(
        settings.learningDates?.[date]?.closed ||
          settings.learningClosed?.includes(date),
      ),
    })),
  });
}

function validationBaseline(days, settings) {
  return {
    version: 1,
    conflicts: validatePlan(days, settings).conflicts.map((conflict) => ({
      key: conflictKey(conflict),
      evidence: conflictEvidence(conflict, days, settings),
    })),
  };
}

/** Local mutations must not introduce or worsen violations, including ID-less daily totals.
 * Calendar imports and explicit rule/semantic-only decisions use their own boundaries.
 */
export function validateMutation(beforeDays, afterDays, beforeSettings, afterSettings = beforeSettings) {
  const before = validatePlan(beforeDays, beforeSettings), after = validatePlan(afterDays, afterSettings);
  const baseline = new Map(before.daily.map(day => [day.date, day]));
  const conflicts = after.conflicts.filter(conflict => {
    if (['daily-capacity','learning-capacity'].includes(conflict.kind)) {
      const learning = conflict.kind === 'learning-capacity', prior = baseline.get(conflict.date);
      const total = prior?.[learning ? 'learningFocus' : 'focus'] || 0;
      const limit = prior?.[learning ? 'learningCapacity' : 'capacity'];
      const excess = limit == null ? 0 : Math.max(0,total-limit);
      return conflict.total > total || conflict.total-conflict.limit > excess;
    }
    return !before.conflicts.some(old => conflictKey(old) === conflictKey(conflict) &&
      conflictEvidence(old,beforeDays,beforeSettings) === conflictEvidence(conflict,afterDays,afterSettings));
  }).map(conflict => {
    if (!['daily-capacity','learning-capacity'].includes(conflict.kind))return conflict;
    const learning=conflict.kind==='learning-capacity', prior=baseline.get(conflict.date)?.[learning?'learningFocus':'focus'] || 0;
    return {...conflict,message:`${conflict.date} already has ${prior} minutes of ${learning?'study':'focus'}. ${conflict.total>prior?`This adds ${conflict.total-prior} minutes for ${conflict.total} in total`:`This makes ${conflict.total} minutes in total`}, above the ${conflict.limit}-minute limit.`};
  });
  return {...after,status:conflicts.length ? 'conflict' : 'ok',conflicts,
    existingConflicts:after.conflicts.filter(c=>!conflicts.some(n=>n.kind===c.kind && n.date===c.date && (n.kind || conflictKey(n)===conflictKey(c))))};
}

export function adjustmentRecord(
  beforeDays,
  afterDays,
  beforeSettings,
  afterSettings,
  label,
  ruleSettings,
  options = {},
) {
  const patches = [],
    additions = [],
    removals = [];
  for (const date of new Set([
    ...Object.keys(beforeDays),
    ...Object.keys(afterDays),
  ])) {
    const old = beforeDays[date] || [],
      next = afterDays[date] || [];
    for (const task of old) {
      const changed = next.find((t) => t.id === task.id);
      if (!changed) {
        removals.push({
          date,
          task: structuredClone(task),
          index: old.indexOf(task),
        });
        continue;
      }
      const recordedFields = options.captureSemantic
        ? [
            ...new Set(
              [
                ...coreFields,
                ...Object.keys(task),
                ...Object.keys(changed),
              ].filter(
                (field) =>
                  coreFields.includes(field) ||
                  field.startsWith("semantic") ||
                  [
                    "calendarClassification",
                    "learning",
                    "protectionSource",
                    "readonlyLock",
                    "learningPlanUserDefined",
                    "planSource",
                    "explanation",
                  ].includes(field),
              ),
            ),
          ]
        : coreFields;
      const fields = recordedFields.filter(
        (field) => !equal(task[field], changed[field]),
      );
      if (fields.length)
        patches.push({
          date,
          id: task.id,
          before: Object.fromEntries(
            fields.map((field) => [field, task[field]]),
          ),
          after: Object.fromEntries(
            fields.map((field) => [field, changed[field]]),
          ),
          doneAtConfirmation: changed.done,
          guardAfter: taskCore(changed),
          deletedBefore: fields.filter((field) => task[field] === undefined),
        });
    }
    for (const task of next)
      if (!old.some((t) => t.id === task.id))
        additions.push({ date, task: structuredClone(task) });
  }
  const settings = [];
  for (const date of new Set([
    ...Object.keys(beforeSettings),
    ...Object.keys(afterSettings),
  ])) {
    if (!equal(beforeSettings[date], afterSettings[date]))
      settings.push({
        date,
        before: beforeSettings[date],
        after: afterSettings[date],
      });
  }
  const moves = [];
  for (let i = removals.length - 1; i >= 0; i--) {
    const removal = removals[i],
      j = additions.findIndex((a) => a.task.id === removal.task.id);
    if (j >= 0) {
      const addition = additions.splice(j, 1)[0];
      moves.push({
        from: removal.date,
        to: addition.date,
        index: removal.index,
        before: removal.task,
        after: addition.task,
      });
      removals.splice(i, 1);
    }
  }
  const orders = Object.fromEntries(
    [...new Set([...Object.keys(beforeDays), ...Object.keys(afterDays)])].map(
      (date) => [
        date,
        {
          before: (beforeDays[date] || []).map((t) => t.id),
          after: (afterDays[date] || []).map((t) => t.id),
          existed: date in beforeDays,
        },
      ],
    ),
  );
  moves.sort((a, b) => a.from.localeCompare(b.from) || a.index - b.index);
  return {
    label,
    patches,
    additions,
    removals,
    moves,
    settings,
    orders,
    ...(ruleSettings
      ? { validationBaseline: validationBaseline(beforeDays, ruleSettings) }
      : {}),
  };
}

/** Undo only affected fields, preserving later additions, completion and Calendar links. */
export function undoAdjustment(data) {
  const action = data.undo;
  if (!action) return { ok: false, message: "There is no adjustment to undo." };
  const draft = structuredClone(data);
  const fail = (message) => ({ ok: false, message });
  const affectedDates = new Set();
  for (const [key, snapshot] of Object.entries(action.semanticMetadata || {})) {
    if (
      ![
        "semanticDecisions",
        "semanticCorrections",
        "semanticPackages",
      ].includes(key) ||
      !equal(draft.calendar?.[key] || {}, snapshot.after)
    )
      return fail("The purpose was confirmed again later, so this adjustment cannot be safely undone.");
    draft.calendar ||= {};
    draft.calendar[key] = structuredClone(snapshot.before);
  }
  if (action.globalSettings) {
    if (!equal(draft.settings, action.globalSettings.after))
      return fail("The rules changed later, so this adjustment cannot be safely undone.");
    draft.settings = structuredClone(action.globalSettings.before);
    Object.keys(draft.days).forEach((date) => affectedDates.add(date));
  }
  for (const move of action.moves || []) {
    affectedDates.add(move.from);
    affectedDates.add(move.to);
    const current = draft.days[move.to]?.find((t) => t.id === move.after.id);
    if (
      !current ||
      coreFields.some((field) => !equal(current[field], move.after[field]))
    )
      return fail("A cross-day task was edited or its completion changed later. This adjustment cannot be safely undone.");
    draft.days[move.to] = draft.days[move.to].filter(
      (t) => t.id !== current.id,
    );
    const restored = {
      ...structuredClone(current),
    };
    for (const field of new Set([
      ...Object.keys(move.before),
      ...Object.keys(move.after),
    ])) {
      if (
        field === "calendarLink" ||
        equal(move.before[field], move.after[field])
      )
        continue;
      if (move.before[field] === undefined) delete restored[field];
      else restored[field] = structuredClone(move.before[field]);
    }
    const source = (draft.days[move.from] ||= []);
    source.splice(Math.min(move.index, source.length), 0, restored);
  }
  for (const patch of action.patches) {
    affectedDates.add(patch.date);
    const task = draft.days[patch.date]?.find((t) => t.id === patch.id);
    if (!task) return fail("The adjusted task was moved or deleted later. This adjustment cannot be safely undone.");
    if (patch.guardAfter && !equal(taskCore(task), patch.guardAfter))
      return fail(
        `“${task.title}” was edited or its completion record changed later. It cannot be safely undone.`,
      );
    for (const [field, after] of Object.entries(patch.after))
      if (!equal(task[field], after))
        return fail(
          `The ${field === "start" ? "time" : "content"} of “${task.title}” changed later. It cannot be safely undone.`,
        );
    if (
      [
        "start",
        "duration",
        "rest",
        "locked",
        "deferred",
        "bufferBefore",
        "bufferAfter",
      ].some((field) => field in patch.before) &&
      task.done !== patch.doneAtConfirmation
    )
      return fail(
        `The completion status of “${task.title}” changed. Undo will not move completed tasks; check it first.`,
      );
    Object.assign(task, patch.before);
    for (const field of patch.deletedBefore || []) delete task[field];
  }
  for (const addition of action.additions) {
    affectedDates.add(addition.date);
    const items = draft.days[addition.date] || [];
    const task = items.find((t) => t.id === addition.task.id);
    if (
      !task ||
      coreFields.some((field) => !equal(task[field], addition.task[field])) ||
      task.calendarLink
    )
      return fail(
        "The added or moved task was edited or linked to Calendar later. This adjustment cannot be safely undone.",
      );
    draft.days[addition.date] = items.filter((t) => t.id !== task.id);
  }
  for (const removal of action.removals) {
    affectedDates.add(removal.date);
    const items = (draft.days[removal.date] ||= []);
    if (items.some((t) => t.id === removal.task.id))
      return fail("The original task ID already exists. Undo stopped to avoid a duplicate.");
    items.splice(
      Math.min(removal.index, items.length),
      0,
      structuredClone(removal.task),
    );
  }
  for (const patch of action.settings) {
    affectedDates.add(patch.date);
    if (!equal(draft.daySettings[patch.date], patch.after))
      return fail("The daily settings changed later and cannot be overwritten by undo.");
    if (patch.before === undefined) delete draft.daySettings[patch.date];
    else draft.daySettings[patch.date] = structuredClone(patch.before);
  }
  for (const [date, order] of Object.entries(action.orders || {})) {
    const items = draft.days[date] || [],
      oldIds = new Set(order.before),
      oldItems = items.filter((t) => oldIds.has(t.id));
    oldItems.sort(
      (a, b) => order.before.indexOf(a.id) - order.before.indexOf(b.id),
    );
    let index = 0;
    draft.days[date] = items.map((t) =>
      oldIds.has(t.id) ? oldItems[index++] : t,
    );
    if (!order.existed && !draft.days[date].length) delete draft.days[date];
  }
  for (const date of affectedDates) {
    const tasks = draft.days[date] || [];
    if (
      tasks.some((task) =>
        taskInputError(
          task.externalReadOnly &&
            task.calendarOccupation &&
            task.duration > 1440
            ? { ...task, duration: 1440 }
            : task,
        ),
      )
    )
      return fail("The restored task format is invalid. Undo stopped.");
  }
  const check = validatePlan(draft.days, draft.settings);
  const baseline = action.validationBaseline;
  let introduced = check.conflicts.length > 0;
  if (
    baseline?.version === 1 &&
    Array.isArray(baseline.conflicts) &&
    check.status !== "error"
  ) {
    const current = validationBaseline(data.days, data.settings);
    const allowed = [...baseline.conflicts, ...current.conflicts];
    introduced = check.conflicts.some((conflict) => {
      const key = conflictKey(conflict),
        evidence = conflictEvidence(conflict, draft.days, draft.settings);
      return !allowed.some(
        (previous) => previous.key === key && previous.evidence === evidence,
      );
    });
  }
  if (introduced)
    return fail(
      "Undo stopped because it would create or worsen a conflict with later schedule edits, availability, capacity, or dependencies. Resolve those changes first.",
    );
  draft.undo = null;
  return { ok: true, data: draft };
}
