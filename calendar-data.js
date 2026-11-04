import { dateParts, calendarEndpointInstant as parseEndpoint, MINUTE } from "./time.js";
import { normalizeLearningDays } from "./learning.js";
import { interpretCalendar } from "./calendar-semantics.js";

const clone = (value) => structuredClone(value);
const isRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

/** An occurrence's original Google ID, not its title or scheduled date, is its identity. */
export function calendarKey(calendarId, eventId) {
  if (isRecord(calendarId)) {
    const value = calendarId.calendarLink || calendarId;
    return JSON.stringify([value.calendarId, value.eventId || value.id]);
  }
  return JSON.stringify([calendarId, eventId]);
}

// Synchronous and browser-compatible. The complete key is retained on calendarLink too.
function stableHash(text) {
  const mask = (1n << 64n) - 1n;
  let a = 14695981039346656037n,
    b = 7809847782465536322n;
  for (const character of text) {
    const point = BigInt(character.codePointAt(0));
    a = ((a ^ point) * 1099511628211n) & mask;
    b = ((b ^ point) * 14029467366897019727n) & mask;
  }
  return a.toString(16).padStart(16, "0") + b.toString(16).padStart(16, "0");
}

/** Only fields that change the Google event payload participate in local-change detection. */
export function localCalendarSignature(
  task,
  date = task.date,
  timeZone = "America/Los_Angeles",
) {
  return JSON.stringify({
    date,
    start: task.start,
    duration: task.duration,
    title: task.title,
    timeZone,
    allDay: Boolean(task.calendarSource?.allDay),
  });
}

function flattenEvent(wrapper) {
  const event = wrapper.event || wrapper;
  return {
    ...event,
    id: event.id || event.eventId,
    calendarId: wrapper.calendarId || event.calendarId,
    calendarName:
      wrapper.calendarName || event.calendarName || "Google Calendar",
    calendarTimeZone: wrapper.calendarTimeZone || event.calendarTimeZone,
    accessRole: wrapper.accessRole || event.accessRole,
    managed: wrapper.managed ?? event.managed,
    managedUid: wrapper.managedUid || event.managedUid,
    managedProfileId: wrapper.managedProfileId || event.managedProfileId,
    baselineEtag: wrapper.baselineEtag || event.baselineEtag,
    canManage: wrapper.canManage ?? event.canManage,
  };
}

function parsedEvent(event, timeZone) {
  const eventZone = event.start?.timeZone || event.calendarTimeZone || timeZone;
  const allDay = Boolean(event.start?.date);
  if (allDay !== Boolean(event.end?.date))
    throw new Error("The event’s start and end must both be all-day dates or both be exact times.");
  // Google all-day dates are floating dates: their timezone field has no significance.
  // Anchor their occupation to the app's viewed day, never convert them to yesterday.
  const startInstant = parseEndpoint(
    event.start,
    allDay ? timeZone : eventZone,
  );
  const endInstant = parseEndpoint(
    event.end,
    allDay ? timeZone : event.end?.timeZone || eventZone,
  );
  if (!(endInstant > startInstant))
    throw new Error("The event must end after it starts.");
  const local = dateParts(startInstant, timeZone);
  return {
    date: local.date,
    start: local.minute,
    duration: Math.max(1, Math.ceil((endInstant - startInstant) / MINUTE)),
    title: event.summary || "(Untitled event)",
    occupation: { startInstant, endInstant },
    source: {
      summary: event.summary || "",
      description: event.description || "",
      location: event.location || "",
      start: clone(event.start),
      end: clone(event.end),
      allDay,
      minutePrecision:
        startInstant % MINUTE === 0 &&
        (endInstant - startInstant) % MINUTE === 0,
      timeZone: eventZone,
      organizer: clone(event.organizer || null),
      creator: clone(event.creator || null),
      recurringEventId: event.recurringEventId || null,
      originalStartTime: clone(event.originalStartTime || null),
      accessRole: event.accessRole || "reader",
      calendarName: event.calendarName,
      calendarTimeZone: event.calendarTimeZone || null,
      colorId: event.colorId || null,
      eventType: event.eventType || "default",
      canManage: event.canManage,
      transparency: event.transparency || "opaque",
    },
  };
}

