import { localCalendarSignature } from "./calendar-data.js";

const clone = (value) => structuredClone(value);
const activeStatuses = new Set(["queued", "syncing", "failed", "blocked"]);
export const TERMINAL_HISTORY_LIMIT = 50;
// Calendar execute requests time out after 45 seconds. A fixed five-minute
// grace protects persisted receipts across reloads without retaining them forever.
export const RECEIPT_RETENTION_MS = 5 * 60 * 1000;
// Only a real markSyncing caller holding this exact snapshot can recover an
// unusually late receipt after another page pruned the old terminal job.
const receiptSnapshots = new WeakMap();
const keyOf = (task) => task.uid || task.id;
const allEntries = (days = {}) =>
  Object.entries(days).flatMap(([date, tasks]) =>
    tasks.map((task) => ({ date, task })),
  );
const eligible = (task) =>
  task &&
  !task.done &&
  !task.locked &&
  !task.timeLocked &&
  !task.deferred &&
  task.type !== "activity" &&
  !task.externalReadOnly &&
  !task.calendarConflict &&
  (task.calendarLink?.source !== "google" ||
    task.calendarLink.managed === true) &&
  task.calendarLink?.managed !== false &&
  !task.calendarLink?.remoteDeleted;
const signature = (entry, zone) =>
  localCalendarSignature(entry.task, entry.date, zone);

const receiptProof = (entry, zone) => JSON.stringify([
  entry.syncJobId, keyOf(entry.task), entry.task.id, signature(entry, entry.task.timeZone || zone),
  entry.task.calendarLink || null,
]);
const jobScope = id => /^sync-(.+)-\d+$/.exec(id)?.[1] || null;

// Job IDs are receipt identities. Reject duplicates rather than renumbering
// pending jobs, and return the lowest sequence that cannot recycle a retained
// allocator-shaped ID.
function sequenceFloor(jobs) {
  const pattern = /^sync-.+-(\d+)$/;
  const seen = new Set();
  return jobs.reduce((next, job) => {
    if (job.id) {
      if (seen.has(job.id)) throw new Error("Duplicate sync job ID");
      seen.add(job.id);
    }
    const sequence = Number(pattern.exec(job.id)?.[1]);
    return Number.isSafeInteger(sequence) ? Math.max(next, sequence + 1) : next;
  }, 1);
}

/** Mutates only the supplied draft. Protected jobs do not consume history slots. */
export function pruneSyncHistory(branch) {
  const queue = branch.calendar?.syncQueue;
  if (!Array.isArray(queue?.jobs)) return branch;
  // Establish the counter floor before pruning can shorten the queue.
  const floor = sequenceFloor(queue.jobs);
  if (!Number.isSafeInteger(queue.nextId) || queue.nextId < floor)
    throw new Error("Sync queue ID counter would reuse an existing job ID");
  const now = Date.now();
  for (const job of queue.jobs) for (const item of job.items || []) {
    if (!item.awaitingReceipt) continue;
    if (!Number.isSafeInteger(item.receiptPendingUntil) || item.receiptPendingUntil > now + RECEIPT_RETENTION_MS) {
      // A missing, malformed or future timestamp is not a dispatch lease.
      // Never create a fresh grace on load: the same raw bytes may load again.
      item.receiptPendingUntil = 0;
    }
    if (["success", "superseded"].includes(item.status) && item.receiptPendingUntil <= now) {
      delete item.awaitingReceipt;
      delete item.receiptPendingUntil;
    }
  }
  const live = new Set(allEntries(branch.days).map(({ task }) => keyOf(task)));
  const protectedIds = new Set(Object.values(branch.calendar.syncDisplayRefs || {})
    .map(ref => ref?.syncJobId).filter(Boolean));
  // Keep the latest item used by presentation, including legacy references.
  const latest = new Map();
  for (const job of queue.jobs)
    for (const item of job.items || [])
      if (live.has(item.uid)) latest.set(item.uid, job.id);
  for (const id of latest.values()) protectedIds.add(id);
  let remaining = TERMINAL_HISTORY_LIMIT;
  queue.jobs = queue.jobs.slice().reverse().filter(job => {
    const terminal = ["success", "superseded"].includes(job.status) &&
      (job.items || []).every(item => ["success", "superseded"].includes(item.status) && !item.awaitingReceipt);
    return !terminal || protectedIds.has(job.id) || remaining-- > 0;
  }).reverse();
  return branch;
}

