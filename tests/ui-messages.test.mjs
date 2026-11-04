import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { presentError, splitHelp, messageHtml, attributeMessage } from '../ui-messages.js';
import { constraints } from '../scheduler.js';
import { parseTimeExpression } from '../time.js';
import { normalizeDays } from '../storage.js';
import { syncPresentation } from '../sync-queue.js';
import { undoAdjustment } from '../workflow.js';
import { FIXED_LABEL } from '../workbench.js';
import { mergeCalendar } from '../calendar-data.js';
import { setupMessage } from '../calendar-service.mjs';

const CJK = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/;
const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

const WRITES_OFF_PREVIEW = 'Calendar writes are off. You can connect and preview; no events will be created or updated. A local save in Shunri is kept apart from a Google write. Writes stay off until the owner separately approves turning them on. Help for the server owner: the setting name is CALENDAR_WRITES_ENABLED.';
const WRITES_OFF_LOCAL = 'Calendar writes are off. No create or update requests were sent, and your change is kept in Shunri only. A local save in Shunri is kept apart from a Google write. Writes stay off until the owner separately approves turning them on. Help for the server owner: the setting name is CALENDAR_WRITES_ENABLED.';

describe('messages produced by the real code', () => {
  test('a scheduling conflict keeps exact task names and source data', () => {
    const tasks = [
      { id: 'a', title: 'Sync succeeded / Client task', start: 660, duration: 60, rest: 15 },
      { id: 'b', title: '<b>Dentist</b>', start: 700, duration: 30, rest: 0, locked: true },
    ], snapshot = structuredClone(tasks);
    const message = constraints(tasks).conflicts[0].message;
    assert.equal(message, '“Sync succeeded / Client task” overlaps “<b>Dentist</b>”, including event protection periods.');
    assert.equal(presentError(message), message);
    assert.deepEqual(tasks, snapshot);
  });

  test('parser errors, explanations and clarification questions keep the date and time basis', () => {
    const options = { now: { date: '2026-10-12', minute: 840 }, timeZone: 'America/Los_Angeles' };
    assert.equal(parseTimeExpression('tomorrow at 2', options).question, 'Do you mean 02:00 (AM) or 14:00 (PM)?');
    assert.equal(parseTimeExpression('in 30 minutes', options).explanation, '30 minutes after the app time 2026-10-12 14:00.');
    assert.equal(parseTimeExpression('when I finish', options).message, 'This expression is not supported. Use an exact time, such as “tomorrow at 2pm” or “2026-10-15 14:30”.');
  });

  test('storage validation and undo failures are actionable English sentences', () => {
    let error; try { normalizeDays(null); } catch (e) { error = e; }
    assert.equal(error.message, 'The schedule format is not recognized.');
    assert.equal(undoAdjustment({}).message, 'There is no adjustment to undo.');
  });

  test('sync presentation keeps the local-save and writes-off qualifications', () => {
    const branch = { calendar: { autoSync: false, syncQueue: { jobs: [] } } };
    const raw = syncPresentation(branch, { writesEnabled: false });
    assert.equal(raw.state, 'write_disabled');
    assert.equal(raw.text, 'Saved locally · Saved locally; sync result not verified · Google writes are off');
  });

  test('attribute messages name the affected tasks', () => {
    assert.equal(attributeMessage('late', 'Report'), 'Past its deadline: Report.');
    assert.equal(attributeMessage('unknown'), '');
  });

  test('the fixed badge uses the shared label', () => {
    assert.equal(FIXED_LABEL, 'Will not move');
  });
});