export function canManageCalendarSource(source) {
  return (
    Boolean(source) &&
    source.canManage !== false &&
    source.accessRole === "owner" &&
    source.organizer?.self === true &&
    !source.allDay &&
    source.minutePrecision !== false &&
    (source.eventType || "default") === "default"
  );
}

function selectedFor(selections, key) {
  if (selections instanceof Map) return selections.get(key);
  if (Array.isArray(selections))
    return selections.find((item) => item.key === key);
  return selections?.[key];
}

/** Shared by classification previews and imports; display exactly what will be matched. */
export function calendarRuleMatches(task, rule) {
  if (rule.calendarId && rule.calendarId !== task.calendarLink?.calendarId)
    return false;
  if (rule.match === "calendar") return true;
  if (typeof rule.value !== "string" || !rule.value.trim()) return false;
  const value = rule.value.trim();
  if (rule.match === "color")
    return (task.calendarSource?.colorId || "default") === value;
  const text =
    rule.match === "title_contains"
      ? task.calendarSource?.summary || task.title || ""
      : rule.match === "description_contains"
        ? task.calendarSource?.description || ""
        : null;
  return (
    text !== null &&
    text.toLocaleLowerCase().includes(value.toLocaleLowerCase())
  );
}

export function ruleFor(task, rules = []) {
  return rules.find((rule) => calendarRuleMatches(task, rule));
}

function adoptionFor(options, key, task) {
  if (task.calendarClassification?.manage === false) return false;
  const refs = options.managedRefs;
  let reference;
  if (refs instanceof Set) reference = refs.has(key);
  else if (refs instanceof Map) reference = refs.get(key);
  else if (Array.isArray(refs))
    reference = refs.find((item) => item === key || item?.key === key);
  else if (isRecord(refs)) reference = refs[key];
  return Boolean(reference || task.calendarLink.managed);
}

function enforceManagementVeto(task, rule) {
  if (rule?.manage === false)
    task.calendarClassification = { kind: rule.kind, ...task.calendarClassification, manage: false };
  if (task.calendarClassification?.manage !== false) return;
  task.calendarLink.managed = false;
  task.externalReadOnly = true;
  task.locked = true;
}

function revokeVerifiedManagement(task) {
  const link = task.calendarLink;
  // Preserve an observed old lock without guessing who or what owns it.
  if (link.managed && task.locked && task.calendarRestrictionLock !== true)
    link.lockedBeforeManagementLoss = true;
  link.managed = false;
  delete link.adoptedEtag;
  task.externalReadOnly = true;
  if (!task.locked) task.calendarRestrictionLock = true;
  task.locked = true;
}

function preserveReverifiedLocks(data) {
  for (const tasks of Object.values(data.days || {})) for (const task of tasks) {
    if (!task.calendarLink?.lockedBeforeManagementLoss || !task.calendarLink.managed ||
      task.calendarClassification?.manage === false || !canManageCalendarSource(task.calendarSource)) continue;
    // Classification/semantic readonly recovery may release its own lock, but
    // not one already present before the server withdrew management.
    task.locked = true;
    delete task.calendarLink.lockedBeforeManagementLoss;
  }
}

function releaseRestrictionLock(task) {
  if (
    task.calendarRestrictionLock !== true ||
    !task.calendarLink.managed ||
    !canManageCalendarSource(task.calendarSource)
  ) return;
  task.externalReadOnly = false;
  // Explicit owners replace this temporary lock; old bare locks never reach here.
  if (task.lockSource === "user" || task.type === "activity" ||
    task.calendarClassification?.kind === "fixed" || task.calendarClassification?.locked
  ) {
    delete task.calendarRestrictionLock;
    return;
  }
  // Keep provenance while another temporary guard (including a semantic snapshot
  // of locked=true) is active, so a later poll can release the original lock.
  if (task.timeLocked || task.semanticLock || task.semanticPendingLock ||
    task.semanticConflict || task.readonlyLock || task.calendarConflict) return;
  delete task.calendarRestrictionLock;
  task.locked = false;
  // done/deferred already block adjustment; they do not own a separate time lock.
}