function queueOf(branch) {
  branch.calendar ||= {};
  branch.calendar.syncQueue ||= { jobs: [], nextId: 1 };
  branch.calendar.syncQueue.jobs ||= [];
  return branch.calendar.syncQueue;
}

function summarize(job) {
  const relevant = job.items.filter((item) => item.status !== "superseded");
  if (!relevant.length || relevant.every((item) => item.status === "success"))
    return "success";
  if (relevant.some((item) => item.status === "syncing")) return "syncing";
  if (relevant.some((item) => item.status === "success")) return "partial";
  if (relevant.every((item) => item.status === "blocked")) return "blocked";
  if (
    relevant.some(
      (item) => item.status === "failed" || item.status === "blocked",
    )
  )
    return "partial";
  return "queued";
}

function desiredItems(queue) {
  const result = new Map();
  for (const job of queue?.jobs || []) {
    for (const item of job.items) {
      if (activeStatuses.has(item.status)) result.set(item.uid, { job, item });
    }
  }
  return result;
}

const ownedForResume = task => !task.calendarSource ||
  task.calendarSource.accessRole === "owner" && (task.calendarSource.organizer?.self === true ||
    !task.calendarSource.organizer && task.calendarSource.creator?.self === true);

/** Reviewable data only. Turning a preference on never authorizes a blind scan
 * of all historical local tasks. The remote baseline is never changed here. */
export function syncResumeProposal(branch, options = {}) {
  const zone = branch.settings?.timeZone || "America/Los_Angeles";
  const targetCalendarId = options.targetCalendarId || branch.calendar?.targetCalendarId || null;
  const active = desiredItems(branch.calendar?.syncQueue), items = [], blocked = [], scope = [];
  for (const entry of allEntries(branch.days)) {
    const task = entry.task, uid = keyOf(task), link = task.calendarLink;
    const ref = branch.calendar?.syncDisplayRefs?.[uid], pending = active.get(uid);
    const desired = signature(entry, zone), baseline = link?.localFingerprint || null;
    const managed = ["google", "app"].includes(link?.source) && link.managed === true && !!link.eventId;
    const newLocal = !link?.eventId && !task.calendarSource && ref?.intentId && !ref.eventId;
    if (!managed && !newLocal && !pending) continue;
    const calendarId = link?.calendarId || targetCalendarId;
    const allowed = eligible(task) && ownedForResume(task) && (managed || newLocal);
    const item = { uid, id: task.id, title: task.title, date: entry.date, start: task.start, duration: task.duration,
      calendarId, eventId: link?.eventId || null, signature: desired, baseline, intentId: ref?.intentId || null };
    const reusable = pending && pending.item.signature === desired && pending.item.calendarId === calendarId &&
      ref?.syncJobId === pending.job.id && ref?.eventId === item.eventId;
    scope.push({ ...item, allowed, managed, remoteDeleted: !!link?.remoteDeleted,
      pending: pending && [pending.job.id, pending.item.signature, pending.item.status], refJob: ref?.syncJobId || null });
    if (!allowed) {
      if (managed && (desired !== baseline || pending)) blocked.push({ ...item, reason: "This item is fixed, completed, read-only, or has a remote conflict. It stays unchanged; check its purpose and management permission first." });
      continue;
    }
    if (managed && !baseline) { blocked.push({ ...item, reason: "The original Calendar baseline cannot be verified. Read and check this item first." }); continue; }
    if (desired === baseline) continue;
    if (!calendarId) { blocked.push({ ...item, reason: "No writable target calendar is selected." }); continue; }
    items.push({ ...item, reuseJobId: reusable ? pending.job.id : null });
  }
  return { targetCalendarId, items, blocked,
    fingerprint: JSON.stringify({ zone, autoSync: !!branch.calendar?.autoSync,
      preferenceEpoch: branch.calendar?.syncPreferenceEpoch || 0, selectedTarget: branch.calendar?.targetCalendarId || null, targetCalendarId, scope }) };
}

/** One explicit confirmation collects only the latest reviewed differences.
 * The existing executor still owns fresh reads, preview validity and receipts. */
