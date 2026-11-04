import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mergeCalendar, classifyCalendar, calendarKey, calendarRuleMatches, canManageCalendarSource, localCalendarSignature } from '../calendar-data.js';
import { interpretCalendar, applySemanticDecision } from '../calendar-semantics.js';
import { defaults } from '../storage.js';
import { learningTask } from '../learning.js';
import { pendingTasks, syncResumeProposal, enqueueChanges } from '../sync-queue.js';

const day = '2026-10-12', zone = 'America/Los_Angeles';
const event = (extra = {}) => ({ calendarId: 'synthetic@example.test', eventId: 'synthetic-event', summary: 'SQL practice',
  accessRole: 'owner', organizer: { self: true }, canManage: true, calendarTimeZone: zone, etag: '"v1"',
  start: { dateTime: day + 'T11:00:00-07:00' }, end: { dateTime: day + 'T12:00:00-07:00' },
  managed: true, managedUid: 'synthetic-uid', managedProfileId: 'synthetic-profile', ...extra });
const rule = (extra = {}) => ({ calendarId: 'synthetic@example.test', match: 'calendar', kind: 'learning', planId: 'job-prepare', ...extra });
const item = data => Object.values(data.days).flat()[0];
const fixture = () => mergeCalendar({ days: {}, settings: defaults() }, { events: [event()] }, { profileId: 'synthetic-profile' }).data;
function readonly(data) {
  assert.equal(item(data).calendarClassification.manage, false);
  assert.equal(item(data).calendarLink.managed, false);
  assert.equal(item(data).externalReadOnly, true);
  assert.equal(item(data).locked, true);
  assert.equal(syncResumeProposal(data).items.length, 0);
  assert.equal(pendingTasks(data).length, 0);
}

test('An explicit manage:false revokes existing management for each classification, even with a verified reference', () => {
  for (const kind of ['learning', 'task', 'fixed']) {
    const source = fixture(), before = structuredClone(source), key = calendarKey(item(source));
    const data = classifyCalendar(source, { rules: [rule({ kind, manage: false })], managedRefs: new Set([key]) }).data;
    readonly(data); assert.deepEqual(source, before);
  }
});

test('An explicit manage:false survives every read path despite a server-verified managed mapping', () => {
  for (const variant of ['same', 'pending', 'both-changed', 'unverified', 'cancelled', 'invalid', 'absent']) {
    let data = fixture();
    if (['pending', 'both-changed', 'unverified'].includes(variant)) item(data).start = 800;
    if (variant === 'unverified') {
      delete item(data).calendarLink.localFingerprint;
      item(data).calendarLink.signature = 'synthetic-old-signature';
      delete item(data).calendarSource.start;
    }
    data = classifyCalendar(data, { rules: [rule({ manage: false })] }).data;
    const incoming = variant === 'both-changed' || variant === 'unverified' ? event({ etag: '"v2"', summary: 'Changed SQL practice' })
      : variant === 'cancelled' ? event({ status: 'cancelled' })
      : variant === 'invalid' ? event({ start: { dateTime: 'invalid' } }) : event();
    const read = mergeCalendar(data, { events: variant === 'absent' ? [] : [incoming] }, { profileId: 'synthetic-profile' });
    readonly(read.data);
    if (['pending', 'both-changed', 'unverified'].includes(variant)) assert.equal(item(read.data).start, 800, variant);
    readonly(mergeCalendar(read.data, { events: [event()] }, { profileId: 'synthetic-profile' }).data);
  }
});

test('A stored manage:false rule protects historical classifications before pending or absent reads', () => {
  for (const events of [[], [event()]]) {
    const data = fixture(); item(data).start = 800;
    data.calendar ||= {}; data.calendar.classificationRules = [rule({ manage: false })];
    delete item(data).calendarClassification.manage;
    readonly(mergeCalendar(data, { events }, { profileId: 'synthetic-profile' }).data);
  }
});

test('Semantic purpose rebuilding and an omitted manage flag preserve an explicit manage:false', () => {
  let data = classifyCalendar(fixture(), { rules: [rule({ manage: false })] }).data;
  for (const purpose of ['life', 'external', 'learning']) {
    data = applySemanticDecision(data, item(data).id, purpose).data;
    readonly(data);
  }
  data = classifyCalendar(data, { rules: [rule()] }).data;
  readonly(data);
});