function applyClassification(task, date, rule, options) {
  const key = calendarKey(task);
  if (!rule || !["learning", "fixed", "task"].includes(rule.kind)) return task;
  const wasReadonly = task.externalReadOnly;
  const manage = typeof rule.manage === "boolean" ? rule.manage : task.calendarClassification?.manage;
  const classification = { kind: rule.kind, source: rule.source || "user-confirmed-classification",
    ...(typeof manage === "boolean" ? { manage } : {}),
    ...(rule.locked ? { locked: true } : {}),
    ...(rule.purpose ? { purpose: rule.purpose } : {}),
    ...(rule.evidence ? { evidence: clone(rule.evidence) } : {}) };
  if (rule.kind === "learning")
    classification.planId = rule.planId || task.planId || "study-default";
  task.calendarClassification = classification;
  task.tags = [
    ...new Set(
      (task.tags || [])
        .filter((tag) => tag !== "study")
        .concat(rule.kind === "learning" ? ["study"] : []),
    ),
  ];
  if (rule.kind === "learning") {
    task.planId = classification.planId;
    if (!rule.source && rule.planId && !/^(?:job-prepare|sql|interface(?:\.ai)?|study-default|my-study-plan)$/i.test(rule.planId)) {
      task.learningPlanUserDefined = true;
      task.planSource = "user";
    }
    task.packageOriginDate ||= date;
    // The shared normalizer reuses an existing plan/day package before assigning one.
    // Never create a separate Google-only package beside that day's local learning.
    if (!task.packageId && rule.packageId) task.packageId = rule.packageId;
    task.counted = true;
  } else if (task.planId && !task.done) {
    // A semantic correction changes participation, not original package identity.
    // Re-reading an adopted Google event must not erase this stable history.
    if (!["user-confirmed-purpose", "built-in-personal-rule"].includes(rule.source)) {
      delete task.planId;
      delete task.packageId;
      delete task.packageOrder;
      delete task.packageOriginDate;
    }
    task.counted = false;
  }
  const managed =
    adoptionFor(options, key, task) && canManageCalendarSource(task.calendarSource);
  task.calendarLink.managed = managed;
  task.externalReadOnly = !managed;
  if (rule.kind === "fixed") {
    classification.bufferExplicit = rule.bufferExplicit || rule.bufferBefore !== undefined || rule.bufferAfter !== undefined;
    task.type = "activity";
    task.locked = true;
    if (rule.bufferBefore !== undefined || rule.bufferAfter !== undefined)
      task.protectionSource = "user";
    const keepProtection = classification.bufferExplicit || task.protectionSource === "user";
    task.bufferBefore = rule.bufferBefore ?? (keepProtection ? task.bufferBefore : 0);
    task.bufferAfter = rule.bufferAfter ?? (keepProtection ? task.bufferAfter : 0);
  } else {
    task.type = "task";
    task.bufferBefore = 0;
    task.bufferAfter = 0;
    task.locked =
      !managed ||
      Boolean(rule.locked) ||
      task.lockSource === "user" ||
      (!wasReadonly && Boolean(task.locked));
  }
  // An ordinary classification can still be locked solely because management
  // is unavailable. Only an independent classification lock replaces its source.
  if (rule.kind === "fixed" || rule.locked) delete task.calendarRestrictionLock;
  return task;
}

function eventItems(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.events)) return response.events;
  if (Array.isArray(response?.pages)) return response.pages.flatMap(eventItems);
  return response?.items || [];
}

function findEntry(days, key, uid) {
  for (const [date, tasks] of Object.entries(days)) {
    const index = tasks.findIndex(
      (task) =>
        (["google", "app"].includes(task.calendarLink?.source) &&
          calendarKey(task) === key) ||
        (uid && task.uid === uid),
    );
    if (index !== -1) return { date, index, task: tasks[index] };
  }
  return null;
}

function unclassifiedEntries(days) {
  return Object.entries(days).flatMap(([date, tasks]) =>
    tasks
      .filter(
        (task) =>
          task.calendarLink?.source === "google" &&
          !task.calendarClassification &&
          !task.calendarLink.remoteDeleted,
      )
      .map((task) => ({
        key: calendarKey(task),
        calendarId: task.calendarLink.calendarId,
        calendarName: task.calendarSource?.calendarName || "Google Calendar",
        title: task.title,
        date,
        canManage: canManageCalendarSource(task.calendarSource),
        allDay: Boolean(task.calendarSource?.allDay),
        colorId: task.calendarSource?.colorId || null,
        description: task.calendarSource?.description || "",
      })),
  );
}

