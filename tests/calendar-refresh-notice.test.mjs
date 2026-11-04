import { presentError } from '../ui-messages.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createWorkbench } from '../workbench.js';
import { WorkspaceStore, defaults } from '../storage.js';
import { mergeCalendar, classifyCalendar, canManageCalendarSource, localCalendarSignature } from '../calendar-data.js';
import { interpretCalendar } from '../calendar-semantics.js';
import { addDays, wallInstant } from '../time.js';
import { learningTask } from '../learning.js';

const day = '2026-10-12', zone = 'America/Los_Angeles';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const event = (extra = {}) => ({ calendarId: 'synthetic@example.test', id: 'synthetic-event', summary: 'Opaque practice',
  accessRole: 'owner', canManage: true, organizer: { self: true }, calendarTimeZone: zone,
  start: { dateTime: day + 'T11:00:00-07:00' }, end: { dateTime: day + 'T12:00:00-07:00' }, etag: '"v1"', ...extra });
function fixture(extra = {}) {
  const result = mergeCalendar({ days: {}, settings: defaults() }, { events: [event()] });
  const item = result.data.days[day][0];
  Object.assign(item, { locked: false, externalReadOnly: false, start: 800, ...extra });
  item.calendarLink.managed = true;
  item.calendarOccupation = { startInstant: wallInstant(day, 800, zone), endInstant: wallInstant(day, 860, zone) };
  return result.data;
}
// Runs the real readCalendar, acceptManaged and save handlers from app.js with the real workbench,
// merge, interpret and store code, against a synthetic DOM and synthetic Calendar responses (no network).
function rig(branch = fixture()) {
  const originalDocument = globalThis.document, nodes = new Map(), notices = [];
  let html = '', textWrites = 0, response = { events: [] }, beforeResponse, beforeAdopt;
  const node = id => ({ id, hidden: false, dataset: {}, text: '',
    focus() { document.activeElement = this; }, getClientRects() { return [{}]; },
    querySelector() { return node('span'); }, set innerHTML(value) { this.html = value; },
    get textContent() { return this.text; }, set textContent(value) { this.text = value; if (id === 'wb-refresh-notice') textWrites++; },
  });
  const root = { get innerHTML() { return html; }, set innerHTML(value) {
    html = value;
    for (const id of [...nodes.keys()]) if (!['workbench', 'wb-calendar', 'wb-calendar-label', 'wb-refresh-notice', 'wb-notice'].includes(id)) nodes.delete(id);
    for (const match of value.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], node(match[1]));
  }, querySelector(selector) { return selector === '[data-stage]' ? { dataset: { stage: html.match(/data-stage="([^"]+)/)?.[1] } }
      : selector === 'h1' || selector === '.photo-frame img' ? node(selector) : null; } };
  nodes.set('workbench', root);
  for (const id of ['wb-calendar', 'wb-calendar-label', 'wb-refresh-notice', 'wb-notice']) nodes.set(id, node(id));
  nodes.get('wb-refresh-notice').hidden = true;
  globalThis.document = { activeElement: null, getElementById: id => nodes.get(id) || null };
  const kv = new Map(), memory = { getItem: key => kv.get(key) ?? null, setItem: (key, value) => kv.set(key, value), removeItem: key => kv.delete(key) };
  const store = new WorkspaceStore(memory); store.load();
  store.save(s => { s.personal = structuredClone(branch); s.ui.mode = 'personal'; s.ui.selection = { mode: 'personal', id: Object.values(branch.days).flat()[0]?.id }; });
  let bench;
  const ctx = vm.createContext({ store, state: store.state, mode: 'personal', date: day, lastSaved: false, structuredClone, URLSearchParams, presentError,
    addDays, mergeCalendar, interpretCalendar, classifyCalendar, canManageCalendarSource, localCalendarSignature, learningTask,
    readingCalendar: false, calendarReadWaiters: [], calendarReadError: '', calendarStatus: { state: 'connected', writesEnabled: false },
    calendarRetryAttempts: 0, calendarRetryTimer: null, clearTimeout() {}, scheduleCalendarRetry() {}, today: () => day,
    notice(text, error) { notices.push({ text, error }); nodes.get('wb-notice').textContent = text; },
    render() { bench?.render(); }, renderCalendarState() { bench?.refreshStatus(); },
    all: days => Object.entries(days).flatMap(([date, tasks]) => tasks.map(task => ({ date, task }))),
    calendarRequest: async action => { if (action === 'adopt') return beforeAdopt ? beforeAdopt() : { results: [] }; if (beforeResponse) await beforeResponse(); return structuredClone(response); },
  });
  const movable = t => !t.done && !t.locked && !t.timeLocked && !t.externalReadOnly && !t.calendarConflict && !t.deferred && t.type !== 'activity';
  bench = createWorkbench({ context: () => ({ mode: ctx.mode, date: ctx.date, branch: ctx.state.personal, revision: ctx.state.revision,
      ui: ctx.state.ui, calendarStatus: ctx.calendarStatus, reading: ctx.readingCalendar, readError: ctx.calendarReadError,
      error: store.error, dayStartInstant: wallInstant(ctx.date, 0, zone), dayEndInstant: wallInstant(addDays(ctx.date, 1), 0, zone), proposalKey: JSON.stringify(ctx.state.personal.days) }),
    movable, clearNotice() {}, ambiguous: () => [], interpretation: () => null, syncSummary: () => '', refreshRead: () => ctx.readCalendar(day, { force: true }),
  });
  ctx.bench = bench;
  vm.runInContext(extract('function save(mutator,', 'function saveDays(') + '\n' + extract('async function refreshCalendar()', 'function scheduleCalendarRead(') + '\n' + extract('async function acceptManaged(', 'function scheduleCalendarRetry('), ctx);
  bench.render();
  return { bench, ctx, store, nodes, notices, get html() { return html; }, get writes() { return textWrites; },
    get text() { return nodes.get('wb-refresh-notice').hidden ? '' : nodes.get('wb-refresh-notice').textContent; },
    item: () => Object.values(ctx.state.personal.days).flat()[0],
    read(next, options = {}) { response = next; return ctx.readCalendar(day, { force: true, ...options }); },
    beforeResponse(fn) { beforeResponse = fn; }, beforeAdopt(fn) { beforeAdopt = fn; },
    click(id) { assert.equal(typeof nodes.get('wb-' + id)?.onclick, 'function', id); return nodes.get('wb-' + id).onclick(); },
    close() { globalThis.document = originalDocument; },
  };
}

