import { taskOccupation, dailyTotals, validateIntentDays } from './intent-planner.js';
import { addDays, weekday, wallInstant, validDate } from './time.js';
import { rulesForDate, isActivity } from './planner.js';
import { commuteFootprint, recoveryAfter, tiringViolations, habitStart, bufferedDuration, missesDeadline, byPriorityThenDeadline } from './task-attributes.js';

const entries = days => Object.entries(days).flatMap(([date,tasks])=>tasks.map(task=>({date,task})));
const unionMinutes = ranges => { let total=0,end=-Infinity;for(const[a,b]of ranges.sort((a,b)=>a[0]-b[0])){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return total/60000; };

/** Historical Google provenance still requires coverage after connection failures. */
export function needsCalendarCoverage({ branch, mode, calendarStatus }) {
  // Coverage remains necessary after authorization/network failure, even when
  // a successful Google read returned zero events. Connection state is not data.
  const calendar = branch.calendar || {}, days = branch.days;
  const googleHistory = (calendar.readRanges || []).length || calendar.lastRead ||
    (calendar.calendars || []).length || (calendar.learningCatalogs || []).length ||
    calendar.targetCalendarId || entries(days).some(e=>e.task.calendarLink?.source==='google');
  return mode === 'personal' && (googleHistory ||
    ['connected','expired'].includes(calendarStatus?.state));
}

/** Read-only facts; never a second scheduler or a claim that blank time is available. */
export function scheduleContext(context, selectedDate, now) {
  const {branch,mode}=context, settings={...branch.settings,timeZone:branch.settings.timeZone || 'America/Los_Angeles'};
  const days=branch.days, all=entries(days).filter(e=>!e.task.calendarLink?.remoteDeleted && (!e.task.deferred || e.task.done));
  const startOfWeek=addDays(selectedDate,-((weekday(selectedDate)+6)%7));
  const weekDates=Array.from({length:7},(_,i)=>addDays(startOfWeek,i));
  const check=validateIntentDays(days,settings),totals=dailyTotals(days,settings,[...weekDates,selectedDate]);
  const completed=dailyTotals(Object.fromEntries(Object.entries(days).map(([date,ts])=>[date,ts.filter(t=>t.done)])),settings,[...weekDates,selectedDate]);
  const occupations=all.map(entry=>{try{return taskOccupation(entry,settings);}catch{return null;}}).filter(Boolean);
  const needsRead = needsCalendarCoverage(context);
  const source = needsRead ? 'calendar' : mode === 'personal' ? 'local' : 'demo';
  const readKnown=date=>!context.error && !context.readError && !context.reading && check.status!=='error' && (!needsRead || (
    (branch.calendar?.readRanges || []).some(r=>!r.partial && r.timeZone===settings.timeZone && r.from<=date && r.to>=addDays(date,1)) &&
    !(branch.calendar?.readRanges || []).some(r=>r.partial && r.from<=date && r.to>=date)));
  const model=date=>{
    const start=wallInstant(date,0,settings.timeZone),end=wallInstant(addDays(date,1),0,settings.timeZone);
    const axisStart=wallInstant(date,540,settings.timeZone),axisEnd=wallInstant(date,1380,settings.timeZone);
    const items=occupations.filter(b=>b.start<end&&b.end>start).sort((a,b)=>a.actualStart-b.actualStart||a.entry.task.id.localeCompare(b.entry.task.id));
    const total=totals.find(d=>d.date===date),done=completed.find(d=>d.date===date);
    const closed=rulesForDate(settings,date).closed || settings.learningDates?.[date]?.closed || settings.learningClosed?.includes(date);
    const known=readKnown(date),busy=unionMinutes(items.filter(b=>!b.nonBlocking).map(b=>[Math.max(axisStart,b.start),Math.min(axisEnd,b.end)]).filter(([a,b])=>b>a));
    const conflicts=check.conflicts.filter(c=>c.date===date || c.message.includes(date) || c.ids?.some(id=>items.some(b=>b.entry.task.id===id)));
    return{date,items,known,closed,source,learning:total?.learningFocus ?? 0,completed:done?.learningFocus ?? 0,capacity:total?.learningCapacity ?? 150,
      busyRatio:busy/((axisEnd-axisStart)/60000),axisStart,axisEnd,conflicts,
      label:!known?'Incomplete calendar coverage':closed?'Rest day':total?.learningFocus?`${total.learningFocus} minutes of study`:items.length?`${items.length} scheduled item${items.length === 1 ? '' : 's'}`:source==='local'?'No local plans':'No plans'};
  };
  const day=model(selectedDate);
  return{day,week:weekDates.map(model),nowInstant:now.date===selectedDate && now.minute>=540 && now.minute<=1380 ? now.instant ?? wallInstant(now.date,now.minute,settings.timeZone) : null};
}

// The five default rescheduling rules, applied together as ONE proposal (re-exported by default-rules.js).
// 1 Same-day shift  2 Cross-day shift  3 Next-day gap  4 Habit buffers  5 Scheduled rest.
// Pure: never mutates its input; minutes are wall-clock minutes of each date.
// They live in this module because the local server serves it to the browser workbench.
export const DEFAULT_RULES = Object.freeze({
  dayStart: 540,
  dayEnd: 1380,
  fixedBuffer: 60,
  habitBuffer: 10,
});

const isBreak = (task) => task.type === "break";
// Same definition as the "Will not move" badge: fixed events, time-locked and locked items.
const isFixed = (task) => !isBreak(task) && Boolean(task.locked || task.timeLocked || isActivity(task));
const isTask = (task) => !isBreak(task) && !isFixed(task);
const movable = (task) => isTask(task) && !task.done && !task.deferred;
const clock = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// Required empty minutes between two neighbours; fixed protection and rest share one interval.
// A task the user moved by hand is locked but keeps only the 10-minute rest, not the 60-minute fixed buffer.
const buffered = (task) => isFixed(task) && task.lockSource !== "user";
function spacing(a, b, rules) {
  if (buffered(a) || buffered(b))
    return Math.max(rules.fixedBuffer, isTask(a) || isTask(b) ? rules.habitBuffer : 0);
  return isTask(a) || isTask(b) ? rules.habitBuffer : 0;
}
// Commute travel is part of a task's occupancy; a tiring task needs its longer recovery after it.
const clashes = (task, start, other, rules) => {
  const gap = spacing(task, other, rules);
  const a = commuteFootprint({ ...task, start }), b = commuteFootprint(other);
  const recovery = (t) => (t.tiring ? recoveryAfter(t, rules.habitBuffer) : 0);
  return a.end + Math.max(gap, recovery(task)) > b.start && b.end + Math.max(gap, recovery(other)) > a.start;
};

function firstFit(task, earliest, placed, rules) {
  const before = task.commute?.before ?? 0, after = task.commute?.after ?? 0;
  const from = Math.max(earliest, rules.dayStart + rules.habitBuffer + before);
  const last = rules.dayEnd - rules.habitBuffer - after - task.duration;
  const fits = (start) => !placed.some((other) => clashes(task, start, other, rules)) &&
    // Never put two tiring tasks in a row: skip the slot (the next one is tried, else the task is deferred).
    !(task.tiring && tiringViolations([...placed, { ...task, start }]).length);
  if (task.habit) {
    // Habit tasks stay inside their window, nearest the ideal time; no slot means unscheduled.
    const slots = [];
    for (let start = Math.max(from, task.habit.from); start <= Math.min(last, task.habit.to - task.duration); start++)
      if (fits(start)) {
        const run = slots[slots.length - 1];
        if (run && run.end === start + task.duration - 1) run.end++;
        else slots.push({ start, end: start + task.duration });
      }
    return habitStart(task, slots);
  }
  for (let start = from; start <= last; start++) if (fits(start)) return start;
  return null;
}

/** Rule 5: every rest is an explicit timeline item, before and after every task. */
export function restBlocks(tasks, rules = DEFAULT_RULES) {
  const seen = new Map();
  for (const task of tasks.filter((item) => isTask(item) && !item.deferred))
    for (const start of [task.start - rules.habitBuffer, task.start + task.duration]) {
      const key = `${start}`;
      if (!seen.has(key))
        seen.set(key, { type: "rest", start,
          duration: start === task.start + task.duration ? recoveryAfter(task, rules.habitBuffer) : rules.habitBuffer, around: [] });
      seen.get(key).around.push(task.id);
    }
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

// Where each moving task would land today if no tag applied (no habit window, tiring rule or travel time).
// A task whose real slot differs from this is moved by a tag, not by plain order. null = does not fit.
function plainSlots(moving, anchor, target, stay, rules) {
  const strip = (t) => ({ ...structuredClone(t), habit: undefined, tiring: false, commute: undefined });
  const placed = stay.map(strip), slots = new Map();
  let cursor = target, full = false;
  for (const original of moving) {
    const task = strip(original);
    if (task.estimate) task.duration = bufferedDuration(task.estimate, task.bufferRatio);
    const at = full ? null : firstFit(task, original === anchor ? cursor : Math.max(cursor, task.start), placed, rules);
    slots.set(task.id, at);
    if (at === null) { full = true; continue; }
    task.start = at; placed.push(task); cursor = at + task.duration + rules.habitBuffer;
  }
  return slots;
}

/**
 * Postpone one task (by `delay` minutes or to `start`) and return a single proposal.
 * Later unfinished tasks of the day move back in order; done work, breaks and fixed
 * events stay. Work the day cannot hold before dayEnd is never moved silently: it gets
 * a warning and goes into tomorrow's first gap that holds it, moving nothing else.
 */
export function proposeReschedule(days, { date, taskId, delay, start } = {}, settings = {}) {
  const rules = { ...DEFAULT_RULES, ...settings };
  const fail = (message) => ({ status: "error", message, proposal: null });
  if (!validDate(date) || !days || !Array.isArray(days[date] ?? []))
    return fail("Choose a valid day to reschedule.");
  const today = days[date] || [];
  const anchorIndex = today.findIndex((task) => task.id === taskId);
  const anchor = today[anchorIndex];
  if (anchor && !isBreak(anchor) && isFixed(anchor)) {
    const event = isActivity(anchor);
    return fail(`${event ? "Fixed event" : "Locked task"} “${anchor.title}” will not move. Nothing was changed.${event ? "" : " Unlock it first to change its time."}`);
  }
  if (!anchor || !movable(anchor))
    return fail("Choose an unfinished task that is not a fixed event or a break.");
  const target = start ?? (Number.isInteger(delay) ? anchor.start + delay : NaN);
  if (!Number.isInteger(target) || target < 0 || target >= 1440)
    return fail("Enter a valid new time on the same day.");

  const tomorrow = addDays(date, 1);
  // "Later" means later on the clock, whatever order the stored list is in.
  const moving = today
    .filter((task, index) => movable(task) &&
      (task.start > anchor.start || (task.start === anchor.start && index >= anchorIndex)))
    .sort((a, b) => a.start - b.start || (a === anchor ? -1 : b === anchor ? 1 : 0) || byPriorityThenDeadline(a, b));
  const movingIds = new Set(moving.map((task) => task.id));
  const stay = today.filter((task) => !task.deferred && !movingIds.has(task.id));
  const later = (days[tomorrow] || []).filter((task) => !task.deferred);
  const placedToday = structuredClone(stay);
  const placedTomorrow = structuredClone(later);
  const changes = [],
    warnings = [],
    unscheduled = [],
    late = [];
  const plain = plainSlots(moving, anchor, target, stay, rules);
  let cursor = target,
    tomorrowCursor = 0,
    overflowing = false;
  // The next task may start only after this one's travel home and its rest or tiring recovery.
  const clear = (task) => commuteFootprint(task).end + recoveryAfter(task, rules.habitBuffer);
  const overflow = [];
  for (const original of moving) {
    const task = structuredClone(original);
    // A task with an estimate occupies the estimate plus its 25-30% buffer.
    if (task.estimate) task.duration = bufferedDuration(task.estimate, task.bufferRatio);
    const longer = task.duration !== original.duration;
    // Only the chosen task may take its new time; successors never start earlier.
    const earliest = original === anchor ? cursor : Math.max(cursor, task.start);
    const sameDay = overflowing ? null : firstFit(task, earliest, placedToday, rules);
    // Evidence for a tag-driven move: the slot the day would give with no tags at all (see plainSlots).
    // The cause is named only when that slot differs and a tag on this task or an earlier one explains it.
    let cause = null, causeTitle = task.title;
    if ((plain.get(task.id) ?? null) !== sameDay) {
      const hasCommute = (t) => (t.commute?.before ?? 0) + (t.commute?.after ?? 0) > 0;
      const before = placedToday.filter((t) => !t.deferred && (sameDay === null || t.start < sameDay))
        .sort((x, y) => y.start - x.start);
      const tiringSource = before.find((t) => t.tiring) ?? (task.tiring ? task : undefined);
      const travelSource = hasCommute(task) ? task : before.find(hasCommute);
      if (task.habit) cause = "habit window";
      else if (hasCommute(task)) cause = "travel time";
      else if (tiringSource) { cause = "tiring"; causeTitle = tiringSource.title; }
      else if (travelSource) { cause = "travel time"; causeTitle = travelSource.title; }
    }
    if (sameDay !== null) {
      task.start = sameDay;
      placedToday.push(task);
      if (missesDeadline(task, date)) late.push(task.id);
      cursor = clear(task);
      if (sameDay !== original.start || longer)
        changes.push({ id: task.id, title: task.title,
          from: { date, start: original.start }, to: { date, start: sameDay },
          ...(cause ? { cause, causeTitle } : {}),
          reason: cause === "habit window" ? "Moved into its habit window"
            : cause === "tiring" ? "Moved later because of tiring-task recovery or spacing"
            : cause === "travel time" ? "Moved later to leave room for travel time"
            : longer
            ? `Kept order; now ${task.duration} minutes (estimate ${task.estimate} plus its buffer), shifted after the previous task`
            : "Kept order and duration; shifted after the previous task" });
      continue;
    }
    // Rules 2 and 3: only now does work leave the day, into tomorrow's first gap.
    // Only a genuinely full day sends later work away; a habit window or tiring rule affects that task alone.
    if (!task.habit && !task.tiring) overflowing = true;
    overflow.push({ original, task, cause, causeTitle });
  }
  // Work that leaves the day takes tomorrow's gaps by priority, then the earlier deadline.
  overflow.sort((a, b) => byPriorityThenDeadline(a.original, b.original));
  for (const { original, task, cause, causeTitle } of overflow) {
    const next = firstFit(task, tomorrowCursor, placedTomorrow, rules);
    if (next !== null && missesDeadline(task, tomorrow)) late.push(task.id);
    warnings.push({ id: task.id,
      message: `"${task.title}" does not fit before ${clock(rules.dayEnd)} today.` });
    if (next === null) {
      // Never lose the task: it stays on its day, visibly deferred and not scheduled.
      unscheduled.push({ ...task, deferred: true });
      changes.push({ id: task.id, title: task.title,
        from: { date, start: original.start }, to: null,
        ...(cause ? { cause, causeTitle } : {}),
        reason: "No gap tomorrow holds it; left unscheduled" });
      continue;
    }
    task.start = next;
    placedTomorrow.push(task);
    tomorrowCursor = clear(task);
    changes.push({ id: task.id, title: task.title,
      from: { date, start: original.start }, to: { date: tomorrow, start: next },
      ...(cause ? { cause, causeTitle } : {}),
      reason: cause
        ? `No same-day slot because of ${cause === "tiring" ? "tiring-task recovery or spacing" : cause === "travel time" ? "travel time" : "its habit window"}; moved to tomorrow's first free gap without moving anything else`
        : "Day is full; moved to tomorrow's first free gap without moving anything else" });
  }
  // Tiring tasks that stay or are fixed can become neighbours when work between them moves away; say so.
  const pairKey = (pair) => pair.join(" ");
  const existing = new Set([today, days[tomorrow] || []].flatMap((list) => tiringViolations(list).map(pairKey)));
  const tiringPairs = [placedToday, placedTomorrow].flatMap((list) => tiringViolations(list))
    .filter((pair) => !existing.has(pairKey(pair)));

  const order = (list) => list.sort((a, b) => a.start - b.start);
  const deferred = (list) => list.filter((task) => task.deferred);
  const proposedDays = {
    ...structuredClone(days),
    [date]: [...order(placedToday), ...unscheduled, ...structuredClone(deferred(today))],
    [tomorrow]: [...order(placedTomorrow), ...structuredClone(deferred(days[tomorrow] || []))],
  };
  const timeline = (day, list) =>
    order([
      ...list.map((task) => ({ type: isFixed(task) ? "fixed" : isBreak(task) ? "break" : "task",
        id: task.id, title: task.title, start: task.start, duration: task.duration,
        done: Boolean(task.done) })),
      ...restBlocks(list, rules).map((rest) => ({ ...rest, title: "Rest" })),
    ]).map((item) => ({ date: day, ...item }));
  return {
    status: warnings.length ? "warning" : "ok",
    message: warnings.length
      ? `${warnings.map((w) => w.message).join(" ")} ${
          unscheduled.length === warnings.length ? "It stays unscheduled."
          : unscheduled.length ? "What fits moves to tomorrow; the rest stays unscheduled."
          : "It moves to tomorrow."} Change it like this?`
      : "Change it like this?",
    proposal: {
      days: proposedDays,
      changes,
      unchanged: [...stay, ...later].map((task) => task.id),
      warnings,
      late,
      tiringPairs,
      unscheduled: unscheduled.map((task) => task.id),
      timeline: [...timeline(date, placedToday), ...timeline(tomorrow, placedTomorrow)],
    },
  };
}

/**
 * Move one ordinary task to a time on ANOTHER day under the same five default rules as a same-day shift:
 * 60-minute fixed-event buffer on each side, 10-minute rests, the day's window. Only the chosen task
 * moves; nothing on the target day shifts. Fixed events and completed work never move. A time the rules cannot give is a conflict.
 */
export function proposeMoveToDay(days, { date, taskId, targetDate, start } = {}) {
  const rules = { ...DEFAULT_RULES };
  if (!validDate(date) || !validDate(targetDate) || date === targetDate || !days || !Array.isArray(days[date] ?? []))
    return { status: "error", message: "Choose a valid day to move to.", proposal: null };
  const anchor = (days[date] || []).find((task) => task.id === taskId);
  if (!anchor || !movable(anchor) || !Number.isInteger(start) || start < 0 || start >= 1440)
    return { status: "error", message: "Choose an unfinished task that is not a fixed event or a break.", proposal: null };
  const placed = structuredClone((days[targetDate] || []).filter((task) => !task.deferred));
  const task = structuredClone(anchor);
  if (task.estimate) task.duration = bufferedDuration(task.estimate, task.bufferRatio);
  const nearest = firstFit(task, start, placed, rules);
  if (nearest !== start) {
    // Rule 3: nothing else moves. A time that does not fit is a conflict; the nearest later time
    // that fits on that day (null if none) is offered.
    return { status: "conflict", proposal: null, nearest,
      message: `Try another is unavailable for a move to another day. ${clock(start)} on ${targetDate} leaves less than ${rules.fixedBuffer} minutes around a fixed event, less than ${rules.habitBuffer} minutes of rest, or runs outside ${clock(rules.dayStart)}–${clock(rules.dayEnd)}.` };
  }
  task.start = start;
  placed.push(task);
  const order = (list) => list.sort((a, b) => a.start - b.start);
  const proposedDays = { ...structuredClone(days),
    [date]: structuredClone((days[date] || []).filter((item) => item.id !== taskId)),
    [targetDate]: [...order(placed), ...structuredClone((days[targetDate] || []).filter((item) => item.deferred))] };
  return { status: "ok", message: "Change it like this?", proposal: { days: proposedDays,
    changes: [{ id: taskId, title: task.title, from: { date, start: anchor.start }, to: { date: targetDate, start },
      reason: "Moved to the chosen day; nothing else moves" }],
    unchanged: Object.values(days).flat().filter((item) => item.id !== taskId && !item.deferred).map((item) => item.id),
    warnings: [], late: missesDeadline(task, targetDate) ? [taskId] : [], tiringPairs: [], unscheduled: [],
    timeline: [date, targetDate].flatMap((day) => {
      const list = proposedDays[day].filter((item) => !item.deferred);
      return order([
        ...list.map((item) => ({ type: isFixed(item) ? "fixed" : isBreak(item) ? "break" : "task",
          id: item.id, title: item.title, start: item.start, duration: item.duration, done: Boolean(item.done) })),
        ...restBlocks(list, rules).map((rest) => ({ ...rest, title: "Rest" })),
      ]).map((entry) => ({ date: day, ...entry }));
    }) } };
}

/** Parts of one split piece of work share a workId; the work is done only when every part is done. */
export function workParts(days, task) {
  if (!task?.workId) return [task].filter(Boolean);
  return Object.values(days || {}).flat().filter((t) => t.workId === task.workId);
}
export const workDone = (days, task) => { const parts = workParts(days, task); return parts.length > 0 && parts.every((t) => t.done); };
/** The one wording every screen uses for a finished task: a done part of unfinished work says so. */
export const doneLabel = (days, task) => task.workId && !workDone(days, task)
  ? `Part ${task.part} of ${task.parts} done · the rest is still open` : "Completed";

// ---- The options behind "Try another", in the order the product direction lists them.
export const ALTERNATIVES = Object.freeze(["reorder", "split", "usual-slot", "unscheduled", "drop-or-archive", "morning-replan"]);
const MIN_PIECE = 15;
const MORNING_SPAN = 180; // minutes after the first available window opens

/**
 * One alternative proposal for the same request as proposeReschedule. Pure; never mutates `days`.
 * Fixed events, completed work and breaks are never moved. Result:
 * { status: "ok"|"warning"|"ask"|"unavailable"|"error", kind, message, proposal|null }.
 * opts: usualStart (minutes), postponements/limit (drop-or-archive), choice ("drop"|"archive"|"keep"),
 * now {date, minute} and replannedOn (morning-replan).
 */
export function proposeAlternative(days, { date, taskId, start } = {}, kind, opts = {}, settings = {}) {
  const rules = { ...DEFAULT_RULES, ...settings };
  const result = (status, message, proposal = null) => ({ status, kind, message, proposal });
  if (!ALTERNATIVES.includes(kind)) return result("error", "Choose one of the listed alternatives.");
  if (!validDate(date) || !days || !Array.isArray(days[date] ?? []))
    return result("error", "Choose a valid day to reschedule.");
  const today = days[date] || [], tomorrow = addDays(date, 1);
  const anchor = today.find((task) => task.id === taskId);
  if (!anchor || !movable(anchor))
    return result("error", "Choose an unfinished task that is not a fixed event or a break.");
  const target = start ?? anchor.start;
  if (!Number.isInteger(target) || target < 0 || target >= 1440)
    return result("error", "Enter a valid new time on the same day.");
  const key = (task) => [task.deadline ? String(task.deadline) : "\uffff",
    -(Number(task.priority) || { high: 3, medium: 2, low: 1 }[task.priority] || 0), task.start];
  const byUrgency = (a, b) => {
    const x = key(a), y = key(b);
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1] || x[2] - y[2];
  };
  const finish = (placedToday, placedTomorrow, unscheduled, changes, warnings, extra = {}) => {
    const order = (list) => list.sort((a, b) => a.start - b.start);
    const touched = new Set(changes.map((change) => change.id));
    const all = [...today, ...(days[tomorrow] || [])];
    return result(warnings.length ? "warning" : "ok",
      warnings.length ? `${warnings.map((w) => w.message).join(" ")} Change it like this?` : "Change it like this?", {
        days: { ...structuredClone(days),
          [date]: [...order(placedToday), ...unscheduled, ...structuredClone(today.filter((task) => task.deferred))],
          [tomorrow]: [...order(placedTomorrow), ...structuredClone((days[tomorrow] || []).filter((task) => task.deferred))] },
        changes, warnings, unscheduled: unscheduled.map((task) => task.id),
        unchanged: all.filter((task) => !touched.has(task.id)).map((task) => task.id), ...extra });
  };
  const keep = (list) => structuredClone(list.filter((task) => !task.deferred));
  // Place tasks one by one in order (monotonic cursor): today, else tomorrow, else unscheduled.
  const lay = (list, floors, placedToday, placedTomorrow) => {
    const changes = [], warnings = [], unscheduled = [];
    let cursor = 0, tomorrowCursor = 0;
    for (const original of list) {
      const task = structuredClone(original), from = { date, start: original.start };
      const at = firstFit(task, Math.max(cursor, floors.get(original.id) ?? 0), placedToday, rules);
      if (at !== null) {
        task.start = at; placedToday.push(task); cursor = at + task.duration + rules.habitBuffer;
        if (at !== original.start) changes.push({ id: task.id, title: task.title, from, to: { date, start: at },
          reason: kind === "reorder" ? "Ordered by deadline and priority" : "Replanned for the whole day" });
        continue;
      }
      warnings.push({ id: task.id, message: `"${task.title}" does not fit before ${clock(rules.dayEnd)} today.` });
      const next = firstFit(task, tomorrowCursor, placedTomorrow, rules);
      if (next === null) {
        unscheduled.push({ ...task, deferred: true });
        changes.push({ id: task.id, title: task.title, from, to: null, reason: "No gap tomorrow holds it; left unscheduled" });
        continue;
      }
      task.start = next; placedTomorrow.push(task); tomorrowCursor = next + task.duration + rules.habitBuffer;
      changes.push({ id: task.id, title: task.title, from, to: { date: tomorrow, start: next },
        reason: "Day is full; moved to tomorrow's first free gap" });
    }
    return { changes, warnings, unscheduled };
  };

  if (kind === "reorder" || kind === "morning-replan") {
    if (kind === "morning-replan") {
      if (opts.replannedOn === date) return result("unavailable", "Today was already replanned this morning.");
      // "Morning" follows the user's first available window that day, not a fixed clock time.
      const windowStart = rulesForDate(settings, date).windows[0]?.[0];
      if (opts.now && (opts.now.date !== date || windowStart === undefined || opts.now.minute >= windowStart + MORNING_SPAN))
        return result("unavailable", "The whole-day replan runs once, in the first hours of your day.");
    }
    const pool = today.filter((task) => movable(task) && (kind === "morning-replan" || task.start >= anchor.start));
    const ids = new Set(pool.map((task) => task.id));
    const floors = new Map(pool.map((task) => [task.id, kind === "morning-replan" ? 0
      : task === anchor ? target : anchor.start]));
    const placedToday = keep(today.filter((task) => !ids.has(task.id))), placedTomorrow = keep(days[tomorrow] || []);
    const { changes, warnings, unscheduled } = lay([...pool].sort(byUrgency), floors, placedToday, placedTomorrow);
    return finish(placedToday, placedTomorrow, unscheduled, changes, warnings,
      kind === "morning-replan" ? { replannedOn: date } : {});
  }

  const others = keep(today.filter((task) => task.id !== anchor.id));
  const placedTomorrow = keep(days[tomorrow] || []);
  if (kind === "split") {
    const probe = { ...anchor, duration: MIN_PIECE };
    const at = firstFit(probe, target, others, rules);
    if (at === null) return result("unavailable", "No time left today to start a part of this task.");
    let length = MIN_PIECE;
    while (length < anchor.duration && firstFit({ ...anchor, duration: length + 5 }, at, others, rules) === at) length += 5;
    length = Math.min(length, anchor.duration);
    if (length >= anchor.duration) return result("unavailable", "The whole task fits today, so it is not split.");
    const rest = anchor.duration - length, workId = anchor.workId || `work-${anchor.id}`,
      base = String(anchor.title).replace(/\s*\(part \d+ of \d+\)$/, ""),
      taken = new Set(Object.values(days).flat().map((t) => t.id));
    let n = 2; while (taken.has(`${anchor.id}-part${n}`)) n += 1;
    const partTwo = { ...structuredClone(anchor), id: `${anchor.id}-part${n}`, title: base, duration: rest, workId, part: (anchor.part || 1) + 0.5 };
    if (partTwo.uid) partTwo.uid = `${anchor.uid}-part${n}`;
    const next = firstFit(partTwo, 0, placedTomorrow, rules);
    if (next === null) return result("unavailable", "Tomorrow has no gap for the rest of this task.");
    partTwo.start = next; placedTomorrow.push(partTwo);
    others.push({ ...structuredClone(anchor), title: base, start: at, duration: length, workId, part: anchor.part || 1 });
    const res = finish(others, placedTomorrow, [], [
      { id: anchor.id, title: anchor.title, from: { date, start: anchor.start }, to: { date, start: at },
        reason: `Split: ${length} minutes today, ${rest} minutes tomorrow` },
      { id: partTwo.id, title: base, from: null, to: { date: tomorrow, start: next },
        reason: "Second part placed in tomorrow's first free gap" }], [], { split: { today: length, tomorrow: rest } });
    // Renumber every part of this work so labels always read "part i of N" in order.
    const all = Object.values(res.proposal.days).flat().filter((t) => t.workId === workId)
      .sort((x, y) => (x.part || 1) - (y.part || 1));
    all.forEach((t, i) => { t.part = i + 1; t.parts = all.length; t.title = `${base} (part ${i + 1} of ${all.length})`; });
    for (const c of res.proposal.changes) if (c.id === partTwo.id) c.title = all.find((t) => t.id === c.id)?.title ?? c.title;
    return res;
  }
  if (kind === "usual-slot") {
    const usual = anchor.idealStart ?? opts.usualStart;
    if (!Number.isInteger(usual)) return result("unavailable", "There is no usual time for this kind of task yet.");
    const at = firstFit(anchor, usual, others, rules);
    if (at === null) return result("unavailable", "The usual time is full today.");
    const task = { ...structuredClone(anchor), start: at };
    return finish([...others, task], placedTomorrow, [], at === anchor.start ? [] : [
      { id: anchor.id, title: anchor.title, from: { date, start: anchor.start }, to: { date, start: at },
        reason: "Placed where this kind of task is usually done" }], []);
  }
  if (kind === "unscheduled")
    return finish(others, placedTomorrow, [{ ...structuredClone(anchor), deferred: true }], [
      { id: anchor.id, title: anchor.title, from: { date, start: anchor.start }, to: null,
        reason: "It does not fit; left unscheduled" }],
      [{ id: anchor.id, message: `"${anchor.title}" does not fit, so it stays unscheduled.` }]);
  // drop-or-archive: only after N consecutive postponements, and only by the user's answer.
  const limit = opts.limit ?? 3, count = opts.postponements ?? anchor.postponed ?? 0;
  if (count < limit) return result("unavailable", `Asked only after ${limit} postponements in a row.`);
  const choice = opts.choice;
  if (!["drop", "archive"].includes(choice))
    return { ...result("ask", `"${anchor.title}" was postponed ${count} times. Drop it, archive it, or keep it?`),
      choices: ["drop", "archive", "keep"] };
  const changes = [{ id: anchor.id, title: anchor.title, from: { date, start: anchor.start }, to: null,
    reason: choice === "drop" ? "Dropped after repeated postponements" : "Archived after repeated postponements" }];
  const archived = choice === "archive" ? [{ ...structuredClone(anchor), deferred: true, archived: true }] : [];
  const out = finish(others, placedTomorrow, archived, changes, []);
  if (choice === "drop") out.proposal.unscheduled = [];
  return out;
}

/** Archived tasks, oldest day first (kept in `days` with archived: true; nothing is deleted). */
export function archivedTasks(days) {
  return Object.keys(days || {}).sort().flatMap((date) => (days[date] || [])
    .filter((task) => task.archived && task.deferred).map((task) => ({ date, task })));
}

/**
 * Where an archived task goes back: the first free gap from its old day and time, within
 * two weeks, never before `now`. Returns { status: "ok", days, to } or { status: "none", message }.
 */
export function proposeRestore(days, taskId, now = null, settings = {}) {
  const rules = { ...DEFAULT_RULES, ...settings };
  const found = archivedTasks(days).find((entry) => entry.task.id === taskId);
  if (!found) return { status: "none", message: "That task is not in the archive." };
  const { archived, deferred, ...rest } = found.task;
  // Two weeks from the old day, or from today when the old day is already behind us.
  const origin = now && now.date > found.date ? now.date : found.date;
  for (let offset = 0; offset <= 14; offset++) {
    const date = addDays(origin, offset);
    if (rulesForDate(settings, date).closed) continue;
    const others = (days[date] || []).filter((task) => task.id !== taskId && !task.deferred);
    let earliest = date === found.date ? found.task.start : 0;
    if (now && date === now.date) earliest = Math.max(earliest, now.minute);
    const at = firstFit(rest, earliest, others, rules);
    if (at === null) continue;
    const next = structuredClone(days);
    next[found.date] = next[found.date].filter((task) => task.id !== taskId);
    next[date] = [...(next[date] || []), { ...structuredClone(rest), start: at }].sort((a, b) => a.start - b.start);
    return { status: "ok", days: next, to: { date, start: at } };
  }
  return { status: "none", message: `"${found.task.title}" has no free gap in the next two weeks, so it stays archived.` };
}