test('An explicit manage:true can replace false but needs adoption and an eligible source, and omitting the flag stays compatible with legacy data', () => {
  const source = fixture(), key = calendarKey(item(source));
  assert.equal(classifyCalendar(source, { rules: [rule()] }).data.days[day][0].calendarLink.managed, true);
  const veto = classifyCalendar(source, { rules: [rule({ manage: false })] }).data;
  const requested = classifyCalendar(veto, { rules: [rule({ manage: true })] }).data;
  assert.equal(item(requested).calendarClassification.manage, true);
  assert.equal(item(requested).calendarLink.managed, false);
  assert.equal(item(requested).externalReadOnly, true);
  const adopted = classifyCalendar(requested, { managedRefs: new Set([key]) }).data;
  assert.equal(item(adopted).calendarLink.managed, true); assert.equal(item(adopted).externalReadOnly, false);
  const denied = structuredClone(requested); item(denied).calendarSource.canManage = false;
  assert.equal(item(classifyCalendar(denied, { managedRefs: new Set([key]) }).data).calendarLink.managed, false);
  const locked = structuredClone(veto); item(locked).lockSource = 'user';
  assert.equal(item(classifyCalendar(locked, { rules: [rule({ manage: true })], managedRefs: new Set([key]) }).data).locked, true);
});

// Slices of the real app.js handlers run against a synthetic context.
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const extract = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
function appRig(branch) {
  const calls = [], ctx = vm.createContext({ state: { personal: branch, profileId: 'synthetic-profile', revision: 1 }, date: day,
    structuredClone, learningTask, classifyCalendar, interpretCalendar, canManageCalendarSource, localCalendarSignature,
    ruleMatches: calendarRuleMatches, all: days => Object.entries(days).flatMap(([date, tasks]) => tasks.map(task => ({ date, task }))),
    calendarRequest: async (route, payload) => { calls.push({ route, payload }); return { results: payload.tasks.map(t => ({ uid: t.uid, ok: true, calendarLink: { ...t.calendarLink, managed: true } })) }; },
    notice() {}, save(fn) { fn(ctx.state); return true; },
  });
  vm.runInContext(extract('async function acceptManaged(', 'async function readCalendar(') + '\n' + extract('async function adoptLearning(', 'async function saveWorkbenchTask('), ctx);
  return { ctx, calls };
}

test('The automatic-adoption handler cannot use a remembered semantic-plan permission to override manage:false', async () => {
  const branch = classifyCalendar(fixture(), { rules: [rule({ manage: false })] }).data;
  branch.calendar.semanticManagedPlans = ['job-prepare'];
  const r = appRig(branch);
  const result = await r.ctx.acceptManaged(branch, branch.calendar.classificationRules);
  assert.equal(r.calls.length, 0); readonly(result.data);
  const allowed = classifyCalendar(result.data, { rules: [rule({ manage: true })] }).data;
  const next = await r.ctx.acceptManaged(allowed, allowed.calendar.classificationRules);
  assert.equal(r.calls.length, 1); assert.equal(item(next.data).calendarLink.managed, true);
});

test('The explicit plan-adoption handler excludes a vetoed sibling from the batch', async () => {
  const branch = classifyCalendar(fixture(), { selections: { [calendarKey(item(fixture()))]: rule({ manage: false }) } }).data;
  const other = structuredClone(item(branch)); other.id = 'other-id'; other.uid = 'other-uid'; other.calendarLink.eventId = 'other-event';
  delete other.calendarClassification.manage;
  branch.days[day].push(other);
  const r = appRig(branch); await r.ctx.adoptLearning('job-prepare');
  assert.deepEqual(Array.from(r.calls[0].payload.tasks, t => t.uid), ['other-uid']);
  readonly(r.ctx.state.personal);
  assert.equal(r.ctx.state.personal.days[day][1].calendarLink.managed, true);
});