test('A storage-save failure shows an honest label and offers a read retry that first rechecks the status', async () => {
  const r = rig(); try {
    let state = 'storage_error', statusChecks = 0, eventReads = 0;
    const request = r.ctx.calendarRequest;
    r.ctx.calendarRequest = async action => {
      if (action === 'status') {
        statusChecks++;
        return { state, storageRetryable: state === 'storage_error', writesEnabled: false, message: state === 'storage_error' ? 'The authorization update could not be saved yet. Check local storage and try again.' : 'Recovered' };
      }
      if (action.startsWith('events')) eventReads++;
      return request(action);
    };
    r.ctx.calendarStatus.state = state; r.ctx.calendarStatus.storageRetryable = true; r.bench.calendar();
    assert.match(r.html, /Authorization storage unavailable/);
    assert.match(r.html, /id="wb-refresh"[^>]*>Try reading again/);
    assert.doesNotMatch(r.html, /id="wb-connect"/);
    const blocked = await r.read({ events: [event()] });
    assert.equal(blocked.ok, false);
    assert.equal(statusChecks, 1);
    assert.equal(eventReads, 0, 'a failed save still prevents provider reads');
    assert.match(r.html, /The authorization update could not be saved yet/);
    state = 'connected';
    const recovered = await r.read({ events: [event()] });
    assert.equal(recovered.ok, true);
    assert.equal(statusChecks, 2);
    assert.equal(eventReads, 1);
    assert.equal(r.ctx.calendarStatus.state, 'connected');
    assert.doesNotMatch(r.html, /Authorization storage unavailable/);
  } finally { r.close(); }
});

