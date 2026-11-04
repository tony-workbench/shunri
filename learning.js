import { validDate } from "./time.js";

/** Learning is an explicit classification, never a title substring heuristic. */
export function learningTask(task) {
  return Boolean(
    task?.learning === true ||
      (Array.isArray(task?.tags) && task.tags.includes("study")),
  );
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

const packageKey = (task) => `${task.planId}\u0000${task.packageId}`;

/**
 * Add stable learning identities once. Moving a task must retain these fields.
 * Original dates/order/IDs and all completion and calendar metadata are preserved.
 */
export function normalizeLearningDays(days) {
  const draft = structuredClone(days);
  if (!draft || typeof draft !== "object" || Array.isArray(draft))
    throw new Error("Invalid schedule data.");
  const entries = Object.entries(draft)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([date, tasks]) => {
      if (!validDate(date) || !Array.isArray(tasks))
        throw new Error("Invalid study date or task list.");
      return tasks.map((task, index) => ({ date, task, index }));
    });
  const knownOrigins = new Map();
  for (const { date, task } of entries) {
    if (!learningTask(task)) continue;
    const planId = task.planId || "study-default";
    const origin = validDate(task.packageOriginDate)
      ? task.packageOriginDate
      : date;
    if (task.packageId) {
      const key = `${planId}\u0000${origin}`,
        existing = knownOrigins.get(key);
      if (
        !existing ||
        (existing.packageId === task.packageId &&
          existing.packageOrder == null &&
          task.packageOrder != null)
      )
        knownOrigins.set(key, {
          packageId: task.packageId,
          packageOrder: task.packageOrder,
        });
    }
  }
  const packages = new Map();
  for (const entry of entries) {
    const { date, task } = entry;
    if (!learningTask(task)) continue;
    if (
      task.tags != null &&
      (!Array.isArray(task.tags) ||
        task.tags.some((tag) => typeof tag !== "string"))
    )
      throw new Error("Invalid study tag format.");
    task.tags = [...new Set([...(task.tags || []), "study"])];
    task.planId ||= "study-default";
    task.packageOriginDate = validDate(task.packageOriginDate)
      ? task.packageOriginDate
      : date;
    const originKey = `${task.planId}\u0000${task.packageOriginDate}`;
    const known = knownOrigins.get(originKey);
    task.packageId ||=
      known?.packageId ||
      `package-${stableHash(originKey)}-${task.packageOriginDate}`;
    // Date-coded defaults are stable integers and do not renumber existing content.
    if (task.packageOrder == null)
      task.packageOrder =
        known?.packageOrder ??
        Number(task.packageOriginDate.replaceAll("-", ""));
    const key = packageKey(task);
    if (!packages.has(key)) packages.set(key, []);
    packages.get(key).push(entry);
  }
  for (const members of packages.values()) {
    members.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.task.start || 0) - (b.task.start || 0) ||
        a.index - b.index,
    );
    const used = new Set(
      members.map(({ task }) => task.packageTaskOrder).filter(Number.isInteger),
    );
    let order = 0;
    for (const { task } of members) {
      if (task.packageTaskOrder != null) continue;
      while (used.has(order)) order++;
      task.packageTaskOrder = order;
      used.add(order++);
    }
  }
  return draft;
}

/** Compact, read-only package inventory for the UI and planner. */
export function packageSummary(days) {
  const packages = new Map();
  for (const [date, tasks] of Object.entries(days)) {
    for (const task of tasks) {
      if (!learningTask(task) || !task.packageId) continue;
      const key = packageKey(task);
      if (!packages.has(key))
        packages.set(key, {
          planId: task.planId || "study-default",
          packageId: task.packageId,
          packageOrder: task.packageOrder,
          originDate: task.packageOriginDate || date,
          dates: [],
          taskIds: [],
          completedCount: 0,
          remainingCount: 0,
          deferredCount: 0,
          totalMinutes: 0,
          remainingMinutes: 0,
        });
      const summary = packages.get(key);
      if (!summary.dates.includes(date)) summary.dates.push(date);
      summary.taskIds.push(task.id);
      summary.totalMinutes += task.duration;
      if (task.done) summary.completedCount++;
      else if (task.deferred) summary.deferredCount++;
      else {
        summary.remainingCount++;
        summary.remainingMinutes += task.duration;
      }
    }
  }
  return [...packages.values()]
    .map((item) => ({ ...item, dates: item.dates.sort() }))
    .sort(
      (a, b) =>
        a.planId.localeCompare(b.planId) ||
        a.packageOrder - b.packageOrder ||
        a.packageId.localeCompare(b.packageId),
    );
}