export function resumeSync(branch, proposal, options = {}) {
  const current = syncResumeProposal(branch, { targetCalendarId: proposal?.targetCalendarId });
  if (!proposal || branch.calendar?.autoSync || proposal.fingerprint !== current.fingerprint)
    return { status: "stale", data: branch };
  let data = clone(branch);
  const queue = queueOf(data), reviewed = new Map(current.items.map(item => [item.uid, item]));
  for (const job of queue.jobs) {
    for (const item of job.items) {
      if (activeStatuses.has(item.status) && reviewed.get(item.uid)?.reuseJobId !== job.id) {
        if (item.status === "syncing") item.awaitingReceipt = true;
        item.status = "superseded";
        item.message = "Sync was re-enabled using the latest confirmed local intent. Older pending items are no longer valid.";
      }
    }
    job.status = summarize(job);
  }
  data.calendar.autoSync = true;
  data.calendar.syncPreferenceEpoch = (data.calendar.syncPreferenceEpoch || 0) + 1;
  if (current.targetCalendarId) data.calendar.targetCalendarId = current.targetCalendarId;
  const fresh = new Set(current.items.filter(item => !item.reuseJobId).map(item => item.uid));
  const beforeDays = Object.fromEntries(Object.entries(data.days).map(([date, tasks]) =>
    [date, tasks.filter(task => !fresh.has(keyOf(task)))]));
  data = enqueueChanges(data, beforeDays, data.days, options);
  return { status: "ok", data };
}

/** One local confirmation is one persistent batch, never an export checklist. */
export function enqueueChanges(branch, beforeDays, afterDays, options = {}) {
  const data = clone(branch);
  const enabled = options.autoSync ?? data.calendar?.autoSync ?? false;
  data.calendar ||= {};
  if (typeof options.autoSync === "boolean")
    data.calendar.autoSync = options.autoSync;
  if (!enabled) return rememberSyncPresentation(data, beforeDays, afterDays, false);
  const queue = queueOf(data);
  const zone = data.settings?.timeZone || "America/Los_Angeles";
  const before = new Map(
    allEntries(beforeDays).map((entry) => [keyOf(entry.task), entry]),
  );
  const after = new Map(
    allEntries(afterDays).map((entry) => [keyOf(entry.task), entry]),
  );
  const currentDesired = desiredItems(queue);
  // A deleted, deferred, newly completed, read-only or locked task is never sent to Google.
  for (const [uid, { job, item }] of currentDesired) {
    if (!after.has(uid) || !eligible(after.get(uid).task)) {
      if (item.status === "syncing") item.awaitingReceipt = true;
      item.status = "superseded";
      item.message = "This local task no longer needs syncing. The Google event will not be deleted.";
      job.status = summarize(job);
    }
  }
  const items = [];
  for (const [uid, entry] of after) {
    if (!eligible(entry.task)) continue;
    const desired = signature(entry, zone),
      old = before.get(uid);
    if (old && signature(old, zone) === desired) continue; // Done/notes/dependency-only edits are not event writes.
    const pending = currentDesired.get(uid);
    if (
      pending &&
      pending.item.signature === desired &&
      activeStatuses.has(pending.item.status)
    )
      continue;
    for (const job of queue.jobs) {
      for (const item of job.items) {
        if (item.uid === uid && activeStatuses.has(item.status)) {
          if (item.status === "syncing") item.awaitingReceipt = true;
          item.status = "superseded";
          item.message = "A newer local adjustment replaced this pending sync.";
        }
      }
      job.status = summarize(job);
    }
    const calendarId =
      entry.task.calendarLink?.calendarId ||
      options.targetCalendarId ||
      data.calendar.targetCalendarId;
    items.push({
      uid,
      id: entry.task.id,
      signature: desired,
      date: entry.date,
      calendarId: calendarId || null,
      status: calendarId ? "queued" : "blocked",
      message: calendarId ? "Waiting to sync" : "Select a target Google calendar first.",
    });
  }
  if (items.length) {
    // Reject reuse or exhaustion before allocating; data is still a private clone.
    if (!Number.isSafeInteger(queue.nextId + 1)) throw new Error("Sync queue ID counter exhausted");
    if (queue.nextId < sequenceFloor(queue.jobs))
      throw new Error("Sync queue ID counter would reuse an existing job ID");
    const sequence = queue.nextId++;
    queue.jobs.push({
      id: `sync-${options.profileId || "local"}-${sequence}`,
      createdAt: options.createdAt || new Date().toISOString(),
      status: "queued",
      items,
    });
    queue.jobs.at(-1).status = summarize(queue.jobs.at(-1));
  }
  return rememberSyncPresentation(data, beforeDays, afterDays, true);
}

