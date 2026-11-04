import { formatTime } from "./scheduler.js";
import { addDays, dateParts, wallInstant, validDate, parseTimeExpression } from "./time.js";
import { isActivity, necessaryRest, rulesForDate } from "./planner.js";
import { learningTask } from "./learning.js";
import { syncPresentation, syncPresentationRefs } from "./sync-queue.js";
import { scheduleContext, proposeReschedule, proposeMoveToDay, proposeAlternative, ALTERNATIVES, DEFAULT_RULES, doneLabel } from "./schedule-context.js";
import { canManageCalendarSource } from "./calendar-data.js";
import { presentError, attributeMessage, messageHtml } from "./ui-messages.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const rows = (days) =>
  Object.keys(days)
    .sort()
    .flatMap((date) => days[date].map((task) => ({ date, task })))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.task.start - b.task.start ||
        a.task.title.localeCompare(b.task.title),
    );
// Display only: management eligibility remains in canAdjust/needsManagement.
function readOnlyCalendarNote(task, canRequestManagement) {
  if (!task?.externalReadOnly || task.calendarLink?.source !== "google") return "";
  const source = task.calendarSource;
  if (source?.eventType && source.eventType !== "default") {
    switch (source.eventType) {
      case "focusTime": return "Read-only · Shunri cannot move focus-time events yet.";
      case "outOfOffice": return "Read-only · Shunri cannot move out-of-office events yet.";
      case "workingLocation": return "Read-only · Shunri cannot change working-location events yet.";
      default: return "Read-only · Shunri cannot move this event type yet.";
    }
  }
  if (source?.allDay === true) return "Read-only · All-day events keep their original dates.";
  if (source?.minutePrecision === false) return "Read-only · This event uses seconds; Shunri currently schedules by the minute.";
  if (source?.accessRole && source.accessRole !== "owner") return "Read-only · Shunri can manage events only on calendars you own.";
  if (source?.organizer?.self === false) return "Read-only · This event belongs to another organizer and keeps its original time.";
  if (source?.canManage === false) return "Read-only · Shunri cannot move this event. Its original time is preserved.";
  if (task.calendarClassification?.manage === false) return "Read-only · You chose to keep this event outside Shunri management.";
  if (canRequestManagement) return "Imported as read-only · Choose a time to review local management permission.";
  return "Read-only · This calendar event keeps its original time.";
}

const button = (id, text, primary = false) =>
  `<button id="wb-${id}" ${primary ? 'class="primary"' : ""}>${esc(text)}</button>`;
const field = (id, label, type, value, extra = "") =>
  `<label>${esc(label)}<input id="wb-${id}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const freezeSnapshot = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeSnapshot);
    Object.freeze(value);
  }
  return value;
};
const scheduleKey = (branch) => JSON.stringify({
  settings: branch.settings,
  daySettings: branch.daySettings,
  tasks: rows(branch.days).map(({ date, task }) => ({
    date,
    ...Object.fromEntries([
      "id", "title", "start", "duration", "rest", "done", "doneAt", "completedDate",
      "deferred", "type", "locked", "timeLocked", "bufferBefore", "bufferAfter",
      "learning", "counted", "tags", "planId", "packageId", "packageOriginDate",
      "dependencies", "purpose", "externalReadOnly", "commute", "tiring", "priority",
      "deadline", "estimate", "bufferRatio", "habit", "manuallyMoved", "lockSource",
    ].map(key => [key, task[key]])),
    occupation: task.calendarOccupation && {
      startInstant: task.calendarOccupation.startInstant,
      endInstant: task.calendarOccupation.endInstant,
    },
    remoteDeleted: Boolean(task.calendarLink?.remoteDeleted),
  })),
});
const changeRows = (changes) => changes.map(c =>
  `<div class="change-row"><strong>${esc(c.title)}</strong><p><span class="old-time">${esc(c.timing?.before.range || c.from.date + " " + formatTime(c.from.start))}</span><span class="new-time">→ ${esc(c.timing?.after.range || c.to.date + " " + formatTime(c.to.start))}</span></p>${c.timing ? timingNote(c.timing.after) : ""}<small>${esc((c.reason || "Original order and duration preserved"))}${c.packageOriginDate ? ` · Original study date ${esc(c.packageOriginDate)}` : ""}</small></div>`
).join("");
// One shared "will not move" look so fixed and movable plans differ at a glance.
export const FIXED_LABEL = "Will not move";
export const BUFFER_EXPLANATION = "Buffers · time kept free before and after fixed events";
// The same rule as the scheduler: fixed events, time-locked and manually locked items never move.
export const isFixedTask = (task) => Boolean(task) && (isActivity(task) || Boolean(task.timeLocked || task.locked));
// A fixed event and a task the user locked both will not move, but they are not the same thing.
export const fixedBadge = (task) => {
  const label = !task || isActivity(task) ? FIXED_LABEL
    : task.lockSource === "user" ? `Locked by you · ${FIXED_LABEL.toLowerCase()}`
    : `Locked · ${FIXED_LABEL.toLowerCase()}`;
  return `<span class="fixed-badge">${label}</span>`;
};
// Words that explain the buffers kept free around a fixed event; movable tasks have none.
export const bufferNote = (task, settings = {}) => {
  if (!isActivity(task)) return "";
  const before = task.bufferBefore ?? settings.bufferBefore ?? 0, after = task.bufferAfter ?? settings.bufferAfter ?? 0;
  return `Buffers · ${before} min before / ${after} min after are kept free so nothing is squeezed against this event`;
};
const timingNote = timing => `${timing.rest || timing.next ? `<p class="timing-note">${[timing.rest, timing.next].filter(Boolean).map(esc).join(" · ")}</p>` : ""}${timing.protection.map(text => `<p class="protection-note">${esc(text)}</p>`).join("")}`;

/** Rest/protection facts, never a promise of schedulable learning time. */
export function taskTiming(entry, settings = {}, days = {}) {
  const { task, date } = entry, zone = settings.timeZone || "America/Los_Angeles";
  const start = task.calendarOccupation?.startInstant ?? wallInstant(date, task.start, zone);
  const end = task.calendarOccupation?.endInstant ?? start + task.duration * 60000;
  const zoneAt = instant => new Intl.DateTimeFormat('en-US',{timeZone:zone,timeZoneName:'short'}).formatToParts(instant).find(p=>p.type==='timeZoneName')?.value;
  const clock = instant => { const p = dateParts(instant, zone); return `${p.date !== date ? p.date + " " : ""}${formatTime(p.minute)}${zoneAt(instant) !== zoneAt(start) ? " " + zoneAt(instant) : ""}`; };
  const activity = isActivity(task), medical = task.purpose === "medical" || task.calendarClassification?.purpose === "medical";
  const before = activity ? medical ? Math.max(60, task.bufferBefore ?? 0) : task.bufferBefore ?? settings.bufferBefore ?? 0 : 0;
  const after = activity ? task.bufferAfter ?? settings.bufferAfter ?? 0 : 0;
  const rest = !activity && !task.externalReadOnly ? task.rest || 0 : 0;
  const gap = necessaryRest(task, settings), rule = rulesForDate(settings,date);
  const closed = rule.closed || settings.learningDates?.[date]?.closed;
  const gapEnd = end + gap * 60000, boundary = wallInstant(date, rule.dayEnd, zone);
  return { range: arrangementRange(entry, zone), rest: rest ? `${clock(end)}–${clock(end + rest * 60000)} Break` : "",
    next: closed ? "No study scheduled this day" : !activity && !task.done && !task.externalReadOnly && gap > rest && gapEnd <= boundary ? `Required gap until ${clock(gapEnd)}` : "",
    protection: [before ? `${clock(start - before * 60000)}–${clock(start)} ${medical ? "Before appointment" : "Before event"} buffer` : "",
      after ? `${clock(end)}–${clock(end + after * 60000)} After-event buffer` : ""].filter(Boolean) };
}
export function arrangementRange(e, timeZone = "America/Los_Angeles") {
  if (e.task.calendarSource?.allDay) {
    const end = e.task.calendarSource.end?.date;
    const last = end ? addDays(end, -1) : e.date;
    return `${e.date}${last > e.date ? " — " + last : ""} · All day`;
  }
  const occupation = e.task.calendarOccupation;
  if (
    Number.isFinite(occupation?.startInstant) &&
    Number.isFinite(occupation?.endInstant)
  ) {
    const start = dateParts(occupation.startInstant, timeZone),
      end = dateParts(occupation.endInstant, timeZone);
    const seconds =
      occupation.startInstant % 60000 !== 0 ||
      occupation.endInstant % 60000 !== 0;
    const time = (instant) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        ...(seconds ? { second: "2-digit" } : {}),
        hourCycle: "h23",
      }).format(new Date(instant));
    const zone = (instant) =>
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
        .formatToParts(new Date(instant))
        .find((p) => p.type === "timeZoneName")?.value || timeZone;
    const startZone = zone(occupation.startInstant),
      endZone = zone(occupation.endInstant),
      transition = startZone !== endZone;
    return `${start.date} ${time(occupation.startInstant)}${transition ? " " + startZone : ""}–${end.date !== start.date ? end.date + " " : ""}${time(occupation.endInstant)}${transition ? " " + endZone : ""}`;
  }
  return `${e.date} ${formatTime(e.task.start)}–${e.task.start + e.task.duration >= 1440 ? addDays(e.date, Math.floor((e.task.start + e.task.duration) / 1440)) + " " : ""}${formatTime((e.task.start + e.task.duration) % 1440)}`;
}

export function conciseChanges(changes, targetId) {
  const index = changes.findIndex((change) => change.id === targetId);
  return index < 0 ? changes.slice(0, 3) : changes.slice(index, index + 3);
}

// One question, one answer: what moves, what stays and why, in at most three lines.
// Only "Yes", "Try another" and "Cancel" answer it; Yes is offered only for a savable plan.
// `later` names the other moved tasks; `breaks` and `rest` count what the plan keeps in place.
// `spacing` says when the planner, not the five default rules, spaced this proposal.
export function proposalQuestion({ conflict = false, noChange = false, target = null, moved = 0,
  fixed = 0, done = 0, breaks = 0, rest = 0, later = null, reason = "", note = "", why = "", next = null,
  noAlternative = false, otherDay = false, spacing = "", reference } = {}) {
  const at = (place) => `${friendlyDate(place.date, reference)} ${formatTime(place.start)}`;
  const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const listed = (parts) => parts.length > 2 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join(" and ");
  const names = (list) => listed(list.length > 3 ? [...list.slice(0, 2), count(list.length - 2, "more task")] : list);
  const kept = [fixed && count(fixed, "fixed event"), breaks && count(breaks, "break"),
    done && count(done, "completed task")].filter(Boolean);
  // `next` is the planner's nearest free time for a time that did not fit, not one of the ALTERNATIVES.
  const nextLine = next ? `A nearby time is free. Try another to check ${at(next)}.` : "";
  let title, lines;
  if (conflict) {
    title = "This time does not fit yet";
    lines = [`Nothing moves: ${reason || "No complete plan meets the current rules."}`,
      note || "Your original plans are kept.", nextLine || "Type another time, or Cancel."];
  } else if (noChange) {
    title = "No time changes";
    lines = [reason || "Nothing needs to move, so there is nothing to save.", note];
  } else {
    // Name every other moved task, and say where one leaves the day.
    const others = later || [], sameDay = others.filter((c) => c.to && c.from && c.to.date === c.from.date);
    const away = others.filter((c) => !sameDay.includes(c)).map((c) => !c.to ? `${c.title} stays unscheduled`
      : `${c.title} moves to ${c.to.date === addDays(reference || c.from?.date || c.to.date, 1) ? "tomorrow" : friendlyDate(c.to.date, reference)} ${formatTime(c.to.start)}`);
    const follow = [sameDay.length ? `${names(sameDay.map((c) => c.title))} ${sameDay.length === 1 ? "follows" : "follow"} in the same order` : "", ...away].filter(Boolean);
    const unnamed = later ? 0 : Math.max(0, moved - (target ? 1 : 0));
    const because = note ? (/^Why:/.test(note) ? note : `Why: ${note}`) : why || (!target ? ""
      : others.length || unnamed ? `Why: at its new time ${target.title} would run into ${others[0]?.title || "later tasks"}, so later tasks move back in order with their lengths unchanged.`
      : target.to ? `Why: ${at(target.to)} is free, so nothing else has to move.` : "");
    title = "Change it like this?";
    lines = [
      target ? `Moves: ${target.title}, ${at(target.from)} → ${target.to ? at(target.to) : "unscheduled"}${follow.length ? `; ${follow.join("; ")}`
        : unnamed ? `, and ${count(unnamed, "later task")} in the same order` : ""}.`
        : `Moves: ${count(moved, "task")}.`,
      `Stays: ${kept.length ? listed(kept) + ". " : ""}${rest ? `${rest}-minute rests stay before and after each task; fixed events` : "Fixed events"} and completed work never move.${spacing ? " " + spacing : ""}`,
      [because, nextLine || (noAlternative ? otherDay ? "Other options need a same-day time." : "No other options are left." : "")].filter(Boolean).join(" "),
    ];
  }
  return { title, lines: lines.filter(Boolean).slice(0, 3), canSave: !conflict && !noChange,
    buttons: ["Yes", "Try another", "Cancel"] };
}

// Plan from now keeps the planner's own answer on the task's own day (later study moves with it).
// Moving to another day, even from Plan from now, is a one-task move under the default rules.
export function usesDefaultRules(startFromNow, entryDate, targetDate) {
  return !startFromNow || entryDate !== targetDate;
}

// A new time for one ordinary task on its own day gets the five default rules' proposal.
// A time the rules cannot give as asked keeps the planner's own answer.
const OTHER_DAY_LINE = "Other options need a same-day time.";
export function applyDefaultRules(out, days, entry, date, start) {
  if (!out || !entry) return null;
  if (entry.date !== date) {
    const failed = !["ok", "warning"].includes(out.status);
    if (failed && out.status !== "conflict") return null;
    const moved = proposeMoveToDay(days, { date: entry.date, taskId: entry.task.id, targetDate: date, start });
    if (failed) {
      // The planner has no next step for a time that breaks the fixed-event buffer: offer the closest free
      // time that keeps it, as the same "A nearby time is free" line the same-day case uses.
      const near = moved.status === "conflict" && Number.isInteger(moved.nearest)
        ? proposeMoveToDay(days, { date: entry.date, taskId: entry.task.id, targetDate: date, start: moved.nearest }) : null;
      // The planner's own alternatives stay behind it, unless they name the same time.
      if (near?.status === "ok") out.alternatives = [{ label: `Move to ${date} ${formatTime(moved.nearest)}`, targetDate: date, targetStart: moved.nearest },
        ...(out.alternatives || []).filter((a) => !(a.targetDate === date && a.targetStart === moved.nearest))];
      return null;
    }
    if (moved.status === "error") return null;
    if (moved.status === "conflict") {
      const near = Number.isInteger(moved.nearest) ? proposeMoveToDay(days, { date: entry.date, taskId: entry.task.id, targetDate: date, start: moved.nearest }) : null;
      if (near?.status === "ok") {
        near.lead = `${formatTime(start)} does not fit. The nearest time that fits is ${formatTime(moved.nearest)}. ${OTHER_DAY_LINE}`;
        writeProposal(out, days, near, entry.task.id);
        return near;
      }
      Object.assign(out, { status: "conflict", days: structuredClone(days), changes: [], alternatives: [], warnings: [],
        conflicts: [{ message: moved.message, ids: [entry.task.id] }], unscheduled: [] });
      return null;
    }
    moved.lead = OTHER_DAY_LINE;
    writeProposal(out, days, moved, entry.task.id);
    return moved;
  }
  if (learningTask(entry.task)) return null;
  const ruled = proposeReschedule(days, { date, taskId: entry.task.id, start });
  const anchor = ruled.proposal?.changes.find((change) => change.id === entry.task.id);
  if (ruled.status === "error" || anchor?.to?.date !== date || anchor.to.start !== start) return null;
  writeProposal(out, days, ruled, entry.task.id);
  return ruled;
}

// Rewrite the previewed result in place, so Yes saves exactly this proposal through the
// normal preview → Yes → save → Undo path.
function writeProposal(out, days, ruled, anchorId) {
  const { proposal } = ruled, tasks = new Map(rows(days).map((e) => [e.task.id, e.task]));
  const after = new Map(rows(proposal.days).map((e) => [e.task.id, e.task]));
  const anchor = proposal.changes.find((change) => change.id === anchorId);
  const placed = proposal.changes.filter((change) => change.to);
  Object.assign(out, {
    timeline: proposal.timeline, status: "ok", days: proposal.days, conflicts: [], alternatives: [], warnings: [],
    exactTarget: anchor?.to || undefined, recommendation: undefined, summary: { skippedDates: [] },
    changes: placed.map((change) => {
      const was = tasks.get(change.id) || tasks.get(anchorId);
      return { ...change, from: { ...(change.from || anchor.from), duration: was?.duration },
        to: { ...change.to, duration: after.get(change.id)?.duration ?? was?.duration } };
    }),
    unscheduled: proposal.changes.filter((change) => !change.to).map(({ id, title, reason }) => ({ id, title, reason })),
  });
}

// The next savable alternative behind "Try another", in the product-direction order,
// starting after position `after`. Alternatives that are unavailable (or only repeat the
// proposal on screen) are skipped. Drop-or-archive asks first; Yes then archives, which
// loses nothing, and Undo restores it.
export function nextAlternative(days, entry, start, after = -1, shown = "", opts = {}) {
  const request = { date: entry.date, taskId: entry.task.id, start }, skipped = [];
  for (let index = after + 1; index < ALTERNATIVES.length; index++) {
    const kind = ALTERNATIVES[index];
    const { settings, ...rest } = opts;
    let ruled = proposeAlternative(days, request, kind, rest, settings), ask = null;
    if (ruled.status === "ask") { ask = ruled.message; ruled = proposeAlternative(days, request, kind, { ...rest, choice: "archive" }, settings); }
    if (ruled.status === "unavailable" && ruled.message) skipped.push(`${ALTERNATIVE_NAME[kind]} was skipped: ${ruled.message}`);
    if (!["ok", "warning"].includes(ruled.status) || !ruled.proposal.changes.length) continue;
    if (shown && JSON.stringify(ruled.proposal.days) === shown) continue;
    return { index, kind, ruled: { ...ruled, lead: [...skipped, ask ? `${ask} Yes archives it; nothing is deleted.` : ALTERNATIVE_WHY[kind]].join(" ") } };
  }
  return null;
}
const ALTERNATIVE_NAME = Object.freeze({ reorder: "Reorder", split: "Split", "usual-slot": "Usual slot", unscheduled: "Leave unscheduled",
  "drop-or-archive": "Archive", "morning-replan": "Morning replan" });
const ALTERNATIVE_WHY = Object.freeze({
  reorder: "The rest of the day is reordered by deadline and priority.",
  split: "The task is split across today and tomorrow.",
  "usual-slot": "It is placed where this kind of task is usually done.",
  unscheduled: "It does not fit, so it is left unscheduled.",
  "drop-or-archive": "It was postponed several times, so it is archived.",
  "morning-replan": "The whole day is replanned once this morning.",
});

// Say why a task's length or place changed because of its fixed attributes (empty when none apply).
function attributeNotes(proposal, days, targetId) {
  const before = new Map(rows(days).map((e) => [e.task.id, e.task]));
  const after = rows(proposal.days).map((e) => e.task);
  const named = (pick) => after.filter(pick).map((task) => task.title).join(", ");
  const parts = [];
  const buffered = named((t) => t.estimate && !t.deferred);
  if (buffered) parts.push(attributeMessage("buffer", buffered));
  const tiring = named((t) => t.tiring && !t.deferred && t.type !== "break");
  if (tiring) parts.push(attributeMessage("tiring", tiring));
  const habit = named((t) => t.habit && proposal.unscheduled.includes(t.id));
  if (habit) parts.push(attributeMessage("habit", habit));
  const late = (proposal.late || []).map((id) => before.get(id)?.title || after.find((t) => t.id === id)?.title).filter(Boolean).join(", ");
  if (late) parts.push(attributeMessage("late", late));
  const title = (id) => before.get(id)?.title || after.find((t) => t.id === id)?.title || id;
  const pairs = (proposal.tiringPairs || []).map((pair) => pair.map(title).join(" and ")).join("; ");
  if (pairs) parts.push(attributeMessage("adjacent", pairs));
  if (after.some((t) => t.id === targetId && t.lockSource === "user")) parts.push(attributeMessage("locked"));
  return parts.join(" ");
}

// The three question lines for a default-rules proposal: what moves, what stays, why.
export function defaultRulesQuestion(ruled, days, targetId, reference, options = {}) {
  const { proposal } = ruled, tasks = new Map(rows(days).map((e) => [e.task.id, e.task]));
  const kept = proposal.unchanged.map((id) => tasks.get(id)).filter(Boolean);
  const target = proposal.changes.find((change) => change.id === targetId);
  const others = proposal.changes.filter((change) => change !== target);
  // The cause is named only when the planner found that a tag changed the slot (change.cause).
  const driver = proposal.changes.find((change) => change.cause);
  const verb = !driver ? "" : !driver.to ? "was left unscheduled" : driver.to.date !== driver.from.date ? "moved to tomorrow" : "moved";
  const named = driver?.causeTitle && driver.causeTitle !== driver.title;
  const cause = !driver ? "" : driver.cause === "habit window" ? `Why: ${driver.title} ${verb} because of its habit window.`
    : driver.cause === "travel time"
      ? `Why: ${driver.title} ${verb} because ${named ? `${driver.causeTitle}'s` : "its"} travel time needs room.`
    : named ? `Why: ${driver.title} ${verb} because ${driver.causeTitle} is tiring and needs recovery time.`
      : `Why: ${driver.title} ${verb} because of its tiring recovery and spacing rule.`;
  // A day the rules cannot finish before 23:00 is a warning; the screen styles it apart.
  return { ...proposalQuestion({ target, moved: proposal.changes.filter((change) => change.to).length, later: others,
    fixed: kept.filter((task) => !task.done && task.type !== "break" && isFixedTask(task)).length,
    breaks: kept.filter((task) => task.type === "break").length,
    done: kept.filter((task) => task.done).length, rest: DEFAULT_RULES.habitBuffer,
    // proposalQuestion adds the unavailable-reason line itself, once, when Try another is off for another day.
    note: [cause, options.noAlternative && options.otherDay ? ruled.lead?.replace(OTHER_DAY_LINE, "").trim() : ruled.lead, ruled.status === "warning" ? ruled.message.replace(/\s*Change it like this\?$/, "") : "",
      attributeNotes(proposal, days, targetId)].filter(Boolean).join(" "),
    why: others.length ? `Why: ${others[0].reason}.` : "", reference, ...options }), warning: ruled.status === "warning" };
}

// The five default rules (60-minute fixed-event buffer, 10-minute rests) answer only a
// same-day or cross-day move of an ordinary task. A study task says that its spacing differs.
export function plannerSpacingNote(target, task, settings = {}) {
  const buffered = (settings.bufferBefore ?? 0) >= DEFAULT_RULES.fixedBuffer && (settings.bufferAfter ?? 0) >= DEFAULT_RULES.fixedBuffer;
  if (!target?.to || buffered) return "";
  if (target.to.date !== target.from.date) return "";
  const who = learningTask(task) ? "A study task" : "This move";
  return `${who} is spaced without the same-day ${DEFAULT_RULES.fixedBuffer}-minute buffer around fixed events.`;
}

export function friendlyDate(date, reference = date) {
  const [year, month, day] = date.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1]} ${day}${date.slice(0, 4) !== reference.slice(0, 4) ? ", " + year : ""}`;
}

