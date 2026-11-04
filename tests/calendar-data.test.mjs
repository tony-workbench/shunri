import test from "node:test";
import assert from "node:assert/strict";
import { syncResumeProposal } from "../sync-queue.js";
import { applySemanticDecision } from "../calendar-semantics.js";
import {
  mergeCalendar,
  classifyCalendar,
  calendarKey,
  localCalendarSignature,
  calendarRuleMatches,
  ruleFor,
} from "../calendar-data.js";

const blank = () => ({
  days: {},
  settings: {
    timeZone: "America/Los_Angeles",
    bufferBefore: 60,
    bufferAfter: 60,
  },
});
const event = (changes = {}) => ({
  calendarId: "personal@example.test",
  calendarName: "Personal calendar",
  accessRole: "owner",
  calendarTimeZone: "America/Los_Angeles",
  eventId: "google-event-1",
  etag: '"v1"',
  updated: "2026-10-10T09:00:00Z",
  summary: "Lesson and practice",
  status: "confirmed",
  start: { dateTime: "2026-10-12T11:00:00-07:00" },
  end: { dateTime: "2026-10-12T12:00:00-07:00" },
  organizer: { self: true, email: "personal@example.test" },
  ...changes,
});
const task = (result, date = "2026-10-12") => result.data.days[date][0];
const response = (...events) => ({
  events,
  range: { from: "2026-10-01", to: "2026-11-15" },
});
const studyRule = {
  calendarId: "personal@example.test",
  match: "title_contains",
  value: "Lesson",
  kind: "learning",
  planId: "career",
};

test("First read-only import of a real event: the title is not a basis for management or study classification", () => {
  const source = blank(),
    result = mergeCalendar(source, response(event()));
  const imported = task(result);
  assert.equal(result.imported, 1);
  assert.equal(imported.calendarLink.eventId, "google-event-1");
  assert.equal(imported.calendarLink.source, "google");
  assert.equal(imported.locked, true);
  assert.equal(imported.type, "task");
  assert.equal(imported.externalReadOnly, true);
  assert.equal(imported.bufferBefore, 0);
  assert.deepEqual(imported.tags, []);
  assert.equal(result.unclassified[0].canManage, true);
  assert.deepEqual(source, blank());
});

test("Special Google events are not shown as adoptable or unlocked by an existing management reference", () => {
  for (const eventType of ["focusTime", "outOfOffice", "workingLocation"]) {
    const initial = mergeCalendar(blank(), response(event({ eventType, canManage: true })));
    const key = calendarKey(task(initial));
    assert.equal(initial.unclassified[0].canManage, false, eventType);
    const classified = classifyCalendar(initial.data, {
      selections: { [key]: { kind: "learning", planId: "career" } },
      managedRefs: new Set([key]),
    });
    assert.equal(task(classified).externalReadOnly, true, eventType);
    assert.equal(task(classified).locked, true, eventType);
    assert.equal(task(classified).calendarLink.managed, false, eventType);
  }
});

test("Flat and nested Google events keep the server's explicit decision that adoption is forbidden", () => {
  for (const nested of [false, true]) {
    const source = event({ organizer: null, creator: { self: true } });
    const incoming = nested ? { event: { ...source, canManage: true }, canManage: false } : { ...source, canManage: false };
    const initial = mergeCalendar(blank(), response(incoming));
    assert.equal(task(initial).calendarSource.canManage, false);
    assert.equal(initial.unclassified[0].canManage, false);
    const key = calendarKey(task(initial));
    const classified = classifyCalendar(initial.data, {
      selections: { [key]: { kind: "learning", planId: "career" } },
      managedRefs: new Set([key]),
    });
    assert.equal(task(classified).calendarLink.managed, false);
    assert.equal(task(classified).externalReadOnly, true);
  }
});

test("An ordinary Google event can still be explicitly adopted, and becomes read-only again if the server later forbids it", () => {
  const initial = mergeCalendar(blank(), response(event({ eventType: "default", canManage: true })));
  const key = calendarKey(task(initial));
  assert.equal(initial.unclassified[0].canManage, true);
  const classified = classifyCalendar(initial.data, {
    selections: { [key]: { kind: "learning", planId: "career" } },
    managedRefs: new Set([key]),
  });
  assert.equal(task(classified).externalReadOnly, false);
  const refreshed = mergeCalendar(classified.data, response(event({ eventType: "default", canManage: false })));
  assert.equal(task(refreshed).externalReadOnly, true);
  assert.equal(task(refreshed).calendarLink.managed, false);
});

test("Without organizer.self, creator.self alone cannot open adoption for old data", () => {
  const result = mergeCalendar(blank(), response(event({ organizer: null, creator: { self: true } })));
  assert.equal(result.unclassified[0].canManage, false);
});

test("Repeated pages, repeated reads and refreshes do not duplicate the original Google event", () => {
  const first = mergeCalendar(blank(), {
    pages: [{ events: [event()] }, { events: [event()] }],
  });
  const second = mergeCalendar(first.data, response(event()));
  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(task(first).id, task(second).id);
  assert.equal(Object.values(second.data.days).flat().length, 1);
});

test("The same Google ID on different calendars is not the same event", () => {
  const result = mergeCalendar(
    blank(),
    response(event(), event({ calendarId: "other@example.test" })),
  );
  assert.equal(result.imported, 2);
  assert.notEqual(
    result.data.days["2026-10-12"][0].uid,
    result.data.days["2026-10-12"][1].uid,
  );
});

test("A nested wrapper's event.id and a flat eventId are both supported", () => {
  const nested = {
    calendarId: "personal@example.test",
    accessRole: "owner",
    event: { ...event(), id: "nested", eventId: undefined },
  };
  const result = mergeCalendar(blank(), response(nested));
  assert.equal(result.imported, 1);
  assert.equal(task(result).calendarLink.eventId, "nested");
});

test("Instances of a recurring event use the original eventId and do not merge recurringEventId", () => {
  const a = event({
    eventId: "recurrence_20261012",
    recurringEventId: "recurrence",
    originalStartTime: { dateTime: "2026-10-12T11:00:00-07:00" },
  });
  const b = event({
    eventId: "recurrence_20261013",
    recurringEventId: "recurrence",
    start: { dateTime: "2026-10-13T11:00:00-07:00" },
    end: { dateTime: "2026-10-13T12:00:00-07:00" },
  });
  const result = mergeCalendar(blank(), response(a, b));
  assert.equal(result.imported, 2);
  assert.equal(
    result.data.days["2026-10-13"][0].calendarSource.recurringEventId,
    "recurrence",
  );
});

test("An all-day event's end.date is exclusive, and the full real occupation of a DST day is saved", () => {
  const result = mergeCalendar(
    blank(),
    response(
      event({ start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }),
    ),
  );
  const item = task(result, "2026-11-01");
  assert.equal(item.start, 0);
  assert.equal(item.duration, 1500);
  assert.equal(item.calendarSource.allDay, true);
  assert.equal(
    item.calendarOccupation.endInstant - item.calendarOccupation.startInstant,
    25 * 3600000,
  );
  assert.equal(result.unclassified[0].canManage, false);
});