// Display provenance only: never permission, executor validity, or a Google payload.
function displayIdentity(entry, branch, item = null) {
  return {
    calendarId: entry.task.calendarLink?.calendarId || item?.calendarId || branch.calendar?.targetCalendarId || null,
    eventId: entry.task.calendarLink?.eventId || null,
  };
}
function latestSyncItems(branch) {
  const latest = new Map();
  for (const job of branch.calendar?.syncQueue?.jobs || [])
    for (const item of job.items || []) latest.set(item.uid, { job, item });
  return latest;
}
function rememberSyncPresentation(data, beforeDays, afterDays, enabled) {
  const zone = data.settings?.timeZone || "America/Los_Angeles";
  const before = new Map(allEntries(beforeDays).map(e => [keyOf(e.task), e]));
  const after = new Map(allEntries(afterDays).map(e => [keyOf(e.task), e]));
  const refs = data.calendar.syncDisplayRefs ||= {};
  const latest = latestSyncItems(data);
  for (const uid of Object.keys(refs)) if (!after.has(uid)) delete refs[uid];
  for (const [uid, entry] of after) {
    const desired = signature(entry, zone), old = before.get(uid);
    if (old && signature(old, zone) === desired &&
        JSON.stringify(displayIdentity(old, data)) === JSON.stringify(displayIdentity(entry, data))) continue;
    const match = enabled && eligible(entry.task) ? latest.get(uid) : null;
    const belongs = match?.item.signature === desired && activeStatuses.has(match.item.status);
    data.calendar.nextSyncDisplayId = (data.calendar.nextSyncDisplayId || 0) + 1;
    refs[uid] = { uid, signature: desired, intentId: data.calendar.nextSyncDisplayId,
      ...displayIdentity(entry, data, belongs ? match.item : null), syncJobId: belongs ? match.job.id : null };
  }
  return pruneSyncHistory(data);
}
/** Plain references captured in a saved result; safe to clone and freeze. */
export function syncPresentationRefs(branch, ids = null) {
  const zone = branch.settings?.timeZone || "America/Los_Angeles";
  const latest = latestSyncItems(branch);
  return allEntries(branch.days).filter(e => !ids || ids.includes(e.task.id) || ids.includes(keyOf(e.task))).map(e => {
    const uid = keyOf(e.task), desired = signature(e, zone), stored = branch.calendar?.syncDisplayRefs?.[uid];
    if (stored?.signature === desired) return clone(stored);
    const match = latest.get(uid);
    const pending = match?.item.signature === desired && activeStatuses.has(match.item.status);
    // Legacy pending intent is visible; historical success without provenance
    // cannot be attributed to this local operation.
    return { uid, signature: desired, ...displayIdentity(e, branch, pending ? match.item : null),
      syncJobId: pending ? match.job.id : null };
  });
}
/** Same current-state source for home, Calendar and immutable result records. */
export function syncPresentation(branch, { writesEnabled = false, ids = null, refs = null } = {}) {
  const latest = latestSyncItems(branch);
  const desired = refs || syncPresentationRefs(branch, ids).filter(ref => ids || ref.intentId || ref.syncJobId);
  const live = new Map(allEntries(branch.days).map(e => [keyOf(e.task), e]));
  const states = desired.map(ref => {
    const match = latest.get(ref.uid), entry = live.get(ref.uid);
    const currentIntent = branch.calendar?.syncDisplayRefs?.[ref.uid];
    if (!entry || signature(entry, branch.settings?.timeZone || "America/Los_Angeles") !== ref.signature ||
        (ref.intentId && currentIntent?.intentId !== ref.intentId)) return "superseded";
    const identity = displayIdentity(entry, branch, match?.item);
    // A create may acquire its first mapping from this exact job's receipt.
    // No other event replacement may borrow that receipt.
    const createdIdentity = !ref.eventId && match?.job.id === ref.syncJobId && match.item.receipt;
    const expectedEvent = ref.eventId || createdIdentity?.eventId || null;
    const expectedCalendar = createdIdentity?.calendarId || ref.calendarId;
    if (identity.eventId !== expectedEvent || identity.calendarId !== expectedCalendar) return "superseded";
    if (!ref.syncJobId) return "local";
    if (match?.job.id !== ref.syncJobId || match.item.signature !== ref.signature) return "superseded";
    return match.item.status;
  });
  const queueState = states.includes("syncing") ? "syncing"
    : states.some(s => ["failed", "blocked"].includes(s)) ? "partial"
    : states.includes("queued") ? "queued"
    : states.includes("superseded") ? "superseded"
    : states.length && states.every(s => s === "success") ? "success" : "local";
  const label = { syncing: "Syncing", partial: "Some items failed or need attention", queued: "Queued for sync", superseded: "A later adjustment replaced this one", success: "Sync succeeded", local: "Saved locally; sync result not verified" }[queueState];
  const pending = ["syncing", "partial", "queued"].includes(queueState);
  const reason = pending ? desired.map(ref => latest.get(ref.uid)).find(m => m && ["failed", "blocked"].includes(m.item.status))?.item.message || "" : "";
  return { state: writesEnabled ? queueState : "write_disabled", queueState,
    text: `Saved locally · ${label}${reason ? ": " + reason : ""}${!branch.calendar?.autoSync && pending ? " · Auto-sync is off" : ""}${writesEnabled ? "" : " · Google writes are off"}` };
}