test('A non-retryable storage-load failure does not offer the pending-save read retry', async () => {
  const r = rig(); try {
    r.ctx.calendarStatus = { state: 'storage_error', storageRetryable: false, message: 'Authorization storage could not be read. The original data was retained. Check that the server’s data folder is readable, restart Shunri, then reconnect.' };
    r.ctx.calendarRequest = async () => { throw new Error('unexpected Calendar request'); };
    r.bench.calendar();
    assert.match(r.html, /Authorization storage unavailable/);
    assert.match(r.html, /Authorization storage could not be read/);
    assert.doesNotMatch(r.html, /id="wb-refresh"/);
    assert.equal((await r.read({ events: [event()] })).ok, false);
  } finally { r.close(); }
});

test('A successful read withdraws and restores controls after the final save without changing the pending time', async () => {
  const r = rig(); try {
    assert.equal(r.nodes.has('wb-from-now'), true);
    r.nodes.get('wb-task-actions').focus();
    const result = await r.read({ events: [event({ canManage: false })] });
    assert.equal(result.ok, true); assert.equal(r.nodes.has('wb-from-now'), false);
    assert.match(r.text, /Opaque practice/); assert.match(r.text, /can no longer be moved by Shunri/);
    assert.equal(document.activeElement.id, 'wb-task-actions');
    assert.equal(r.item().start, 800); assert.equal(r.item().calendarLink.managed, false);
    const writes = r.writes, noticeNode = r.nodes.get('wb-refresh-notice');
    r.bench.refreshStatus(); await r.read({ events: [event({ canManage: false })] });
    assert.equal(r.writes, writes); assert.equal(r.nodes.get('wb-refresh-notice'), noticeNode);
    await r.read({ events: [event({ managed: true, managedUid: r.item().uid })] });
    assert.equal(r.nodes.has('wb-from-now'), true, JSON.stringify({item:r.item(),error:r.ctx.calendarReadError})); assert.match(r.text, /can now be adjusted in Shunri/);
    assert.equal(r.item().start, 800);
  } finally { r.close(); }
});

test('The Calendar-panel refresh notice survives returning home and stays separate from existing errors', async () => {
  const r = rig(); try {
    r.ctx.notice('Synthetic storage error must stay', true); r.bench.calendar();
    r.nodes.get('wb-refresh').focus();
    await r.read({ events: [event({ canManage: false })] });
    assert.equal(document.activeElement.id, 'wb-refresh'); assert.match(r.text, /can no longer be moved by Shunri/);
    const message = r.text, writes = r.writes;
    r.click('back'); r.bench.refreshStatus();
    assert.equal(r.text, message); assert.equal(r.writes, writes);
    assert.equal(r.nodes.get('wb-notice').textContent, 'Synthetic storage error must stay');
  } finally { r.close(); }
});

test('A first import and unchanged existing reads never invent an action transition', async () => {
  for (const branch of [{ days: {}, settings: defaults() }, fixture()]) {
    const r = rig(branch); try {
      await r.read({ events: [event()] }, { initial: true }); assert.equal(r.text, '');
      await r.read({ events: [event()] }); assert.equal(r.text, '');
    } finally { r.close(); }
  }
});