test("A cross-day event is saved once, shows its start in the app timezone and keeps the full end instant", () => {
  const result = mergeCalendar(
    blank(),
    response(
      event({
        start: { dateTime: "2026-10-12T23:00:00-07:00" },
        end: { dateTime: "2026-10-14T01:00:00-07:00" },
      }),
    ),
  );
  assert.equal(task(result).duration, 1560);
  assert.equal(Object.values(result.data.days).flat().length, 1);
  assert.equal(
    task(result).calendarOccupation.endInstant,
    Date.parse("2026-10-14T01:00:00-07:00"),
  );
});

test("An autumn repeated time with a Google offset needs no guessing, and an ambiguous time without an offset is rejected explicitly", () => {
  const explicit = mergeCalendar(
    blank(),
    response(
      event({
        start: { dateTime: "2026-11-01T01:30:00-07:00" },
        end: { dateTime: "2026-11-01T01:30:00-08:00" },
      }),
    ),
  );
  assert.equal(task(explicit, "2026-11-01").duration, 60);
  const ambiguous = mergeCalendar(
    blank(),
    response(
      event({
        start: {
          dateTime: "2026-11-01T01:30:00",
          timeZone: "America/Los_Angeles",
        },
        end: {
          dateTime: "2026-11-01T03:00:00",
          timeZone: "America/Los_Angeles",
        },
      }),
    ),
  );
  assert.equal(ambiguous.imported, 0);
  assert.match(ambiguous.errors[0].message, /is ambiguous in America\/Los_Angeles because of a daylight-saving change/);
});

test("When the event timezone differs from the app timezone, the real instant is converted to the app's local date", () => {
  const result = mergeCalendar(
    blank(),
    response(
      event({
        start: {
          dateTime: "2026-10-13T08:00:00+09:00",
          timeZone: "Asia/Tokyo",
        },
        end: { dateTime: "2026-10-13T09:00:00+09:00", timeZone: "Asia/Tokyo" },
      }),
    ),
  );
  assert.equal(task(result).start, 16 * 60);
  assert.equal(task(result).calendarSource.timeZone, "Asia/Tokyo");
});

test("An all-day date does not shift to the previous day with calendarTimeZone, and the Google timezone field does not apply to all-day events", () => {
  const result = mergeCalendar(
    blank(),
    response(
      event({
        calendarTimeZone: "Asia/Tokyo",
        start: { date: "2026-10-13", timeZone: "Asia/Tokyo" },
        end: { date: "2026-10-14", timeZone: "Asia/Tokyo" },
      }),
    ),
  );
  assert.equal(task(result, "2026-10-13").start, 0);
  assert.equal(task(result, "2026-10-13").duration, 1440);
  assert.equal(result.data.days["2026-10-12"], undefined);
});

test("A seconds-level event keeps its exact occupation instead of silently being rewritten by minute-level scheduling", () => {
  const result = mergeCalendar(
    blank(),
    response(
      event({
        start: { dateTime: "2026-10-12T11:00:20-0700" },
        end: { dateTime: "2026-10-12T12:00:40-0700" },
      }),
    ),
  );
  assert.equal(result.imported, 1);
  assert.equal(
    task(result).calendarOccupation.endInstant -
      task(result).calendarOccupation.startInstant,
    3620000,
  );
  assert.equal(task(result).calendarSource.minutePrecision, false);
  assert.equal(result.unclassified[0].canManage, false);
});

test("Invalid calendar dates and mixed all-day/timed values are rejected explicitly instead of repaired into other dates", () => {
  const result = mergeCalendar(
    blank(),
    response(
      event({ start: { dateTime: "2026-02-30T11:00:00-07:00" } }),
      event({ eventId: "mixed", start: { date: "2026-10-12" } }),
    ),
  );
  assert.equal(result.imported, 0);
  assert.equal(result.errors.length, 2);
});

test("A one-time classification mapping is remembered and then applied automatically, and study that is not adopted stays read-only", () => {
  const initial = mergeCalendar(blank(), response(event()));
  const classified = classifyCalendar(initial.data, { rules: [studyRule] });
  assert.deepEqual(task(classified).tags, ["study"]);
  assert.equal(task(classified).planId, "career");
  assert.equal(task(classified).locked, true);
  assert.equal(task(classified).calendarLink.managed, false);
  const second = mergeCalendar(
    classified.data,
    response(event({ eventId: "new-learning" })),
  );
  assert.equal(
    second.data.days["2026-10-12"][1].calendarClassification.kind,
    "learning",
  );
  assert.equal(
    second.data.days["2026-10-12"][1].packageId,
    task(classified).packageId,
  );
});

test("Management authorization cannot come from classification manage:true alone; it unlocks only after server-confirmed adoption", () => {
  const initial = mergeCalendar(blank(), response(event()));
  const key = calendarKey(task(initial));
  const without = classifyCalendar(initial.data, {
    selections: { [key]: { kind: "learning", manage: true, planId: "career" } },
  });
  assert.equal(task(without).externalReadOnly, true);
  const withAdoption = classifyCalendar(initial.data, {
    selections: { [key]: { kind: "learning", planId: "career" } },
    managedRefs: new Set([key]),
  });
  assert.equal(task(withAdoption).externalReadOnly, false);
  assert.equal(task(withAdoption).locked, false);
  assert.equal(task(withAdoption).counted, true);
});

test("Local study and imported study of the same plan and original day share the existing package/order", () => {
  const initial = blank();
  initial.days["2026-10-12"] = [
    {
      id: "local-learning",
      uid: "local-learning",
      title: "Existing homework",
      start: 780,
      duration: 40,
      rest: 15,
      done: false,
      tags: ["study"],
      planId: "career",
      packageId: "package-A",
      packageOriginDate: "2026-10-12",
      packageOrder: 20261012,
    },
  ];
  const result = mergeCalendar(initial, response(event()), {
    rules: [studyRule],
  });
  const imported = result.data.days["2026-10-12"].find(
    (item) => item.calendarLink,
  );
  assert.equal(imported.packageId, "package-A");
  assert.equal(imported.packageOrder, 20261012);
  assert.equal(
    new Set(result.data.days["2026-10-12"].map((item) => item.packageId)).size,
    1,
  );
});

test("A newly imported packageOrder matches the shared YYYYMMDD default and does not put a future import before local items", () => {
  const initial = blank();
  initial.days["2026-10-11"] = [
    {
      id: "local-learning",
      uid: "local-learning",
      title: "Earlier study",
      start: 660,
      duration: 40,
      rest: 15,
      done: false,
      tags: ["study"],
      planId: "career",
      packageId: "package-A",
      packageOriginDate: "2026-10-11",
      packageOrder: 20261011,
    },
  ];
  const result = mergeCalendar(initial, response(event()), {
    rules: [studyRule],
  });
  const imported = task(result);
  assert.equal(imported.packageOrder, 20261012);
  assert.ok(
    imported.packageOrder > result.data.days["2026-10-11"][0].packageOrder,
  );
});