/** Merge a completed server read. Absence in a bounded read NEVER means deletion. */
export function mergeCalendar(input, response, options = {}) {
  const data = clone(input);
  data.days ||= {};
  const timeZone =
    options.timeZone || data.settings?.timeZone || "America/Los_Angeles";
  const rules = options.rules || data.calendar?.classificationRules || [];
  // Local explicit read-only consent outranks a still-existing server mapping.
  // Enforce it even for absent/invalid events and conflict/pending early returns.
  for (const tasks of Object.values(data.days)) for (const task of tasks)
    if (task.calendarLink?.source === "google")
      enforceManagementVeto(task, selectedFor(options.selections, calendarKey(task)) || ruleFor(task, rules));
  const outcome = {
    data,
    imported: 0,
    updated: 0,
    unchanged: 0,
    conflicts: [],
    errors: [],
    unclassified: [],
    range: response?.range || null,
  };
  // Expanded recurring instances retain their own Google event ID. Duplicate pages are harmless.
  const events = new Map();
  for (const wrapper of eventItems(response)) {
    const event = flattenEvent(wrapper);
    if (!event.calendarId || !event.id) {
      outcome.errors.push({ message: "The calendar or original event ID is missing. It was not imported." });
      continue;
    }
    const key = calendarKey(event.calendarId, event.id),
      previous = events.get(key);
    if (!previous || (event.updated || "") >= (previous.updated || ""))
      events.set(key, event);
  }
  for (const [key, event] of events) {
    const managementRevoked = event.managed === false;
    const verifiedManaged = Boolean(
      event.managed &&
        event.managedUid &&
        (!options.profileId ||
          !event.managedProfileId ||
          event.managedProfileId === options.profileId),
    );
    const entry = findEntry(
      data.days,
      key,
      verifiedManaged ? event.managedUid : null,
    );
    if (entry && managementRevoked) revokeVerifiedManagement(entry.task);
    if (event.status === "cancelled") {
      if (!entry) {
        outcome.unchanged++;
        continue;
      }
      entry.task.calendarLink.remoteDeleted = true;
      entry.task.calendarLink.etag = event.etag || entry.task.calendarLink.etag;
      entry.task.externalReadOnly = true;
      if (!entry.task.done && !entry.task.deferred) {
        entry.task.calendarLink.deferredByCancellation = true;
        entry.task.deferred = true;
      }
      entry.task.calendarConflict = {
        kind: "remote_deleted",
        message: "Google cancelled this event. The local record is retained and will not be automatically deleted.",
      };
      outcome.conflicts.push({
        key,
        id: entry.task.id,
        kind: "remote_deleted",
        message: entry.task.calendarConflict.message,
      });
      outcome.updated++;
      continue;
    }
    let parsed;
    try {
      parsed = parsedEvent(event, timeZone);
    } catch (error) {
      outcome.errors.push({ key, message: error.message });
      continue;
    }
    const id = `gcal-${stableHash(key)}`;
    const incoming = {
      id,
      uid: verifiedManaged ? event.managedUid : id,
      title: parsed.title,
      start: parsed.start,
      duration: parsed.duration,
      rest: 0,
      counted: false,
      done: false,
      locked: true,
      deferred: false,
      type: "task",
      bufferBefore: 0,
      bufferAfter: 0,
      dependencies: [],
      tags: [],
      externalReadOnly: true,
      calendarOccupation: parsed.occupation,
      calendarSource: parsed.source,
      calendarLink: {
        source: "google",
        calendarId: event.calendarId,
        eventId: event.id,
        etag: event.etag || null,
        updated: event.updated || null,
        managed: verifiedManaged,
        remoteDeleted: false,
        localFingerprint: null,
        ...(verifiedManaged && event.baselineEtag
          ? { adoptedEtag: event.baselineEtag }
          : {}),
      },
    };
    const incomingFingerprint = localCalendarSignature(
      incoming,
      parsed.date,
      timeZone,
    );
    incoming.calendarLink.localFingerprint = incomingFingerprint;
    if (!entry) {
      const rule =
        selectedFor(options.selections, key) || ruleFor(incoming, rules);
      applyClassification(incoming, parsed.date, rule, {
        ...options,
        managedRefs: managementRevoked ? undefined : options.managedRefs,
        bufferBefore: data.settings?.bufferBefore,
        bufferAfter: data.settings?.bufferAfter,
      });
      (data.days[parsed.date] ||= []).push(incoming);
      outcome.imported++;
      continue;
    }
    const task = entry.task;
    enforceManagementVeto(task, selectedFor(options.selections, key) ||
      ruleFor({ ...task, calendarSource: parsed.source }, rules));
    const oldLink = task.calendarLink || {};
    // Only valid, present events reach here. Clear cancellation state before
    // pending-edit/conflict returns, without undoing a user's earlier deferral.
    if (oldLink.remoteDeleted || task.calendarConflict?.kind === "remote_deleted") {
      if (oldLink.deferredByCancellation === true) task.deferred = false;
      delete oldLink.deferredByCancellation;
      oldLink.remoteDeleted = false;
      if (task.calendarConflict?.kind === "remote_deleted") delete task.calendarConflict;
    }
    let baseline = oldLink.localFingerprint;
    if (!baseline && task.calendarSource?.start && task.calendarSource?.end) {
      try {
        const oldParsed = parsedEvent(
          {
            ...task.calendarSource,
            calendarTimeZone: task.calendarSource.timeZone,
          },
          timeZone,
        );
        baseline = localCalendarSignature(
          {
            ...task,
            title: oldParsed.title,
            start: oldParsed.start,
            duration: oldParsed.duration,
            calendarSource: oldParsed.source,
          },
          oldParsed.date,
          timeZone,
        );
      } catch {
        /* Missing historical metadata is handled conservatively below. */
      }
    }
    const localFingerprint = localCalendarSignature(task, entry.date, timeZone);
    if (
      baseline == null &&
      oldLink.signature &&
      localFingerprint !== incomingFingerprint
    ) {
      task.calendarConflict = {
        kind: "unverified_baseline",
        message:
          "The original sync record has no verifiable local baseline, and the versions differ. Choose which version to keep.",
        local: {
          date: entry.date,
          title: task.title,
          start: task.start,
          duration: task.duration,
        },
        remote: {
          date: parsed.date,
          title: parsed.title,
          start: parsed.start,
          duration: parsed.duration,
          calendarOccupation: parsed.occupation,
          calendarSource: parsed.source,
          etag: event.etag || null,
          updated: event.updated || null,
          localFingerprint: incomingFingerprint,
        },
      };
      outcome.conflicts.push({
        key,
        id: task.id,
        kind: "unverified_baseline",
        message: task.calendarConflict.message,
      });
      continue;
    }
    const localChanged = baseline != null && localFingerprint !== baseline;
    const remoteChanged =
      oldLink.etag && event.etag
        ? oldLink.etag !== event.etag
        : baseline != null && incomingFingerprint !== baseline;
    const actualRemotePayloadChanged =
      baseline != null && incomingFingerprint !== baseline;
    if (
      remoteChanged &&
      actualRemotePayloadChanged &&
      (localChanged || task.done)
    ) {
      const kind = task.done ? "completed_remote_changed" : "both_changed";
      task.calendarConflict = {
        kind,
        message: task.done
          ? "Google changed a completed event. The completion record is retained; choose which version to keep."
          : "Both the local and Google versions changed. Neither has been overwritten; choose which version to keep.",
        local: {
          date: entry.date,
          title: task.title,
          start: task.start,
          duration: task.duration,
        },
        remote: {
          date: parsed.date,
          title: parsed.title,
          start: parsed.start,
          duration: parsed.duration,
          calendarOccupation: parsed.occupation,
          calendarSource: parsed.source,
          etag: event.etag || null,
          updated: event.updated || null,
          localFingerprint: incomingFingerprint,
        },
      };
      outcome.conflicts.push({
        key,
        id: task.id,
        kind,
        message: task.calendarConflict.message,
      });
      continue;
    }
    // Preserve a pending local move during polling. ETag-only metadata changes are safe.
    if (localChanged && !actualRemotePayloadChanged) {
      task.calendarLink = {
        ...oldLink,
        source: "google",
        calendarId: event.calendarId,
        eventId: event.id,
        etag: event.etag || oldLink.etag,
        updated: event.updated || oldLink.updated,
        managed: task.calendarClassification?.manage !== false && Boolean(oldLink.managed || verifiedManaged),
        remoteDeleted: false,
        localFingerprint: baseline,
        ...(verifiedManaged && event.baselineEtag
          ? { adoptedEtag: event.baselineEtag }
          : {}),
      };
      task.calendarSource = parsed.source;
      // Fresh eligibility is authoritative even without a classification rule;
      // keep the pending time and baseline while preventing further adjustments.
      if (!canManageCalendarSource(parsed.source)) {
        task.calendarLink.managed = false;
        task.externalReadOnly = true;
        if (!task.locked) task.calendarRestrictionLock = true;
        task.locked = true;
      } else if (task.calendarLink.managed) {
        // Revived records may have no classification to clear this flag.
        // Preserve their independent user/semantic/time locks.
        task.externalReadOnly = false;
        releaseRestrictionLock(task);
      }
      outcome.unchanged++;
      continue;
    }
    if (!localChanged && !task.done) {
      task.title = parsed.title;
      task.start = parsed.start;
      task.duration = parsed.duration;
      task.calendarOccupation = parsed.occupation;
      task.calendarSource = parsed.source;
      if (entry.date !== parsed.date) {
        data.days[entry.date].splice(entry.index, 1);
        (data.days[parsed.date] ||= []).push(task);
      }
    }
    task.calendarLink = {
      ...oldLink,
      ...incoming.calendarLink,
      managed: task.calendarClassification?.manage !== false && Boolean(oldLink.managed || verifiedManaged),
      // A pending local edit must not become its own accepted remote baseline.
      localFingerprint: localChanged ? baseline : incomingFingerprint,
    };
    if (task.calendarConflict?.kind !== "remote_deleted")
      delete task.calendarConflict;
    // A pending move can also settle before the next eligible response.
    releaseRestrictionLock(task);
    const rule =
      selectedFor(options.selections, key) ||
      task.calendarClassification ||
      ruleFor(task, rules);
    applyClassification(task, parsed.date, rule, {
      ...options,
      managedRefs: managementRevoked ? undefined : options.managedRefs,
      bufferBefore: data.settings?.bufferBefore,
      bufferAfter: data.settings?.bufferAfter,
    });
    if (remoteChanged) outcome.updated++;
    else outcome.unchanged++;
  }
  if (response?.range) {
    data.calendar ||= {};
    data.calendar.lastRead = {
      range: clone(response.range),
      count: events.size,
      ...(response.readAt ? { readAt: response.readAt } : {}),
    };
  }
  data.days = normalizeLearningDays(data.days);
  const interpreted = interpretCalendar(data, options);
  preserveReverifiedLocks(interpreted.data);
  outcome.data = interpreted.data;
  outcome.interpretation = interpreted.summary;
  outcome.ambiguousDecisions = interpreted.ambiguousDecisions;
  outcome.unclassified = unclassifiedEntries(interpreted.data.days);
  return outcome;
}