test('Reviving a cancellation-owned deferral describes visibility without claiming adjustment or Google writes', async () => {
  for (const locked of [false, true]) {
    const before = fixture(locked ? { locked: true, lockSource: 'user' } : {});
    const cancelled = mergeCalendar(before, { events: [event({ status: 'cancelled', start: undefined, end: undefined })] }).data;
    const r = rig(cancelled); try {
      assert.equal(r.item().calendarLink.deferredByCancellation, true);
      await r.read({ events: [event({ managed: true, managedUid: r.item().uid })] });
      assert.match(r.text, /Opaque practice.*is back on the schedule/);
      assert.doesNotMatch(r.text, /can now be adjusted in Shunri|synced|Google.*writ/i);
      assert.equal(r.item().deferred, false); assert.equal(r.nodes.has('wb-from-now'), !locked);
      const writes = r.writes; await r.read({ events: [event({ managed: true, managedUid: r.item().uid })] });
      assert.equal(r.writes, writes);
    } finally { r.close(); }
  }
});

test('A prior user deferral, a completed task, and a legacy cancellation without provenance do not claim revival', async () => {
  for (const extra of [{ deferred: true }, { done: true }, { deferred: true, legacy: true }]) {
    const before = fixture(extra);
    const cancelled = mergeCalendar(before, { events: [event({ status: 'cancelled', start: undefined, end: undefined })] }).data;
    if (extra.legacy) delete cancelled.days[day][0].calendarLink.deferredByCancellation;
    const r = rig(cancelled); try {
      await r.read({ events: [event({ managed: true, managedUid: r.item().uid })] });
      assert.equal(r.text, ''); assert.equal(r.nodes.has('wb-from-now'), false);
    } finally { r.close(); }
  }
});

test('Eligible metadata alone does not announce restored controls behind independent protections or missing management', async () => {
  for (const protection of [{ locked: true, lockSource: 'user' }, { timeLocked: true, locked: true },
    { type: 'activity', locked: true }, { done: true }, { deferred: true },
    { semanticPendingLock: { locked: false }, locked: true }, { semanticLock: true, locked: true }, { missingManagement: true }]) {
    const branch = mergeCalendar(fixture(protection), { events: [event({ canManage: false })] }).data;
    const r = rig(branch); try {
      await r.read({ events: [event(protection.missingManagement ? {} : { managed: true, managedUid: r.item().uid })] });
      assert.equal(r.text, '', JSON.stringify(protection)); assert.equal(r.nodes.has('wb-from-now'), false);
    } finally { r.close(); }
  }
});

test('Partial reads, response errors, adoption errors and remaining conflicts do not announce a completed recovery', async () => {
  for (const kind of ['partial', 'response-error', 'adoption-error', 'conflict']) {
    const branch = mergeCalendar(fixture(), { events: [event({ canManage: false })] }).data;
    const r = rig(branch); try {
      const response = { events: [event({ managed: true, managedUid: r.item().uid })] };
      if (kind === 'partial') response.partial = true;
      if (kind === 'response-error') response.errors = [{ message: 'synthetic failed calendar' }];
      // Inject a fault at the adoption boundary, after the real merge and interpretation.
      const adopt = r.ctx.acceptManaged;
      if (kind === 'adoption-error') r.ctx.acceptManaged = async (...args) => ({ ...await adopt(...args), failures: [{ message: 'synthetic adoption failure' }] });
      if (kind === 'conflict') r.ctx.acceptManaged = async (...args) => {
        const out = await adopt(...args); out.data.days[day][0].calendarConflict = { kind: 'both_changed', message: 'synthetic remaining conflict' }; return out;
      };
      await r.read(response); assert.equal(r.text, '', kind);
      if (kind === 'response-error' || kind === 'adoption-error') assert.match(r.ctx.calendarReadError, /synthetic/);
    } finally { r.close(); }
  }
});