/** Reads the latest desired payloads. A persisted 'syncing' batch resumes safely after reload. */
export function pendingTasks(branch) {
  if (!branch.calendar?.autoSync) return [];
  const entries = new Map(
    allEntries(branch.days).map((entry) => [keyOf(entry.task), entry]),
  );
  const zone = branch.settings?.timeZone || "America/Los_Angeles";
  const results = [];
  for (const [uid, { job, item }] of desiredItems(branch.calendar.syncQueue)) {
    const entry = entries.get(uid);
    if (
      !entry ||
      !eligible(entry.task) ||
      signature(entry, zone) !== item.signature
    )
      continue;
    const calendarId =
      entry.task.calendarLink?.calendarId ||
      item.calendarId ||
      branch.calendar.targetCalendarId;
    if (!calendarId) continue;
    const task = clone(entry.task);
    task.timeZone = zone;
    // This identity belongs to the internal request snapshot, never the task
    // or Google payload. Equal content after an ABA edit is still a new intent.
    results.push({ date: entry.date, task, syncJobId: job.id });
  }
  return results;
}

/** Optional state transition before network I/O; never performs I/O itself. */
export function markSyncing(branch, snapshot = pendingTasks(branch)) {
  const data = clone(branch),
    queue = queueOf(data);
  const zone = data.settings?.timeZone || "America/Los_Angeles";
  const entries = Array.isArray(snapshot) ? snapshot : snapshot.tasks || [];
  const requests = new Map(
    entries.map((entry) => [
      keyOf(entry.task),
      { entry, syncJobId: entry.syncJobId, signature: signature(entry, entry.task.timeZone || zone) },
    ]),
  );
  // A queue-instance identity survives normal saves, while another branch with
  // coincidentally equal job IDs/UIDs cannot use this runtime receipt proof.
  if (!/^[a-f0-9-]{36}$/.test(queue.receiptScopeId || ""))
    queue.receiptScopeId = crypto.randomUUID();
  const current = new Map(allEntries(data.days).map(entry => [keyOf(entry.task), entry]));
  const proofs = new Map();
  for (const job of queue.jobs) {
    for (const item of job.items) {
      if (
        activeStatuses.has(item.status) &&
        requests.get(item.uid)?.syncJobId &&
        requests.get(item.uid).syncJobId === job.id &&
        requests.get(item.uid).signature === item.signature
      ) {
        item.status = "syncing";
        item.awaitingReceipt = true;
        item.receiptPendingUntil = Date.now() + RECEIPT_RETENTION_MS;
        item.message = "Syncing";
        const request = requests.get(item.uid).entry, live = current.get(item.uid);
        if (live && receiptProof(request, zone) === receiptProof({ ...live, syncJobId: job.id }, zone))
          proofs.set(item.uid, { proof: receiptProof(request, zone), scope: jobScope(job.id), queueScope: queue.receiptScopeId,
            calendarId: request.task.calendarLink?.calendarId || item.calendarId || data.calendar.targetCalendarId });
      }
    }
    job.status = summarize(job);
  }
  receiptSnapshots.set(snapshot, proofs);
  return pruneSyncHistory(data);
}