test('Plan re-adoption preserves a user-locked sibling outside the reconnect read range', async () => {
  const siblingDay = '2026-10-13';
  const events = [event(), event({ eventId: 'sibling-event', managedUid: 'sibling-uid',
    start: { dateTime: siblingDay + 'T11:00:00-07:00' }, end: { dateTime: siblingDay + 'T12:00:00-07:00' } })];
  const initial = classifyCalendar(mergeCalendar({ days: {}, settings: defaults() }, { events }, { profileId: 'synthetic-profile' }).data,
    { rules: [rule({ planId: 'synthetic-plan' })] }).data;
  const sibling = initial.days[siblingDay][0];
  sibling.locked = true; sibling.lockSource = 'user';
  assert.equal(sibling.externalReadOnly, false);
  assert.equal(sibling.readonlyLock, undefined);
  // A bounded read after reconnect revokes only the event it returns; absence is neither deletion nor revocation.
  const reconnected = mergeCalendar(initial, { events: [{ ...events[0], managed: false }] }, { profileId: 'synthetic-profile' }).data;
  assert.equal(reconnected.days[day][0].calendarRestrictionLock, true);
  assert.deepEqual(reconnected.days[siblingDay][0], sibling);
  const r = appRig(reconnected);
  await r.ctx.adoptLearning('synthetic-plan');
  assert.deepEqual(Array.from(r.calls[0].payload.tasks, t => t.uid), ['synthetic-uid', 'sibling-uid']);
  const recovered = r.ctx.state.personal;
  assert.equal(recovered.days[siblingDay][0].locked, true, 'plan authorization must not unlock an independently locked sibling');
  assert.equal(recovered.days[siblingDay][0].lockSource, 'user');
  assert.equal(recovered.days[siblingDay][0].start, sibling.start);
  assert.equal(recovered.days[day][0].locked, false, 'management-loss-only lock should recover');
  assert.equal(recovered.days[day][0].externalReadOnly, false);
  assert.equal(recovered.days[day][0].calendarRestrictionLock, undefined);
});

test('Plan re-adoption reconciles restriction-only, user, explicit classification and observed pre-loss locks', async () => {
  for (const owner of ['restriction-only', 'user', 'classification', 'observed-before-loss']) {
    let branch = classifyCalendar(fixture(), { selections: {
      [calendarKey(item(fixture()))]: rule({ planId: 'synthetic-plan', ...(owner === 'classification' ? { locked: true } : {}) }),
    } }).data;
    if (owner === 'user') { item(branch).locked = true; item(branch).lockSource = 'user'; }
    if (owner === 'observed-before-loss') item(branch).locked = true;
    branch = mergeCalendar(branch, { events: [event({ managed: false })] }, { profileId: 'synthetic-profile' }).data;
    const before = structuredClone(branch), fingerprint = item(branch).calendarLink.localFingerprint;
    assert.equal(item(branch).calendarLink.managed, false);
    assert.equal(item(branch).locked, true);
    if (owner === 'observed-before-loss') assert.equal(item(branch).calendarLink.lockedBeforeManagementLoss, true);
    const r = appRig(branch);
    await r.ctx.adoptLearning('synthetic-plan');
    assert.deepEqual(branch, before, 'the original input must remain unchanged');
    const restored = item(r.ctx.state.personal);
    assert.equal(restored.calendarLink.managed, true, owner);
    assert.equal(restored.externalReadOnly, false, owner);
    assert.equal(restored.locked, owner !== 'restriction-only', owner);
    assert.equal(restored.calendarRestrictionLock, undefined, owner);
    assert.equal(restored.calendarLink.lockedBeforeManagementLoss, undefined, owner);
    assert.equal(restored.calendarLink.localFingerprint, fingerprint, owner);
    assert.equal(restored.start, item(before).start, owner);
    assert.equal(restored.lockSource, owner === 'user' ? 'user' : undefined, 'never guess the owner of a prior lock');
    assert.equal(restored.planId, item(before).planId, owner);
    assert.equal(restored.packageId, item(before).packageId, owner);
    const reread = mergeCalendar(r.ctx.state.personal, { events: [event()] }, { profileId: 'synthetic-profile' }).data;
    assert.equal(item(reread).locked, owner !== 'restriction-only', owner + ' after another verified read');
  }
});

test('The durable sync queue cannot expose a previously queued item after an explicit manage:false', () => {
  const original = fixture(), moved = structuredClone(original);
  item(moved).start = 800;
  const queued = enqueueChanges(moved, original.days, moved.days, { profileId: 'synthetic-profile', autoSync: true });
  assert.equal(pendingTasks(queued).length, 1);
  const data = classifyCalendar(queued, { rules: [rule({ manage: false })] }).data;
  readonly(data);
  assert.equal(data.calendar.syncQueue.jobs.length, 1, 'pending history retained');
});