test('A save failure or a stale revision preserves errors and never publishes unsaved controls', async () => {
  for (const kind of ['save', 'stale']) {
    const r = rig(); try {
      if (kind === 'save') r.store.save = () => ({ ok: false, message: 'synthetic storage failure' });
      else {
        const adopt = r.ctx.acceptManaged;
        r.ctx.acceptManaged = async (...args) => {
          const out = await adopt(...args); r.store.save(s => { s.personal.days[day][0].title = 'user changed locally'; });
          r.ctx.state = r.store.state; return out;
        };
      }
      const result = await r.read({ events: [event({ canManage: false })] });
      assert.equal(result.ok, false); assert.equal(r.text, ''); assert.match(r.ctx.calendarReadError, /local save failed/);
      assert.ok(r.notices.some(n => n.error)); assert.equal(r.item().externalReadOnly, false);
    } finally { r.close(); }
  }
});

test('A view change during the fetch rejects the old notice, and later navigation clears the retained text', async () => {
  const r = rig(); try {
    r.beforeResponse(() => { r.ctx.date = '2026-10-13'; r.bench.render(); });
    await r.read({ events: [event({ canManage: false })] });
    assert.equal(r.text, ''); r.beforeResponse(null);
    await r.read({ events: [event({ managed: true, managedUid: r.item().uid })] });
    assert.match(r.text, /can now be adjusted in Shunri/);
    r.ctx.date = day; r.bench.render(); assert.equal(r.text, '');
  } finally { r.close(); }
});

test('A local change during the fetch is the comparison baseline, not the stale pre-fetch controls', async () => {
  const r = rig(); try {
    r.beforeResponse(() => { r.store.save(s => { s.personal.days[day][0].locked = true; s.personal.days[day][0].lockSource = 'user'; }); r.ctx.state = r.store.state; r.bench.render(); });
    await r.read({ events: [event({ canManage: false })] });
    assert.equal(r.text, ''); assert.equal(r.item().lockSource, 'user');
  } finally { r.close(); }
});

test('The notice never exposes provider identifiers or unescaped task HTML', async () => {
  const branch = fixture(); branch.days[day][0].title = '<img src=x onerror=alert(1)>';
  const r = rig(branch); try {
    await r.read({ events: [event({ canManage: false })] });
    assert.match(r.text, /<img src=x onerror=alert\(1\)>/);
    assert.doesNotMatch(r.text, /synthetic@example|synthetic-event|gcal-/);
    assert.equal(r.nodes.get('wb-refresh-notice').html, undefined, 'notice uses textContent only');
  } finally { r.close(); }
});

test('An initial read with a trusted existing task can explain an actual transition', async () => {
  const r = rig(); try {
    await r.read({ events: [event({ canManage: false })] }, { initial: true });
    assert.match(r.text, /Opaque practice.*can no longer be moved by Shunri/);
  } finally { r.close(); }
});

test('A restored management-confirmation entry does not claim direct adjustment or Google synchronization', async () => {
  const branch = mergeCalendar(fixture(), { events: [event({ canManage: false })] }).data;
  Object.assign(branch.days[day][0], { tags: ['study'], learning: true });
  const r = rig(branch); try {
    await r.read({ events: [event()] });
    assert.equal(r.item().calendarLink.managed, false);
    assert.equal(r.item().externalReadOnly, true);
    assert.equal(r.nodes.has('wb-from-now'), true);
    assert.match(r.text, /can be adjusted again; choosing a time still requires management confirmation/);
    assert.doesNotMatch(r.text, /can now be adjusted in Shunri/);
    assert.doesNotMatch(r.text, /synced|directly|Google.*writ/i);
  } finally { r.close(); }
});

test('Active previews keep the stale protection and suppress unrelated refresh notices', async () => {
  const r = rig(); try {
    const proposal = { mode: 'personal', revision: r.ctx.state.revision, result: { status: 'ok', days: structuredClone(r.ctx.state.personal.days), changes: [] } };
    r.bench.preview(proposal);
    const before = document.activeElement;
    await r.read({ events: [event({ canManage: false })] });
    assert.equal(r.text, ''); assert.match(r.html, /The original schedule changed/);
    assert.equal(r.bench.lifecycle().kind, 'pending'); assert.equal(r.bench.lifecycle().stale, true);
    assert.ok(before, 'preview had its own focus');
  } finally { r.close(); }
});