test("An event organized by someone else stays unchangeable even on an owner calendar with a wrong adoption flag", () => {
  const initial = mergeCalendar(
    blank(),
    response(
      event({ organizer: { self: false, email: "other@example.test" } }),
    ),
  );
  const key = calendarKey(task(initial));
  const classified = classifyCalendar(initial.data, {
    selections: { [key]: { kind: "learning" } },
    managedRefs: new Set([key]),
  });
  assert.equal(task(classified).locked, true);
  assert.equal(task(classified).calendarLink.managed, false);
});

test("A fixed-event classification explicitly protects its time but does not become a movable managed task", () => {
  const initial = mergeCalendar(
    blank(),
    response(event({ summary: "Badminton" })),
  );
  const key = calendarKey(task(initial));
  const classified = classifyCalendar(initial.data, {
    selections: { [key]: { kind: "fixed" } },
  });
  assert.equal(task(classified).type, "activity");
  assert.equal(task(classified).bufferBefore, 0);
  assert.equal(task(classified).bufferAfter, 0);
  assert.equal(task(classified).locked, true);
});

test("When only the Google side updates the time or date, the original ID/UID/study package/dependency records are kept", () => {
  const first = mergeCalendar(blank(), response(event()), {
    rules: [studyRule],
  });
  task(first).dependencies = [{ id: "earlier", gap: 20 }];
  const original = structuredClone(task(first));
  const second = mergeCalendar(
    first.data,
    response(
      event({
        etag: '"v2"',
        summary: "Lesson renamed",
        start: { dateTime: "2026-10-14T13:00:00-07:00" },
        end: { dateTime: "2026-10-14T14:00:00-07:00" },
      }),
    ),
  );
  const moved = task(second, "2026-10-14");
  assert.equal(second.updated, 1);
  assert.equal(moved.id, original.id);
  assert.equal(moved.uid, original.uid);
  assert.equal(moved.packageId, original.packageId);
  assert.equal(moved.packageOriginDate, "2026-10-12");
  assert.deepEqual(moved.dependencies, original.dependencies);
  assert.equal(first.data.days["2026-10-12"].length, 1);
});

test("A local queued-for-sync adjustment is not rolled back when the original Google version is read again", () => {
  const first = mergeCalendar(blank(), response(event()));
  const item = first.data.days["2026-10-12"].pop();
  item.start = 800;
  first.data.days["2026-10-15"] = [item];
  const second = mergeCalendar(first.data, response(event()));
  assert.equal(task(second, "2026-10-15").start, 800);
  assert.equal(second.conflicts.length, 0);
  assert.notEqual(
    localCalendarSignature(task(second, "2026-10-15"), "2026-10-15"),
    item.calendarLink.localFingerprint,
  );
});

test("Changes on both sides produce an explicit conflict and neither silently overwrite local nor change the baseline to the new value", () => {
  const first = mergeCalendar(blank(), response(event()));
  task(first).start = 900;
  const baseline = task(first).calendarLink.localFingerprint;
  const second = mergeCalendar(
    first.data,
    response(
      event({
        etag: '"v2"',
        start: { dateTime: "2026-10-12T14:00:00-07:00" },
        end: { dateTime: "2026-10-12T15:00:00-07:00" },
      }),
    ),
  );
  assert.equal(task(second).start, 900);
  assert.equal(second.conflicts[0].kind, "both_changed");
  assert.equal(task(second).calendarConflict.remote.start, 840);
  assert.equal(task(second).calendarLink.localFingerprint, baseline);
});

test("When Google changes only metadata/etag, it does not form a false conflict with a local date change", () => {
  const first = mergeCalendar(blank(), response(event()));
  task(first).start = 900;
  const second = mergeCalendar(
    first.data,
    response(event({ etag: '"v2"', description: "Notes updated" })),
  );
  assert.equal(task(second).start, 900);
  assert.equal(second.conflicts.length, 0);
  assert.equal(task(second).calendarSource.description, "Notes updated");
  assert.equal(task(second).calendarLink.etag, '"v2"');
});

test("Completed content and the actual completion record cannot be rescheduled by a remote change", () => {
  const first = mergeCalendar(blank(), response(event()), {
    rules: [studyRule],
  });
  task(first).done = true;
  task(first).completedAt = "2026-10-12T12:02:00-07:00";
  task(first).completedDate = "2026-10-12";
  const second = mergeCalendar(
    first.data,
    response(
      event({
        etag: '"v2"',
        start: { dateTime: "2026-10-14T11:00:00-07:00" },
        end: { dateTime: "2026-10-14T12:00:00-07:00" },
      }),
    ),
  );
  assert.equal(task(second).done, true);
  assert.equal(task(second).completedAt, "2026-10-12T12:02:00-07:00");
  assert.equal(task(second).completedDate, "2026-10-12");
  assert.equal(second.conflicts[0].kind, "completed_remote_changed");
  assert.equal(second.data.days["2026-10-14"], undefined);
});

test("A cancelled event keeps the local record and is reported, and an event absent from a narrow range is not inferred as deleted", () => {
  const first = mergeCalendar(blank(), response(event()));
  const narrow = mergeCalendar(first.data, {
    events: [],
    range: { from: "2026-10-13", to: "2026-10-14" },
  });
  assert.equal(task(narrow).calendarLink.remoteDeleted, false);
  const cancelled = mergeCalendar(
    narrow.data,
    response(event({ status: "cancelled", start: undefined, end: undefined })),
  );
  assert.equal(task(cancelled).calendarLink.remoteDeleted, true);
  assert.equal(task(cancelled).deferred, true);
  assert.equal(Object.values(cancelled.data.days).flat().length, 1);
});

test("An unknown cancelled Google instance creates no fake task, and an invalid event gives a read error", () => {
  const result = mergeCalendar(
    blank(),
    response(
      event({ status: "cancelled", start: undefined, end: undefined }),
      event({ eventId: "broken", end: undefined }),
    ),
  );
  assert.equal(result.imported, 0);
  assert.equal(result.errors.length, 1);
});

test("A server-verified app-managed UID matches the existing task and does not re-import an event the app created itself", () => {
  const existing = {
    id: "local-original",
    uid: "stable-local-uid",
    title: "Lesson and practice",
    start: 660,
    duration: 60,
    rest: 15,
    done: false,
    locked: false,
    deferred: false,
    dependencies: [],
    counted: true,
    tags: ["study"],
    planId: "career",
    packageId: "package-A",
    packageOrder: 1,
    packageOriginDate: "2026-10-12",
  };
  const initial = blank();
  initial.days["2026-10-12"] = [existing];
  const result = mergeCalendar(
    initial,
    response(
      event({
        managed: true,
        managedUid: "stable-local-uid",
        managedProfileId: "profile",
      }),
    ),
    { profileId: "profile" },
  );
  assert.equal(result.imported, 0);
  assert.equal(task(result).id, "local-original");
  assert.equal(task(result).uid, "stable-local-uid");
  assert.equal(task(result).rest, 15);
  assert.equal(task(result).packageId, "package-A");
});

