// Scheduling is independent from storage, UI and Calendar.
export const DAY_END = 23 * 60;
const BUFFER = 60;
export const endOf = (task) => task.start + task.duration;
export const occupiedEnd = (task) =>
  endOf(task) + (task.locked ? 0 : task.rest);
export const formatTime = (minutes) => {
  const day = Math.floor(minutes / 1440);
  const value = ((minutes % 1440) + 1440) % 1440;
  return `${day > 0 ? `Next day${day > 1 ? ` +${day - 1} ` : " "}` : ""}${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
};
export function parseTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return NaN;
  const [hour, minute] = value.split(":").map(Number);
  return hour < 24 && minute < 60 ? hour * 60 + minute : NaN;
}
export const overlaps = (start, end, otherStart, otherEnd) =>
  start < otherEnd && end > otherStart;
export const protection = (task) => ({
  start: task.start - (task.bufferBefore ?? BUFFER),
  end: endOf(task) + (task.bufferAfter ?? BUFFER),
});
export function taskInputError(task) {
  if (
    !task ||
    typeof task.id !== "string" ||
    !task.id ||
    typeof task.title !== "string" ||
    !task.title.trim()
  )
    return "Each item needs a name and a stable ID.";
  if (!Number.isInteger(task.start) || task.start < 0 || task.start >= 1440)
    return "Choose a valid start time within the day.";
  if (
    !Number.isInteger(task.duration) ||
    task.duration <= 0 ||
    task.duration > 1440
  )
    return "Task duration must be a whole number from 1 to 1,440 minutes.";
  if (!Number.isInteger(task.rest) || task.rest < 0 || task.rest > 1440)
    return "Rest must be a whole number from 0 to 1,440 minutes.";
  if (
    task.locked &&
    [task.bufferBefore ?? BUFFER, task.bufferAfter ?? BUFFER].some(
      (value) => !Number.isInteger(value) || value < 0 || value > 1440,
    )
  )
    return "Protection before and after an event must be a whole number from 0 to 1,440 minutes.";
  return null;
}

export function constraints(tasks, dayEnd = DAY_END) {
  const active = tasks.filter((task) => !task.deferred);
  const conflicts = [];
  for (let i = 0; i < active.length; i++) {
    const task = active[i];
    for (let j = i + 1; j < active.length; j++) {
      const other = active[j];
      let hit;
      if (task.locked && other.locked) {
        const first = protection(task),
          second = protection(other);
        hit =
          overlaps(task.start, endOf(task), second.start, second.end) ||
          overlaps(other.start, endOf(other), first.start, first.end);
      } else if (task.locked || other.locked) {
        const fixed = task.locked ? task : other;
        const ordinary = task.locked ? other : task;
        const block = protection(fixed);
        hit = overlaps(
          ordinary.start,
          occupiedEnd(ordinary),
          block.start,
          block.end,
        );
      } else
        hit = overlaps(
          task.start,
          occupiedEnd(task),
          other.start,
          occupiedEnd(other),
        );
      if (hit)
        conflicts.push({
          ids: [task.id, other.id],
          titles: [task.title, other.title],
          message: `“${task.title}” overlaps “${other.title}”, including ${task.locked || other.locked ? "event protection periods" : "rest"}.`,
        });
    }
  }
  const overflow = active
    .filter((task) => !task.done && occupiedEnd(task) > dayEnd)
    .map((task) => ({
      ...task,
      occupiedEnd: occupiedEnd(task),
      excess: occupiedEnd(task) - dayEnd,
    }));
  return { conflicts, overflow };
}

function nextFree(start, size, blocks) {
  let cursor = start;
  for (const block of blocks)
    if (overlaps(cursor, cursor + size, block.start, block.end))
      cursor = block.end;
  return cursor;
}

/** Calculate a proposal; never mutate the input or split/move tasks to another date. */
export function schedule(tasks, { anchorId, start, dayEnd = DAY_END } = {}) {
  const proposed = structuredClone(tasks);
  const fail = (message) => ({
    status: "error",
    message,
    tasks: proposed,
    changes: [],
    conflicts: [],
    overflow: [],
  });
  if (!Number.isInteger(dayEnd) || dayEnd <= 0 || dayEnd > 1440)
    return fail("The daily end time must be within the day.");
  const seen = new Set();
  for (const task of proposed) {
    const error = taskInputError(task);
    if (error) return fail(error);
    if (seen.has(task.id)) return fail("Duplicate task IDs were found for this day. Restore valid data first.");
    seen.add(task.id);
  }
  const anchorIndex =
    anchorId === undefined
      ? -1
      : proposed.findIndex((task) => task.id === anchorId);
  if (anchorId !== undefined && anchorIndex < 0)
    return fail("The starting task could not be found.");
  if (anchorIndex >= 0) {
    const anchor = proposed[anchorIndex];
    if (anchor.done || anchor.locked)
      return fail("Completed or locked items cannot start an automatic adjustment.");
    if (!Number.isInteger(start) || start < 0 || start >= 1440)
      return fail("Enter a valid starting time within the day.");
    const active = proposed.filter((task) => !task.deferred);
    const immutable = active.filter(
      (task) =>
        task.done || task.locked || proposed.indexOf(task) < anchorIndex,
    );
    const blocks = immutable
      .map((task) =>
        task.locked
          ? protection(task)
          : { start: task.start, end: occupiedEnd(task) },
      )
      .sort((a, b) => a.start - b.start);
    const before = proposed
      .slice(0, anchorIndex)
      .filter((task) => !task.deferred && !task.locked);
    let cursor = Math.max(start, ...before.map(occupiedEnd));
    for (let index = anchorIndex; index < proposed.length; index++) {
      const task = proposed[index];
      if (task.done || task.locked || task.deferred) continue;
      // Only the explicitly selected anchor may start earlier; successors never do.
      if (index !== anchorIndex) cursor = Math.max(cursor, task.start);
      task.start = nextFree(cursor, task.duration + task.rest, blocks);
      cursor = occupiedEnd(task);
    }
  }
  const { conflicts, overflow } = constraints(proposed, dayEnd);
  const changes = proposed
    .filter((task, index) => task.start !== tasks[index].start)
    .map((task) => ({
      id: task.id,
      title: task.title,
      from: tasks.find((original) => original.id === task.id).start,
      to: task.start,
    }));
  return {
    status: conflicts.length ? "conflict" : overflow.length ? "overflow" : "ok",
    tasks: proposed,
    changes,
    conflicts,
    overflow,
    message: conflicts[0]?.message || "",
  };
}