// An unchanged automatic recommendation can still differ from the requested now.
export function retainedRecommendation(result, reference) {
  const requested = result.recommendation?.requested, target = result.exactTarget;
  if (!requested || !target || (requested.date === target.date && requested.start === target.start)) return "";
  const day = target.date === reference ? "Today" : target.date === addDays(reference, 1) ? "Tomorrow" : friendlyDate(target.date, reference);
  const reason = result.recommendation.reason || "";
  const explanation = /another original day package|original study group/i.test(reason)
    ? "The original study group already uses this day, including completed work. The groups cannot be combined."
    : reason ? reason.replace(/[.]+$/, "") + "." : "";
  return `Keeping ${day} ${formatTime(target.start)}. ${explanation}`;
}

export function packageChanges(changes, days) {
  const tasks = new Map(rows(days).map((e) => [e.task.id, e.task]));
  const groups = new Map();
  for (const change of changes) {
    const task = tasks.get(change.id);
    if (!learningTask(task) || task.done) continue;
    const key = JSON.stringify([task.planId, task.packageId]);
    if (!groups.has(key))
      groups.set(key, {
        key,
        planId: task.planId,
        packageId: task.packageId,
        memberIds: [],
        members: [],
        origin: task.packageOriginDate || change.from.date,
        from: change.from.date,
        to: change.to.date,
        count: 0,
      });
    const group = groups.get(key);
    group.memberIds.push(change.id);
    group.members.push(change);
    group.count++;
  }
  return [...groups.values()];
}

export function timelineDate(date, reference) {
  const relative = date === reference ? "Today" : date === addDays(reference, 1) ? "Tomorrow" : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(date + "T12:00:00Z").getUTCDay()];
  return `${relative} · ${friendlyDate(date, reference)}`;
}

function weekMarkup(model, selectedDate, now) {
  return `<section class="week-context desktop-context" aria-label="Selected week, read-only"><ol>${model.week.map(day=>`<li class="${day.date===selectedDate?'week-selected':''} ${day.date===now.date?'week-today':''}" ${day.date===selectedDate?'aria-current="date"':''}><p class="week-date">${esc(friendlyDate(day.date,now.date))}<span>${day.date===now.date?'Today':''}${day.date===now.date && day.date===selectedDate?' · ':''}${day.date===selectedDate?'Selected':''}</span></p><p class="week-summary">${esc(day.label)}</p><div class="week-occupancy ${day.known?'':'unknown'}" aria-hidden="true">${day.known?`<i style="width:${Math.round(day.busyRatio*100)}%"></i>`:''}</div></li>`).join('')}</ol></section>`;
}
/** Plot references retain real bar positions; only labels move to avoid collisions. */
function axisReferences(items, axisStart, axisEnd) {
  const span = axisEnd - axisStart;
  const visible = items.filter(b => !b.nonBlocking && b.actualStart < axisEnd && b.actualEnd > axisStart);
  const references = visible.map(b => ({
    ...b,
    center: 100 * ((Math.max(axisStart,b.actualStart) + Math.min(axisEnd,b.actualEnd)) / 2 - axisStart) / span,
  })).sort((a,b) => a.center - b.center || a.index - b.index);
  const gap = 100 / (references.length + 1);
  for (let i = 0; i < references.length; i++)
    references[i].label = Math.max(references[i].center, gap / 2, i ? references[i-1].label + gap : 0);
  for (let i = references.length - 1; i >= 0; i--)
    references[i].label = Math.min(references[i].label, i === references.length - 1 ? 100 - gap / 2 : references[i+1].label - gap);
  return references;
}

export function dayMarkup(model, settings, selectedId, days) {
  const day=model.day, span=day.axisEnd-day.axisStart, pct=instant=>100*(instant-day.axisStart)/span;
  const lanes=[];
  const items=day.items.map((block,i)=>{let lane=lanes.findIndex(end=>end<=block.start);if(lane<0)lane=lanes.length;lanes[lane]=block.end;return{...block,lane,index:i+1};});
  const segment=(block,start,end,kind)=>{start=Math.max(start,day.axisStart);end=Math.min(end,day.axisEnd);return end>start?`<i class="axis-interval ${kind} ${kind==='task' && isFixedTask(block.entry.task)?'fixed':''} ${block.entry.task.id===selectedId?'axis-selected':''}" ${kind==='task'?`data-axis-index="${block.index}"`:""} style="top:${pct(start)}%;height:${pct(end)-pct(start)}%;left:${block.lane/Math.max(1,lanes.length)*100}%;width:${100/Math.max(1,lanes.length)}%"></i>`:'';};
  const intervals=items.filter(b=>!b.nonBlocking).map(b=>{
    const rest = !isActivity(b.entry.task) && !b.entry.task.externalReadOnly ? b.entry.task.rest || 0 : 0;
    const restEnd = Math.min(b.end, b.actualEnd + rest * 60000);
    return segment(b,b.start,b.actualStart,'protection') + segment(b,b.actualStart,b.actualEnd,'task') + segment(b,b.actualEnd,restEnd,'rest') + segment(b,restEnd,b.end,isActivity(b.entry.task)?'protection':'gap');
  }).join('');
  const references = axisReferences(items,day.axisStart,day.axisEnd);
  const leaders = `<svg class="axis-leaders" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${references.map(b=>`<path d="M ${(b.lane+1)/Math.max(1,lanes.length)*100} ${b.center} L 125 ${b.label}"/>`).join('')}</svg>`;
  const referenceLabels = references.map(b=>`<span class="axis-reference" data-reference-index="${b.index}" style="top:${b.label}%">${b.index}</span>`).join('');
  const ticks=[540,720,900,1080,1260,1380].map(minute=>`<span class="axis-tick" style="top:${pct(wallInstant(day.date,minute,settings.timeZone))}%">${formatTime(minute)}</span>`).join('');
  const now=model.nowInstant!==null&&model.nowInstant>=day.axisStart&&model.nowInstant<=day.axisEnd?`<div class="axis-now" style="top:${pct(model.nowInstant)}%"><span>Now</span></div>`:'';
  return `<section class="day-context desktop-context" aria-label="Day timeline, read-only"><div class="context-heading"><h2>Day timeline</h2><p>${day.known?'Study':'Known study'} ${day.learning}/${day.capacity} min${day.completed?` (including ${day.completed} completed min)`:''}</p></div>${!day.known?'<p class="reading-note">Calendar reading is incomplete. Only known plans are shown.</p>':day.closed?'<p class="context-rest">Rest day · No study scheduled</p>':''}${day.conflicts.length?`<p class="issue context-conflict">${esc(day.conflicts[0].message)}${day.conflicts.length>1?` ${day.conflicts.length-1} more conflicts.`:''}</p>`:''}<p class="context-legend"><span class="legend-fixed">Fixed · ${FIXED_LABEL.toLowerCase()}</span><span class="legend-movable">Movable</span><span class="legend-rest">Break</span><span class="legend-protection">${BUFFER_EXPLANATION}</span><span>Numbers beside the timeline match the plans on the right</span></p><div class="context-body"><div style="--axis-reference-count:${references.length+1}" class="day-axis ${day.known?'':'unknown'}" aria-hidden="true">${ticks}<div class="axis-track">${intervals}${leaders}${referenceLabels}${now}</div></div><ol class="day-agenda">${items.map(b=>{
    const e=b.entry,t=e.task,timing=taskTiming(e,settings),fixed=isFixedTask(t);
    return `<li class="agenda-item ${t.id===selectedId?'agenda-selected':''} ${fixed?'agenda-fixed':''}"><p class="agenda-title"><span class="agenda-number">${b.index}</span>${esc(t.title)}${fixed&&!t.done?fixedBadge(t):''}</p><p class="agenda-time">${esc(timing.range.replace(e.date===day.date?e.date+' ':'\0',''))}${t.done?' · '+(days?doneLabel(days,t):'Completed'):b.nonBlocking?' · Does not block time':''}</p>${timingNote(timing)}${fixed&&isActivity(t)?`<p class="protection-note">${esc(bufferNote(t,settings))}</p>`:""}${b.start<day.axisStart||b.end>day.axisEnd?'<p class="outside-window">Includes time outside the 09:00–23:00 view</p>':''}</li>`;
  }).join('')}${!items.length?`<li class="day-empty">${day.known?day.source==='local'?'No local plans for this day.':'No plans for this day.':'The full schedule for this day is not yet available.'}</li>`:''}</ol></div><p class="context-footnote">${day.known?day.source==='local'?'Showing local plans only.':'Empty space means no plans are scheduled.':'Hatching marks incomplete schedule information.'}</p></section>`;
}

export function previewOverview(changes, days) {
  const packages = packageChanges(changes, days);
  return {
    packages,
    packageCount: packages.length,
    taskCount: changes.length,
    from: changes.map(c => c.from.date).sort()[0] || null,
    to: changes.map(c => c.to.date).sort().at(-1) || null,
    later: changes.length > 0 && changes.every(c => c.to.date > c.from.date || (c.to.date === c.from.date && c.to.start >= c.from.start)),
  };
}

export function previewScope(changes, days, targetId, reference) {
  const overview = previewOverview(changes, days), packages = overview.packages;
  const target = changes.find(c => c.id === targetId), own = packages.find(p => p.memberIds.includes(targetId));
  const others = packages.filter(p => p !== own);
  const sameDay = changes.every(c => c.from.date === c.to.date);
  const end = overview.to ? `through ${friendlyDate(overview.to, reference)}` : '';
  let text = '';
  if (sameDay) {
    const count = changes.length - (target ? 1 : 0);
    if (count) text = `${count} ${target ? 'other ' : ''}plan${count === 1 ? '' : 's'} will change together.`;
  } else if (packages.length) {
    if (others.length) {
      const following = own && overview.later && others.every(p => p.planId === own.planId && p.origin > own.origin);
      text = `${others.length} ${following ? 'later study day' : 'other study group'}${others.length === 1 ? '' : 's'} will move ${end}.`;
    }
    const members = new Set(packages.flatMap(p => p.memberIds));
    const nonLearning = changes.filter(c => !members.has(c.id) && c.id !== targetId).length;
    if (nonLearning) text += ` ${nonLearning} other plan${nonLearning === 1 ? '' : 's'} will also change${text ? '.' : ` ${end}.`}`;
  } else if (changes.length > (target ? 1 : 0)) {
    const count = changes.length - (target ? 1 : 0);
    text = `${count} ${target ? 'other ' : ''}plan${count === 1 ? '' : 's'} will change together ${end}.`;
  }
  if (packages.length > 3) text += ' Showing the first 3. Open all changes for the complete list.';
  return text.trim();
}