test("Another profile's Google managedUid cannot impersonate a local stable task", () => {
  const initial = blank();
  initial.days["2026-10-12"] = [
    { id: "local", uid: "stable", title: "Local", start: 500, duration: 30 },
  ];
  const result = mergeCalendar(
    initial,
    response(
      event({
        managed: true,
        managedUid: "stable",
        managedProfileId: "other-profile",
      }),
    ),
    { profileId: "this-profile" },
  );
  assert.equal(result.imported, 1);
  assert.notEqual(result.data.days["2026-10-12"][1].uid, "stable");
});

test("An old sync lacking a historical baseline with differing sides conservatively blocks overwriting", () => {
  const initial = blank();
  initial.days["2026-10-12"] = [
    {
      id: "local",
      uid: "stable",
      title: "Local change",
      start: 900,
      duration: 60,
      calendarLink: {
        calendarId: "personal@example.test",
        eventId: "google-event-1",
        source: "google",
        signature: "historic-sha256",
      },
    },
  ];
  const result = mergeCalendar(initial, response(event()));
  assert.equal(task(result).title, "Local change");
  assert.equal(result.conflicts[0].kind, "unverified_baseline");
});

test("Invalid classification rules do not change the input, and the pure function gives repeatable results", () => {
  const initial = mergeCalendar(blank(), response(event()));
  assert.throws(
    () =>
      classifyCalendar(initial.data, {
        rules: [{ match: "title_contains", value: "", kind: "learning" }],
      }),
    /classification rules are invalid/,
  );
  assert.deepEqual(
    mergeCalendar(blank(), response(event())).data,
    mergeCalendar(blank(), response(event())).data,
  );
  assert.equal(task(initial).calendarClassification, undefined);
});

test("description_contains matches once against the original event description and keeps taking effect on later reads", () => {
  const initial = mergeCalendar(
    blank(),
    response(
      event({
        summary: "Module 1",
        description: "Career STUDY · lesson and practice",
      }),
    ),
  );
  const rule = {
    calendarId: "personal@example.test",
    match: "description_contains",
    value: "career study",
    kind: "learning",
    planId: "career",
  };
  const classified = classifyCalendar(initial.data, { rules: [rule] });
  assert.deepEqual(task(classified).tags, ["study"]);
  assert.equal(task(classified).locked, true);
  assert.equal(task(classified).calendarLink.managed, false);
  assert.equal(calendarRuleMatches(task(classified), rule), true);
  const later = mergeCalendar(
    classified.data,
    response(
      event({
        eventId: "lesson-2",
        summary: "Module 2",
        description: "Career Study · assignments",
      }),
    ),
  );
  assert.deepEqual(later.data.days["2026-10-12"][1].tags, ["study"]);
  assert.equal(later.unclassified.length, 0);
});

test("color matches exactly by the actual colorId and does not guess a classification from a color number in the title", () => {
  const initial = mergeCalendar(
    blank(),
    response(
      event({ summary: "1 lesson", colorId: "5" }),
      event({ eventId: "other-color", colorId: "6" }),
    ),
  );
  const rule = {
    calendarId: "personal@example.test",
    match: "color",
    value: "5",
    kind: "learning",
    planId: "career",
    manage: true,
  };
  const classified = classifyCalendar(initial.data, { rules: [rule] });
  const learning = classified.data.days["2026-10-12"][0];
  assert.deepEqual(learning.tags, ["study"]);
  assert.equal(learning.externalReadOnly, true);
  assert.equal(
    classified.data.days["2026-10-12"][1].calendarClassification,
    undefined,
  );
  assert.equal(calendarRuleMatches(learning, { ...rule, value: "1" }), false);
  assert.equal(
    calendarRuleMatches(learning, { ...rule, calendarId: "another" }),
    false,
  );
});

test("A missing colorId maps to the calendar default color only through an explicit default rule, and an empty value never matches broadly", () => {
  const initial = mergeCalendar(blank(), response(event()));
  const rule = { match: "color", value: "default", kind: "fixed" };
  const classified = classifyCalendar(initial.data, { rules: [rule] });
  assert.equal(task(classified).type, "activity");
  assert.equal(task(classified).bufferBefore, 0);
  assert.equal(
    calendarRuleMatches(task(initial), { ...rule, value: "" }),
    false,
  );
  assert.throws(
    () => classifyCalendar(initial.data, { rules: [{ ...rule, value: "" }] }),
    /classification rules are invalid/,
  );
});

test("The shared ruleFor uses first-match priority and does not guess a label when there is no description", () => {
  const initial = mergeCalendar(blank(), response(event({ colorId: "5" })));
  const description = {
    match: "description_contains",
    value: "Lesson",
    kind: "learning",
  };
  const color = { match: "color", value: "5", kind: "fixed" };
  const calendar = { match: "calendar", kind: "task" };
  assert.equal(calendarRuleMatches(task(initial), description), false);
  assert.equal(ruleFor(task(initial), [description, color, calendar]), color);
  assert.equal(ruleFor(task(initial), [calendar, color]), calendar);
});

test("adoptedEtag comes from the server-verified baselineEtag and does not treat a new remote etag as an authorized baseline", () => {
  const first = mergeCalendar(
    blank(),
    response(
      event({
        managed: true,
        managedUid: "server-managed",
        managedProfileId: "profile",
        baselineEtag: '\"v1\"',
      }),
    ),
    { profileId: "profile" },
  );
  assert.equal(task(first).calendarLink.adoptedEtag, '\"v1\"');
  const changed = mergeCalendar(
    first.data,
    response(
      event({
        managed: true,
        managedUid: "server-managed",
        managedProfileId: "profile",
        baselineEtag: '\"v1\"',
        etag: '\"v2\"',
        description: "Google notes changed",
      }),
    ),
    { profileId: "profile" },
  );
  assert.equal(task(changed).calendarLink.etag, '\"v2\"');
  assert.equal(task(changed).calendarLink.adoptedEtag, '\"v1\"');
  const rebased = mergeCalendar(
    changed.data,
    response(
      event({
        managed: true,
        managedUid: "server-managed",
        managedProfileId: "profile",
        baselineEtag: '\"v2\"',
        etag: '\"v2\"',
      }),
    ),
    { profileId: "profile" },
  );
  assert.equal(task(rebased).calendarLink.adoptedEtag, '\"v2\"');
});

test("An unverified baselineEtag from another profile cannot change the local adoptedEtag", () => {
  const first = mergeCalendar(blank(), response(event()));
  task(first).calendarLink.adoptedEtag = '\"trusted\"';
  const second = mergeCalendar(
    first.data,
    response(
      event({
        managed: true,
        managedUid: "other",
        managedProfileId: "other-profile",
        baselineEtag: '\"untrusted\"',
      }),
    ),
    { profileId: "profile" },
  );
  assert.equal(task(second).calendarLink.adoptedEtag, '\"trusted\"');
});