function withOtherPendingTask(branch) {
  const otherEvent = event({ id: 'other-event', summary: 'Other pending item' });
  const data = mergeCalendar(branch, { events: [otherEvent] }).data;
  const other = data.days[day].find(t => t.calendarLink.eventId === 'other-event');
  Object.assign(other, { start: 900, locked: false, externalReadOnly: false });
  other.calendarLink.managed = true;
  other.calendarOccupation = { startInstant: wallInstant(day, 900, zone), endInstant: wallInstant(day, 960, zone) };
  return { data, otherEvent, other };
}

test('An unrelated out-of-range historical conflict does not hide the withdrawal or recovery of this task', async () => {
  const { data, other } = withOtherPendingTask(fixture());
  data.days[day] = data.days[day].filter(t => t.id !== other.id);
  data.days['2026-09-01'] = [other];
  Object.assign(other, { deferred: true, calendarConflict: { kind: 'remote_deleted', message: 'Historical conflict kept for review' } });
  other.calendarLink.remoteDeleted = true;
  const r = rig(data); try {
    r.ctx.notice('Earlier unresolved conflicts still need checking', true);
    await r.read({ events: [event({ canManage: false })], range: { from: '2026-10-09', to: '2026-10-26' } });
    assert.equal(r.nodes.has('wb-from-now'), false);
    assert.match(r.text, /Opaque practice.*can no longer be moved by Shunri/);
    await r.read({ events: [event({ managed: true, managedUid: r.item().uid })], range: { from: '2026-10-09', to: '2026-10-26' } });
    assert.equal(r.nodes.has('wb-from-now'), true);
    assert.match(r.text, /Opaque practice.*can now be adjusted in Shunri/);
    assert.equal(r.ctx.state.personal.days['2026-09-01'][0].calendarConflict.kind, 'remote_deleted');
    assert.equal(r.nodes.get('wb-notice').textContent, 'Earlier unresolved conflicts still need checking');
  } finally { r.close(); }
});

test('A new conflict on another task keeps its global error but does not hide the transition of this task', async () => {
  for (const restoring of [false, true]) {
    const branch = restoring ? mergeCalendar(fixture(), { events: [event({ canManage: false })] }).data : fixture();
    const { data, otherEvent, other } = withOtherPendingTask(branch);
    const r = rig(data); try {
      const originalStart = r.item().start;
      await r.read({ events: [event(restoring ? { managed: true, managedUid: r.item().uid } : { canManage: false }),
        { ...otherEvent, summary: 'Other task changed remotely', etag: '"other-v2"' }] });
      assert.equal(r.nodes.has('wb-from-now'), restoring);
      assert.match(r.text, restoring ? /Opaque practice.*can now be adjusted in Shunri/ : /Opaque practice.*can no longer be moved by Shunri/);
      assert.equal(r.item().start, originalStart);
      const conflicted = r.ctx.state.personal.days[day].find(t => t.id === other.id);
      assert.equal(conflicted.calendarConflict.kind, 'both_changed');
      assert.equal(conflicted.start, 900);
      assert.match(r.nodes.get('wb-notice').textContent, /1 conflicts/);
      assert.ok(r.notices.some(n => n.error && /conflicts/.test(n.text)));
    } finally { r.close(); }
  }
});

test('The own newly detected conflict of the task still suppresses its transition', async () => {
  const r = rig(); try {
    await r.read({ events: [event({ summary: 'Target changed remotely', etag: '"target-v2"' })] });
    assert.equal(r.item().calendarConflict.kind, 'both_changed');
    assert.equal(r.text, ''); assert.equal(r.nodes.has('wb-from-now'), false);
    assert.match(r.nodes.get('wb-notice').textContent, /1 conflicts/);
  } finally { r.close(); }
});