export function skippedDateSummary(skipped, settings, reference) {
  const dates = new Map();
  for (const item of skipped) {
    const closed = rulesForDate(settings,item.date).closed || settings.learningDates?.[item.date]?.closed || settings.learningClosed?.includes(item.date);
    const reason = closed ? 'Rest day' : /no (?:available )?study time/i.test(item.reason) ? 'No available study time'
      : /another (?:original )?(?:study group|day package)/i.test(item.reason) ? 'Another study group already scheduled' : /(?:exceed|remaining|daily).*(?:capacity|study limit)/i.test(item.reason) ? 'Not enough remaining study capacity' : 'The complete study group does not fit';
    // Several packages can try the same date; count dates, not attempts.
    dates.set(item.date, dates.has(item.date) && dates.get(item.date) !== reason ? 'The complete study group does not fit' : reason);
  }
  const groups = new Map();
  for (const [date,reason] of dates) { if(!groups.has(reason))groups.set(reason,[]);groups.get(reason).push(date); }
  const shown = [...groups].slice(0,2);
  const text = shown.map(([reason,ds]) => `${ds.slice(0,2).map(d=>friendlyDate(d,reference)).join(', ')}${ds.length>2 ? ` and ${ds.length - 2} more days` : ''}: skipped. ${reason}. `).join('');
  const rest = dates.size - shown.reduce((n,[,ds])=>n+ds.length,0);
  return (text + (rest ? `${rest} more day${rest === 1 ? '' : 's'} skipped. See all changes for the reasons.` : '')).trim();
}

export function adjustmentPresentation(changes, days, targetId, reference) {
  const overview = previewOverview(changes, days);
  const target = changes.find(c => c.id === targetId) || changes[0];
  const sameDay = changes.length > 0 && changes.every(c => c.from.date === c.to.date);
  const multiPlan = new Set(overview.packages.map(p => p.planId)).size > 1;
  const unit = multiPlan ? "study group" : "study day";
  const affectedDays = overview.packageCount;
  const dayTime = c => `${c.to.date === reference ? "Today" : friendlyDate(c.to.date, reference)} ${formatTime(c.to.start)}`;
  let headline = "Your new time is ready", result = target ? `${target.title} moves to ${dayTime(target)}.` : "The scheduled time has not changed.";
  if (sameDay) {
    const delta = changes[0].to.start - changes[0].from.start;
    const commonDelta = changes.every(c => c.to.start - c.from.start === delta);
    const sameDate = changes.every(c => c.from.date === changes[0].from.date);
    const day = sameDate ? (changes[0].from.date === reference ? "Today" : friendlyDate(changes[0].from.date, reference)) : "This change";
    const duration = Math.abs(delta) % 60 === 0 ? `${Math.abs(delta) / 60} hr` : `${Math.abs(delta)} min`;
    headline = commonDelta && delta ? `${changes.length} plan${changes.length === 1 ? "" : "s"} ${delta > 0 ? "later" : "earlier"} by ${duration}` : `${changes.length} plan${changes.length === 1 ? "" : "s"} will change`;
    result = changes.length === 1 ? `${target.title} moves to ${dayTime(target)}. Later study dates stay the same.` : `${changes.length} plans are ready. Later study dates stay the same.`;
  } else if (overview.packageCount) {
    headline = `${affectedDays} ${unit}${affectedDays === 1 ? "" : "s"} ${overview.later ? "move later in order" : "rescheduled"}`;
    result = `This changes ${affectedDays} ${unit}${affectedDays === 1 ? "" : "s"}, through ${friendlyDate(overview.to, reference)}.`;
  } else if (changes.length) {
    result += ` The latest change is on ${friendlyDate(overview.to, reference)}.`;
  }
  return { headline, result, facts: [], affectedDays, packageCount: overview.packageCount, sameDay };
}

// Demo clock is fixed; personal scheduling uses the application's timezone, not the device's.
// First-open guide: the same three steps everywhere.
export const FIRST_USE_EXAMPLE_TIME = "tomorrow at 11 am";
export const FIRST_USE_STEPS = Object.freeze([
  "Pick a task.",
  `Choose a time, then type "${FIRST_USE_EXAMPLE_TIME}".`,
  "Answer \"Yes\" to save. Undo is always there.",
]);
export const EXAMPLE_BUTTON_LABEL = "Try the example · Fictional data";
export function firstUseGuide() {
  return `<section class="first-use-guide" aria-label="How Shunri works"><h2>Reschedule in three steps</h2><ol>${FIRST_USE_STEPS.map(step => `<li>${esc(step)}</li>`).join("")}</ol></section>`;
}
// After the guide hides, the same steps stay one tap away, collapsed.
function firstUseReminder() {
  return `<details class="first-use-reminder"><summary>How to reschedule</summary><ol>${FIRST_USE_STEPS.map(step => `<li>${esc(step)}</li>`).join("")}</ol></details>`;
}
// Show the guide until the first change is saved; after that it stays hidden
// for good, even after Undo or switching between the example and personal.
export function showsFirstUseGuide(context, rescheduled = false) {
  const branch = context?.branch || {};
  return !rescheduled && !context?.ui?.rescheduledOnce && !branch.undo && !context?.error;
}

export function planningNow(context, instant = Date.now()) {
  return context.mode === "demo" ? { date: context.branch.exampleOrigin, minute: 690 }
    : { ...dateParts(instant, context.branch.settings.timeZone), instant };
}

// One reachable surface. Every stage replaces the previous controls, including the header.
const isEditingLabel = label => typeof label === "string" && /edit/i.test(label);