test("A pending local move keeps its time but loses management when the source stops being eligible", () => {
  for (const classified of [true, false]) for (const restriction of [
    { canManage: false }, { organizer: { self: false } },
    { accessRole: "reader" }, { eventType: "focusTime" },
  ]) {
    const first = mergeCalendar(blank(), response(event({ canManage: true })));
    const key = calendarKey(task(first));
    const adopted = classifyCalendar(first.data, {
      selections: { [key]: { kind: "learning", planId: "career" } }, managedRefs: new Set([key]),
    });
    const item = task(adopted);
    if (!classified) delete item.calendarClassification;
    item.start = 800;
    const baseline = item.calendarLink.localFingerprint, before = structuredClone(adopted.data);
    const refreshed = mergeCalendar(adopted.data, response(event({ etag: '"permissions-v2"', ...restriction })));
    const updated = task(refreshed);
    assert.equal(updated.start, 800);
    assert.equal(updated.calendarLink.localFingerprint, baseline);
    assert.equal(updated.calendarLink.managed, false);
    assert.equal(updated.externalReadOnly, true);
    assert.equal(updated.locked, true);
    assert.equal(updated.calendarLink.etag, '"permissions-v2"');
    assert.equal(refreshed.conflicts.length, 0);
    assert.deepEqual(adopted.data, before);
  }
});

test("Polling metadata on an eligible source keeps the pending move and management", () => {
  const first = mergeCalendar(blank(), response(event({ canManage: true })));
  const key = calendarKey(task(first));
  const adopted = classifyCalendar(first.data, {
    selections: { [key]: { kind: "learning", planId: "career" } }, managedRefs: new Set([key]),
  });
  task(adopted).start = 800;
  const refreshed = mergeCalendar(adopted.data, response(event({ canManage: true, etag: '"notes-v2"', description: "Synthetic notes" })));
  assert.equal(task(refreshed).start, 800);
  assert.equal(task(refreshed).calendarLink.managed, true);
  assert.equal(task(refreshed).externalReadOnly, false);
  assert.equal(task(refreshed).locked, false);
});

test("A confirmed revival clears only the cancellation-owned deferral, across repeated reads", () => {
  for (const preDeferred of [false, true]) for (const done of [false, true]) {
    const first = mergeCalendar(blank(), response(event()));
    Object.assign(task(first), { deferred: preDeferred, done, completedAt: done ? "2026-10-12T19:02:00Z" : undefined });
    const original = structuredClone(task(first));
    const cancellation = response(event({ status: "cancelled", start: undefined, end: undefined, etag: '"cancelled-v2"' }));
    const cancelled = mergeCalendar(first.data, cancellation);
    const repeated = mergeCalendar(cancelled.data, cancellation);
    const revived = mergeCalendar(repeated.data, response(event({ etag: '"restored-v3"' })));
    assert.equal(task(revived).calendarLink.remoteDeleted, false);
    assert.equal(task(revived).calendarConflict, undefined);
    assert.equal(task(revived).deferred, preDeferred);
    assert.equal(task(revived).done, done);
    assert.equal(task(revived).completedAt, original.completedAt);
    assert.equal(task(revived).uid, original.uid);
    assert.equal(task(revived).id, original.id);
    assert.equal(task(revived).start, original.start);
    assert.equal(Object.values(revived.data.days).flat().length, 1);
    assert.equal(task(mergeCalendar(revived.data, response(event({ etag: '"restored-v3"' })))).deferred, preDeferred);
  }
});

test("Revived pending edits become visible without losing the local time or remote conflicts", () => {
  for (const remoteMoved of [false, true]) {
    const first = mergeCalendar(blank(), response(event()));
    task(first).start = 800;
    const baseline = task(first).calendarLink.localFingerprint;
    const cancelled = mergeCalendar(first.data, response(event({ status: "cancelled", start: undefined, end: undefined, etag: '"cancelled-v2"' })));
    const restored = event({ etag: '"restored-v3"', ...(remoteMoved ? {
      start: { dateTime: "2026-10-12T14:00:00-07:00" }, end: { dateTime: "2026-10-12T15:00:00-07:00" },
    } : {}) });
    const revived = mergeCalendar(cancelled.data, response(restored));
    assert.equal(task(revived).calendarLink.remoteDeleted, false);
    assert.equal(task(revived).deferred, false);
    assert.equal(task(revived).start, 800);
    assert.equal(task(revived).calendarLink.localFingerprint, baseline);
    assert.equal(task(revived).calendarConflict?.kind, remoteMoved ? "both_changed" : undefined);
  }
});

test("Missing or invalid restored data cannot clear a cancellation", () => {
  const first = mergeCalendar(blank(), response(event()));
  const cancelled = mergeCalendar(first.data, response(event({ status: "cancelled", start: undefined, end: undefined })));
  for (const read of [response(), response(event({ end: undefined }))]) {
    const unchanged = mergeCalendar(cancelled.data, read);
    assert.equal(task(unchanged).calendarLink.remoteDeleted, true);
    assert.equal(task(unchanged).deferred, true);
    assert.equal(task(unchanged).calendarConflict.kind, "remote_deleted");
  }
});

test("Legacy cancelled records clear the false cancellation notice without guessing deferral ownership", () => {
  for (const remoteDeleted of [true, false]) {
    const first = mergeCalendar(blank(), response(event()));
    task(first).deferred = true;
    task(first).calendarLink.remoteDeleted = remoteDeleted;
    task(first).calendarConflict = { kind: "remote_deleted", message: "legacy cancellation" };
    const revived = mergeCalendar(first.data, response(event({ etag: '"restored-v3"' })));
    assert.equal(task(revived).calendarLink.remoteDeleted, false);
    assert.equal(task(revived).calendarConflict, undefined);
    assert.equal(task(revived).deferred, true);
  }
});

// A managed legacy item with a pending local move (start 800) whose Google event was cancelled and then restored.
function pendingLegacyEvent(extra = {}) {
  const original = event({ summary: "Legacy opaque item", canManage: true });
  const initial = mergeCalendar(blank(), response(original));
  Object.assign(task(initial), { locked: false, externalReadOnly: false, start: 800, ...extra });
  task(initial).calendarLink.managed = true;
  assert.equal(task(initial).calendarClassification, undefined);
  const cancelled = mergeCalendar(initial.data, response({ ...original, status: "cancelled", start: undefined, end: undefined, etag: '\"cancelled-v2\"' }));
  return { initial, cancelled, restored: { ...original, etag: '\"restored-v3\"' } };
}

