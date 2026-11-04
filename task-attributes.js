// Fixed task attributes. Plain rules, no AI. Pure helpers; minutes are wall-clock minutes of a day.
const TIRING_RECOVERY = 30;
const MIN_REST = 10;
const BUFFER_RANGE = Object.freeze([0.25, 0.3]);

const int = (v) => Number.isInteger(v);
const rank = (p) => (typeof p === "number" ? -p : { high: 0, medium: 1, low: 2 }[p] ?? 3);

/** Commute: the task occupies its travel time before and after, and moves with it. */
export function commuteFootprint(task) {
  const before = task.commute?.before ?? 0, after = task.commute?.after ?? 0;
  return { start: task.start - before, end: task.start + task.duration + after };
}

/** Tiring tasks need a longer recovery after them; every task keeps at least the 10-minute rest. */
export function recoveryAfter(task, rest = MIN_REST) {
  return task.tiring ? Math.max(TIRING_RECOVERY, rest) : rest;
}

/** Pairs of tiring tasks that follow each other (breaks are ignored). Empty means the plan is valid. */
export function tiringViolations(tasks) {
  const list = tasks.filter((t) => t.type !== "break" && !t.deferred).sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 1; i < list.length; i++)
    if (list[i - 1].tiring && list[i].tiring) out.push([list[i - 1].id, list[i].id]);
  return out;
}

/** High priority first, then the earlier deadline; undated tasks last. */
export function byPriorityThenDeadline(a, b) {
  return rank(a.priority) - rank(b.priority) ||
    String(a.deadline || "\uffff").localeCompare(String(b.deadline || "\uffff")) || (a.start ?? 0) - (b.start ?? 0);
}

export const missesDeadline = (task, date) => Boolean(task.deadline) && date > task.deadline;

/** Estimate plus a 25-30% buffer (default 25%), rounded up to whole minutes. */
export function bufferedDuration(estimate, ratio = BUFFER_RANGE[0]) {
  const r = Math.min(BUFFER_RANGE[1], Math.max(BUFFER_RANGE[0], Number.isFinite(ratio) ? ratio : BUFFER_RANGE[0]));
  return Math.ceil(estimate * (1 + r) - 1e-9);
}

/** Habit: the start inside the window and the free slots {start,end} nearest the ideal time, or null. */
export function habitStart(task, freeSlots) {
  const { from, to, ideal } = task.habit || {};
  let best = null;
  for (const slot of freeSlots) {
    const lo = Math.max(slot.start, from), hi = Math.min(slot.end, to) - task.duration;
    if (hi < lo) continue;
    const at = Math.min(hi, Math.max(lo, ideal));
    if (best === null || Math.abs(at - ideal) < Math.abs(best - ideal)) best = at;
  }
  return best;
}

/** A user who moves a task by hand locks it. It stays a task (never turns into an activity). */
export function markManuallyMoved(task, newStart) {
  return { ...task, start: newStart, type: "task", locked: true, lockSource: "user", manuallyMoved: true };
}

/** After an editor time change is previewed, the task keeps the user's time: lock it in the proposal. */
export function lockManualMove(result, taskId) {
  if (result?.status !== "ok" || !result.days) return result;
  for (const date of Object.keys(result.days))
    result.days[date] = result.days[date].map((task) => (task.id === taskId ? markManuallyMoved(task, task.start) : task));
  return result;
}

/** Returns an error message for invalid attributes, else null. */
export function attributeError(task) {
  const { commute, tiring, priority, deadline, estimate, bufferRatio, habit, manuallyMoved, lockSource } = task;
  if (commute !== undefined && (!commute || typeof commute !== "object" ||
    [commute.before ?? 0, commute.after ?? 0].some((n) => !int(n) || n < 0 || n > 1440)))
    return "Commute time must be whole minutes from 0 to 1440.";
  for (const [name, v] of [["tiring", tiring], ["manuallyMoved", manuallyMoved]])
    if (v !== undefined && typeof v !== "boolean") return `The ${name} flag must be true or false.`;
  if (priority !== undefined && !["high", "medium", "low"].includes(priority) && !(int(priority) && priority > 0))
    return "Priority must be high, medium or low.";
  if (deadline !== undefined && !(typeof deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(deadline) &&
    !Number.isNaN(Date.parse(`${deadline}T00:00:00Z`)) &&
    new Date(`${deadline}T00:00:00Z`).toISOString().slice(0, 10) === deadline))
    return "Deadline must be a date written as YYYY-MM-DD.";
  if (estimate !== undefined && (!int(estimate) || estimate <= 0 || estimate > 1440))
    return "Estimate must be whole minutes.";
  if (bufferRatio !== undefined && !(typeof bufferRatio === "number" && bufferRatio >= 0.25 && bufferRatio <= 0.3))
    return "Estimate buffer must be between 25% and 30%.";
  if (habit !== undefined && (!habit || ![habit.from, habit.to, habit.ideal].every((n) => int(n) && n >= 0 && n <= 1440) ||
    habit.from >= habit.to || habit.ideal < habit.from || habit.ideal > habit.to))
    return "Habit needs a window and an ideal time inside it.";
  if (lockSource != null && lockSource !== "user") return "Lock source is not recognised.";
  return null;
}