export const MEANING_LOCK_NOTE = "This time will also be locked by you and will not move.";
// Lock the task inside the proposal's own branch (never the live plan) and say so in the confirmation text.
export function applyMeaningLock(proposal, taskId) {
  let locked = false;
  for (const list of Object.values(proposal?.semanticBranch?.days || {}))
    for (const t of list)
      if (t.id === taskId) { t.locked = true; t.lockSource = "user"; locked = true; }
  if (locked && proposal.semanticDescription && !proposal.semanticDescription.includes(MEANING_LOCK_NOTE))
    proposal.semanticDescription = proposal.semanticDescription.replace(/ The original time stays unchanged\./, " The original time stays unchanged. " + MEANING_LOCK_NOTE);
  return locked;
}
export function createWorkbench(api) {
  const root = document.getElementById("workbench"),
    header = document.getElementById("wb-calendar"),
    label = document.getElementById("wb-calendar-label");
  let encouragementAudio = null, rescheduled = false;
  let phase = "home",
    selectedId = api.context().ui?.selection?.mode === api.context().mode ? api.context().ui.selection.id : null,
    query = "",
    page = 0,
    draft = null,
    preview = null,
    detail = false,
    request = 0,
    custom = null,
    returnPhase = "home",
    lastConfirmed = null,
    viewNotice = "",
    refreshNotice = null,
    refreshView = null,
    refreshEpoch = 0,
    homeTaskId = null,
    personalView = api.context().ui?.personalViewBeforeDemo || null;
  const $ = (id) => document.getElementById("wb-" + id);
  function stopEncouragement() {
    if (!encouragementAudio) return;
    encouragementAudio.pause();
    encouragementAudio.currentTime = 0;
    encouragementAudio = null;
  }
  function bindEncouragement() {
    on("encouragement", async () => {
      const control = $("encouragement"), status = $("encouragement-status");
      if (!control || !status) return;
      if (encouragementAudio && !encouragementAudio.paused) {
        stopEncouragement();
        control.textContent = "Play encouragement";
        control.setAttribute("aria-pressed", "false");
        status.textContent = "Stopped. Take your time.";
        return;
      }
      const audio = document.createElement("audio");
      audio.preload = "none";
      audio.autoplay = false;
      audio.src = "/assets/encouragement.mp3";
      encouragementAudio = audio;
      const current = () => encouragementAudio === audio && $("encouragement") === control;
      const unavailable = () => {
        if (!current()) return;
        stopEncouragement();
        control.disabled = false;
        control.textContent = "Play encouragement";
        control.setAttribute("aria-pressed", "false");
        status.textContent = "The encouragement audio is unavailable. You can keep planning without it.";
      };
      audio.addEventListener("error", unavailable, { once: true });
      audio.addEventListener("ended", () => {
        if (!current()) return;
        stopEncouragement();
        control.textContent = "Play encouragement";
        control.setAttribute("aria-pressed", "false");
        status.textContent = "Finished. Go at your own pace.";
      }, { once: true });
      status.textContent = "Loading the optional encouragement…";
      control.disabled = true;
      try {
        await audio.play();
        if (!current()) return;
        control.disabled = false;
        control.textContent = "Stop encouragement";
        control.setAttribute("aria-pressed", "true");
        status.textContent = "Playing encouragement.";
      } catch { unavailable(); }
    });
  }
  const context = () => api.context();
  const when = (e) => arrangementRange(e, context().branch.settings.timeZone);
  const selected = () =>
    rows(context().branch.days).find((e) => e.task.id === selectedId && !e.task.calendarLink?.remoteDeleted);
  const needsManagement = (e) =>
    e?.task.externalReadOnly &&
    e.task.calendarClassification?.manage !== false &&
    learningTask(e.task) &&
    !e.task.done &&
    e.task.lockSource !== "user" &&
    !e.task.timeLocked &&
    e.task.type !== "activity" &&
    canManageCalendarSource(e.task.calendarSource);
  const canAdjust = (e) => e && (api.movable(e.task) || needsManagement(e));
  // Transient explanation only: reuse the actual control predicate, never
  // change management, scheduling, or Google write authorization.
  const refreshViewKey = () => JSON.stringify([context().mode, context().date, selectedId]);
  const refreshSurface = () => context().mode === "personal" && ["home", "calendar"].includes(phase) && !lastConfirmed;
  const refreshTasks = () => rows(context().branch.days)
    .filter(e => e.task.calendarLink?.source === "google")
    .map(e => ({
      key: JSON.stringify([e.task.id, e.task.uid, e.task.calendarLink.calendarId, e.task.calendarLink.eventId]),
      id: e.task.id, title: e.task.title, date: e.date,
      active: !e.task.done && !e.task.deferred && !e.task.calendarLink.remoteDeleted,
      adjust: Boolean(!e.task.done && !e.task.deferred && !e.task.calendarLink.remoteDeleted && !e.task.calendarConflict && canAdjust(e)),
      needsManagement: Boolean(needsManagement(e)),
      cancelled: Boolean(e.task.deferred && e.task.calendarLink.remoteDeleted && e.task.calendarLink.deferredByCancellation),
      conflict: Boolean(e.task.calendarConflict),
    }));
  function refreshNoticeContext(task) {
    const entries = rows(context().branch.days), entry = entries.find(e => e.task.id === task.id);
    if (!entry) return null;
    const timeZone = context().branch.settings.timeZone, range = arrangementRange(entry, timeZone);
    const sameTitle = entries.filter(e => e.task.title === task.title &&
      (e.task.id === task.id || !e.task.calendarLink?.remoteDeleted));
    const current = selected() || entries.find(e => e.task.id === homeTaskId && !e.task.calendarLink?.remoteDeleted);
    const relation = current?.task.id === task.id ? "this event"
      : current?.task.title === task.title ? "another event with the same name" : "an event with the same name";
    return {
      subject: sameTitle.length > 1 ? `${relation}, “${task.title}” (${range})` : `“${task.title}”`,
      range, timeZone,
      // Identity stays internal. Even identical names and ranges do not make
      // this public description a unique event identifier.
      sameTitleIds: sameTitle.map(e => e.task.id).sort(),
    };
  }
  function syncRefreshNotice() {
    const view = refreshViewKey(), surface = refreshSurface();
    if (refreshView !== view || !surface) {
      refreshNotice = null;
      refreshEpoch++;
      refreshView = view;
    }
    if (refreshNotice && (
      JSON.stringify(refreshTasks().find(t => t.key === refreshNotice.task.key)) !== JSON.stringify(refreshNotice.task) ||
      JSON.stringify(refreshNoticeContext(refreshNotice.task)) !== JSON.stringify(refreshNotice.context)
    )) refreshNotice = null;
    const line = $("refresh-notice"), text = refreshNotice?.text || "";
    if (line) {
      // This live region sits outside the replaced shell. Unchanged polls do
      // not replace the node or its text, and no notice operation moves focus.
      if (line.textContent !== text) line.textContent = text;
      line.hidden = !text;
    }
  }
  function captureCalendarRead(anchor) {
    syncRefreshNotice();
    if (anchor === null || anchor && (anchor.view !== refreshViewKey() || anchor.epoch !== refreshEpoch)) return null;
    return refreshSurface() ? { view: refreshViewKey(), epoch: refreshEpoch, preferredId: selectedId || homeTaskId, tasks: refreshTasks() } : null;
  }
  function completeCalendarRead(snapshot, { complete }) {
    syncRefreshNotice();
    if (!snapshot || !complete || !refreshSurface() || snapshot.view !== refreshViewKey() || snapshot.epoch !== refreshEpoch) return;
    const after = refreshTasks();
    const changes = after.flatMap(task => {
      // Another task's conflict does not invalidate this task's saved facts.
      // A resolved prior conflict (including cancellation) may reveal them.
      if (task.conflict) return [];
      const before = snapshot.tasks.find(t => t.key === task.key);
      if (!before) return [];
      const change = before.cancelled && task.active ? "is back on the schedule."
        : before.adjust && !task.adjust ? "can no longer be moved by Shunri."
        : !before.adjust && task.adjust ? task.needsManagement
          ? "can be adjusted again; choosing a time still requires management confirmation."
          : "can now be adjusted in Shunri." : "";
      return change ? [{ task, change }] : [];
    });
    const next = changes.find(n => n.task.id === snapshot.preferredId) || changes[0];
    if (next) {
      const display = refreshNoticeContext(next.task);
      if (display) refreshNotice = { task: next.task, context: display, text: `After refreshing, ${display.subject} ${next.change}` };
    }
    syncRefreshNotice();
  }
  const on = (id, fn) => {
    if ($(id)) $(id).onclick = fn;
  };
  const home = (message = "") => {
    viewNotice = typeof message === "string" ? message : "";
    stopCustom();
    // Returning home ends this intent. Keep the text/exact draft, but a new
    // entry must resolve a fresh clock/task baseline and ask its own questions.
    // Internal retry, purpose continuation and detail return do not call home.
    if (draft) draft.expressionIntent = null;
    phase = "home";
    lastConfirmed = null;
    request++;
    render();
  };
  const leaveDemo = () => {
    api.clearNotice?.();
    if (api.switchMode("personal") === false) return;
    if (personalView) ({ selectedId, query, page, draft } = personalView);
    if (!selected()) selectedId = null;
    personalView = null;
    home();
  };
  const shell = (
    title,
    body,
    actions = "",
    intro = "",
    embeddedHeading = false,
    recordMode = null,
  ) => {
    syncRefreshNotice();
    // Automatic custom previews replace only this region, never the input nodes.
    if (custom && $("custom-result") && ["adjust", "preview", "conflict", "details", "meaning", "time-question", "permission", "busy", "error"].includes(phase)) {
      const modal = ["details", "meaning", "time-question", "permission", "busy", "error"].includes(phase) || Boolean(preview?.semanticCorrection);
      $("custom-inputs").inert = modal;
      $("custom-result").dataset.stage = phase;
      $("custom-result").innerHTML = `<h2>${esc(title)}</h2>${body}<div class="work-actions">${actions}</div><p id="wb-error" class="error" role="alert"></p>`;
      return;
    }
    const previousStage = root.querySelector("[data-stage]")?.dataset.stage,
      focusedId = document.activeElement?.id,
      displayMode = recordMode || context().mode;
    stopEncouragement();
    root.innerHTML = `<section class="work-area" data-stage="${phase}">${intro || (displayMode === "demo" && phase !== "home") ? `<p class="step-label">${displayMode === "demo" ? (intro ? "Independent example · " : "Independent example") : ""}${esc(intro)}</p>` : ""}${embeddedHeading ? "" : `<h1>${esc(title)}</h1>`}${body}${actions ? `<div class="work-actions">${actions}</div>` : ""}<p id="wb-error" class="error" role="alert"></p></section>`;
    header.hidden = phase !== "home" || context().mode === "demo";
    label.hidden = !header.hidden;
    label.innerHTML = `<img src="/assets/google-calendar.png" width="20" height="20" alt=""><span>Google Calendar<span class="calendar-state">${esc(statusText())}</span></span>`;
    const heading = root.querySelector("h1");
    heading.tabIndex = -1;
    if (
      previousStage === phase &&
      focusedId &&
      document.getElementById(focusedId)?.getClientRects().length
    )
      document.getElementById(focusedId).focus({ preventScroll: true });
    else heading.focus({ preventScroll: true });
  };
  const statusText = () =>
    context().calendarStatus?.mock
      ? ({ disconnected: "Demo · Not connected", "writes-off": "Demo · Writes off", expired: "Demo · Reconnect needed", syncing: "Demo · Syncing", "partial-failure": "Demo · Partly unavailable", offline: "Demo · Offline" }[context().calendarStatus.mockState] || "Demo")
      : context().reading
      ? "Reading"
      : {
          connected: "Connected",
          expired: "Reconnect",
          network: "Temporarily unavailable",
          storage_error: "Authorization storage unavailable",
          disconnected: "Not connected",
          unconfigured: "Not configured",
        }[context().calendarStatus?.state] || "Checking";
  function refreshStatus() {
    header.querySelector("span").innerHTML = `Google Calendar<span class="calendar-state">${esc(statusText())}</span>`;
    label.innerHTML = `<img src="/assets/google-calendar.png" width="20" height="20" alt=""><span>Google Calendar<span class="calendar-state">${esc(statusText())}</span></span>`;
    if (phase === "calendar") renderCalendar();
    else if (phase === "home") renderHome();
    else if (phase === "completed" && lastConfirmed) renderSavedArrangement(lastConfirmed);
    else if (phase === "result-details" && lastConfirmed) renderResultDetails();
  }
  function renderHome() {
    const c = context(),
      entries = rows(c.branch.days).filter(
        (e) => !e.task.deferred && !e.task.calendarLink?.remoteDeleted,
      ),
      now = planningNow(c);
    const dayEntries = entries.filter(
      (e) =>
        e.date === c.date ||
        (e.task.calendarOccupation &&
          e.task.calendarOccupation.startInstant < c.dayEndInstant &&
          e.task.calendarOccupation.endInstant > c.dayStartInstant),
    );
    let current =
      selected() ||
      dayEntries.find(
        (e) =>
          !e.task.done &&
          e.task.start <= now.minute &&
          e.task.start + e.task.duration > now.minute &&
          c.date === now.date,
      ) ||
      dayEntries.find(
        (e) =>
          !e.task.done && e.task.start >= now.minute && c.date === now.date,
      ) ||
      dayEntries.find(
        (e) =>
          !e.task.done &&
          (api.movable(e.task) ||
            e.date > now.date ||
            (e.date === now.date &&
              e.task.start + e.task.duration > now.minute)),
      ) ||
      null;
    const viewDate = c.date;
    homeTaskId = current?.task.id || null;
    const fixed = current && isFixedTask(current.task);
    const canMove = canAdjust(current),
      canDone =
        current &&
        !current.task.externalReadOnly &&
        !fixed &&
        !current.task.locked;
    const readOnlyNote = readOnlyCalendarNote(current?.task, needsManagement(current));
    const restDay = rulesForDate(c.branch.settings,viewDate).closed || c.branch.settings.learningDates?.[viewDate]?.closed;
    const note = restDay
      ? "No study is scheduled this day. Later study stays in its original order."
      : current?.task.semantic?.explanation ||
        current?.task.explanation ||
        current?.task.semanticExplanation ||
        (fixed
          ? isActivity(current.task) ? "This is a fixed event. Its original time is preserved." : "This time is locked. It will not move."
          : current?.task.externalReadOnly
            ? readOnlyNote ? "" : "This calendar event is currently read-only."
            : current?.task.done
              ? (doneLabel(c.branch.days, current.task) === "Completed" ? "Completed. The actual completion record is preserved." : "This part is saved as done. The rest of the work is still open.")
              : current?.date < now.date ||
                  (current?.date === now.date &&
                    current.task.start + current.task.duration <= now.minute)
                ? "The planned time has passed; this does not mark the task complete."
                : current?.task.locked && !canMove
                  ? "This time is locked and cannot be moved."
                  : "Choose one plan and a new time.");
    const next = current
      ? entries.filter(e => e.task.id !== current.task.id && !e.task.done && !e.task.deferred && (e.date > current.date || (e.date === current.date && e.task.start >= current.task.start)))
      : dayEntries.filter(e => !e.task.done);
    const empty = !entries.length && !c.error;
    const dayLabel = c.mode === "demo" ? (viewDate===now.date ? "Independent example" : "Independent example · Selected date") : viewDate === now.date ? "Today" : "Selected date";
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(viewDate + "T12:00:00Z").getUTCDay()];
    const title = current?.task.title || (restDay ? "A day to rest" : c.error ? "The schedule is temporarily unavailable" : empty ? "Make room for your day" : dayEntries.length && dayEntries.every(e => e.task.done) ? "Everything for today is complete" : "No unfinished plans for this day");
    const stateLabel = current?.task.done ? (doneLabel(c.branch.days, current.task)) : selectedId && current?.date < now.date ? "Selected past plan · Not completed" : fixed ? (isActivity(current.task) ? "Fixed event" : "Locked task") : current?.date === now.date && current.task.start <= now.minute && current.task.start + current.task.duration > now.minute ? "In progress" : current?.date < now.date || (current?.date === now.date && current.task.start + current.task.duration <= now.minute) ? "Not completed" : "Upcoming";
    const savedResult = lastConfirmed;
    const selector = button("select", "Choose a date and task");
    const completion = canDone && !savedResult ? `<button id="wb-complete" data-completed="${Boolean(current.task.done)}"><span class="completion-icon" aria-hidden="true">${current.task.done ? "✓" : ""}</span>${current.task.done ? "Mark as not completed" : "Done"}</button>` : "";
    const timing = current && taskTiming(current, c.branch.settings, c.branch.days);
    const displayedRange = current && current.date === viewDate && current.date >= now.date && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?–\d{2}:\d{2}(?::\d{2})?$/.test(timing.range) ? timing.range.replace(current.date + " ", "") : timing?.range;
    // Shown right after an editor move too: that save is what locked the task, so the way out must be there.
    const canUnlock = Boolean(current) && !isActivity(current.task) && !current.task.timeLocked && current.task.locked && current.task.lockSource === "user" && !current.task.externalReadOnly;
    const archivedCount = api.archived?.().length || 0;
    const actions = (canUnlock ? button("unlock", "Unlock time", true) : "") + (canMove && !savedResult ? button("from-now", "Plan from now", true) : "") + button("task-actions", canMove ? "Choose a time" : "Task details / Add") + (archivedCount ? button("archived", `Archived (${archivedCount})`) : "");
    const purposeNote = !current && !empty ? restDay ? "Choose another day to see its plans." : "Choose another day or add one thing." : empty ? "No plans yet. The example uses made-up tasks, so nothing real changes." : c.mode === "demo" && canMove && learningTask(current.task) && !c.branch.undo ? (next.some((e) => learningTask(e.task)) ? "Plan from the example time of 11:30. Later study is included in the preview." : "Plan from the example time of 11:30. Only this task moves; later study stays where it is.") : note;
    const calendarContext = scheduleContext(c,viewDate,now);
    shell(title,
      `<div class="day-heading"><div class="date-copy"><p class="day-kicker">${esc(dayLabel)}${c.mode === "demo" ? ' · Example time 11:30' : ''}</p><p class="day-date">${esc(friendlyDate(viewDate, now.date))}<span>${weekday}</span></p><p class="day-caption">${restDay ? 'Rest day. No study scheduled.' : 'Make space for the next small step.'}</p></div><div class="photo-frame" aria-hidden="true"><img src="/assets/sunny-path.webp" width="900" height="540" alt="" decoding="async"></div></div>
      ${showsFirstUseGuide(c, rescheduled) ? firstUseGuide() : c.error ? "" : firstUseReminder()}${weekMarkup(calendarContext,viewDate,now)}<div class="home-layout"><div class="home-focus"><div class="timeline"><section class="current-arrangement${fixed ? ' current-fixed' : ''}"><div class="time-rail" aria-hidden="true">${current ? formatTime(current.task.start) : 'Today'}</div><div class="focus-content"><div class="task-eyebrow"><span class="task-state">${current ? esc(stateLabel) : restDay ? 'Rest day' : 'Selected date'}</span>${selector}</div><h1>${esc(title)}</h1>
      ${current ? `<p class="current-time"><span>${esc(displayedRange)}</span><span class="duration">${current.task.duration} min</span>${fixed ? fixedBadge(current.task) : ''}</p>${timingNote(timing)}` : ''}
      ${savedResult ? savedResultMarkup(savedResult, Boolean(savedResult.lockedByMove), canUnlock && savedResult.targetTaskId === current.task.id) : ""}
      ${purposeNote ? `<p class="purpose-note">${esc(purposeNote)}</p>` : ""}
      ${readOnlyNote ? `<p class="purpose-note readonly-note">${esc(readOnlyNote)}</p>` : ""}
      <div class="work-actions home-actions">${empty ? button("try-demo", EXAMPLE_BUTTON_LABEL, true) + button("task-actions", "Add / Edit") + (archivedCount ? button("archived", `Archived (${archivedCount})`) : "") : completion + actions}</div>${!empty && canUnlock ? '<p class="unlock-hint">Unlock the time to choose another one.</p>' : ""}<section class="encouragement-control" aria-label="Optional encouragement"><button id="wb-encouragement" type="button" aria-pressed="false" aria-describedby="wb-encouragement-caption">Play encouragement</button><p id="wb-encouragement-caption" class="encouragement-caption">Take a breath. Choose one small next step, and we can go at your pace.</p><p id="wb-encouragement-status" class="encouragement-status" role="status" aria-live="polite"></p></section></div></section>
      ${next.length ? `<section class="next-arrangements" aria-label="Upcoming plans"><h2>Up next</h2>${next.slice(0,2).map((e,i,items) => {
        const range = arrangementRange(e,c.branch.settings.timeZone).replace(e.date + " ", "");
        const newDate = e.date !== viewDate && (!i || items[i-1].date !== e.date);
        return `${newDate ? `<p class="next-date">${esc(timelineDate(e.date,now.date))}</p>` : ''}<div class="next-row${isFixedTask(e.task) ? ' next-fixed' : ''}"><p class="next-time same-day" aria-hidden="true"></p><div class="next-content"><p class="next-title">${esc(e.task.title)}${isFixedTask(e.task) ? fixedBadge(e.task) : ''}</p><p class="next-range">${esc(range)}</p></div></div>`;
      }).join('')}</section>` : ''}</div>
      ${c.mode === 'personal' && current && !savedResult ? `<p class="saved-feedback home-sync" data-sync-state="${esc(syncPresentation(c.branch, { writesEnabled: c.calendarStatus?.writesEnabled, ids: [current.task.id] }).state)}">${esc(syncPresentation(c.branch, { writesEnabled: c.calendarStatus?.writesEnabled, ids: [current.task.id] }).text)}</p>` : ''}
      ${c.readError ? `<p class="reading-note">Calendar reading is incomplete. Your local plans are preserved.${esc(presentError(c.readError))}</p>` : ''}</div>${dayMarkup(calendarContext,c.branch.settings,current?.task.id,c.branch.days)}</div>`, "", "", true);
    if(viewNotice) error(viewNotice);
    root.querySelector(".photo-frame img").onerror = e => { e.target.hidden = true; e.target.parentElement.classList.add("photo-unavailable"); };
    on("select", () => {
      api.clearNotice?.();
      phase = "select";
      renderSelect();
    });
    on("task-actions", () => {
      selectedId = current?.task.id || null;
      if (canMove) adjust(current);
      else manage(0);
    });
    on("from-now", () => {
      if (!canAdjust(current)) return;
      api.clearNotice?.();
      const now = planningNow(context()), when = `${now.date}T${formatTime(now.minute)}`;
      if (draft?.taskId !== current.task.id) draft = { taskId: current.task.id, when };
      void calculate({ taskId: current.task.id, when, startFromNow: true });
    });
    on("complete", () => complete(current));
    on("unlock", () => {
      if (!api.unlock?.(current)) return;
      api.clearNotice?.();
      selectedId = current.task.id;
      lastConfirmed = null;
      phase = "unlocked";
      shell("Time unlocked",
        `<p>${esc(current.task.title)} can be moved again. Its time did not change.</p>`,
        button("home", "Back to current plans", true) + button("undo-unlock", "Undo this change"));
      on("home", home);
      on("undo-unlock", undoRecent);
    });
    on("archived", renderArchived);
    on("saved-details", renderResultDetails);
    on("undo", () => { if (savedResult && ownsResultUndo(savedResult)) undoRecent(); });
    on("exit-demo", leaveDemo);
    on("try-demo", enterDemo);
    bindEncouragement();
    if (c.error) {
      $("task-actions")?.remove();
      root
        .querySelector(".work-actions")
        .insertAdjacentHTML("beforeend", button("recover", "Recover your schedule", true));
      on("recover", backup);
    }
  }
  function renderSelect() {
    const selectedDate=context().date, todayDate=context().mode==='demo'?context().branch.exampleOrigin:dateParts(Date.now(),context().branch.settings.timeZone).date;
    const viewDate = day => { if(!validDate(day))return error('Choose a valid date.');selectedId=null;phase='home';if(api.selectDate?.(day)!==false)home(); };
    shell("Choose a date and task", `<div class="date-picker-row">${field('picker-date','Date to view','date',selectedDate)}${button('view-date','View date')}${button('task-details','Task details / New')}</div><label for="wb-search">Search by name or date</label><div class="task-picker"><input id="wb-search" type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="wb-options" aria-describedby="wb-picker-hint" autocomplete="off" value="${esc(query)}" placeholder="For example, SQL or 2026-10-14"><div id="wb-options" role="listbox" aria-label="Matching plans"></div></div><p id="wb-picker-hint" class="muted" role="status"></p>`, button("back","Back"));
    const input = $("search"), options = $("options");
    let choices = [], active = -1, composing = false, justComposed = false, lastRead = "";
    const expanded = value => { options.hidden = !value; input.setAttribute('aria-expanded',String(value)); if(!value)input.removeAttribute('aria-activedescendant'); };
    // Keep the input (including its caret, selection and native IME session) intact.
    const refreshChoices = () => {
      const c = context(), q = query.toLocaleLowerCase().trim();
      const now = c.mode === "demo" ? c.branch.exampleOrigin : dateParts(Date.now(),c.branch.settings.timeZone).date;
      const rank = e => e.task.id === selectedId ? 0 : !e.task.done && api.movable(e.task) && e.date >= now ? 1 : e.date >= now && !e.task.done ? 2 : 3;
      choices = rows(c.branch.days).filter(e => !e.task.calendarLink?.remoteDeleted && (!q || `${e.date} ${e.task.title} ${e.task.done ? "Completed" : "Not completed"} ${e.task.semanticExplanation || ""}`.toLocaleLowerCase().includes(q)))
        .sort((a,b)=>rank(a)-rank(b)||a.date.localeCompare(b.date)||a.task.start-b.task.start);
      active = -1; input.removeAttribute('aria-activedescendant');
      options.innerHTML = choices.map((e,i)=>`<div id="wb-result-${i}" class="search-result" role="option" aria-selected="false"><strong>${esc(e.task.title)}</strong><span>${esc(when(e))} · ${e.task.done ? doneLabel(c.branch.days, e.task) : e.task.deferred ? 'Deferred' : isFixedTask(e.task) ? 'Fixed' : 'Not completed'}</span></div>`).join('');
      $("picker-hint").textContent = choices.length ? `${choices.length} results · Use ↑↓, then Enter to choose` : validDate(query) ? 'No matching tasks. Press Enter to view this day.' : 'No matching tasks. Use the date above to view another day.';
      choices.forEach((e,i)=>on('result-'+i,()=>{if(!composing && !justComposed)void choose(e);}));
    };
    const readQueryDate = () => {
      if(!/^\d{4}-\d{2}-\d{2}$/.test(query)){lastRead="";return;}
      if(query===lastRead)return;
      const requested = lastRead = query;
      void api.readDate(requested).then(()=>{
        if(phase==='select' && $("search")===input && !composing && query===requested)refreshChoices();
      });
    };
    const activate = index => {
      if(!choices.length)return;expanded(true);active=(index+choices.length)%choices.length;
      choices.forEach((_,i)=>$("result-"+i).setAttribute('aria-selected',String(i===active)));
      input.setAttribute('aria-activedescendant','wb-result-'+active);$("result-"+active).scrollIntoView({block:'nearest'});
    };
    input.addEventListener('compositionstart', () => { composing=true; justComposed=false; });
    input.addEventListener('compositionend', () => {
      composing=false; justComposed=true; query=input.value; refreshChoices(); readQueryDate();
      // Some engines finish composition before dispatching its committing key.
      setTimeout(()=>{justComposed=false;},0);
    });
    input.oninput = e => {
      query=input.value;
      if(e.isComposing)composing=true;
      if(composing)return;
      refreshChoices();expanded(true);readQueryDate();
    };
    input.onfocus = ()=>expanded(true);
    input.onkeyup = e => { if(!composing && !e.isComposing && e.keyCode!==229)justComposed=false; };
    input.onkeydown = e => {
      if(composing || e.isComposing || e.keyCode===229 || justComposed)return;
      if(['ArrowDown','ArrowUp','Enter','Escape'].includes(e.key))e.preventDefault();
      if(e.key==='ArrowDown')activate(active+1);
      if(e.key==='ArrowUp')activate(active<0?choices.length-1:active-1);
      if(e.key==='Enter' && choices[active<0?0:active])void choose(choices[active<0?0:active]);
      else if(e.key==='Enter' && validDate(query))viewDate(query);
      if(e.key==='Escape')expanded(false);
      if(e.key==='Tab')expanded(false);
    };
    refreshChoices();on('back',home);on('view-date',()=>viewDate($('picker-date').value));on('task-details',()=>manage(0));input.focus({preventScroll:true});
  }
  async function choose(e) {
    selectedId = e.task.id;
    const unclear = (api.ambiguous?.() || []).find(
      (q) => q.taskId === e.task.id,
    );
    if (unclear)
      return meaning(unclear, () =>
        choose(
          rows(context().branch.days).find((x) => x.task.id === e.task.id),
        ),
      );
    api.select(e);
    home();
  }
  function requestManagement(e, wanted) {
    phase = "permission";
    const related = rows(context().branch.days).filter(
      (x) =>
        learningTask(x.task) &&
        x.task.planId === e.task.planId &&
        x.task.calendarClassification?.manage !== false &&
        canManageCalendarSource(x.task.calendarSource) &&
        !x.task.done && !x.task.timeLocked && x.task.type !== "activity" &&
        x.task.duration <= 1440 && !x.task.calendarConflict,
    );
    shell(
      "Let Shunri schedule this study group?",
      `<p>Shunri found ${esc(e.task.title)} and ${related.length} remaining study tasks in this plan. They stay grouped by their original study dates.</p><p>This records local management permission only. Google is not changed, and real writes remain off.</p>`,
      button("allow", "Let Shunri schedule locally", true) +
        button("view", "View only") +
        button("back", "Cancel"),
    );
    on("allow", async () => {
      const token = ++request,
        requestedMode = context().mode;
      const isCurrent = () =>
        token === request && context().mode === requestedMode;
      busy("Checking the study group…");
      try {
        await api.adoptLearning(e.task.planId, isCurrent);
        if (!isCurrent()) return;
        api.select(e);
        if (custom) queueCustom(0);
        else await calculate(wanted);
      } catch (err) {
        if (isCurrent()) error(err.message);
      }
    });
    on("view", () => {
      api.select(e);
      home();
    });
    on("back", () => {
      if (custom) { invalidateCustom(); customStatus("Your input is preserved. Change the time to check again.", true); }
      else adjust(e, wanted.when);
    });
  }
  function stopCustom() {
    if (!custom) return;
    clearTimeout(custom.timer);
    custom = null;
    preview = null;
    request++;
    api.cancel();
  }
  function customValid() {
    if (!custom || custom.composing.size) return false;
    if (custom.inputMode === "text") {
      const intent = draft?.expressionIntent;
      return Boolean(intent?.result.status === "target" && $("expression")?.value === intent.text && intent.taskId === custom.taskId && intent.mode === context().mode);
    }
    const date = $("date"), time = $("time");
    return Boolean(date && time && validDate(date.value) && /^\d{4}-\d{2}-\d{2}$/.test(date.value) &&
      /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time.value) && date.validity.valid && time.validity.valid);
  }
  function customStatus(message, retry = false) {
    phase = "adjust";
    shell("", `${messageHtml(message, esc, ' role="status"')}${custom?.failure && custom.failure !== message ? `<p class="reading-note">Previous check: ${esc(presentError(custom.failure))}</p>` : ""}`,
      (retry ? button("retry-custom", "Check again", true) : '<button id="wb-confirm" class="primary" disabled>Confirm changes</button>') + button("back", "Back"));
    on("back", home);
    on("retry-custom", () => queueCustom(0));
  }
  function invalidateCustom(message = "Input changed. Waiting to check…") {
    if (!custom) return;
    clearTimeout(custom.timer);
    request++;
    api.cancel();
    preview = null;
    custom.snapshot = null;
    customStatus(message);
  }
  function resolveExpression(session) {
    if (!draft.expressionIntent) {
      const entry = rows(context().branch.days).find(e => e.task.id === session.taskId);
      const options = { now: planningNow(context()), task: entry && { date: entry.date, start: entry.task.start }, timeZone: context().branch.settings.timeZone };
      draft.expressionIntent = freezeSnapshot({ text: draft.text, taskId: session.taskId, mode: session.mode, options, result: parseTimeExpression(draft.text, options) });
    }
    const intent = draft.expressionIntent, result = intent.result;
    if (result.status === "target") {
      draft.when = `${result.date}T${formatTime(result.minute)}`;
      void calculate({ ...draft, startFromNow: result.startFromNow }, session);
    } else if (result.status === "clarify") {
      const token = request;
      phase = "time-question";
      shell(result.question, "<p>This confirms this time only. It does not save a long-term preference.</p>", result.choices.map((c,i)=>button("time-choice-"+i,c.label)).join("") + button("edit-expression", "Back to edit"));
      result.choices.forEach((choice,i)=>on("time-choice-"+i,()=>{
        if (custom !== session || request !== token || context().mode !== intent.mode || $("expression")?.value !== intent.text) return;
        const answer = {question:result.id,choice:choice.id};
        draft.expressionIntent = freezeSnapshot({ ...intent, result:parseTimeExpression(intent.text,{...intent.options,answer}), answer });
        resolveExpression(session);
      }));
      on("edit-expression",()=>{invalidateCustom();customStatus("Add a clear date and time of day.");});
    } else customStatus(result.message);
  }
  function queueCustom(delay = 400) {
    if (!custom) return;
    if (custom.inputMode === "text") {
      const text = $("expression").value;
      if (text !== draft.text) { draft.text = text; draft.expressionIntent = null; draft.when = ""; draft.pending = null; }
    } else {
      draft.when = `${$("date").value}T${$("time").value}`;
      draft.text = `${$("date").value} ${$("time").value}`;
      draft.expressionIntent = null;
      draft.pending = null;
    }
    invalidateCustom(custom.inputMode === "text" ? "Reading the time…" : customValid() ? "Time changed. Waiting to check…" : "Enter a complete, valid date and time.");
    if (custom.composing.size || (custom.inputMode === "exact" && !customValid())) return;
    const session = custom;
    session.timer = setTimeout(() => {
      if (custom !== session || session.composing.size) return;
      if (session.inputMode === "text") resolveExpression(session);
      else if (customValid()) void calculate({ ...draft, startFromNow: false }, session);
    }, delay);
  }
  // A fixed event or locked task is never moved: say so on screen and change nothing.
  function refuseFixed(e) {
    if (!e || !isFixedTask(e.task) || e.task.type === "break") return false;
    const refused = proposeReschedule(context().branch.days, { date: e.date, taskId: e.task.id, start: 0 });
    const message = refused.message || `${e.task.title} will not move. Nothing was changed.`;
    stopCustom();
    request++;
    api.cancel?.();
    preview = null;
    custom = null;
    phase = "error";
    shell("This will not move", `<p class="error">${esc(message)}</p>`, button("back", "Back"));
    on("back", home);
    return true;
  }
  function adjust(e, initial = null, inputMode = "text") {
    api.clearNotice?.();
    if (refuseFixed(e)) return;
    if (!canAdjust(e)) return;
    stopCustom();
    request++;
    api.cancel();
    phase = "adjust";
    const previous = draft?.taskId === e.task.id && (!draft.mode || draft.mode === context().mode) ? draft : null;
    draft = {
      ...previous, taskId: e.task.id, mode: context().mode,
      text: previous?.text || "", expressionIntent: previous?.expressionIntent || null, pending: null,
      when: initial || previous?.when || `${context().mode === "demo" ? addDays(context().branch.exampleOrigin, 1) : e.date}T${formatTime(context().mode === "demo" ? 660 : e.task.start)}`,
    };
    shell("When would you like to move it?",
      `<div id="wb-custom-inputs"><p class="selected-name">${esc(e.task.title)}</p>${inputMode === "text"
        ? `<label for="wb-expression">New time</label><input id="wb-expression" type="text" autocomplete="off" placeholder="For example: ${FIRST_USE_EXAMPLE_TIME}" value="${esc(draft.text)}">${button("use-exact", "Use date and time fields")}`
        : `<div class="time-fields">${field("date", "Date", "date", draft.when.split("T")[0], 'required')}${field("time", "Time · 24-hour clock", "time", draft.when.split("T")[1], 'required step="60" lang="en-GB"')}</div>`}</div><section id="wb-custom-result" class="custom-result" aria-label="Time-change preview"></section>`);
    $("error")?.remove();
    custom = { taskId: e.task.id, mode: context().mode, inputMode, composing: new Set(), snapshot: null, timer: null, saving: false };
    for (const id of inputMode === "text" ? ["expression"] : ["date", "time"]) {
      const input = $(id);
      input.addEventListener("compositionstart", () => { custom?.composing.add(id); invalidateCustom("Typing. Nothing has been calculated yet."); });
      input.addEventListener("compositionend", () => { if (!custom) return; custom.composing.delete(id); queueCustom(); });
      input.oninput = event => {
        if (!custom) return;
        if (event.isComposing || custom.composing.size) { invalidateCustom("Typing. Nothing has been calculated yet."); return; }
        queueCustom();
      };
    }
    on("use-exact",()=>adjust(e,draft.when,"exact"));
    queueCustom();
  }
  async function calculate(target = null, session = null) {
    const wanted = Object.freeze({ ...(target || draft) }),
      token = ++request,
      requestedMode = context().mode,
      parts = typeof wanted?.when === "string" ? wanted.when.split("T") : [];
    if (parts.length !== 2 || !validDate(parts[0]) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(parts[1]))
      return error("Choose a complete date and time.");
    const entry = rows(context().branch.days).find(
      (e) => e.task.id === wanted.taskId,
    );
    const expressionIntent = session?.inputMode === "text" ? draft.expressionIntent : null;
    const isCurrent = () => token === request && requestedMode === context().mode &&
      (!session || (custom === session && customValid() && draft?.taskId === wanted.taskId && draft.when === wanted.when && (session.inputMode !== "text" || expressionIntent === draft.expressionIntent)));
    if (session) {
      session.snapshot = Object.freeze({ taskId: wanted.taskId, mode: requestedMode, when: wanted.when, request: token, inputMode: session.inputMode, expressionIntent });
      customStatus("Checking this time and later plans…");
    }
    if (refuseFixed(entry)) return;
    if (needsManagement(entry)) return requestManagement(entry, { ...wanted });
    if (!session) busy("Checking the calendar and later plans…");
    try {
      const result = await api.move(wanted.taskId, parts[0], parts[1], { startFromNow: wanted.startFromNow === true, isCurrent });
      if (!isCurrent() || !result) return;
      const unclear = (result.result?.conflicts || result.conflicts || [])
        .flatMap((conflict) => conflict.ids || [])
        .map((id) => api.ambiguityFor?.(id))
        .find(Boolean);
      if (unclear) {
        api.cancel();
        return meaning(unclear, () => { if (session && custom === session) queueCustom(0); else if (!session) void calculate({ ...wanted }); });
      }
      preview = result;
      preview.defaultRules = !usesDefaultRules(wanted.startFromNow === true, rows(context().branch.days).find((e) => e.task.id === wanted.taskId)?.date, parts[0]) ? null : applyDefaultRules(result.result || result,
        context().branch.days, rows(context().branch.days).find((e) => e.task.id === wanted.taskId), parts[0], Number(parts[1].slice(0, 2)) * 60 + Number(parts[1].slice(3)));
      if (session) {
        session.basis = context().proposalKey;
        const out = result.result || result;
        session.failure = out.status === "ok" ? "" : out.conflicts?.[0]?.message || out.unscheduled?.[0]?.reason || "";
        if (out.status === "ok") api.clearNotice?.();
      }
      // Keep the intent that produced this preview separate from custom-time drafts.
      preview.moveIntent = { taskId: wanted.taskId, when: wanted.when, startFromNow: wanted.startFromNow === true };
      detail = false;
      phase = "preview";
      renderPreview();
    } catch (err) {
      if (isCurrent()) {
        if (session) { session.failure = err.message || "The check failed. Your original plans are preserved."; customStatus(session.failure, true); return; }
        phase = "adjust";
        adjust(
          rows(context().branch.days).find((e) => e.task.id === wanted.taskId),
          wanted.when,
        );
        error(err.message);
      }
    }
  }
  function busy(message) {
    message = presentError(message);
    phase = "busy";
    shell(message, "<p>Your original plans have not moved.</p>", button("cancel", "Cancel"));
    on("cancel", () => {
      api.cancel();
      preview = null;
      draft = null;
      home();
    });
  }
  function error(message) {
    message = presentError(message);
    if ($("error")) $("error").textContent = message;
    if (phase === "busy") {
      phase = "error";
      shell(
        "This step is not complete",
        `<p class="error">${esc(message)}</p>`,
        button("back", "Back"),
      );
      on("back", home);
    }
  }
  function renderPreview() {
    const result = preview?.result || preview;
    if (!result) return home();
    preview.scheduleKey ??= scheduleKey(context().branch);
    preview.mode ??= context().mode;
    const changes = result.changes || [],
      conflict = result.status !== "ok",
      noChange = !conflict && !changes.length && !preview?.allowRuleConflicts &&
        !(preview?.altKind && (result.unscheduled || []).length);
    phase = conflict ? "conflict" : detail ? "details" : "preview";
    const targetId =
      preview?.targetTaskId ||
      (isEditingLabel(preview?.label) ? editEntry?.task.id : draft?.taskId) ||
      changes.find(
        (change) =>
          change.to.date === result.exactTarget?.date &&
          change.to.start === result.exactTarget?.start,
      )?.id;
    const display = detail ? changes : conciseChanges(changes, targetId);
    const target = changes.find((c) => c.id === targetId);
    const taskMap = new Map(
      rows(context().branch.days).map((e) => [e.task.id, e.task]),
    );
    const targetTask = taskMap.get(targetId);
    const priorCount = changes
      .slice(
        0,
        Math.max(
          0,
          changes.findIndex((c) => c.id === targetId),
        ),
      )
      .filter(
        (c) =>
          targetTask?.packageId &&
          taskMap.get(c.id)?.packageId === targetTask.packageId &&
          taskMap.get(c.id)?.planId === targetTask.planId,
      ).length;
    const overview = previewOverview(changes, context().branch.days);
    const packages = overview.packages;
    const reference = context().mode === "demo" ? context().branch.exampleOrigin : dateParts(Date.now(), context().branch.settings.timeZone).date;
    const skipped = result.summary?.skippedDates || [];
    const changedIds = new Set(changes.map((c) => c.id));
    const rangeFrom = changes.flatMap(c => [c.from.date, c.to.date]).sort()[0];
    const rangeTo = changes
      .flatMap((c) => [c.from.date, c.to.date])
      .sort()
      .at(-1);
    const fixed = rows(context().branch.days).filter(
      (e) =>
        !e.task.done &&
        e.date >= rangeFrom &&
        e.date <= rangeTo &&
        !changedIds.has(e.task.id) &&
        isFixedTask(e.task),
    );
    const skipText = skippedDateSummary(skipped, preview.settings || context().branch.settings, reference);
    const contentOnly =
      isEditingLabel(preview?.label) &&
      changes.every(
        (change) =>
          change.from.date === change.to.date &&
          change.from.start === change.to.start &&
          change.from.duration === change.to.duration,
      );
    const durationOnly = isEditingLabel(preview?.label) && !contentOnly && changes.length > 0 && changes.every(c=>c.from.date===c.to.date && c.from.start===c.to.start);
    const presentation = adjustmentPresentation(changes, context().branch.days, targetId, reference);
    const summary = preview?.semanticDescription || (contentOnly ? `Save details for ${changes.length} plan${changes.length === 1 ? "" : "s"}. Times stay the same.` : durationOnly ? changes.length===1 ? `The start time stays the same. Duration becomes ${changes[0].to.duration} min.` : 'Start times stay the same. Durations change as shown below.' : target ? `${target.title} moves to ${friendlyDate(target.to.date, reference)} ${formatTime(target.to.start)}. ${presentation.sameDay ? "Later study dates stay the same." : ""}` : presentation.result);
    preview.targetTaskId = targetId;
    preview.adjustmentContext = { targetId: target?.id || null, targetTitle: target?.title || null,
      from: target?.from || null, to: target?.to || null, packageCount: packages.length, taskCount: changes.length };
    const reason =
        (result.conflicts || [])[0]?.message ||
        (result.unscheduled || [])[0]?.reason;
    const facts = [[skipText, fixed.length ? `${fixed.length} fixed plan${fixed.length === 1 ? " keeps" : "s keep"} the original time.` : ''].filter(Boolean).join(' ')].filter(Boolean);
    preview.presentation = {
      summary,
      facts,
      headline: presentation.headline,
      editing: contentOnly || durationOnly,
      count: changes.length,
    };
    const afterTasks = new Map(rows(result.days || context().branch.days).map(e => [e.task.id, e.task]));
    const timedChanges = changes.map(change => {
      const beforeTask = taskMap.get(change.id) || afterTasks.get(change.id);
      const afterTask = afterTasks.get(change.id) || beforeTask;
      return { ...change, packageOriginDate: beforeTask?.packageOriginDate, timing: beforeTask && afterTask ? {
        before: /^\d{4}-\d{2}-\d{2}$/.test(change.from.date) ? taskTiming({ date: change.from.date, task: { ...beforeTask, ...change.from } }, context().branch.settings) : { range: "New" },
        after: taskTiming({ date: change.to.date, task: { ...afterTask, ...change.to } }, preview.settings || context().branch.settings, result.days),
      } : null };
    });
    preview.timedChanges = timedChanges;
    preview.fixedContext = fixed.map(e => ({ title: e.task.title, ...taskTiming(e, context().branch.settings) }));
    const fixedContext = preview.fixedContext.length ? `<section class="fixed-context"><h2>These times stay fixed</h2>${preview.fixedContext.map(e => `<div><strong>${esc(e.title)}</strong><p>${esc(e.range)}</p>${e.protection.map(p => `<p class="protection-note">${esc(p)}</p>`).join('')}</div>`).join('')}</section>` : '';
    const detailedRows = changeRows(timedChanges);
    const compact = packages.length
      ? `<div class="package-list">${packages.slice(0, 3).map(p => {
          const workload = p.members.reduce((n,c)=>n+(c.to.duration ?? afterTasks.get(c.id)?.duration ?? 0),0);
          const chosen = p.members.find(c=>c.id===targetId), name = chosen?.title || p.members[0]?.title || 'Study';
          return `<div class="package-change" data-package-key="${esc(p.key)}" data-member-ids="${esc(JSON.stringify(p.memberIds))}"><div class="package-dates"><span class="old-time">${esc(friendlyDate(p.from, reference))}</span><span class="date-arrow" aria-label="Move to">→</span><strong>${esc(friendlyDate(p.to, reference))}</strong></div><p class="package-summary">${chosen ? '<span class="selected-marker">Selected · </span>' : ''}${esc(name)}${p.count > 1 ? ` and ${p.count - 1} more · Remaining ` : ' · '}${workload} min</p></div>`;
        }).join('')}</div>`
      : `<div class="package-list">${timedChanges.filter(c=>display.some(d=>d.id===c.id)).slice(0,3).map(c=>`<div class="package-change"><strong>${esc(c.title)}</strong><p>${esc(c.timing?.before.range || c.from.date)} → ${esc(c.timing?.after.range || c.to.date)}</p></div>`).join('')}</div>`;
    const headline = noChange ? "No time changes" : contentOnly ? `Save details for ${changes.length} plan${changes.length === 1 ? "" : "s"}` : durationOnly ? 'Duration will change' : preview?.semanticCorrection ? "Use the confirmed purpose" : presentation.headline;
    const scope = detail ? `${changes.length} changes${packages.length ? ` · ${packages.length} study groups` : ''}`
      : contentOnly || preview?.semanticDescription ? '' : previewScope(changes, context().branch.days, targetId, reference);
    const ruleNote = [result.recommendation?.reason ? `${result.recommendation.reason}. A workable time is suggested.` : "", skipText, fixed.length ? `${fixed.length} fixed plans stay unchanged.` : '', priorCount ? `${priorCount} earlier study tasks in this group stay in their prerequisite order.` : ''].filter(Boolean).join(' ');
    const compactSummary = !detail && target && packages.slice(0,3).some(p=>p.memberIds.includes(target.id)) && !contentOnly && !preview?.semanticDescription
      ? summary.replace(target.title, 'Selected task') : summary;
    let body = conflict && !preview?.allowRuleConflicts
      ? `<p class="issue">${esc(reason || "No complete plan meets the current rules. Your original plans are preserved.")}</p><p>Nothing has changed. A partial result will not be saved.</p>`
      : noChange ? (retainedRecommendation(result, reference) ? `<p class="retained-recommendation">${esc(retainedRecommendation(result, reference))}</p>` : '<p>No save or sync is needed.</p>') : `<p class="target-result">${esc(compactSummary)}</p>${scope ? `<p class="preview-count">${esc(scope)}</p>` : ''}${(result.warnings || []).map(w=>`<p class="reading-note">${esc(w)}</p>`).join('')}${detail ? detailedRows + fixedContext : compact}${ruleNote ? `<p class="reading-note">${esc(ruleNote)}</p>` : ''}${detail && skipped.length ? `<section class="rest-day"><h2>Skipped dates</h2>${skipped.map(s=>`<p>${esc(s.date)}: ${esc(s.reason)}</p>`).join('')}</section>` : ''}`;
    const shortCustom = custom && !detail && !preview?.semanticCorrection && !preview?.allowRuleConflicts;
    if (shortCustom) {
      const parsed = draft.expressionIntent?.result;
      const basisNote = parsed?.status === "target" && /relative to|no date was specified|confirmed the date as|minutes after (?:the task’s saved time|the app time)/i.test(parsed.explanation) ? `<p class="input-basis">${esc(parsed.explanation)}</p>` : "";
      const requestNote = (conflict || noChange || result.recommendation) ? `<p class="requested-target">Requested time: ${esc(draft.when?.replace("T", " "))}</p>` : "";
      if (!conflict && !noChange && target) {
        const ownPackage = packages.find(p=>p.memberIds.includes(targetId));
        const following = packages.filter(p=>p!==ownPackage);
        const movedOthers = changes.length-1;
        const ownOthers = Math.max(0,(ownPackage?.members.length || 1)-1);
        const packageIds = new Set(packages.flatMap(p=>p.memberIds));
        const ordinaryOthers = changes.filter(c=>c.id!==targetId && !packageIds.has(c.id)).length;
        const shortScope = following.length
          ? `${ownOthers ? `${ownOthers} other tasks in this group and ` : ""}${following.length} later ${new Set(packages.map(p=>p.planId)).size>1?'study groups':'study days'} move together, through ${friendlyDate(overview.to,reference)}.${ordinaryOthers ? ` ${ordinaryOthers} other plans also change.` : ""}`
          : movedOthers ? `${movedOthers} other plans change together.` : "";
        body = `<p class="target-result">${esc(friendlyDate(target.from.date,reference))} ${formatTime(target.from.start)} → <strong>${esc(target.to.date)} ${formatTime(target.to.start)}</strong></p>${shortScope?`<p class="preview-count">${esc(shortScope)}</p>`:""}${(result.warnings||[]).map(w=>`<p class="reading-note">${esc(w)}</p>`).join("")}${ruleNote?`<p class="reading-note">${esc(ruleNote)}</p>`:""}`;
      }
      body = requestNote + body + basisNote;
    }
    let actions = "";
    if (conflict && !preview?.allowRuleConflicts) {
      actions =
        (result.alternatives || [])
          .slice(0, 2)
          .map((a, i) => button("alternative-" + i, a.label, i === 0))
          .join("") +
        button("change-time", preview?.editorConflict ? "Back to edit" : "Change time") +
        button("cancel", "Cancel");
    } else if (noChange)
      actions = button("change-time", "Change time") + button("cancel", "Back");
    else
      actions =
        button(
          "confirm",
          preview?.semanticCorrection
            ? "Confirm purpose"
            : preview?.allowRuleConflicts
              ? "Confirm rules"
              : "Confirm changes",
          true,
        ) +
        (detail
          ? button("detail-back", "Back to summary")
          : button(
              "change-time",
              preview?.allowRuleConflicts
                ? preview?.semanticCorrection
                  ? "Change purpose"
                  : "Change rules"
                : isEditingLabel(preview?.label)
                  ? "Edit details"
                  : "Back to edit",
            )) +
        button("cancel", "Cancel") +
        (!detail && changes.length ? button("details", "View all changes") : "");
    if (custom && !detail && !preview?.semanticCorrection && !preview?.allowRuleConflicts) {
      actions = conflict
        ? (result.alternatives || []).slice(0,2).map((a,i)=>button("alternative-"+i,a.label,i===0)).join("") + (!(result.alternatives || []).length ? button("retry-custom", "Check again", true) : "") + button("back", "Back")
        : noChange ? button("back", "Back")
        : button("confirm", "Confirm changes", true) + button("details", "View all changes") + button("back", "Back");
    }
    const question = Boolean(preview?.moveIntent) && !detail && !preview?.semanticCorrection &&
      !preview?.allowRuleConflicts && !preview?.editorConflict && !isEditingLabel(preview?.label);
    let title = conflict ? "This time does not fit yet" : detail ? "All changes" : shortCustom && !noChange ? "" : headline;
    if (question) {
      // Nearby times answer only a time that does not fit; a savable proposal drops them.
      if (draft) draft.pending = conflict ? (result.alternatives || []).slice(0, 2) : null;
      const pending = draft?.pending || [], next = pending[0];
      const parsed = custom?.inputMode === "text" ? draft?.expressionIntent?.result : null;
      const basis = parsed?.status === "target" && /relative to|no date was specified|confirmed the date as|minutes after (?:the task’s saved time|the app time)/i.test(parsed.explanation) ? parsed.explanation : "";
      const doneCount = rangeFrom ? rows(context().branch.days).filter(e => e.task.done && e.date >= rangeFrom &&
        e.date <= rangeTo && !changedIds.has(e.task.id)).length : 0;
      const breakCount = rangeFrom ? rows(context().branch.days).filter(e => e.task.type === "break" && e.date >= rangeFrom &&
        e.date <= rangeTo && !changedIds.has(e.task.id)).length : 0;
      // For a savable default-rules proposal, "Try another" steps through ALTERNATIVES in order.
      preview.nextAlt = null;
      const whenText = preview.moveIntent?.when || "";
      const askedAt = Number(whenText.slice(11, 13)) * 60 + Number(whenText.slice(14, 16));
      const askedEntry = rows(context().branch.days).find((e) => e.task.id === targetId);
      if (preview.defaultRules && !conflict && !noChange && askedEntry && askedEntry.date === whenText.slice(0, 10) && Number.isInteger(askedAt))
        preview.nextAlt = nextAlternative(context().branch.days, askedEntry, askedAt, preview.altIndex ?? -1,
          JSON.stringify(result.days), { now: planningNow(context()), settings: context().branch.settings });
      const options = { next: next && { date: next.targetDate, start: next.targetStart }, noAlternative: !next && !preview.nextAlt,
        otherDay: !!askedEntry && askedEntry.date !== whenText.slice(0, 10) };
      const ask = preview.defaultRules && !conflict
        ? defaultRulesQuestion(preview.defaultRules, context().branch.days, targetId, reference, options)
        : proposalQuestion({ conflict, noChange, target, moved: changes.length, fixed: fixed.length, done: doneCount,
        breaks: breakCount, rest: Number(targetTask?.rest) || 0, later: target ? changes.filter(c => c !== target) : null,
        reason: conflict ? reason : retainedRecommendation(result, reference),
        note: [...(result.warnings || []), basis].filter(Boolean).join(" "),
        spacing: !conflict && !noChange ? plannerSpacingNote(target, targetTask, context().branch.settings) : "",
        reference, ...options });
      title = ask.title;
      body = `<div class="question${ask.warning ? " question-warning" : ""}">${ask.lines.map(line => `<p class="question-line">${esc(line)}</p>`).join("")}</div>`;
      const disabled = (id, text, off, primary) =>
        `<button id="wb-${id}"${primary ? ' class="primary"' : ""}${off ? " disabled" : ""}>${esc(text)}</button>`;
      actions = disabled("confirm", "Yes", !ask.canSave, true) +
        disabled("another", "Try another", !next && !preview.nextAlt) +
        button(custom ? "back" : "cancel", "Cancel");
    }
    shell(title, body, actions);
    on("back", home);
    on("retry-custom", () => queueCustom(0));
    on("cancel", () => {
      api.cancel();
      preview = null;
      draft = null;
      home();
    });
    on("change-time", () => {
      api.cancel();
      if(preview?.editorConflict){editStep=1;renderEditor();return;}
      if (preview?.allowRuleConflicts) {
        if (preview?.semanticCorrection) {
          const previous = preview, question = previous.semanticIntent?.question;
          const resume = previous.meaningResume || previous.afterConfirm || home;
          if (question) meaning(question, resume);
          else correctPurpose(selected());
        }
        else {
          ruleStep = 0;
          renderRules();
        }
      } else if (isEditingLabel(preview?.label)) {
        editStep = 2;
        renderEditor();
      } else
        adjust(
          rows(context().branch.days).find((e) => e.task.id === draft?.taskId),
          draft?.when,
        );
    });
    on("details", () => {
      detail = true;
      renderPreview();
      if (custom) {
        const heading = $("custom-result")?.querySelector("h2");
        if (heading) { heading.tabIndex = -1; heading.focus(); }
      }
    });
    on("detail-back", () => {
      detail = false;
      renderPreview();
      if (custom) $("details")?.focus();
    });
    on("confirm", () => {
      const confirmed = preview,
        after = confirmed?.afterConfirm;
      if (!confirmed || custom?.saving) return;
      if (custom && !after && (!customValid() || !custom.snapshot || custom.snapshot.request !== request || custom.snapshot.when !== draft?.when || custom.snapshot.inputMode !== custom.inputMode || (custom.inputMode === "text" && custom.snapshot.expressionIntent !== draft.expressionIntent) || custom.mode !== context().mode || custom.basis !== context().proposalKey)) {
        invalidateCustom("The schedule or input changed. Please check again.");
        return;
      }
      if (custom) custom.saving = true;
      const taskOf = (days, id) => { for (const list of Object.values(days || {})) for (const t of list || []) if (t.id === id) return t; return null; };
      const targetId = confirmed.targetTaskId || null;
      const priorTask = targetId ? taskOf(context().branch.days, targetId) : null;
      const savedTask = targetId ? taskOf((confirmed.result || confirmed).days, targetId) : null;
      // Only the save that newly sets the move lock may claim "your move locked this task".
      const lockedByThisSave = Boolean(savedTask?.manuallyMoved && savedTask.lockSource === "user" && !(priorTask?.manuallyMoved && priorTask.lockSource === "user"));
      const saved = api.confirm();
      if (custom) custom.saving = false;
      if (saved) {
        preview = null;
        rescheduled = true;
        if (!after && custom) { stopCustom(); draft = null; }
        if (after) after();
        else {
          const result = confirmed.result || confirmed;
          lastConfirmed = freezeSnapshot(structuredClone({
            presentation: confirmed.presentation,
            targetTaskId: confirmed.targetTaskId || null,
            lockedByMove: lockedByThisSave,
            changes: confirmed.timedChanges || result.changes || [],
            fixedContext: confirmed.fixedContext || [],
            skippedDates: result.summary?.skippedDates || [],
            warnings: result.warnings || [],
            mode: context().mode,
            timeZone: context().branch.settings.timeZone,
            savedRevision: context().revision,
            scheduleKey: scheduleKey(context().branch),
            undoKey: context().branch.undo ? JSON.stringify(context().branch.undo) : null,
            syncRefs: syncPresentationRefs(context().branch, (result.changes || []).map(change => change.id)),
          }));
          renderSavedArrangement(lastConfirmed, true);
        }
      }
    });
    const useAlternative = async (a) => {
      if(preview?.editorConflict){
        const token=++request;busy('Checking the original study groups again…');
        try{const out=await api.saveTask(editDraft,editEntry,editRevision,a);if(token!==request)return;preview=out;detail=false;renderPreview();}
        catch(e){if(token!==request)return;renderEditor();error(e.message);}return;
      }
      draft.when = `${a.targetDate}T${formatTime(a.targetStart)}`;
      if (custom) {
        if (custom.inputMode === "text") $("expression").value = `${a.targetDate} ${formatTime(a.targetStart)}`;
        else { $("date").value = a.targetDate; $("time").value = formatTime(a.targetStart); }
        queueCustom(0);
      } else void calculate();
    };
    (result.alternatives || []).slice(0, 2).forEach((a, i) =>
      on("alternative-" + i, () => useAlternative(a)),
    );
    on("another", () => {
      const [next] = draft?.pending || [];
      if (next) return useAlternative(next);
      // The same preview, the same task and the same Yes / Cancel; only the proposal changes.
      const alt = preview?.nextAlt;
      if (!alt || !preview.defaultRules || custom?.saving) return;
      writeProposal(preview.result || preview, context().branch.days, alt.ruled, preview.targetTaskId);
      preview.defaultRules = alt.ruled;
      preview.altIndex = alt.index;
      preview.altKind = alt.kind;
      detail = false;
      renderPreview();
    });
  }
  const LOCK_NOTE = "Your move also locked this task at its new time, so later automatic changes will not move it. Choose Unlock time to release it.";
  const LOCK_NOTE_PLAIN = "This time is now locked. Automatic changes will not move it.";
  function savedResultMarkup(record, lockedByMove = false, canUnlock = true) {
    const changed = record.mode !== context().mode || record.scheduleKey !== scheduleKey(context().branch);
    return `<section class="saved-result" aria-label="Most recent saved change"><p class="saved-result-title" role="status">${changed ? "Record of this change" : record.presentation.editing ? "Details saved" : "Time updated"}</p>${resultHistoryNote(record)}<p class="saved-result-summary">${esc(record.presentation.summary)}</p><p class="saved-result-status">${esc(resultSaveStatus(record))}</p>${lockedByMove ? `<p class="saved-result-lock">${esc(canUnlock ? LOCK_NOTE : LOCK_NOTE_PLAIN)}</p>` : ""}<div class="work-actions saved-result-actions">${button("saved-details", "View all changes")}${ownsResultUndo(record) ? button("undo", "Undo this change") : ""}</div></section>`;
  }
  function renderSavedArrangement(confirmed, selectTarget = false) {
    api.clearNotice?.();
    lastConfirmed = confirmed;
    phase = "home";
    // Only the first successful save selects the moved task. Read-only details,
    // status refreshes and other-tab updates must not overwrite newer browsing.
    if (selectTarget && confirmed.targetTaskId) {
      const current = rows(context().branch.days).find(e => e.task.id === confirmed.targetTaskId && !e.task.calendarLink?.remoteDeleted);
      if (confirmed.mode === context().mode && current) {
        selectedId = current.task.id;
        api.select(current);
      } else {
        selectedId = null;
        viewNotice = "That task is no longer in the current schedule. The current plans are shown; your saved change record is preserved.";
      }
    }
    renderHome();
  }
  function ownsResultUndo(record) {
    return record.mode === context().mode && record.undoKey && record.undoKey === JSON.stringify(context().branch.undo);
  }
  function resultHistoryNote(record) {
    const c = context();
    return record.mode !== c.mode
      ? '<p class="reading-note">You are viewing a different schedule. The record of this change is preserved below.</p>'
      : record.scheduleKey !== scheduleKey(c.branch)
        ? '<p class="reading-note">The schedule changed later. This record is preserved. If Undo is unavailable, review the changes and choose the current task to adjust it again.</p>'
        : "";
  }
  function resultSaveStatus(record) {
    const c = context();
    if (record.mode === "demo") return "Independent example · Saved locally; not synced to a real calendar.";
    if (c.mode !== record.mode) return "This change is saved. Return to your personal schedule to see its current sync status.";
    if (c.calendarStatus?.mock) return "Saved locally · Calendar is simulated; no real calendar was changed.";
    return syncPresentation(c.branch, { writesEnabled: c.calendarStatus?.writesEnabled, refs: record.syncRefs }).text;
  }
  // Archived tasks stay out of the schedule; Restore puts one back in its first free gap (Undo applies).
  function renderArchived() {
    api.clearNotice?.();
    phase = "archived";
    const list = api.archived?.() || [];
    const wouldReturn = (e) => {
      const to = api.previewRestore?.(e, planningNow(context()));
      return to ? `<small class="archived-preview">Would return ${esc(friendlyDate(to.date, planningNow(context()).date))} at ${esc(formatTime(to.start))}</small>` : "";
    };
    shell("Archived",
      list.length ? `<p class="muted">Nothing here is deleted. Restore saves at once in the first free gap from its old time, so the day or time may change. The line under each task shows where it would return. You can Undo it.</p>${list.map((e, i) => `<div class="archived-row"><strong>${esc(e.task.title)}</strong><span>${esc(friendlyDate(e.date, planningNow(context()).date))} · ${esc(formatTime(e.task.start))} · ${e.task.duration} min</span>${wouldReturn(e)}${button("restore-" + i, "Restore")}</div>`).join("")}` : "<p>No archived tasks.</p>",
      button("home", "Back to current plans", true));
    on("home", home);
    list.forEach((e, i) => on("restore-" + i, () => {
      const now = planningNow(context());
      const proposal = api.restoreProposal?.(e, now);
      if (!proposal) return;
      phase = "restore-proposal";
      shell("Change it like this?",
        `<p>${esc(e.task.title)} would come back on ${esc(friendlyDate(proposal.date, now.date))} at ${esc(formatTime(proposal.start))}.</p><p class="muted">Nothing is saved until you answer.</p>`,
        button("restore-yes", "Yes", true) + button("restore-cancel", "Cancel"));
      on("restore-cancel", renderArchived);
      on("restore-yes", () => {
        const to = api.restore?.(e, now);
        if (!to) return;
        api.clearNotice?.();
        selectedId = e.task.id;
        lastConfirmed = null;
        phase = "restored";
        shell("Task restored",
          `<p>${esc(e.task.title)} is back on ${esc(friendlyDate(to.date, now.date))} at ${esc(formatTime(to.start))}.</p>`,
          button("home", "Back to current plans", true) + button("undo-restore", "Undo this change"));
        on("home", home);
        on("undo-restore", undoRecent);
      });
    }));
  }
  function renderResultDetails() {
    if (!lastConfirmed) return home();
    const record = lastConfirmed;
    phase = "result-details";
    shell("All changes",
      `<p class="muted">Record of this change</p>${resultHistoryNote(record)}<p class="target-result">${esc(record.presentation.summary)}</p>${changeRows(record.changes)}${record.fixedContext?.length ? `<section class="fixed-context"><h2>Fixed times preserved in this change</h2>${record.fixedContext.map(e => `<div><strong>${esc(e.title)}</strong><p>${esc(e.range)}</p>${e.protection.map(p => `<p class="protection-note">${esc(p)}</p>`).join('')}</div>`).join('')}</section>` : ''}${record.warnings.map(w => `<p class="reading-note">${esc(w)}</p>`).join('')}${record.skippedDates.length ? `<section class="rest-day"><h2>Skipped dates</h2>${record.skippedDates.map(s => `<p>${esc(s.date)}: ${esc(s.reason)}</p>`).join('')}</section>` : ''}<p class="saved-feedback">${esc(resultSaveStatus(record))}</p>`,
      button("result-back", "Back to schedule", true), "", false, record.mode);
    on("result-back", () => renderSavedArrangement(record));
  }
  function complete(e) {
    lastConfirmed = null;
    const result = api.complete(e);
    if (!result) return;
    api.clearNotice?.();
    selectedId = null;
    phase = "completed";
    shell(
      e.task.done ? "Marked as not completed" : "Completion saved",
      `<p>${esc(e.task.title)}</p><p>Details, actual completion dates and other plans are preserved. Google events are not deleted.</p>`,
      button("home", "Back to current plans", true) +
        button("undo-complete", "Restore the previous status"),
    );
    on("home", home);
    on("undo-complete", () => {
      if (api.undoComplete()) home();
    });
  }
  function undoRecent() {
    const targetId = context().branch.undo?.presentation?.targetId;
    if(!api.undo()) return;
    const e = rows(context().branch.days).find(e=>e.task.id===targetId && !e.task.calendarLink?.remoteDeleted);
    selectedId=e?.task.id || null;phase="home";lastConfirmed=null;if(e)api.select(e);home();
  }
  function manage(group) {
    api.clearNotice?.();
    phase = "manage";
    const e = selected();
    const action = context().branch.undo, recent = action?.presentation;
    const recentText = recent?.targetTitle ? `${recent.targetTitle}: ${recent.from.date} ${formatTime(recent.from.start)} → ${recent.to.date} ${formatTime(recent.to.start)}${recent.packageCount ? ` · ${recent.packageCount} study days` : ` · ${recent.taskCount} changes`}`
      : action ? `${action.label || 'Latest change'} · ${(action.moves?.length || 0)+(action.patches?.length || 0)+(action.additions?.length || 0)+(action.removals?.length || 0)} records (the older record has no task name)` : '';
    const undo = undoRecent;
    const modeOption = context().mode === "demo" ? ["exit-demo", "Back to personal schedule", leaveDemo] : ["demo", EXAMPLE_BUTTON_LABEL, enterDemo];
    const lists = [
      [
        action ? ["undo", "Undo the latest change", undo] : modeOption,
        ["new", "Add a plan", () => editor(null)],
        ...(canAdjust(e) ? [["adjust", "Custom time", () => adjust(e)]] : e ? [["selected-actions", "Edit the selected plan", () => manage(1)]] : []),
        ["history", "More and backups", () => manage(2)],
      ],
      [
        ...(e && !e.task.externalReadOnly
          ? [
              ["edit", "Edit selected details", () => editor(e)],
              ["delete", "Delete the selected local task", () => api.remove(e)],
            ]
          : []),
        ...(e?.task.calendarLink
          ? [["correct", "Correct the purpose of this plan", () => correctPurpose(e)]]
          : []),
      ],
      [
        ...(canAdjust(e) ? [["selected-actions", "Edit selected details", () => manage(1)]] : []),
        ...(action ? [modeOption] : []),
        ["backup", "Backup and restore", backup],
        ...(context().mode === "demo" ? [["reset-demo", "Reset the independent example", () => confirm("Reset the independent example?", "Only example plans and records are replaced. Personal data and your return position are preserved.", () => { if (api.switchMode("demo", true, personalView) !== false) { selectedId = null; draft = null; home(); } })]] : []),
      ],
    ];
    const opts = lists[group];
    shell(
      group === 0 ? "Task details" : group === 1 ? "Edit the selected plan" : "More and backups",
      group === 0 && action ? `<section class="recent-adjustment"><h2>Latest change</h2><p>${esc(recentText)}</p></section>` : group === 1 && e ? `<p class="muted">Selected: ${esc(e.task.title)}</p>` : "",
      opts.map(([id, text]) => button(id, text)).join("") +
        button("back", "Back"),
    );
    opts.forEach(([id, text, fn]) => on(id, fn));
    on("back", () => {
      if (group !== 0) manage(0);
      else home();
    });
  }
  function enterDemo() {
    api.clearNotice?.();
    if (context().mode !== "demo")
      personalView = {
        selectedId,
        query,
        page,
        draft: draft ? { ...draft } : null,
      };
    if (api.switchMode("demo", false, personalView) === false) return;
    selectedId = null;
    draft = null;
    home();
  }
  function correctPurpose(e) {
    phase = "meaning";
    shell(
      "What is this plan for?",
      `<p>${esc(e.task.title)}</p><p>The correction is local only. The original event identity and completion record are preserved.</p>`,
      button("study-purpose", "Study or practice") +
        button("life-purpose", "Life and fixed events") +
        button("back", "Back"),
    );
    on("study-purpose", () => meaning(api.questionFor(e, "learning"), home));
    on("life-purpose", () => meaning(api.questionFor(e, "life"), home));
    on("back", () => manage(1));
  }
  let editDraft,
    editEntry,
    editStep = 0,
    editRevision;
  function editor(e) {
    editEntry = e;
    editRevision = context().revision;
    editStep = 0;
    editDraft = {
      ...structuredClone(e?.task || {}),
      title: e?.task.title || "",
      when: `${e?.date || context().date}T${formatTime(e?.task.start ?? 660)}`,
      duration: e?.task.duration ?? 45,
      rest: e?.task.rest ?? 20,
      kind:
        e?.task.type === "activity"
          ? "fixed"
          : learningTask(e?.task)
            ? "learning"
            : "task",
      bufferBefore: e?.task.bufferBefore ?? 0,
      bufferAfter: e?.task.bufferAfter ?? 0,
      locked: e?.task.locked ?? false,
      // Manually moved = locked: on by default for an existing movable task; the user can turn it off.
      lockOnMove: Boolean(e) && !e.task.locked && e.task.type !== "activity",
      dependencies: structuredClone(e?.task.dependencies || []),
    };
    renderEditor();
  }
  function renderEditor() {
    phase = "editor";
    let body, actions;
    if (editStep === 0) {
      body =
        field(
          "title",
          "Name",
          "text",
          editDraft.title,
          'maxlength="240" required',
        ) +
        field(
          "edit-when",
          "Date and time",
          "datetime-local",
          editDraft.when,
          'required step="60"',
        ) +
        `<label>Purpose<select id="wb-kind"><option value="task">Personal or ordinary task</option><option value="learning">Job Prepare study / practice</option><option value="fixed">Fixed event</option></select></label>` +
        (editEntry && !editEntry.task.locked && editEntry.task.type !== "activity"
          ? `<label class="check-label"><input id="wb-lock-on-move" type="checkbox" ${editDraft.lockOnMove ? "checked" : ""}>Lock it at the new time if I change the time</label>`
          : "");
      actions = button("next", "Next", true) + button("cancel", "Cancel");
    } else if (editStep === 1) {
      body =
        field(
          "duration",
          "Duration · minutes",
          "number",
          editDraft.duration,
          'min="1" max="1440"',
        ) +
        field(
          "rest",
          "Required break · minutes",
          "number",
          editDraft.rest,
          'min="0" max="1440"',
        );
      actions =
        button("next", "Review details", true) +
        button("back", "Back") +
        button("cancel", "Cancel");
    } else if (editStep === 2) {
      body = `<p>${esc(editDraft.title)}</p><p>${esc(editDraft.when.replace("T", " "))} · ${editDraft.duration} min</p><p>Break ${editDraft.rest} min; ${editDraft.kind === "learning" ? "Included in that day of study and its daily total." : "Other plans are preserved."}</p>`;
      actions =
        button("save-task", "Save details", true) +
        button("advanced", "Buffers and prerequisites") +
        button("back", "Back") +
        button("cancel", "Cancel");
    } else {
      body =
        field(
          "before",
          "Buffer before · minutes",
          "number",
          editDraft.bufferBefore,
          'min="0" max="1440"',
        ) +
        field(
          "after",
          "Buffer after · minutes",
          "number",
          editDraft.bufferAfter,
          'min="0" max="1440"',
        ) +
        `<label class="check-label"><input id="wb-locked" type="checkbox" ${editDraft.locked ? "checked" : ""}>Lock this time</label>`;
      actions = button("dependencies", "Review prerequisites") + button("back", "Back");
    }
    shell(editEntry ? "Edit this task" : "Add one thing", body, actions);
    if (editStep === 0) {
      $("kind").value = editDraft.kind;
      ["title", "edit-when", "kind"].forEach(
        (id) =>
          ($(id).oninput = () => {
            editDraft[id === "edit-when" ? "when" : id] = $(id).value;
          }),
      );
      if ($("lock-on-move")) $("lock-on-move").onchange = () => (editDraft.lockOnMove = $("lock-on-move").checked);
    }
    if (editStep === 1)
      ["duration", "rest"].forEach(
        (id) => ($(id).oninput = () => (editDraft[id] = Number($(id).value))),
      );
    if (editStep === 3) {
      ["before", "after"].forEach(
        (id) =>
          ($(id).oninput = () =>
            (editDraft[id === "before" ? "bufferBefore" : "bufferAfter"] =
              Number($(id).value))),
      );
      $("locked").onchange = () => (editDraft.locked = $("locked").checked);
    }
    on("next", () => {
      if (!editDraft.title.trim() || !editDraft.when)
        return error("Enter a name, date and time.");
      editStep++;
      renderEditor();
    });
    on("back", () => {
      editStep = editStep === 3 ? 2 : Math.max(0, editStep - 1);
      renderEditor();
    });
    on("cancel", home);
    on("advanced", () => {
      editStep = 3;
      renderEditor();
    });
    on("dependencies", () => dependencySearch(""));
    on("save-task", async () => {
      const token = ++request,
        requestedMode = context().mode;
      busy("Saving and checking the plans…");
      try {
        const out = await api.saveTask(editDraft, editEntry, editRevision);
        if (token !== request || requestedMode !== context().mode) return;
        if (out?.result) {
          preview = out;
          detail = false;
          renderPreview();
        } else if (out?.ok) {
          selectedId = out.id;
          home();
        } else {
          editStep = 2;
          renderEditor();
          error(out?.message || "Not saved. Your original data is preserved.");
        }
      } catch (err) {
        if (token !== request || requestedMode !== context().mode) return;
        editStep = 2;
        renderEditor();
        error(err.message);
      }
    });
  }
  function dependencySearch(q) {
    phase = "dependencies";
    const found = rows(context().branch.days)
      .filter(
        (e) =>
          e.task.id !== editEntry?.task.id &&
          `${e.task.title} ${e.date}`.includes(q),
      )
      .slice(0, 2);
    shell(
      "Choose a prerequisite",
      `<label>Name or date<input id="wb-dep-search" type="search" value="${esc(q)}"></label>${found.map((e, i) => button("dep-" + i, (editDraft.dependencies.some((d) => d.id === e.task.id) ? "Linked · " : "") + e.task.title + " · " + e.date)).join("")}`,
      button("finish-deps", "Keep and return") + button("back", "Cancel prerequisite selection"),
    );
    $("dep-search").oninput = (e) => {
      const v = e.target.value;
      dependencySearch(v);
      $("dep-search").focus();
    };
    found.forEach((e, i) => on("dep-" + i, () => dependencyGap(e)));
    on("finish-deps", () => {
      editStep = 2;
      renderEditor();
    });
    on("back", () => {
      editStep = 3;
      renderEditor();
    });
  }
  function dependencyGap(e) {
    phase = "dependency-gap";
    const existing = editDraft.dependencies.find((d) => d.id === e.task.id);
    shell(
      "Gap after the prerequisite",
      `<p>${esc(e.task.title)}</p>` +
        field(
          "dep-gap",
          "Minimum gap · minutes",
          "number",
          existing?.gap ?? 20,
          'min="0" max="525600"',
        ),
      button("keep-dep", "Save relationship", true) +
        (existing ? button("remove-dep", "Remove this relationship") : "") +
        button("back", "Back"),
    );
    on("keep-dep", () => {
      const gap = Number($("dep-gap").value);
      if (!Number.isInteger(gap) || gap < 0 || gap > 525600)
        return error("Enter a valid number of minutes.");
      editDraft.dependencies = editDraft.dependencies.filter(
        (d) => d.id !== e.task.id,
      );
      editDraft.dependencies.push({ id: e.task.id, gap });
      dependencySearch("");
    });
    on("remove-dep", () => {
      editDraft.dependencies = editDraft.dependencies.filter(
        (d) => d.id !== e.task.id,
      );
      dependencySearch("");
    });
    on("back", () => dependencySearch(""));
  }
  let ruleDraft, ruleRevision, ruleStep;
  function rules() {
    ruleDraft = structuredClone(context().branch.settings);
    ruleRevision = context().revision;
    ruleStep = 0;
    renderRules();
  }
  function renderRules() {
    phase = "rules";
    const s = ruleDraft;
    const body =
      ruleStep === 0
        ? field(
            "rule-start",
            "Earliest time each day",
            "time",
            formatTime(s.dayStart ?? 540),
          ) +
          field("rule-end", "Latest finish each day", "time", formatTime(s.dayEnd)) +
          field(
            "rule-capacity",
            "Daily study limit · minutes",
            "number",
            s.learningCapacity ?? 150,
            'min="0" max="1440"',
          )
        : field(
            "rule-gap",
            "Minimum gap between study and other events · minutes",
            "number",
            s.learningMinGap ?? 20,
            'min="0" max="1440"',
          ) +
          field(
            "rule-preference",
            "Preferred start for later study · flexible",
            "time",
            formatTime(s.learningPreferredStart ?? 660),
          ) +
          `<label>Dates without study<textarea id="wb-rule-exclusions" placeholder="2026-10-14,2026-10-20">${esc(
            Object.entries(s.learningDates || {})
              .filter(([d, r]) => r.closed)
              .map(([d]) => d)
              .join(","),
          )}</textarea></label>`;
    shell(
      "Set once for future plans",
      body,
      ruleStep === 0
        ? button("next", "Next", true) + button("cancel", "Cancel")
        : button("save-rules", "Preview rule changes", true) + button("back", "Back"),
    );
    const collect = () => {
      if (ruleStep === 0) {
        const parse = (v) =>
          Number(v.split(":")[0]) * 60 + Number(v.split(":")[1]);
        s.dayStart = parse($("rule-start").value);
        s.dayEnd = parse($("rule-end").value);
        s.learningCapacity = Number($("rule-capacity").value);
      } else {
        s.learningMinGap = Number($("rule-gap").value);
        const v = $("rule-preference").value.split(":");
        s.learningPreferredStart = Number(v[0]) * 60 + Number(v[1]);
        s._exclusions = $("rule-exclusions").value;
      }
    };
    on("next", () => {
      collect();
      ruleStep = 1;
      renderRules();
    });
    on("back", () => {
      collect();
      ruleStep = 0;
      renderRules();
    });
    on("cancel", home);
    on("save-rules", () => {
      collect();
      try {
        preview = api.saveRules(s, ruleRevision);
        detail = false;
        renderPreview();
      } catch (err) {
        error(err.message);
      }
    });
  }
  function backup() {
    phase = "backup";
    const candidates = api.recoveries(), recoveryUrl = api.ipRecoveryUrl?.();
    shell(
      "Backup and restore",
      `<p>A valid previous state is kept before saving. Restore affects this browser only, does not delete Google events, and is not a cross-device backup.</p>${candidates.length ? `<p>Available restore point: ${esc(candidates[0].savedAt || "Previous version")} · ${candidates[0].taskCount} plans.</p>` : "<p>No previous state is available. Keep the original data.</p>"}${recoveryUrl ? `<p>If you previously used Shunri at 127.0.0.1, open the export page in the original browser and port. Data is not moved automatically. Import still requires review and confirmation of whole-workspace replacement.<br><a id="wb-ip-recovery" href="${esc(recoveryUrl)}">Open the old IP-address export page</a></p>` : ""}`,
      button("export", "Export full backup") +
        button("import", "Import a backup") +
        (candidates.length ? button("restore", "Restore the previous valid version") : "") +
        button("back", "Back"),
    );
    on("export", api.export);
    on("import", () => {
      phase = "import";
      shell(
        "Choose a Shunri JSON backup",
        '<label>Backup file<input id="wb-file" type="file" accept="application/json,.json"></label><p>Review first, then confirm replacement. A restore point is kept before replacement.</p>',
        button("back", "Back"),
      );
      $("file").onchange = (e) => {
        if (e.target.files[0]) void api.import(e.target.files[0]);
      };
      on("back", backup);
    });
    on("restore", () =>
      confirm(
        "Restore the previous valid version",
        "Replace the current local schedule and rules with the restore point. The current state is kept for rollback. Google is not changed.",
        () => {
          const out = api.restoreRecovery(candidates[0].id);
          if (out.ok) {
            selectedId = null;
            home();
          } else error(out.message);
        },
      ),
    );
    on("back", home);
  }
  function confirm(title, text, action) {
    phase = "confirmation";
    shell(
      title,
      `<p>${esc(text)}</p>`,
      button("yes", "Confirm", true) + button("cancel", "Cancel"),
    );
    on("yes", async () => {
      try {
        await action();
        if (phase === "confirmation") home();
      } catch (err) {
        error(err.message);
      }
    });
    on("cancel", home);
  }
  function renderCalendar() {
    api.clearNotice?.();
    phase = "calendar";
    const c = context(),
      conflicts = rows(c.branch.days).filter((e) => e.task.calendarConflict),
      groups = api.ambiguous?.() || [];
    const reconnectNote = '<p id="wb-reconnect-note" class="reading-note">Reconnecting resets event-management links to avoid mixing accounts. Check the current calendar and management scope even if you choose the same account. Existing classification or study rules may adopt eligible events again; other events need renewed management permission before sync can change them.</p>';
    if (conflicts.length) {
      const e = conflicts[0];
      shell(
        "The two versions differ",
        `<p>${esc(e.task.title)}</p><p>${esc(e.task.calendarConflict.message)}</p><div class="change-row"><strong>Local version</strong><p>${esc(when(e))}</p>${e.task.done ? "<p>The actual completion record is preserved.</p>" : ""}</div>${e.task.calendarConflict.remote ? `<div class="change-row"><strong>Google version</strong><p>${esc(e.task.calendarConflict.remote.title || e.task.title)}</p><p>${esc(when({ date: e.task.calendarConflict.remote.date, task: e.task.calendarConflict.remote }))}</p></div>` : "<p>No Google version is available to use. The local record will not be deleted automatically.</p>"}<p>No version is overwritten silently. ${conflicts.length > 1 ? (conflicts.length - 1) + " more conflicts remain after this one." : ""}</p>${reconnectNote}`,
        button("local", "Keep the local version") +
          (!e.task.done && e.task.calendarConflict.remote
            ? button("remote", "Use the Google version")
            : "") +
          button("back", "Back"),
      );
      on("local", () => api.resolveConflict(e.task.id, true));
      on("remote", () => api.resolveConflict(e.task.id, false));
      on("back", home);
      return;
    }
    const summary = api.interpretation?.();
    const message = c.readError || c.calendarStatus?.message || "";
    const body = `${c.calendarStatus?.mock ? '<p class="reading-note">This independent preview uses a simulated Calendar. No real calendar is read or changed.</p>' : ''}<p class="current-time">${esc(statusText())}</p>${messageHtml(message, esc)}<p>${summary ? esc(summary.text) : "Calendar reading preserves original event identities. Event descriptions are data, not instructions to execute."}</p><p>${c.lastReadAt ? "Last successful read: " + esc(new Date(c.lastReadAt).toLocaleString("en-US")) : "No complete successful calendar read yet."}</p><p>Real calendar writes: ${c.calendarStatus?.writesEnabled ? "enabled, within the authorized scope only." : "off. Recognizing a purpose does not grant permission to change Google."}</p>${c.readRange ? `<p class="muted">Current read range: ${esc(c.readRange.from)} — ${esc(c.readRange.to)}${c.readRange.partial ? " · Partly incomplete" : ""}</p>` : ""}${api.syncSummary() ? `<p>${esc((api.syncSummary()))}</p>` : ""}`;
    const connected = c.calendarStatus?.state === "connected";
    shell(
      "Google Calendar",
      body + reconnectNote + '<p id="wb-readonly-help" class="reading-note">For the specific read-only reason, return to the schedule and select the event. Its card explains what is preserved.</p>',
      (connected || (c.calendarStatus?.state === "storage_error" && c.calendarStatus.storageRetryable)
        ? button("refresh", "Try reading again")
        : button("connect", "Reconnect")) +
        (connected && /authori[sz]|permission/i.test(c.readError)
          ? button("connect", "Add read-only permission")
          : "") +
        (groups.length ? button("meaning", "Confirm an event purpose") : "") +
        (connected ? button("sync-settings", "Sync preferences") : "") +
        button("back", "Back to schedule"),
    );
    on("refresh", () => void api.refreshRead());
    on("connect", () => api.connect());
    on("meaning", () => meaning(groups[0]));
    on("sync-settings", syncSettings);
    on("back", home);
  }
  function meaning(question, after = renderCalendar) {
    phase = "meaning";
    const entry = rows(context().branch.days).find(e => e.task.id === question.taskId);
    const evidence = (question.evidence || entry?.task.semantic?.evidence || []).map(item => typeof item === "string" ? item : item.excerpt).filter(Boolean).slice(0, 2);
    const candidates = [...new Set(question.choices.map(c => c.closedDate).filter(Boolean))];
    const scopeMessage = question.decisionDate
      ? `Confirm the study limit for ${question.decisionDate} only. Rules for other dates stay the same; Google is not changed.`
      : "Confirm this purpose only. The current basis is remembered; a substantial change will ask again. Google is not changed.";
    const continueAfter = () => {
      const next = question.decisionDate && api.ambiguityFor?.(question.taskId);
      if (next?.decisionDate && next.decisionDate !== question.decisionDate)
        meaning(next, after);
      else after();
    };
    shell(
      question.prompt,
      `<div class="selected-context"><p class="selected-name">${esc(question.title)}</p><p class="muted">${esc(entry ? when(entry) : question.date || '')}</p></div>${candidates.length ? `<p>Dates to confirm: ${candidates.map(d => esc(d) + ' (' + esc(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d + 'T12:00:00Z').getUTCDay()]) + ')').join(', ')}</p>` : ''}${evidence.length ? `<p class="reading-note">Calendar evidence: ${esc(evidence.join(' · '))}</p>` : entry?.task.calendarSource?.description ? `<p class="reading-note">Calendar description: ${esc(entry.task.calendarSource.description.slice(0,240))}</p>` : ''}<p>${esc(scopeMessage)}</p><p class="reading-note">A purpose tag alone leaves the time movable.</p><label class="check-label"><input id="meaning-lock" type="checkbox">Lock this time · will not move</label>`,
      question.choices.slice(0,3).map((c,i) => button("meaning-" + i, c.label + (c.closedDate ? ' · ' + c.closedDate : ''), i === 0)).join('') + button("back", "Cancel"),
    );
    question.choices.slice(0, 3).forEach((c, i) =>
      on("meaning-" + i, async () => {
        const token = ++request,
          requestedMode = context().mode;
        const lockIt = Boolean($("meaning-lock")?.checked);
        busy("Remembering your choice…");
        try {
          const proposal = await api.rememberMeaning(question, c.id);
          if (token !== request || requestedMode !== context().mode) return;
          if (proposal) {
            if (lockIt) applyMeaningLock(proposal, question.taskId);
            preview = proposal;
            preview.afterConfirm = continueAfter;
            preview.meaningResume = after;
            detail = false;
            renderPreview();
          } else continueAfter();
        } catch (err) {
          if (token === request && requestedMode === context().mode)
            error(err.message);
        }
      }),
    );
    on("back", home);
  }
  async function syncSettings() {
    phase = "sync-settings";
    const c = context();
    shell(
      "Sync after local changes",
      `<p>${c.branch.calendar?.autoSync ? "Automatic collection is on." : "Not enabled yet."} After confirmation, the full set of affected plans is collected together.</p><p>Real calendar writes are currently ${c.calendarStatus?.writesEnabled ? "on" : "off"}. This preference does not expand external write permission.</p>`,
      button(
        "toggle-sync",
        c.branch.calendar?.autoSync ? "Turn off automatic sync" : "Turn on change collection",
        true,
      ) +
        (c.branch.calendar?.autoSync &&
        c.calendarStatus?.writesEnabled &&
        api.syncSummary()
          ? button("retry-sync", "Retry pending sync")
          : "") +
        button("back", "Back"),
    );
    on("toggle-sync", async () => {
      try {
        const proposal = await api.toggleSync(!c.branch.calendar?.autoSync);
        if (proposal) renderSyncResume(proposal);
        else renderCalendar();
      } catch (err) {
        error(err.message);
      }
    });
    on("retry-sync", () => {
      api.retrySync();
      renderCalendar();
    });
    on("back", renderCalendar);
  }
  function renderSyncResume(proposal) {
    phase = "sync-resume";
    shell(`Collect ${proposal.items.length} current plan${proposal.items.length === 1 ? "" : "s"}`,
      `<p>For changes made while collection was off, only the latest result is kept. Confirmation checks the calendar before syncing. Cancel does not enable collection or queue changes.</p>
      ${proposal.items.map(item => `<div class="change-row"><strong>${esc(item.title)}</strong><p>${esc(item.date)} ${formatTime(item.start)}–${formatTime(item.start + item.duration)}</p><small>${item.eventId ? "Update the original event managed by Shunri" : "Create in the selected calendar you own"}</small></div>`).join("")}
      ${proposal.blocked.length ? `<section class="reading-note"><h2>${proposal.blocked.length} plans stay unchanged for now</h2>${proposal.blocked.map(item => `<p>${esc(item.title)}: ${esc(item.reason)}</p>`).join("")}</section>` : ""}
      <p class="saved-feedback">Future confirmed changes are collected automatically.${context().calendarStatus?.writesEnabled ? "Sync uses the confirmed scope." : "Google writes are off. Only the pending sync queue is saved; a local save in Shunri is kept apart from a Google write."}</p>`,
      button("resume-confirm", "Confirm and enable", true) + button("resume-cancel", "Cancel"));
    on("resume-confirm", () => {
      try { api.confirmSyncResume(proposal); renderCalendar(); }
      catch (err) { error(err.message); }
    });
    on("resume-cancel", syncSettings);
  }
  function render() {
    syncRefreshNotice();
    if (custom) {
      if (custom.saving) return;
      if (custom.mode !== context().mode) { stopCustom(); home(); return; }
      if (preview && custom.basis !== context().proposalKey && !preview.semanticCorrection) { invalidateCustom(); customStatus("The schedule changed. Your input is preserved; please check again.", true); }
      return;
    }
    if (phase === "home") renderHome();
    else if (phase === "completed" && lastConfirmed) renderSavedArrangement(lastConfirmed);
    else if (phase === "result-details" && lastConfirmed) renderResultDetails();
    else if (
      phase === "preview" ||
      phase === "details" ||
      phase === "conflict"
    ) {
      if (
        (preview?.revision !== undefined && preview.revision !== context().revision) ||
        (preview?.mode !== undefined && preview.mode !== context().mode)
      ) {
        const changed = preview.mode !== context().mode || preview.scheduleKey !== scheduleKey(context().branch);
        shell(
          changed ? "The original schedule changed" : "The view or status changed",
          "<p>This preview needs checking again. Your draft is preserved; recalculate before confirming.</p>",
          button("recalculate", "Recalculate", true) + button("cancel", "Cancel"),
        );
        on("recalculate", () => void recalculatePreview());
        on("cancel", () => {
          api.cancel();
          preview = null;
          draft = null;
          home();
        });
      }
    }
  }
  async function recalculatePreview() {
    api.clearNotice?.();
    const previous = preview;
    if (!previous?.semanticIntent && !isEditingLabel(previous?.label))
      return calculate(previous?.moveIntent || null);
    const token = ++request,
      requestedMode = context().mode;
    busy("Checking the original draft again…");
    try {
      let next;
      if (previous.semanticIntent) {
        const { question, choice } = previous.semanticIntent;
        if (
          !rows(context().branch.days).some(
            (e) => e.task.id === question.taskId,
          )
        )
          throw Error("This plan no longer exists, so its purpose preview cannot be rebuilt.");
        next = await api.rememberMeaning(question, choice);
        if (next) next.afterConfirm = previous.afterConfirm;
      } else {
        editEntry = rows(context().branch.days).find(
          (e) => e.task.id === editEntry?.task.id,
        );
        if (!editEntry) throw Error("This plan no longer exists. Your edit draft is preserved.");
        editRevision = context().revision;
        next = await api.saveTask(editDraft, editEntry, editRevision);
      }
      if (token !== request || requestedMode !== context().mode) return;
      if (!next?.result)
        throw Error(next?.message || "The draft could not produce a preview. No plans were changed.");
      preview = next;
      detail = false;
      renderPreview();
    } catch (err) {
      if (token === request && requestedMode === context().mode)
        error(err.message);
    }
  }
  header.onclick = renderCalendar;
  return {
    render,
    captureCalendarRead,
    completeCalendarRead,
    refreshStatus,
    invalidatePending() {
      if (custom && !custom.saving) { invalidateCustom("The schedule changed. Your input is preserved; please check again."); customStatus("The schedule changed. Your input is preserved; please check again.", true); }
    },
    home,
    confirm,
    backup,
    editor: () => editor(selected()),
    rules,
    calendar: renderCalendar,
    preview(p) {
      lastConfirmed = null;
      preview = p;
      detail = false;
      renderPreview();
    },
    adjust(e) {
      adjust(e);
    },
    phase: () => phase,
    lifecycle: () => ({
      mode: context().mode,
      scheduleKey: scheduleKey(context().branch),
      ...(lastConfirmed && (phase === "home" || phase === "completed" || phase === "result-details")
        ? { kind: "result" }
        : custom
          ? { kind: "pending", stale: !custom.snapshot }
        : preview && ["preview", "details", "conflict"].includes(phase)
          ? { kind: "pending", stale: (preview.revision !== undefined && preview.revision !== context().revision) || preview.mode !== context().mode }
          : { kind: "other" }),
    }),
  };
}