function sameTitleFixture(otherDay = day, otherStart = 900) {
  const otherEvent = event({ id: 'other-same-title', start: { dateTime: otherDay + 'T11:00:00-07:00' }, end: { dateTime: otherDay + 'T12:00:00-07:00' } });
  const branch = mergeCalendar(fixture(), { events: [otherEvent] }).data;
  const other = branch.days[otherDay].find(t => t.calendarLink.eventId === otherEvent.id);
  Object.assign(other, { start: otherStart, locked: false, externalReadOnly: false });
  other.calendarLink.managed = true;
  other.calendarOccupation = { startInstant: wallInstant(otherDay, otherStart, zone), endInstant: wallInstant(otherDay, otherStart + 60, zone) };
  return { branch, other, otherEvent };
}

test('The same-title fallback names the other saved arrangement without changing the current selection or controls', async () => {
  for (const [otherDay, otherStart, range] of [[day, 900, '2026-10-12 15:00–16:00'],
    ['2026-10-13', 800, '2026-10-13 13:20–14:20'], [day, 800, '2026-10-12 13:20–14:20']]) {
    const { branch, other, otherEvent } = sameTitleFixture(otherDay, otherStart), r = rig(branch);
    try {
      const selectedId = r.ctx.state.ui.selection.id, node = r.nodes.get('wb-refresh-notice');
      r.nodes.get('wb-task-actions').focus();
      await r.read({ events: [{ ...otherEvent, canManage: false }] });
      assert.equal(r.text, `After refreshing, another event with the same name, “Opaque practice” (${range}) can no longer be moved by Shunri.`);
      assert.equal(r.ctx.state.ui.selection.id, selectedId);
      assert.equal(r.nodes.has('wb-from-now'), true, 'current A remains adjustable');
      assert.equal(r.item().start, 800); assert.equal(r.item().locked, false);
      assert.equal(r.ctx.state.personal.days[otherDay].find(t => t.id === other.id).locked, true);
      assert.equal(document.activeElement.id, 'wb-task-actions');
      assert.doesNotMatch(r.text, /synthetic@example|other-same-title|gcal-|unique|read-only|confirm.*before scheduling/i);
      const writes = r.writes;
      await r.read({ events: [{ ...otherEvent, canManage: false }] });
      assert.equal(r.nodes.get('wb-refresh-notice'), node); assert.equal(r.writes, writes);
    } finally { r.close(); }
  }
});

test('The preferred current same-title task keeps priority when one or both tasks change', async () => {
  for (const both of [false, true]) {
    const { branch, otherEvent } = sameTitleFixture(), r = rig(branch);
    try {
      await r.read({ events: [event({ canManage: false }), ...(both ? [{ ...otherEvent, canManage: false }] : [])] });
      assert.equal(r.text, 'After refreshing, this event, “Opaque practice” (2026-10-12 13:20–14:20) can no longer be moved by Shunri.');
      assert.equal(r.nodes.has('wb-from-now'), false);
      assert.equal(r.ctx.state.ui.selection.id, r.item().id);
    } finally { r.close(); }
  }
});

test('Same-title context includes a current local task and does not reveal provider IDs', async () => {
  const { branch, otherEvent } = sameTitleFixture();
  const local = branch.days[day][0]; delete local.calendarLink; delete local.calendarSource;
  const r = rig(branch); try {
    await r.read({ events: [{ ...otherEvent, canManage: false }] });
    assert.match(r.text, /another event with the same name, “Opaque practice” \(2026-10-12 15:00–16:00\)/);
    assert.equal(r.nodes.has('wb-from-now'), true);
    assert.equal(r.ctx.state.ui.selection.id, local.id);
    assert.doesNotMatch(r.text, /synthetic@example|other-same-title|gcal-/);
  } finally { r.close(); }
});