test("An eligible managed legacy event with a pending move resumes editing and its sync proposal after revival", () => {
  const { initial, cancelled, restored } = pendingLegacyEvent();
  const baseline = task(initial).calendarLink.localFingerprint;
  assert.equal(task(cancelled).externalReadOnly, true);
  const before = structuredClone(cancelled.data);
  let current = mergeCalendar(cancelled.data, response(restored));
  for (let read = 0; read < 2; read++) {
    const item = task(current);
    assert.equal(item.calendarClassification, undefined);
    assert.equal(item.calendarLink.managed, true);
    assert.equal(item.externalReadOnly, false);
    assert.equal(item.locked, false);
    assert.equal(item.deferred, false);
    assert.equal(item.calendarLink.remoteDeleted, false);
    assert.equal(item.start, 800);
    assert.equal(item.calendarLink.localFingerprint, baseline);
    assert.deepEqual(syncResumeProposal(current.data).items.map((entry) => entry.uid), [item.uid]);
    current = mergeCalendar(current.data, response(restored));
  }
  assert.deepEqual(cancelled.data, before);
});

test("Revival never grants missing management and never ignores a source veto", () => {
  for (const missingManagement of [true, false]) {
    const { cancelled, restored } = pendingLegacyEvent();
    if (missingManagement) task(cancelled).calendarLink.managed = false;
    else restored.canManage = false;
    const current = mergeCalendar(cancelled.data, response(restored));
    assert.equal(task(current).calendarLink.managed, false);
    assert.equal(task(current).externalReadOnly, true);
    assert.equal(task(current).start, 800);
    assert.equal(syncResumeProposal(current.data).items.length, 0);
  }
});

test("An eligible revival preserves user locks, fixed activity, completion and prior deferral", () => {
  for (const protection of [
    { locked: true }, { locked: true, lockSource: "user" }, { timeLocked: true },
    { type: "activity", locked: true }, { done: true, completedAt: "2026-10-12T19:02:00Z" },
    { deferred: true }, { locked: true, semanticPendingLock: { locked: false } },
  ]) {
    const { cancelled, restored } = pendingLegacyEvent(protection);
    const current = mergeCalendar(cancelled.data, response(restored));
    assert.equal(task(current).externalReadOnly, false);
    assert.equal(task(current).calendarLink.managed, true);
    assert.equal(task(current).start, 800);
    for (const [key, value] of Object.entries(protection)) assert.deepEqual(task(current)[key], value);
    assert.equal(syncResumeProposal(current.data).items.length, 0);
  }
});

// The same item after a read in which the source restriction temporarily locked it.
function temporarilyRestrictedLegacy(extra = {}, restriction = { canManage: false }) {
  const { initial, restored: original } = pendingLegacyEvent(extra);
  const restrictedEvent = { ...original, ...restriction, etag: '"restricted"' };
  const restricted = mergeCalendar(initial.data, response(restrictedEvent));
  const restored = { ...original, managed: true, managedUid: task(initial).uid, managedProfileId: "profile", etag: '"eligible"' };
  return { initial, restricted, restrictedEvent, restored };
}

test("Verified recovery releases only the source restriction lock of a pending move", () => {
  for (const restriction of [{ canManage: false }, { accessRole: "reader" }, { organizer: { self: false } }, { eventType: "focusTime" }]) {
    const { initial, restricted, restrictedEvent, restored } = temporarilyRestrictedLegacy({}, restriction);
    const before = structuredClone(restricted.data), baseline = task(initial).calendarLink.localFingerprint;
    assert.equal(task(restricted).calendarRestrictionLock, true);
    const repeated = mergeCalendar(restricted.data, response(restrictedEvent));
    assert.equal(task(repeated).calendarRestrictionLock, true);
    let recovered = mergeCalendar(repeated.data, response(restored), { profileId: "profile" });
    for (let read = 0; read < 2; read++) {
      const item = task(recovered);
      assert.equal(item.locked, false);
      assert.equal(item.calendarRestrictionLock, undefined);
      assert.equal(item.externalReadOnly, false);
      assert.equal(item.calendarLink.managed, true);
      assert.equal(item.start, 800);
      assert.equal(item.calendarLink.localFingerprint, baseline);
      assert.equal(item.uid, task(initial).uid);
      assert.deepEqual(syncResumeProposal(recovered.data).items.map(e => e.uid), [item.uid]);
      recovered = mergeCalendar(recovered.data, response(restored), { profileId: "profile" });
    }
    assert.deepEqual(restricted.data, before);
  }
});

test("Existing locks persist and temporary guards keep recoverable provenance", () => {
  const protections = [
    { locked: true }, { locked: true, lockSource: "user" }, { timeLocked: true },
    { type: "activity", locked: true }, { done: true, completedAt: "2026-10-12T19:02:00Z" },
    { deferred: true }, { semanticLock: true }, { semanticPendingLock: { locked: false } },
    { semanticConflict: { source: "user-confirmation", message: "keep" } }, { readonlyLock: true },
    { locked: true, done: true }, { locked: true, deferred: true },
  ];
  for (const late of [false, true]) for (const protection of protections) {
    // A bare late locked=true is indistinguishable from the existing system lock.
    if (late && protection.locked && !protection.lockSource && !protection.type) continue;
    const { restricted, restored } = temporarilyRestrictedLegacy(late ? {} : protection);
    if (!late && protection.locked) assert.equal(task(restricted).calendarRestrictionLock, undefined);
    if (late) Object.assign(task(restricted), protection);
    const recovered = mergeCalendar(restricted.data, response(restored), { profileId: "profile" });
    const previousLock = !late && protection.locked;
    const explicitOwner = protection.lockSource === "user" || protection.type === "activity";
    const temporaryGuard = protection.timeLocked || protection.semanticLock || protection.semanticPendingLock || protection.semanticConflict || protection.readonlyLock;
    const remainsLocked = Boolean(previousLock || explicitOwner || temporaryGuard);
    assert.equal(task(recovered).locked, remainsLocked, JSON.stringify({ late, protection }));
    assert.equal(task(recovered).calendarRestrictionLock, !previousLock && temporaryGuard ? true : undefined);
    for (const [key, value] of Object.entries(protection)) assert.deepEqual(task(recovered)[key], value);
    assert.equal(syncResumeProposal(recovered.data).items.length, 0);
    // Removing a temporary guard allows the next trusted poll to release only
    // the source-owned lock; existing/user/fixed locks remain independent.
    for (const key of Object.keys(protection)) if (key !== "locked") delete task(recovered)[key];
    const next = task(mergeCalendar(recovered.data, response(restored)));
    assert.equal(next.locked, Boolean(previousLock || explicitOwner));
    assert.equal(next.calendarRestrictionLock, undefined);
  }
});

test("Without management, with a missing or invalid source, or with a remote conflict, the restriction lock is not released", () => {
  const { restricted, restored } = temporarilyRestrictedLegacy();
  const reads = [
    response({ ...restored, managed: false }), response({ ...restored, managedProfileId: "other-profile" }),
    response(), response({ ...restored, end: undefined }), response({ ...restored, canManage: false }),
    response({ ...restored, start: { dateTime: "2026-10-12T14:00:00-07:00" }, end: { dateTime: "2026-10-12T15:00:00-07:00" } }),
  ];
  for (const read of reads) {
    const current = mergeCalendar(restricted.data, read, { profileId: "profile" });
    assert.equal(task(current).locked, true);
    assert.equal(task(current).calendarRestrictionLock, true);
    assert.equal(syncResumeProposal(current.data).items.length, 0);
  }
});