describe('help lines', () => {
  test('presentError returns only the main sentence of a message', () => {
    const text = 'Google Calendar is not set up. Help for the server owner: the setting names are GOOGLE_CLIENT_ID.';
    assert.equal(presentError(text), 'Google Calendar is not set up.');
    assert.equal(presentError('Plain.'), 'Plain.');
    assert.equal(presentError('Calendar request failed.'), 'Calendar request failed.');
    const item = { message: 'x' };
    assert.equal(presentError(item), item); assert.equal(presentError(null), null); assert.equal(presentError(undefined), undefined);
    assert.equal(presentError(''), '');
  });

  test('conflict text that quotes task names is returned unchanged', () => {
    const text = 'Conflicts were found after refreshing Calendar. Nothing was written. Preview again: Study conflicts with Interview.';
    assert.equal(presentError(text), text);
  });

  test('help lines split off the main text and render as a separate small element', () => {
    assert.deepEqual(splitHelp('Plain.'), { main: 'Plain.', help: '' });
    assert.equal(splitHelp('Main. Help for the server owner: x.').help, 'Help for the server owner: x.');
    const esc = (s) => String(s).replace(/</g, '&lt;');
    assert.equal(messageHtml('A <b>', esc), '<p>A &lt;b></p>');
    assert.equal(messageHtml('Plain.', String), '<p>Plain.</p>');
    assert.match(messageHtml('Main. Help for the server owner: x.', esc, ' role="status"'), /^<p role="status">Main\.<\/p><p class="help-line"><small>Help for the server owner: x\.<\/small><\/p>$/);
  });

  test('server variable names stay out of the main sentence and sit in a help line', () => {
    const [main, help] = setupMessage(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']).split(' Help for the server owner');
    assert.doesNotMatch(main, /GOOGLE_/);
    assert.match(help, /GOOGLE_CLIENT_ID/);
  });

  test('the writes-off message renders its setting name in its own help element', () => {
    for (const input of [WRITES_OFF_PREVIEW, WRITES_OFF_LOCAL]) {
      const [first, second] = messageHtml(input, String).split('</p>');
      assert.doesNotMatch(first, /CALENDAR_WRITES_ENABLED/);
      assert.match(first, /Calendar writes are off/);
      assert.match(first, /local save in Shunri is kept apart from a Google write/);
      assert.match(second, /class="help-line"/);
      assert.match(second, /CALENDAR_WRITES_ENABLED/);
    }
  });

  test('write-failure messages keep the setting name out of the main text, even when presented twice', () => {
    for (const input of [WRITES_OFF_PREVIEW, WRITES_OFF_LOCAL]) {
      assert.doesNotMatch(presentError(input), /CALENDAR_WRITES_ENABLED/);
      assert.match(presentError(input), /local save in Shunri is kept apart from a Google write/);
      assert.doesNotMatch(presentError(presentError(input)), /CALENDAR_WRITES_ENABLED/);
    }
  });

  test('screens that show the writes-off status use the split rendering', async () => {
    const source = await read('workbench.js');
    assert.match(source, /messageHtml\(message, esc\)/);
    assert.match(source, /Only the pending sync queue is saved; a local save in Shunri is kept apart from a Google write/);
  });
});

describe('set-up and connection messages', () => {
  // Each message names the problem and the action to take, in English.
  const rows = [
    [setupMessage(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']), /client ID and Google client secret are missing\. Add them.*restart Shunri.*connect again/, /Help for the server owner: the setting names are GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET\./],
    [setupMessage(['GOOGLE_CLIENT_ID']), /Google client ID is missing\. Add it.*connect again/, /Help for the server owner: the setting names are GOOGLE_CLIENT_ID\./],
    [setupMessage(['GOOGLE_CLIENT_SECRET']), /Google client secret is missing\. Add it.*restart Shunri/, /setting names are GOOGLE_CLIENT_SECRET\./],
    [setupMessage(['SOMETHING_ELSE']), /some server settings are missing/, /restart Shunri.*SOMETHING_ELSE/],
    ['Google Calendar is not connected. Choose Connect Google Calendar, sign in to Google, then try again.', /not connected/, /Choose Connect Google Calendar, sign in to Google, then try again/],
    ['Authorization expired. Reconnect Google Calendar.', /expired/, /Reconnect Google Calendar/],
    ['Authorization changed. Repeat the action.', /Authorization changed/, /Repeat the action/],
    ['Authorization was cancelled or its security check failed. Reconnect Google Calendar.', /cancelled/, /Reconnect Google Calendar/],
    ['Google authorization exchange failed. Reconnect Google Calendar.', /exchange failed/, /Reconnect Google Calendar/],
    ['The authorization response is invalid. Reconnect Google Calendar.', /invalid/, /Reconnect Google Calendar/],
    ['Authorization storage is unavailable. The original data was retained. Check that the server’s data folder is writable, restart Shunri, then reconnect.', /storage is unavailable/, /data folder is writable, restart Shunri, then reconnect/],
    ['Authorization storage could not be read. The original data was retained. Check that the server’s data folder is readable, restart Shunri, then reconnect.', /storage could not be read/, /data folder is readable, restart Shunri, then reconnect/],
    ['The authorization update could not be saved yet. Check local storage and try again.', /could not be saved/, /Check local storage and try again/],
    [WRITES_OFF_LOCAL, /Calendar writes are off.*No create or update requests were sent.*Shunri only/, /stay off until the owner separately approves turning them on/],
    [WRITES_OFF_PREVIEW, /Calendar writes are off.*connect and preview/, /stay off until the owner separately approves turning them on/],
    ['Your Calendar management permission was withdrawn. Nothing was written. Reconnect Google Calendar and preview again.', /permission was withdrawn/, /Reconnect Google Calendar/],
    ['Start the connection from the Shunri page.', /Start the connection/, /from the Shunri page/],
    ['Read Google Calendar from the Shunri page.', /Read Google Calendar/, /from the Shunri page/],
    ['Sync is in progress. Wait for it to finish before reconnecting.', /Sync is in progress/, /Wait for it to finish before reconnecting/],
    ['Sync is in progress. Wait for it to finish.', /Sync is in progress/, /Wait for it to finish/],
    ['The request origin or security check is invalid. Refresh the page.', /security check is invalid/, /Refresh the page/],
    ['The request is too large. Select fewer tasks and try again.', /too large/, /Select fewer tasks/],
    ['The same task was selected more than once. Remove the duplicate and try again.', /more than once/, /Remove the duplicate/],
    ['Google is temporarily unavailable. Try again in a few minutes.', /temporarily unavailable/, /Try again in a few minutes/],
    ['Google could not be reached. Check the network and try again.', /could not be reached/, /Check the network and try again/],
    ['The calendar read failed (HTTP 503). Try again.', /read failed \(HTTP 503\)/, /Try again/],
  ];
  for (const [message, problem, action] of rows) test(`set-up message: ${message}`, () => {
    assert.match(message, problem);
    assert.match(message, action);
    assert.doesNotMatch(message, CJK);
  });
});

describe('English-only copy', () => {
  // Every module whose strings can reach the screen as a message, reason or explanation.
  const USER_LEVEL_SOURCES = [
    'app.js', 'workbench.js', 'workflow.js', 'calendar-data.js', 'calendar-semantics.js',
    'calendar-service.mjs', 'intent-planner.js', 'planner.js', 'scheduler.js', 'storage.js',
    'sync-queue.js', 'time.js', 'learning.js', 'schedule-context.js', 'task-attributes.js',
    'default-rules.js', 'ui-messages.js', 'server.mjs', 'index.html', 'ip-recovery.html',
  ];

  test('no source that can reach the user contains Chinese text', async () => {
    for (const file of USER_LEVEL_SOURCES) assert.doesNotMatch(await read(file), CJK, file);
  });

  test('a calendar merge reports English errors and titles', () => {
    const result = mergeCalendar({ days: {} }, { events: [
      { id: 'no-calendar', start: { dateTime: '2026-10-28T09:00:00-07:00' }, end: { dateTime: '2026-10-28T10:00:00-07:00' } },
      { calendarId: 'me', id: 'mixed', start: { date: '2026-10-28' }, end: { dateTime: '2026-10-28T10:00:00-07:00' } },
      { calendarId: 'me', id: 'backwards', start: { dateTime: '2026-10-28T10:00:00-07:00' }, end: { dateTime: '2026-10-28T09:00:00-07:00' } },
      { calendarId: 'me', id: 'untitled', start: { dateTime: '2026-10-28T11:00:00-07:00' }, end: { dateTime: '2026-10-28T12:00:00-07:00' } },
    ] }, { timeZone: 'America/Los_Angeles' });
    assert.equal(result.errors.length, 3);
    for (const { message } of result.errors) assert.doesNotMatch(message, CJK, message);
    const titles = Object.values(result.data.days).flat().map((task) => task.title);
    assert.equal(titles.length, 1);
    for (const title of titles) assert.doesNotMatch(title, CJK, title);
  });
});