test('Duplicates without a same-name current anchor are described as one item without pretending uniqueness', async () => {
  const { branch, other, otherEvent } = sameTitleFixture();
  branch.days[day][0].title = 'Different current title';
  const third = structuredClone(other); third.id = 'third-local'; third.uid = 'third-local'; delete third.calendarLink; delete third.calendarSource;
  branch.days[day].push(third);
  const r = rig(branch); try {
    await r.read({ events: [{ ...otherEvent, canManage: false }] });
    assert.match(r.text, /an event with the same name, “Opaque practice” \(2026-10-12 15:00–16:00\)/);
    assert.doesNotMatch(r.text, /another event|this event|unique/i);
    assert.equal(r.ctx.state.ui.selection.id, r.item().id);
  } finally { r.close(); }
});

test('A changed saved time or duplicate membership clears the old context without creating a transition', async () => {
  for (const change of ['time', 'peer-title', 'peer-removed', 'peer-added']) {
    const { branch, other, otherEvent } = sameTitleFixture(), r = rig(branch);
    try {
      await r.read({ events: [{ ...otherEvent, canManage: false }] });
      assert.match(r.text, /another event with the same name/);
      const saved = r.store.save(s => {
        const items = s.personal.days[day], target = items.find(t => t.id === other.id);
        if (change === 'time') {
          target.start = 930;
          target.calendarOccupation = { startInstant: wallInstant(day, 930, zone), endInstant: wallInstant(day, 990, zone) };
        } else if (change === 'peer-title') items[0].title = 'Renamed current task';
        else if (change === 'peer-removed') items.splice(0, 1);
        else {
          const third = structuredClone(target); third.id = third.uid = 'new-local-peer'; delete third.calendarLink; delete third.calendarSource;
          items.push(third);
        }
      });
      assert.equal(saved.ok, true, saved.message);
      r.ctx.state = r.store.state; r.bench.render();
      assert.equal(r.text, '', change);
      const writes = r.writes;
      await r.read({ events: [{ ...otherEvent, canManage: false }] });
      assert.equal(r.text, '', change); assert.equal(r.writes, writes);
    } finally { r.close(); }
  }
});

test('A changed Workbench timezone clears the old context without inventing an adjustment change', async () => {
  const { branch, otherEvent } = sameTitleFixture(), r = rig(branch);
  try {
    await r.read({ events: [{ ...otherEvent, canManage: false }] });
    assert.match(r.text, /2026-10-12 15:00–16:00/);
    // The personal WorkspaceStore only accepts the Los Angeles timezone, so this is a component-level check, not a saved timezone change.
    r.ctx.state = structuredClone(r.ctx.state);
    r.ctx.state.personal.settings.timeZone = 'Asia/Tokyo';
    r.bench.render();
    assert.equal(r.text, '');
    const writes = r.writes, snapshot = r.bench.captureCalendarRead();
    r.bench.completeCalendarRead(snapshot, { complete: true });
    assert.equal(r.text, ''); assert.equal(r.writes, writes);
  } finally { r.close(); }
});

test('Unique task titles keep the exact concise copy', async () => {
  const r = rig(); try {
    await r.read({ events: [event({ canManage: false })] });
    assert.equal(r.text, 'After refreshing, “Opaque practice” can no longer be moved by Shunri.');
  } finally { r.close(); }
});

test('An explicitly read-only classification has no management shortcut after a verified mapping reread', async () => {
  const branch = classifyCalendar(fixture(), { rules: [{ match: 'calendar', calendarId: 'synthetic@example.test', kind: 'learning', manage: false }] }).data;
  const r = rig(branch); try {
    assert.equal(r.nodes.has('wb-from-now'), false);
    assert.equal(r.nodes.has('wb-exact'), false);
    await r.read({ events: [event({ managed: true, managedUid: r.item().uid })] });
    assert.equal(r.item().calendarClassification.manage, false);
    assert.equal(r.item().calendarLink.managed, false);
    assert.equal(r.nodes.has('wb-from-now'), false);
    assert.equal(r.nodes.has('wb-exact'), false);
    assert.equal(r.text, '', 'no fictional recovery notice');
  } finally { r.close(); }
});