/** One-time user mappings; the caller must verify adoption separately with the server. */
export function classifyCalendar(
  input,
  { rules, selections = {}, ...options } = {},
) {
  const data = clone(input);
  data.calendar ||= {};
  if (rules !== undefined) {
    if (
      !Array.isArray(rules) ||
      rules.some(
        (rule) =>
          !isRecord(rule) ||
          ![
            "calendar",
            "title_contains",
            "description_contains",
            "color",
          ].includes(rule.match) ||
          !["learning", "fixed", "task"].includes(rule.kind) ||
          (rule.match !== "calendar" &&
            (typeof rule.value !== "string" || !rule.value.trim())),
      )
    )
      throw new Error("The study and fixed-event classification rules are invalid.");
    data.calendar.classificationRules = clone(rules);
  }
  const activeRules = data.calendar.classificationRules || [];
  let classified = 0;
  for (const [date, tasks] of Object.entries(data.days || {})) {
    for (const task of tasks) {
      if (task.calendarLink?.source !== "google") continue;
      const rule =
        selectedFor(selections, calendarKey(task)) ||
        ruleFor(task, activeRules) ||
        task.calendarClassification;
      if (rule) {
        applyClassification(task, date, rule, {
          ...options,
          bufferBefore: data.settings?.bufferBefore,
          bufferAfter: data.settings?.bufferAfter,
        });
        classified++;
      }
    }
  }
  data.days = normalizeLearningDays(data.days || {});
  const interpreted = interpretCalendar(data, options);
  preserveReverifiedLocks(interpreted.data);
  return { data: interpreted.data, classified, unclassified: unclassifiedEntries(interpreted.data.days),
    interpretation: interpreted.summary, ambiguousDecisions: interpreted.ambiguousDecisions };
}