/** Partial successes are durable. A late response never overwrites a newer local edit. */
export function settleSync(branch, result, snapshot = []) {
  const data = clone(branch),
    queue = queueOf(data);
  const zone = data.settings?.timeZone || "America/Los_Angeles";
  const current = new Map(
    allEntries(data.days).map((entry) => [keyOf(entry.task), entry]),
  );
  const requests = new Map(
    (Array.isArray(snapshot) ? snapshot : snapshot.tasks || []).map((entry) => [
      keyOf(entry.task),
      { ...entry, signature: signature(entry, entry.task.timeZone || zone) },
    ]),
  );
  const results = new Map(
    (result?.results || []).map((item) => [item.uid || item.id, item]),
  );
  const runtimeProofs = receiptSnapshots.get(snapshot);
  const latestDesired = desiredItems(queue);
  for (const [uid, request] of requests) {
    const foundResponse = results.get(uid) || results.get(request.task.id);
    const response =
      foundResponse && (!foundResponse.uid || foundResponse.uid === uid)
        ? foundResponse
        : null;
    const matched = [];
    for (const job of queue.jobs) {
      for (const item of job.items) {
        if (
          item.uid === uid &&
          request.syncJobId &&
          job.id === request.syncJobId &&
          item.signature === request.signature &&
          item.status !== "success"
        )
          matched.push({ job, item });
      }
    }
    const success =
      response?.ok === true ||
      ["success", "created", "updated", "skipped"].includes(response?.status);
    const active = current.get(uid), proof = runtimeProofs?.get(uid), newer = latestDesired.get(uid);
    const ownPrunedReceipt = !matched.length && success && response?.calendarLink && proof?.scope &&
      proof.queueScope === queue.receiptScopeId && proof.proof === receiptProof(request, zone) && newer && newer.job.id !== request.syncJobId &&
      jobScope(newer.job.id) === proof.scope && newer.item.calendarId === proof.calendarId &&
      response.calendarLink.calendarId === proof.calendarId && active && eligible(active.task) &&
      signature(active, zone) === newer.item.signature;
    if (!matched.length && !ownPrunedReceipt) continue;
    for (const { item } of matched) { delete item.awaitingReceipt; delete item.receiptPendingUntil; }
    const currentSame = active && signature(active, zone) === request.signature;
    if (success && response.calendarLink) {
      const matchesReceipt = (link) =>
        link?.eventId &&
        link.calendarId === response.calendarLink.calendarId &&
        link.eventId === response.calendarLink.eventId;
      const sameMappedEvent =
        matchesReceipt(request.task.calendarLink) &&
        matchesReceipt(active?.task.calendarLink) &&
        active.task.calendarLink.managed !== false;
      const ownLocalCreate =
        !request.task.calendarLink &&
        !active?.task.calendarLink &&
        eligible(active?.task);
      if (
        active &&
        !active.task.calendarConflict &&
        (sameMappedEvent || ownLocalCreate)
      ) {
        // A newer confirmed local position stays untouched. Acknowledge only
        // the actual old write's remote baseline for the same original event,
        // so the mandatory fresh read won't mistake our write for an external
        // concurrent edit. The same holds for our first create while the
        // active task still has no mapping. Never transfer a receipt across
        // event identities or restore revoked local management eligibility.
        active.task.calendarLink = {
          ...active.task.calendarLink,
          ...clone(response.calendarLink),
          ...(active.task.calendarLink?.source === "google"
            ? { source: "google", managed: true }
            : {}),
          ...(response.calendarLink.etag
            ? { adoptedEtag: response.calendarLink.etag }
            : {}),
          localFingerprint: request.signature,
        };
        delete active.task.calendarConflict;
      }
      for (const { item } of matched) {
        item.status = "success";
        item.message = currentSame
          ? "Sync succeeded"
          : "The older version synced. The newer local arrangement remains queued.";
        item.receipt = clone(response.calendarLink);
      }
    } else {
      const blocked =
        result?.blocked ||
        result?.state === "write_disabled" ||
        response?.blocked ||
        response?.status === "blocked";
      for (const { item } of matched) {
        if (item.status === "superseded") continue; // A failed old request must not reactivate an obsolete desired state.
        item.status = blocked ? "blocked" : "failed";
        item.message =
          response?.message ||
          result?.error ||
          result?.message ||
          "Sync did not complete. Try again.";
      }
    }
  }
  for (const job of queue.jobs) job.status = summarize(job);
  receiptSnapshots.delete(snapshot);
  return pruneSyncHistory(data);
}

export function retrySync(branch) {
  const data = clone(branch);
  if (!data.calendar?.autoSync) return data;
  const queue = queueOf(data),
    desired = desiredItems(queue);
  for (const { item } of desired.values()) {
    if (["failed", "blocked", "syncing"].includes(item.status)) {
      item.status = "queued";
      item.message = "Waiting to retry";
    }
  }
  for (const job of queue.jobs) job.status = summarize(job);
  return pruneSyncHistory(data);
}