test("Settling the local move or a cancellation does not orphan the restriction lock", () => {
  for (const transition of ["settled", "cancelled"]) {
    const { restricted, restored } = temporarilyRestrictedLegacy();
    let current = restricted;
    if (transition === "settled") task(current).start = 660;
    else current = mergeCalendar(current.data, response({ ...restored, status: "cancelled", start: undefined, end: undefined }));
    const recovered = mergeCalendar(current.data, response(restored), { profileId: "profile" });
    assert.equal(task(recovered).locked, false);
    assert.equal(task(recovered).externalReadOnly, false);
    assert.equal(task(recovered).calendarRestrictionLock, undefined);
    assert.equal(task(recovered).deferred, false);
  }
});

test("An explicit classification ends the temporary lock ownership", () => {
  const { restricted, restored } = temporarilyRestrictedLegacy();
  const key = calendarKey(task(restricted));
  const classified = classifyCalendar(restricted.data, { selections: { [key]: { kind: "fixed" } } });
  assert.equal(task(classified).calendarRestrictionLock, undefined);
  const recovered = mergeCalendar(classified.data, response(restored), { profileId: "profile" });
  assert.equal(task(recovered).locked, true);
  assert.equal(task(recovered).type, "activity");
});

test("An ambiguous purpose cannot turn the restriction into a permanent lock after clarification", () => {
  for (const preLocked of [false, true]) {
    const { restricted, restored } = temporarilyRestrictedLegacy({ locked: preLocked }, { canManage: false, description: "Maybe deadline." });
    assert.equal(task(restricted).semanticPendingLock.locked, true);
    restored.description = "Maybe deadline.";
    const recovered = mergeCalendar(restricted.data, response(restored), { profileId: "profile" });
    assert.equal(task(recovered).locked, true);
    const clarified = applySemanticDecision(recovered.data, task(recovered).id, "learning");
    assert.equal(task(clarified).semanticPendingLock, undefined);
    const next = mergeCalendar(clarified.data, response(restored), { profileId: "profile" });
    assert.equal(task(next).locked, preLocked);
    assert.equal(task(next).calendarRestrictionLock, undefined);
    assert.equal(syncResumeProposal(next.data).items.length, preLocked ? 0 : 1);
  }
});

// Classification matrix: one-time selections and stored rules, before and after source recovery,
// with and without an existing explicit user lock.
for (const rule of [{ kind: "task" }, { kind: "learning" }, { kind: "fixed" }, { kind: "task", locked: true }, { kind: "learning", locked: true }])
for (const state of ["restricted", "eligible-unmanaged", "eligible-managed"])
for (const userLocked of [false, true])
test(`Classification of a restricted legacy event: ${rule.kind}${rule.locked ? "+locked" : ""} / ${state} / user-lock=${userLocked}`, () => {
  for (const storedRule of [false, true]) {
    const { restricted, restored } = temporarilyRestrictedLegacy(userLocked ? { locked: true, lockSource: "user" } : {});
    const key = calendarKey(task(restricted)), baseline = task(restricted).calendarLink.localFingerprint;
    const source = state === "restricted" ? restricted : mergeCalendar(restricted.data,
      response({ ...restored, managed: state === "eligible-managed" }), { profileId: "profile" });
    const before = structuredClone(source.data), hadMarker = task(source).calendarRestrictionLock === true;
    const classified = classifyCalendar(source.data, {
      ...(storedRule ? { rules: [{ ...rule, calendarId: restored.calendarId, match: "calendar" }] } : { selections: { [key]: rule } }),
      // A supplied reference cannot bypass the current source eligibility.
      ...(state === "restricted" ? { managedRefs: new Set([key]) } : {}),
    });
    const ownsLock = rule.kind === "fixed" || Boolean(rule.locked);
    assert.equal(task(classified).calendarRestrictionLock, hadMarker && !ownsLock ? true : undefined);
    if (rule.locked) assert.equal(task(classified).calendarClassification.locked, true);
    assert.equal(task(classified).calendarLink.managed, state === "eligible-managed");
    assert.equal(task(classified).externalReadOnly, state !== "eligible-managed");
    const unverified = mergeCalendar(classified.data, response({ ...restored, managed: false }), { profileId: "profile" });
    if (state !== "eligible-managed") {
      assert.equal(task(unverified).calendarLink.managed, false);
      assert.equal(task(unverified).externalReadOnly, true);
      assert.equal(task(unverified).locked, true);
      assert.equal(syncResumeProposal(unverified.data).items.length, 0);
    }
    let recovered = unverified;
    for (let read = 0; read < 2; read++) {
      recovered = mergeCalendar(recovered.data, response(restored), { profileId: "profile" });
      assert.equal(task(recovered).locked, userLocked || ownsLock);
      assert.equal(task(recovered).calendarLink.managed, true);
      assert.equal(task(recovered).externalReadOnly, false);
      assert.equal(task(recovered).start, 800);
      assert.equal(task(recovered).calendarLink.localFingerprint, baseline);
      assert.equal(syncResumeProposal(recovered.data).items.length, userLocked || ownsLock ? 0 : 1);
    }
    assert.equal(task(recovered).calendarRestrictionLock, undefined);
    assert.deepEqual(source.data, before);
  }
});

test("Ordinary learning reclassification can replace an explicit rule lock", () => {
  const { restricted, restored } = temporarilyRestrictedLegacy();
  const key = calendarKey(task(restricted));
  const locked = classifyCalendar(restricted.data, { selections: { [key]: { kind: "learning", locked: true } } });
  const unlocked = classifyCalendar(locked.data, { selections: { [key]: { kind: "learning", locked: false } } });
  assert.equal(task(unlocked).calendarClassification.locked, undefined);
  const recovered = mergeCalendar(unlocked.data, response(restored), { profileId: "profile" });
  assert.equal(task(recovered).locked, false);
  assert.equal(syncResumeProposal(recovered.data).items.length, 1);
});

test("Verified adoption does not erase an explicit user lock on an ordinary task", () => {
  const { restricted, restored } = temporarilyRestrictedLegacy({ locked: true, lockSource: "user" });
  const eligible = mergeCalendar(restricted.data, response({ ...restored, managed: false }));
  const key = calendarKey(task(eligible));
  const adopted = classifyCalendar(eligible.data, { selections: { [key]: { kind: "task" } }, managedRefs: new Set([key]) });
  assert.equal(task(adopted).calendarLink.managed, true);
  assert.equal(task(adopted).externalReadOnly, false);
  assert.equal(task(adopted).locked, true);
  assert.equal(task(adopted).lockSource, "user");
});

test("Semantic purpose changes retain explicit rule ownership without inventing a new rule", () => {
  for (const purpose of ["life", "external"]) {
    const { restricted, restored } = temporarilyRestrictedLegacy();
    const eligible = mergeCalendar(restricted.data, response(restored));
    const key = calendarKey(task(eligible));
    let current = classifyCalendar(eligible.data, { selections: { [key]: { kind: "learning", locked: true } } });
    for (const choice of [purpose, "learning"]) {
      current = applySemanticDecision(current.data, task(current).id, choice);
      assert.equal(task(current).calendarClassification.locked, true);
      assert.equal(task(current).locked, true);
    }
    const reclassified = classifyCalendar(current.data, { selections: { [key]: { kind: "learning" } } });
    assert.equal(task(reclassified).calendarClassification.locked, undefined);
  }
});

// A managed, rule-classified item read with a verified management mapping.
function reconnectFixture({ pending = false, kind = "task", guard = {} } = {}) {
  const original = event({ summary: kind === "learning" ? "SQL practice" : "Opaque source item", canManage: true,
    managed: true, managedUid: "reconnect-uid", managedProfileId: "profile", baselineEtag: '"v1"' });
  let result = mergeCalendar(blank(), response(original), { profileId: "profile" });
  result = classifyCalendar(result.data, { rules: [{ match: "calendar", calendarId: original.calendarId, kind, manage: true }] });
  Object.assign(task(result), guard);
  if (pending) task(result).start = 800;
  return { result, original, key: calendarKey(task(result)) };
}

test("On reconnect an explicit server false revokes ordinary and pending management despite stale references", () => {
  for (const pending of [false, true]) for (const nested of [false, true]) {
    const { result, original, key } = reconnectFixture({ pending }), before = structuredClone(result.data);
    const incoming = nested ? { event: original, managed: false } : { ...original, managed: false };
    let current = mergeCalendar(result.data, response(incoming), { profileId: "profile", managedRefs: new Set([key]) });
    for (let n = 0; n < 2; n++) {
      assert.equal(task(current).calendarLink.managed, false);
      assert.equal(task(current).calendarLink.adoptedEtag, undefined);
      assert.equal(task(current).externalReadOnly, true); assert.equal(task(current).locked, true);
      assert.equal(task(current).calendarRestrictionLock, true);
      assert.equal(task(current).start, pending ? 800 : 660);
      assert.equal(task(current).calendarLink.localFingerprint, task(result).calendarLink.localFingerprint);
      assert.equal(syncResumeProposal(current.data).items.length, 0);
      current = mergeCalendar(current.data, response(incoming), { profileId: "profile" });
    }
    assert.deepEqual(result.data, before);
  }
});

test("On reconnect missing management metadata or an absent event does not revoke historical consent", () => {
  const { result, original } = reconnectFixture();
  const legacy = { ...original }; delete legacy.managed; delete legacy.managedUid; delete legacy.managedProfileId; delete legacy.baselineEtag;
  for (const read of [response(), response(legacy)]) {
    const current = mergeCalendar(result.data, read, { profileId: "profile" });
    assert.equal(task(current).calendarLink.managed, true);
    assert.equal(task(current).calendarLink.adoptedEtag, '"v1"');
    assert.equal(task(current).externalReadOnly, false); assert.equal(task(current).locked, false);
  }
});

test("On reconnect fresh verification restores only the new restriction lock and preserves prior locks", () => {
  for (const pending of [false, true]) for (const kind of ["task", "learning"]) for (const guard of [
    {}, { locked: true }, { locked: true, lockSource: "user" }, { timeLocked: true },
  ]) {
    const { result, original } = reconnectFixture({ pending, kind, guard });
    const lost = mergeCalendar(result.data, response({ ...original, managed: false }), { profileId: "profile" });
    let current = mergeCalendar(lost.data, response(original), { profileId: "profile" });
    for (let n = 0; n < 2; n++) {
      assert.equal(task(current).calendarLink.managed, true);
      assert.equal(task(current).calendarLink.adoptedEtag, '"v1"');
      assert.equal(task(current).externalReadOnly, false);
      assert.equal(task(current).locked, Boolean(guard.locked || guard.timeLocked), JSON.stringify({ pending, kind, guard }));
      assert.equal(task(current).calendarLink.lockedBeforeManagementLoss, undefined);
      assert.equal(task(current).start, pending ? 800 : 660);
      assert.equal(task(current).calendarLink.localFingerprint, task(result).calendarLink.localFingerprint);
      if (guard.lockSource) assert.equal(task(current).lockSource, guard.lockSource);
      current = mergeCalendar(current.data, response(original), { profileId: "profile" });
    }
  }
  const { result, original } = reconnectFixture({ kind: "fixed" });
  const lost = mergeCalendar(result.data, response({ ...original, managed: false }));
  const restored = mergeCalendar(lost.data, response(original), { profileId: "profile" });
  assert.equal(task(restored).type, "activity"); assert.equal(task(restored).locked, true);
});

test("On reconnect cancellation, bad dates and conflicts cannot preserve stale verification", () => {
  for (const variant of ["cancelled", "invalid", "conflict"]) {
    const { result, original } = reconnectFixture({ pending: true });
    const incoming = { ...original, managed: false, ...(variant === "cancelled" ? { status: "cancelled" }
      : variant === "invalid" ? { start: { dateTime: "invalid" } }
      : { etag: '"v2"', start: { dateTime: "2026-10-12T14:00:00-07:00" }, end: { dateTime: "2026-10-12T15:00:00-07:00" } }) };
    const current = mergeCalendar(result.data, response(incoming), { profileId: "profile" });
    assert.equal(task(current).calendarLink.managed, false, variant);
    assert.equal(task(current).calendarLink.adoptedEtag, undefined);
    assert.equal(task(current).externalReadOnly, true); assert.equal(task(current).locked, true);
    assert.equal(task(current).start, 800);
    assert.equal(task(current).calendarLink.localFingerprint, task(result).calendarLink.localFingerprint);
  }
});

test("On reconnect a true rule requires renewed adoption, and an explicit false continues to veto it", () => {
  const { result, original, key } = reconnectFixture({ guard: { locked: true } });
  const lost = mergeCalendar(result.data, response({ ...original, managed: false }), { profileId: "profile" });
  assert.equal(task(classifyCalendar(lost.data, {})).calendarLink.managed, false);
  const adopted = classifyCalendar(lost.data, { managedRefs: new Set([key]) });
  assert.equal(task(adopted).calendarLink.managed, true); assert.equal(task(adopted).locked, true);
  assert.equal(task(adopted).calendarLink.lockedBeforeManagementLoss, undefined);
  const veto = classifyCalendar(lost.data, { rules: [{ match: "calendar", kind: "task", manage: false }] });
  const refreshed = mergeCalendar(veto.data, response(original), { profileId: "profile" });
  assert.equal(task(refreshed).calendarClassification.manage, false);
  assert.equal(task(refreshed).calendarLink.managed, false);
  assert.equal(task(refreshed).externalReadOnly, true); assert.equal(task(refreshed).locked, true);
});
