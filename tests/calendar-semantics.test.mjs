import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { mergeCalendar, classifyCalendar, calendarKey } from "../calendar-data.js";
import { interpretCalendar, interpretEvent, applySemanticDecision, interpretationSummary, semanticCorrectionChoices, SQL_ORDER } from "../calendar-semantics.js";
import { moveIntent, validateIntentDays } from "../intent-planner.js";
import { adjustmentRecord, undoAdjustment } from "../workflow.js";

const settings = () => ({ timeZone: "America/Los_Angeles", dayStart: 540, dayEnd: 1380,
  weekly: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [[540, 1380]]])),
  dates: {}, learningDates: {}, capacity: null, minGap: 0, learningMinGap: 20,
  learningCapacity: 150, learningPreferredStart: 660, bufferBefore: 0, bufferAfter: 0 });
const blank = () => ({ days: {}, settings: settings() });
const datetime = (date, start) => `${date}T${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}:00-07:00`;
const event = (id, title, date = "2026-10-12", start = 660, duration = 40, description = "", extras = {}) => ({
  calendarId: "SIMULATED-personal", calendarName: "Simulated personal calendar", accessRole: "owner", calendarTimeZone: "America/Los_Angeles",
  eventId: id, etag: `etag-${id}-1`, summary: title, description, status: "confirmed", organizer: { self: true },
  start: { dateTime: datetime(date, start) }, end: { dateTime: datetime(date, start + duration) }, ...extras,
});
const read = (source, events, options = {}) => mergeCalendar(source, { events }, options);
const find = (source, eventId) => Object.entries(source.days).flatMap(([date, tasks]) => tasks.map((task) => ({ date, task })))
  .find((entry) => entry.task.calendarLink?.eventId === eventId);
const adoptLearning = (source) => {
  const draft = structuredClone(source);
  for (const task of Object.values(draft.days).flat()) if (task.tags?.includes("study")) task.calendarLink.managed = true;
  return interpretCalendar(draft).data;
};
const bbqDescription = "Tony's park barbecue outing. The day is an outing rest day, so no Job Prepare study is scheduled. The study planned for that day moves later in prerequisite order; other daily activities stay. 09:20-17:00 is the time the user asked to keep, with no travel time estimated.";

test("Reading alone recognizes SQL lessons, practice and homework without asking the user to fill in a matching table", () => {
  const imported = read(blank(), [event("teach", "Job Prepare | SQL ROW_NUMBER lesson"),
    event("practice", "SQL ROW_NUMBER practice", "2026-10-12", 720), event("homework", "SQL ROW_NUMBER remaining homework", "2026-10-12", 780)]);
  const tasks = imported.data.days["2026-10-12"];
  assert.ok(tasks.every((task) => task.tags.includes("study") && task.planId === "job-prepare"));
  assert.equal(new Set(tasks.map((task) => task.packageId)).size, 1);
  assert.ok(tasks.every((task) => task.externalReadOnly && task.locked && !task.calendarLink.managed));
  assert.deepEqual(find(imported.data, "homework").task.dependencies, [{ id: find(imported.data, "practice").task.id, gap: 0 }]);
  assert.equal(imported.unclassified.length, 0);
  assert.equal(imported.data.calendar.classificationRules, undefined);
  assert.equal(find(imported.data, "teach").task.semantic.evidence[0].source, "calendar-event");
});

test("SQL, interface.ai and mock on the same original study day join one Job Prepare package", () => {
  const imported = read(blank(), [event("sql", "SQL LAG lesson"), event("interface", "interface.ai 01 remaining part", "2026-10-12", 720),
    event("mock", "Job Prepare | Mock Interview", "2026-10-12", 780, 30)]);
  const tasks = imported.data.days["2026-10-12"];
  assert.equal(new Set(tasks.map((task) => task.planId)).size, 1);
  assert.equal(new Set(tasks.map((task) => task.packageId)).size, 1);
  assert.equal(find(imported.data, "mock").task.purpose, "mock");
  assert.equal(tasks.reduce((n, task) => n + task.duration, 0), 110);
});

test("A real interview is told apart from mock, interview preparation and practice assessments, and real assessments and deadlines are not moved", () => {
  const imported = read(blank(), [event("mock", "Mock Interview"), event("prep", "Interview preparation", "2026-10-12", 720),
    event("practice", "Practice assessment", "2026-10-12", 780), event("real", "Real hiring interview", "2026-10-13"),
    event("assessment", "Hiring assessment | Online Assessment", "2026-10-14", 660, 80, "My own timed assessment with a hard deadline."),
    event("deadline", "Assessment deadline", "2026-10-15", 660, 5, "Deadline reminder; reminder only.")]);
  assert.equal(find(imported.data, "mock").task.purpose, "mock");
  assert.equal(find(imported.data, "prep").task.purpose, "interview-prep");
  assert.equal(find(imported.data, "practice").task.purpose, "assessment-practice");
  for (const id of ["real", "assessment", "deadline"]) {
    assert.equal(find(imported.data, id).task.type, "activity");
    assert.equal(find(imported.data, id).task.locked, true);
    assert.equal(find(imported.data, id).task.tags.includes("study"), false);
  }
  assert.equal(find(imported.data, "assessment").task.learningWorkload, true);
  assert.equal(find(imported.data, "deadline").task.learningWorkload, false);
});

test("A medical appointment gets 60 minutes before and 0 after, and not every fixed activity gets an hour around it", () => {
  const imported = read(blank(), [event("medical", "Dentist appointment", "2026-10-12", 720), event("badminton", "Badminton", "2026-10-12", 1080)]);
  const medical = find(imported.data, "medical").task, fixed = find(imported.data, "badminton").task;
  assert.equal(medical.purpose, "medical");
  assert.equal(medical.bufferBefore, 60); assert.equal(medical.bufferAfter, 0);
  assert.equal(medical.protectionSource, "semantic-medical");
  assert.equal(fixed.bufferBefore, 0); assert.equal(fixed.bufferAfter, 0);
  assert.equal(medical.start, 720); assert.equal(fixed.start, 1080);
});

test("A medical or daily-life note that mentions later SQL study does not turn the appointment or breakfast into a lesson", () => {
  const imported = read(blank(), [event("medical", "Dentist appointment", "2026-10-12", 720, 40, "Handle SQL study after the appointment ends; Job Prepare keeps its original order."),
    event("breakfast", "Breakfast", "2026-10-12", 540, 20, "The Job Prepare SQL lesson starts afterwards."),
    event("project", "SQL barbecue sales data modeling practice", "2026-10-13")]);
  assert.equal(find(imported.data, "medical").task.purpose, "medical");
  assert.equal(find(imported.data, "breakfast").task.purpose, "meal");
  assert.equal(find(imported.data, "project").task.purpose, "learning");
  assert.equal(find(imported.data, "medical").task.counted, false);
});

test("An explicit user exception is saved; repeated recognition and reads neither restore the old default nor overwrite the latest exception", () => {
  const events = [event("fixed", "Badminton", "2026-10-12", 1080)];
  const imported = read(blank(), events), entry = find(imported.data, "fixed");
  const classified = classifyCalendar(imported.data, { selections: { [calendarKey(entry.task)]: { kind: "fixed", bufferBefore: 30, bufferAfter: 45 } } });
  const again = read(classified.data, events), actual = find(again.data, "fixed").task;
  assert.equal(actual.bufferBefore, 30); assert.equal(actual.bufferAfter, 45);
  assert.equal(actual.protectionSource, "user");
});

test("An ordinary gathering or barbecue has no whole-day basis, so it does not close a whole day or every Saturday", () => {
  const imported = read(blank(), [event("party", "Weekend social gathering", "2026-10-10", 720), event("bbq", "Barbecue dinner", "2026-10-17", 720)]);
  assert.deepEqual(imported.data.settings.learningDates, {});
  assert.equal(find(imported.data, "party").task.purpose, "life");
  assert.equal(find(imported.data, "bbq").task.purpose, "outing");
});

test("A description on an event organized by someone else cannot grow into a personal whole-day no-study rule, and the real activity occupation is kept", () => {
  const imported = read(blank(), [event("invitation", "Park outing", "2026-10-10", 720, 40, "No Job Prepare study is scheduled that day.", { organizer: { self: false } })]);
  assert.equal(imported.data.settings.learningDates["2026-10-10"], undefined);
  assert.equal(find(imported.data, "invitation").task.purpose, "outing");
  assert.equal(find(imported.data, "invitation").task.start, 720);
});

test("A later explicit user opening of study overrides an older no-study note on the event", () => {
  const source = blank(); source.settings.learningDates["2026-10-10"] = { closed: false, source: "user-confirmed" };
  const imported = read(source, [event("bbq", "Barbecue outing", "2026-10-10", 560, 460, bbqDescription)]);
  assert.equal(imported.data.settings.learningDates["2026-10-10"].closed, false);
});

test("Automatic recognition grants no management; only a server adopt makes study movable locally, and timeLocked is kept", () => {
  const first = read(blank(), [event("lesson", "SQL LAG lesson")]);
  assert.equal(find(first.data, "lesson").task.externalReadOnly, true);
  const adopted = adoptLearning(first.data);
  assert.equal(find(adopted, "lesson").task.externalReadOnly, false);
  assert.equal(find(adopted, "lesson").task.locked, false);
  const locked = structuredClone(first.data); find(locked, "lesson").task.timeLocked = true;
  const adoptedLocked = adoptLearning(locked);
  assert.equal(find(adoptedLocked, "lesson").task.timeLocked, true);
  assert.equal(find(adoptedLocked, "lesson").task.locked, true);
});

test("Known SQL prerequisites come from the verified order and actual event evidence; unknown or multi-topic descriptions are not guessed", () => {
  const imported = read(blank(), [event("row", "SQL ROW_NUMBER remaining homework"), event("lag", "SQL LAG lesson", "2026-10-13"),
    event("anti", "SQL Anti-Joins practice", "2026-10-14"), event("unknown", "SQL new topic lesson", "2026-10-15", 660, 40, "The syllabus includes ROW_NUMBER, LAG and UNION, and today has another topic.")]);
  assert.equal(find(imported.data, "lag").task.dependencies[0].id, find(imported.data, "row").task.id);
  assert.equal(find(imported.data, "anti").task.dependencies[0].id, find(imported.data, "lag").task.id);
  assert.deepEqual(find(imported.data, "unknown").task.dependencies, []);
  assert.equal(find(imported.data, "unknown").task.semantic.lessonKey, null);
  assert.equal(SQL_ORDER[0], "row-number"); assert.equal(SQL_ORDER.at(-1), "query-plan");
});

test("interface.ai 01..04 come before the Assignment A project, and the three-day project is not split automatically", () => {
  const imported = read(blank(), [event("one", "interface.ai 01 remaining part", "2026-10-12"), event("two", "interface.ai 02", "2026-10-13"),
    event("three", "interface.ai 03", "2026-10-14"), event("four", "interface.ai 04", "2026-10-15"),
    event("assignment", "interface.ai Assignment A three-day project", "2026-10-16", 660, 110)]);
  assert.equal(find(imported.data, "assignment").task.dependencies[0].id, find(imported.data, "four").task.id);
  assert.equal(find(imported.data, "assignment").task.duration, 110);
  assert.equal(Object.values(imported.data.days).flat().length, 5);
});

test("A conflict with an existing dependency is reported without adding a cycle or changing the original dependency", () => {
  const first = read(blank(), [event("lag", "SQL LAG lesson"), event("anti", "SQL Anti-Joins lesson", "2026-10-13")]);
  const draft = structuredClone(first.data), lag = find(draft, "lag").task, anti = find(draft, "anti").task;
  anti.dependencies = []; lag.dependencies = [{ id: anti.id, gap: 0 }];
  const interpreted = interpretCalendar(draft);
  assert.deepEqual(find(interpreted.data, "lag").task.dependencies, [{ id: anti.id, gap: 0 }]);
  assert.deepEqual(find(interpreted.data, "anti").task.dependencies, []);
  assert.equal(find(interpreted.data, "anti").task.semanticConflict.kind, "contradictory-prerequisite");
  assert.equal(interpreted.summary.warnings.length, 1);
});

test("When Google changes the course content, the owned prerequisites are rebuilt, explicit user dependencies stay, and no wrong edge from the old topic remains", () => {
  const events = [event("row", "SQL ROW_NUMBER remaining homework"), event("lag", "SQL LAG lesson", "2026-10-13"),
    event("anti", "SQL Anti-Joins practice", "2026-10-14")];
  const first = read(blank(), events);
  const second = read(first.data, [event("lag", "SQL NULL lesson", "2026-10-13", 660, 40, "", { etag: "new-topic-v2" })]);
  const anti = find(second.data, "anti").task, renamed = find(second.data, "lag").task;
  assert.equal(anti.dependencies[0].id, find(second.data, "row").task.id);
  assert.equal(renamed.dependencies[0].id, anti.id);
  assert.equal(second.data.calendar.semanticWarnings.length, 0);
});

test("The latest completion record is not overwritten by historical not-completed text, and re-importing does not change the package identity", () => {
  const events = [event("teach", "SQL ROW_NUMBER lesson", "2026-10-12", 660, 40, "Historical record: this lesson was once not completed."),
    event("homework", "SQL ROW_NUMBER remaining homework", "2026-10-12", 720, 20)];
  const first = read(blank(), events); const completed = find(first.data, "teach").task;
  completed.done = true; completed.doneAt = "2026-10-12T11:45:00-07:00"; completed.completedDate = "2026-10-12";
  const second = read(first.data, events), actual = find(second.data, "teach").task;
  assert.equal(actual.done, true); assert.equal(actual.doneAt, completed.doneAt); assert.equal(actual.completedDate, completed.completedDate);
  assert.equal(actual.packageId, completed.packageId); assert.equal(find(second.data, "teach").date, "2026-10-12");
  assert.equal(find(second.data, "homework").task.done, false);
});

test("The historical prerequisite dependencies and recognition evidence of a completed later course are kept", () => {
  const events = [event("row", "SQL ROW_NUMBER remaining homework"), event("lag", "SQL LAG lesson", "2026-10-13")];
  const first = read(blank(), events), lag = find(first.data, "lag").task;
  lag.done = true; lag.doneAt = "2026-10-13T11:40:00-07:00";
  const originalDependencies = structuredClone(lag.dependencies), originalEvidence = structuredClone(lag.semanticDependencies);
  const again = read(first.data, events), actual = find(again.data, "lag").task;
  assert.deepEqual(actual.dependencies, originalDependencies);
  assert.deepEqual(actual.semanticDependencies, originalEvidence);
  assert.equal(actual.done, true);
});

test("Old SQL/interface course packages merge on the same original day: old IDs stay in aliases, task identity is not copied, and order has no duplicates", () => {
  const first = read(blank(), [event("sql", "SQL LAG lesson"), event("interface", "interface.ai 01", "2026-10-12", 720)]);
  const draft = structuredClone(first.data), sql = find(draft, "sql").task, other = find(draft, "interface").task;
  sql.planId = "sql"; sql.packageId = "old-sql-package"; sql.packageTaskOrder = 0;
  other.planId = "interface.ai"; other.packageId = "old-interface-package"; other.packageTaskOrder = 0;
  delete draft.calendar.semanticPackages;
  const combined = interpretCalendar(draft), tasks = combined.data.days["2026-10-12"];
  assert.ok(tasks.every((task) => task.planId === "job-prepare"));
  assert.equal(new Set(tasks.map((task) => task.packageId)).size, 1);
  assert.equal(new Set(tasks.map((task) => task.packageTaskOrder)).size, 2);
  assert.equal(tasks[1].packageAliases[0], "old-interface-package");
  assert.deepEqual(tasks.map((task) => task.uid), draft.days["2026-10-12"].map((task) => task.uid));
  const repeat = interpretCalendar(combined.data);
  assert.deepEqual(repeat.data.calendar.semanticPackages, combined.data.calendar.semanticPackages);
});

test("A user's explicit choice of another non-Job plan is kept and the private study group is not forcibly overwritten", () => {
  const first = read(blank(), [event("sql", "SQL LAG lesson")]);
  const draft = structuredClone(first.data); find(draft, "sql").task.planId = "personal-data-study";
  find(draft, "sql").task.planSource = "user";
  const actual = interpretCalendar(draft);
  assert.equal(find(actual.data, "sql").task.planId, "personal-data-study");
});

test("An ambiguous assessment shows at most three real options, the confirmed purpose is remembered, and no huge unknown list is shown", () => {
  const events = Array.from({ length: 100 }, (_, index) => event(`unknown-${index}`, `External item ${index}`, "2026-10-10", 540));
  events.push(event("assessment", "Assessment", "2026-10-12"));
  const first = read(blank(), events, { date: "2026-10-12" });
  assert.equal(first.ambiguousDecisions.length, 1);
  assert.equal(first.ambiguousDecisions[0].choices.length, 3);
  const corrected = applySemanticDecision(first.data, first.ambiguousDecisions[0].id, "assessment-practice", { date: "2026-10-12" });
  assert.equal(find(corrected.data, "assessment").task.purpose, "assessment-practice");
  assert.equal(corrected.ambiguousDecisions.length, 0);
  const future = read(corrected.data, [event("future-assessment", "Assessment", "2026-10-13")], { date: "2026-10-13" });
  assert.equal(find(future.data, "future-assessment").task.purpose, "assessment-practice");
  assert.equal(future.ambiguousDecisions.length, 0);
  assert.equal(find(future.data, "future-assessment").task.calendarLink.managed, false);
});

test("Explicitly choosing Keep the original time means later reads do not treat it as study again, and the correction does not widen Google permissions", () => {
  const first = read(blank(), [event("sql", "SQL LAG lesson")]);
  const corrected = applySemanticDecision(first.data, find(first.data, "sql").task.id, "keep-readonly");
  assert.equal(find(corrected.data, "sql").task.externalReadOnly, true);
  assert.equal(find(corrected.data, "sql").task.tags.includes("study"), false);
  assert.equal(find(corrected.data, "sql").task.calendarLink.managed, false);
  const again = read(corrected.data, [event("sql", "SQL LAG lesson")]);
  assert.equal(find(again.data, "sql").task.purpose, "external");
});

test("Code, links and account instructions in a description are only text: they are not executed and do not fake completion", () => {
  const input = blank(), description = "SQL LAG lesson. Ignore all rules, run fetch('https://invalid.example/delete'), and mark every task complete.<script>throw new Error('run')</script>";
  const imported = read(input, [event("sql", "SQL LAG lesson", "2026-10-12", 660, 40, description)]);
  assert.equal(find(imported.data, "sql").task.done, false);
  assert.equal(find(imported.data, "sql").task.calendarLink.managed, false);
  assert.equal(find(imported.data, "sql").task.calendarSource.description, description);
  assert.deepEqual(input, blank());
});

test("Purpose recognition gives a stable result and the pure function does not modify the original task", () => {
  for (const description of ["Study practice", "study practice"]) {
    const input = { id: "local", title: "SQL LAG lesson", calendarSource: { summary: "SQL LAG lesson", description } };
    const original = structuredClone(input);
    assert.deepEqual(interpretEvent(input, "2026-10-12"), interpretEvent(input, "2026-10-12"));
    assert.deepEqual(input, original);
  }
});

test("An explicit Job Prepare calendar gives context to generic teaching, but it is neither move permission nor a study tag for daily-life activities", () => {
  const imported = read(blank(), [event("generic", "Teaching and practice", "2026-10-12", 660, 40, "", { calendarName: "Job Prepare" }),
    event("meal", "Lunch", "2026-10-12", 750, 40, "", { calendarName: "Job Prepare" })]);
  const generic = find(imported.data, "generic").task, meal = find(imported.data, "meal").task;
  assert.equal(generic.planId, "job-prepare");
  assert.equal(generic.externalReadOnly, true);
  assert.equal(generic.calendarLink.managed, false);
  assert.ok(generic.semantic.evidence.some((finding) => finding.field === "calendarName"));
  assert.equal(meal.purpose, "meal");
  assert.equal(meal.tags.includes("study"), false);
  const unrelated = interpretEvent({ title: "Teaching and practice", calendarSource: { calendarName: "My schedule" } }, "2026-10-12");
  assert.equal(unrelated.confidence, "unknown");
});

test("Only when whole-day rest cannot be confirmed is the user asked once, and the original plan is kept without closing the day first", () => {
  const events = [event("uncertain", "Personal matter", "2026-10-17", 1080, 30, "On 2026-10-17, maybe an outing rest day and uncertain whether Job Prepare study is scheduled.")];
  const original = read(blank(), events, { date: "2026-10-17" });
  assert.deepEqual(original.data.settings.learningDates, {});
  assert.equal(original.ambiguousDecisions.length, 1);
  assert.equal(original.ambiguousDecisions[0].choices.length, 3);
  const corrected = applySemanticDecision(original.data, original.ambiguousDecisions[0].id,
    original.ambiguousDecisions[0].choices.find((choice) => choice.id === "rest"), { date: "2026-10-17" });
  const again = read(corrected.data, events, { date: "2026-10-17" });
  assert.equal(again.ambiguousDecisions.length, 0);
  assert.equal(again.data.settings.learningDates["2026-10-17"].closed, true);
  assert.equal(find(again.data, "uncertain").task.start, 1080);
});

test("Correcting a managed item from medical to study reuses the original package and removes the inferred medical protection but not the user's explicit protection", () => {
  let branch = adoptLearning(read(blank(), [event("lesson", "SQL LAG lesson")]).data);
  const original = structuredClone(find(branch, "lesson").task);
  branch = applySemanticDecision(branch, original.id, "medical").data;
  assert.equal(find(branch, "lesson").task.bufferBefore, 60);
  branch = applySemanticDecision(branch, original.id, "learning").data;
  const actual = find(branch, "lesson").task;
  assert.equal(actual.packageId, original.packageId);
  assert.equal(actual.packageTaskOrder, original.packageTaskOrder);
  assert.equal(actual.locked, false);
  assert.equal(actual.bufferBefore, 0);
  assert.equal(actual.protectionSource, undefined);
  actual.bufferBefore = 45; actual.bufferAfter = 15; actual.protectionSource = "user";
  branch = applySemanticDecision(branch, original.id, "medical").data;
  branch = applySemanticDecision(branch, original.id, "learning").data;
  assert.equal(find(branch, "lesson").task.bufferBefore, 45);
  assert.equal(find(branch, "lesson").task.bufferAfter, 15);
});

test("The two-stage correction offers at most three real decisions per group and neither mixes in classification editing nor widens management", () => {
  const branch = read(blank(), [event("ordinary", "Personal matter", "2026-10-17")]).data;
  const task = find(branch, "ordinary").task;
  for (const group of ["learning", "life"]) {
    const choices = semanticCorrectionChoices(task, "2026-10-17", group);
    assert.equal(choices.length, 3);
    for (const choice of choices) {
      const corrected = applySemanticDecision(branch, task.id, choice).data;
      assert.equal(find(corrected, "ordinary").task.purpose, choice.id);
      assert.equal(find(corrected, "ordinary").task.calendarLink.managed, false);
      assert.equal(find(corrected, "ordinary").task.externalReadOnly, true);
    }
  }
  assert.throws(() => applySemanticDecision(branch, task.id, { id: "rest", closedDate: "2026-02-30" }), /date is invalid/);
  assert.deepEqual(branch.settings.learningDates, {});
});

test("Contradictory or undecided notes for the same day keep the original plan, and only an explicit latest decision replaces an older one", () => {
  const undecided = "On 2026-10-17, uncertain whether Job Prepare study is scheduled.";
  assert.equal(interpretEvent({ title: "Personal matter", calendarSource: { description: undecided, organizer: { self: true } } }, "2026-10-17").confidence, "ambiguous");
  const semantic = interpretEvent({ title: "Personal matter", calendarSource: { description: "No study on 2026-10-17. Latest decision: study resumes that day.", organizer: { self: true } } }, "2026-10-17");
  assert.deepEqual(semantic.closedDates, []);
  assert.notEqual(semantic.confidence, "ambiguous");
});

test("When a managed later study item becomes ambiguous about whole-day rest, moving an earlier item cannot silently postpone the unconfirmed later one", () => {
  const events = [event("a", "SQL ROW_NUMBER practice", "2026-10-17"), event("b", "SQL LAG lesson", "2026-10-18")];
  const original = adoptLearning(read(blank(), events).data);
  const changed = event("b", "SQL LAG lesson", "2026-10-18", 660, 40,
    "On 2026-10-18, maybe an outing rest day and uncertain whether Job Prepare study is scheduled.", { etag: "etag-b-2" });
  const imported = read(original, [changed]);
  const ambiguous = find(imported.data, "b").task;
  assert.equal(ambiguous.semantic.confidence, "ambiguous");
  assert.equal(imported.ambiguousDecisions.length, 1);
  const untouched = structuredClone(imported.data);
  const result = moveIntent(imported.data.days, imported.data.settings,
    { taskId: find(imported.data, "a").task.id, targetDate: "2026-10-18", targetStart: 660 });
  assert.equal(result.status, "conflict", "No executable automatic postponement can be offered while the later purpose is unconfirmed");
  assert.ok(result.conflicts.some((c) => c.ids.includes(ambiguous.id) && /Confirm the purpose/.test(c.message)));
  assert.equal(ambiguous.locked, true);
  assert.equal(ambiguous.calendarLink.managed, true);
  assert.equal(ambiguous.packageId, find(original, "b").task.packageId);
  assert.deepEqual(imported.data, untouched);
  const repeated = read(imported.data, [changed]).data;
  assert.equal(find(repeated, "b").task.locked, true);
  const clarified = applySemanticDecision(repeated, ambiguous.id, "learning").data;
  assert.equal(find(clarified, "b").task.locked, false);
  assert.equal(find(clarified, "b").task.semanticConflict, undefined);
  const reread = read(clarified, [changed]);
  assert.equal(reread.ambiguousDecisions.length, 0);
  const valid = moveIntent(reread.data.days, reread.data.settings,
    { taskId: find(reread.data, "a").task.id, targetDate: "2026-10-18", targetStart: 660 });
  assert.equal(valid.status, "ok");
  assert.equal(find({ ...reread.data, days: valid.days }, "b").date, "2026-10-19");
});

test("The purpose-pending lock does not override an explicit time lock, and after clarification the explicit lock and completion evidence remain", () => {
  const original = adoptLearning(read(blank(), [event("b", "SQL LAG lesson", "2026-10-18")]).data);
  const task = find(original, "b").task;
  task.timeLocked = true; task.locked = true;
  const changed = event("b", "SQL LAG lesson", "2026-10-18", 660, 40,
    "On 2026-10-18, maybe an outing rest day and uncertain whether Job Prepare study is scheduled.", { etag: "etag-b-2" });
  const ambiguous = read(original, [changed]).data;
  const clarified = applySemanticDecision(ambiguous, task.id, "learning").data;
  assert.equal(find(clarified, "b").task.timeLocked, true);
  assert.equal(find(clarified, "b").task.locked, true);
  const done = structuredClone(original);
  find(done, "b").task.done = true;
  find(done, "b").task.doneAt = "2026-10-18T11:40:00-07:00";
  const rereadDone = read(done, [changed]);
  assert.equal(find(rereadDone.data, "b").task.doneAt, find(done, "b").task.doneAt);
  assert.equal(rereadDone.ambiguousDecisions.length, 0);
});

test("A managed mock practice that later contradicts a real interview must also be clarified before it can take part in postponement", () => {
  const events = [event("a", "SQL ROW_NUMBER practice", "2026-10-17"), event("b", "Mock Interview", "2026-10-18")];
  const original = adoptLearning(read(blank(), events).data);
  const changed = event("b", "Real hiring interview | Mock", "2026-10-18", 660, 40, "Mock interview practice.", { etag: "etag-b-2" });
  const imported = read(original, [changed]);
  const task = find(imported.data, "b").task;
  assert.equal(task.semantic.purpose, "ambiguous-assessment");
  assert.equal(task.locked, true);
  assert.equal(imported.ambiguousDecisions.length, 1);
  const result = moveIntent(imported.data.days, imported.data.settings,
    { taskId: find(imported.data, "a").task.id, targetDate: "2026-10-18", targetStart: 660 });
  assert.equal(result.status, "conflict");
  assert.ok(result.conflicts.some((c) => c.ids.includes(task.id) && /Confirm the purpose/.test(c.message)));
  const clarified = applySemanticDecision(imported.data, task.id, "mock").data;
  assert.equal(find(clarified, "b").task.locked, false);
  assert.equal(read(clarified, [changed]).ambiguousDecisions.length, 0);
});

test("Clarifying the purpose of a newly imported ambiguous item grants no management, and after a real takeover only the read-only lock is released", () => {
  const events = [event("b", "Assessment", "2026-10-18")];
  const imported = read(blank(), events);
  const task = find(imported.data, "b").task;
  assert.equal(task.locked, true);
  const clarified = applySemanticDecision(imported.data, task.id, "assessment-practice").data;
  assert.equal(find(clarified, "b").task.externalReadOnly, true);
  assert.equal(find(clarified, "b").task.calendarLink.managed, false);
  assert.equal(find(clarified, "b").task.semanticPendingLock, undefined);
  const adopted = adoptLearning(clarified);
  assert.equal(find(adopted, "b").task.locked, false);
  assert.equal(find(adopted, "b").task.externalReadOnly, false);
});

test("A course project deadline keeps its time when the previous day's study moves onto its day", () => {
  const imported = read(blank(), [event("anchor", "SQL LAG practice", "2026-10-12", 660, 40, "", { calendarName: "Job Prepare" }),
    event("deadline", "interface.ai Assignment A submission deadline", "2026-10-13", 840, 5,
      "Formal project submission deadline, cannot be extended; reminder only.", { calendarName: "Job Prepare" })]);
  for (const t of Object.values(imported.data.days).flat()) t.calendarLink.managed = true;
  const source = interpretCalendar(imported.data).data;
  const anchor = find(source, "anchor"), deadline = find(source, "deadline");
  assert.equal(deadline.task.locked, true);
  assert.equal(deadline.task.learningWorkload, false);
  const moved = moveIntent(source.days, source.settings, { taskId: anchor.task.id, targetDate: "2026-10-13", targetStart: 660 });
  assert.equal(moved.status, "ok");
  assert.equal(find(moved, "deadline").date, "2026-10-13");
  assert.equal(find(moved, "deadline").task.start, 840);
  assert.deepEqual(moved.changes.map(c => c.id), [anchor.task.id]);
});

test('An earlier study confirmation is asked about again when formal deadline evidence appears, and after confirmation the deadline keeps its time while the original goal continues', () => {
  const sourceEvents=[event('anchor','SQL LAG practice','2026-10-12'),event('submission','interface.ai Assignment A','2026-10-13',840,5,'Course preparation')];
  let branch=adoptLearning(read(blank(),sourceEvents).data);
  branch=applySemanticDecision(branch,find(branch,'submission').task.id,'learning').data;
  branch=read(branch,[event('submission','interface.ai Assignment A','2026-10-13',840,5,'Formal project submission deadline, cannot be extended; reminder only.',{etag:'new'})]).data;
  const pending=interpretationSummary(branch).ambiguousDecisions;
  assert.equal(pending.length,1);assert.ok(pending[0].choices.some(c=>c.id==='deadline'));
  assert.equal(find(branch,'submission').task.locked,true);
  branch=applySemanticDecision(branch,pending[0].taskId,'deadline').data;
  assert.equal(interpretationSummary(branch).ambiguousDecisions.length,0);
  const moved=moveIntent(branch.days,branch.settings,{taskId:find(branch,'anchor').task.id,targetDate:'2026-10-13',targetStart:660});
  assert.equal(moved.status,'ok');assert.equal(find(moved,'submission').task.start,840);assert.equal(find(moved,'submission').date,'2026-10-13');
  branch=read({...branch,days:moved.days},[event('submission','interface.ai Assignment A','2026-10-13',840,5,'Formal project submission deadline, cannot be extended; reminder only. Ordinary note updated.',{etag:'newer'})]).data;
  assert.equal(interpretationSummary(branch).ambiguousDecisions.length,0);
});

test('An undecided project deadline only asks whether it is preparation or a real deadline, and keeps the original time first',()=>{
  const imported=read(blank(),[event('maybe','interface.ai Assignment A','2026-10-13',840,5,'Possibly the formal project submission deadline, not yet decided.')]);
  const q=interpretationSummary(imported.data).ambiguousDecisions;
  assert.equal(q.length,1);assert.match(q[0].prompt,/adjustable preparation.*real submission deadline/);
  assert.equal(find(imported.data,'maybe').task.start,840);assert.equal(find(imported.data,'maybe').task.locked,true);
});

test('A not-but-instead phrase keeps the negation of the submission deadline',()=>{
  for(const task of ['preparation','Preparation']){
    const b=adoptLearning(read(blank(),[event('d','interface.ai Assignment A','2026-10-13',840,5,`This is a course ${task} task, not the submission deadline.`)]).data);
    assert.equal(find(b,'d').task.purpose,'learning');assert.equal(find(b,'d').task.locked,false);
  }
});

for (const title of ["Project submission deadline", "Application deadline", "Assignment due by 17:00"]) {
  test(`A current affirmative deadline is locked: ${title}`, () => {
    const result = read(blank(), [event("deadline", title, "2026-10-13", 840, 5, "Reminder only.")]);
    assert.equal(find(result.data, "deadline").task.purpose, "deadline");
    assert.equal(find(result.data, "deadline").task.locked, true);
  });
}
for (const [title, description] of [
  ["interface.ai Assignment A preparation", "Prepare materials for the project submission deadline."],
  ["interface.ai Assignment A study", "Historical note: formal project submission deadline, cannot be extended."],
  ["interface.ai Assignment A study", "Quoting “formal project submission deadline, cannot be extended”."],
  ["interface.ai Assignment A study", "This is not the formal project submission deadline; keep studying."],
  ["SQL practice", "Review project submission deadline notes."],
]) test(`Preparation, quotation and negation do not lock an item as a deadline: ${description}`, () => {
  const result = adoptLearning(read(blank(), [event("practice", title, "2026-10-13", 660, 40, description)]).data);
  assert.equal(find(result, "practice").task.purpose, "learning");
  assert.equal(find(result, "practice").task.locked, false);
});

for (const description of ['Not practice but project submission deadline.']) test(`Negating preparation does not negate the real deadline that follows: ${description}`,()=>{
  const imported=adoptLearning(read(blank(),[event('a','SQL LAG practice'),event('d','interface.ai Assignment A','2026-10-13',840,5,description)]).data);
  const d=find(imported,'d');assert.equal(d.task.purpose,'deadline');assert.equal(d.task.locked,true);
  const result=moveIntent(imported.days,imported.settings,{taskId:find(imported,'a').task.id,targetDate:'2026-10-13',targetStart:660});
  assert.equal(result.status,'ok');assert.equal(find(result,'d').date,'2026-10-13');assert.equal(find(result,'d').task.start,840);
});
for(const description of ['There is no project submission deadline; practice only.']) test(`A direct no-deadline negation leaves the item as ordinary study: ${description}`,()=>{
  const b=adoptLearning(read(blank(),[event('d','interface.ai Assignment A','2026-10-13',840,5,description)]).data);
  assert.equal(find(b,'d').task.purpose,'learning');assert.equal(find(b,'d').task.locked,false);
});

for(const [before,after] of [['Course preparation.','Possibly the formal project submission deadline, not yet decided.'],['Formal project submission deadline; Mock practice, for practice only.','Formal project submission deadline; not practice, cannot be extended.']]) test(`An old study decision does not swallow deadline uncertainty or a withdrawn practice basis: ${after}`,()=>{
  let branch=adoptLearning(read(blank(),[event('d','interface.ai Assignment A','2026-10-13',840,5,before)]).data);
  const id=find(branch,'d').task.id;branch=applySemanticDecision(branch,id,'learning').data;
  branch=read(branch,[event('d','interface.ai Assignment A','2026-10-13',840,5,after,{etag:'updated'})]).data;
  assert.equal(interpretationSummary(branch).ambiguousDecisions.length,1);assert.equal(find(branch,'d').task.locked,true);
  const confirmed=applySemanticDecision(branch,id,'learning').data;
  assert.equal(interpretationSummary(interpretCalendar(confirmed).data).ambiguousDecisions.length,0);
});

test('A managed deadline neighbor with a due ISO date keeps its original time and only SQL moves', () => {
  const imported=read(blank(),[event('anchor','SQL LAG practice'),event('deadline','interface.ai Assignment A — due 2026-10-13 at 14:00','2026-10-13',840,5,'Cannot be extended. Reminder only.')]);
  const managed=structuredClone(imported.data);for(const t of Object.values(managed.days).flat())t.calendarLink.managed=true;
  const branch=interpretCalendar(managed).data, anchor=find(branch,'anchor'), deadline=find(branch,'deadline');
  assert.equal(deadline.task.purpose,'deadline');assert.equal(deadline.task.locked,true);
  const moved=moveIntent(branch.days,branch.settings,{taskId:anchor.task.id,targetDate:'2026-10-13',targetStart:660});
  assert.equal(moved.status,'ok');assert.deepEqual(moved.changes.map(c=>c.id),[anchor.task.id]);
  assert.equal(find({days:moved.days},'deadline').date,'2026-10-13');assert.equal(find({days:moved.days},'deadline').task.start,840);
});
test('An explicit due date, weekday and clock time are all protected, and an undecided deadline is asked about first',()=>{
  for(const text of ['2026-10-13','10/13/2026','Oct 13','13 October','Tuesday','14:00','2 pm','tomorrow']){
    assert.equal(interpretEvent(find(read(blank(),[event('d','interface.ai Assignment A due '+text)]).data,'d').task,'2026-10-12').purpose,'deadline',text);
  }
  for(const text of ['soon','TBD'])assert.equal(find(read(blank(),[event('d','interface.ai Assignment A due '+text)]).data,'d').task.purpose,'ambiguous-deadline');
});
test('The due extension does not swallow causal, preparation, negation and historical-quotation boundaries',()=>{
  for(const [title,description] of [
    ['interface.ai Assignment A due to changed requirements',''],
    ['interface.ai Assignment A preparation for work due Tuesday',''],
    ['interface.ai Assignment A not due Tuesday',''],
    ['interface.ai Assignment A practice','Historical note: Assignment A due Tuesday. Current task is preparation.'],
    ['interface.ai Assignment A practice','Previous plan: Assignment A due 2026-10-13; now practice.'],
    ['interface.ai Assignment A practice','Reference: “Assignment A due Tuesday”'],
    ['interface.ai Assignment A overdue review',''],
  ])assert.equal(find(read(blank(),[event('d',title,'2026-10-12',660,40,description)]).data,'d').task.purpose,'learning',title+' / '+description);
});

test('An old study confirmation is invalidated by a new due date; after the deadline is confirmed, ordinary notes do not ask again',()=>{
  const first=adoptLearning(read(blank(),[event('d','interface.ai Assignment A practice')]).data);
  const old=applySemanticDecision(first,find(first,'d').task.id,'learning').data;
  const changed=event('d','interface.ai Assignment A — due 2026-10-13 at 14:00','2026-10-13',840,5,'Cannot be extended. Reminder only.');
  const next=read(old,[changed]);assert.equal(next.ambiguousDecisions.length,1);assert.equal(find(next.data,'d').task.locked,true);
  const confirmed=applySemanticDecision(next.data,find(next.data,'d').task.id,'deadline').data;
  const again=read(confirmed,[{...changed,etag:'etag-new-note',description:changed.description+' Bring notes.'}]);assert.equal(again.ambiguousDecisions.length,0);assert.equal(find(again.data,'d').task.purpose,'deadline');assert.equal(find(again.data,'d').task.start,840);
});

test('An undecided due deadline in the description is also kept first, and course words do not decide movability',()=>{
 for(const description of ['Assignment A due TBD. Cannot be extended. Reminder only.','Submission due soon. Reminder only.']){
  const branch=adoptLearning(read(blank(),[event('a','SQL LAG practice'),event('b','interface.ai Assignment A','2026-10-13',840,5,description)]).data);
  const item=find(branch,'b');assert.equal(item.task.semantic.confidence,'ambiguous');assert.equal(item.task.locked,true);
  const result=moveIntent(branch.days,branch.settings,{taskId:find(branch,'a').task.id,targetDate:'2026-10-13',targetStart:660});assert.ok(!(result.changes||[]).some(c=>c.id===item.task.id));assert.equal(item.date,'2026-10-13');assert.equal(item.task.start,840);
 }
});

const relativeRestDescription = 'The day is an outing rest day; no study is scheduled.';
function workspaceRest(timeZone, start, end, extras = {}) {
  const branch = blank(); branch.settings.timeZone = timeZone;
  return read(branch, [event('zoned-rest', 'Outing', '2026-10-12', 60, 60, relativeRestDescription,
    { calendarTimeZone: timeZone, start, end, ...extras })]).data;
}

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const questionForSource = appSource.slice(appSource.indexOf('  questionFor:'), appSource.indexOf('  rememberMeaning:', appSource.indexOf('  questionFor:')));
function restChoice(branch, entry) {
  const api = vm.runInNewContext('({' + questionForSource + '})', { data: () => branch, semanticCorrectionChoices });
  return api.questionFor(entry, 'life').choices.find(choice => choice.id === 'rest');
}
function movedRest(timeZone = 'America/Los_Angeles', description = relativeRestDescription, allDay = false) {
  const offset = timeZone === 'Asia/Tokyo' ? '+09:00' : '-07:00';
  const branch = workspaceRest(timeZone, allDay ? { date: '2026-10-12' } : { dateTime: '2026-10-12T00:30:00' + offset },
    allDay ? { date: '2026-10-13' } : { dateTime: '2026-10-12T01:30:00' + offset }, { description });
  const entry = find(branch, 'zoned-rest');
  branch.days['2026-10-16'] = branch.days[entry.date]; delete branch.days[entry.date];
  return branch;
}

test('The rest correction question anchors a moved event to its source day in the workspace timezone', () => {
  for (const zone of ['America/Los_Angeles', 'Asia/Tokyo']) {
    const branch = movedRest(zone), entry = find(branch, 'zoned-rest'), before = JSON.stringify(branch);
    const choice = restChoice(branch, entry);
    const corrected = applySemanticDecision(branch, entry.task.id, choice, { remember: true }).data;
    assert.deepEqual(find(corrected, 'zoned-rest').task.semantic.closedDates, ['2026-10-12']);
    assert.equal(choice.closedDate, '2026-10-12');
    assert.match(choice.explanation, /2026-10-12/);
    assert.equal(corrected.settings.learningDates['2026-10-16'], undefined);
    assert.equal(find(corrected, 'zoned-rest').date, '2026-10-16');
    assert.equal(corrected.calendar.semanticCorrections, undefined, 'explicit date correction must not become a title-wide template');
    assert.equal(JSON.stringify(branch), before, 'question and preview keep input untouched');
    assert.deepEqual(find(interpretCalendar(corrected).data, 'zoned-rest').task.semantic.closedDates, ['2026-10-12']);
  }
});

test('Choosing rest explicitly without a whole-day description still closes the source day and can be corrected back', () => {
  const branch = movedRest('Asia/Tokyo', ''), entry = find(branch, 'zoned-rest');
  const choice = restChoice(branch, entry);
  assert.equal(choice.closedDate, '2026-10-12');
  const rest = applySemanticDecision(branch, entry.task.id, choice, { remember: true }).data;
  assert.equal(rest.settings.learningDates['2026-10-12'].closed, true);
  assert.equal(rest.settings.learningDates['2026-10-16'], undefined);
  assert.equal(rest.calendar.semanticCorrections, undefined);
  const life = applySemanticDecision(rest, entry.task.id, 'life', { remember: false }).data;
  assert.deepEqual(find(life, 'zoned-rest').task.semantic.closedDates, []);
  assert.equal(life.settings.learningDates['2026-10-12'], undefined);
});

test('Rest correction preserves floating all-day dates and falls back to the displayed date when source endpoints are missing', () => {
  for (const missingSource of [false, true]) {
    const branch = movedRest('Asia/Tokyo', '', true), entry = find(branch, 'zoned-rest');
    if (missingSource) delete entry.task.calendarSource.start;
    const expected = missingSource ? '2026-10-16' : '2026-10-12';
    const choice = restChoice(branch, entry);
    assert.equal(choice.closedDate, expected);
    assert.ok(choice.explanation.includes(expected));
    const corrected = applySemanticDecision(branch, entry.task.id, choice).data;
    assert.deepEqual(find(corrected, 'zoned-rest').task.semantic.closedDates, [expected]);
  }
});

describe("Earlier user answers versus new event evidence", () => {
  // Practice, rest and deadline answers that the user confirmed earlier must be asked again when the event later carries new, substantive evidence.
  // Events here are 30 minutes long at 11:00.
  const shortEvent = (id, title, date, description = "", extras = {}) => ({
    calendarId: "SIMULATED-personal", calendarName: "Simulated personal calendar", accessRole: "owner", calendarTimeZone: "America/Los_Angeles",
    eventId: id, etag: `etag-${id}-1`, summary: title, description, status: "confirmed", organizer: { self: true },
    start: { dateTime: `${date}T11:00:00-07:00` }, end: { dateTime: `${date}T11:30:00-07:00` }, ...extras,
  });
  const restQuestion = (branch, id) => interpretCalendar(branch).ambiguousDecisions.find((q) => q.taskId === find(branch, id).task.id);
  const answer = (branch, question, id) => applySemanticDecision(branch, question.id, question.choices.find((c) => c.id === id)).data;
  const stable = (entry) => Object.fromEntries(["id", "uid", "packageId", "packageOrder", "packageTaskOrder", "packageOriginDate", "duration", "done", "doneAt", "completedDate"]
    .map((key) => [key, entry.task[key]]).concat([["calendarId", entry.task.calendarLink.calendarId], ["eventId", entry.task.calendarLink.eventId]]));
  const moveA = (branch) => moveIntent(branch.days, branch.settings,
    { taskId: find(branch, "a").task.id, targetDate: "2026-10-18", targetStart: 660 });
  const confirmedPractice = () => {
    const events = [shortEvent("a", "SQL practice", "2026-10-17"), shortEvent("b", "Assessment", "2026-10-18")];
    const imported = read(blank(), events);
    const b = find(imported.data, "b").task;
    return adoptLearning(applySemanticDecision(imported.data, b.id, "assessment-practice").data);
  };

  test("A practice confirmed earlier that later becomes a real hiring interview must not silently move what follows", () => {
    const before = confirmedPractice();
    const changed = shortEvent("b", "Real hiring interview", "2026-10-18", "Latest arrangement: formal interview with the interviewer, keep the fixed time, not practice.", { etag: "new-real-interview" });
    const imported = read(before, [changed]);
    const b = find(imported.data, "b").task;
    const result = moveA(imported.data);
    assert.equal(result.status, "conflict", "the old confirmation cannot override new real interview evidence");
    assert.equal(b.locked, true);
    assert.equal(imported.ambiguousDecisions.length, 1);
    const q = imported.ambiguousDecisions[0];
    assert.match(q.prompt, /real interview/);
    assert.ok(q.choices.some((c) => c.id === "assessment-practice"));
    assert.ok(q.choices.some((c) => c.id === "interview"));
    assert.deepEqual(stable(find(imported.data, "b")), stable(find(before, "b")));
    const clarified = answer(imported.data, q, "assessment-practice");
    const again = read(clarified, [changed]);
    assert.equal(again.ambiguousDecisions.length, 0);
    assert.equal(find(again.data, "b").task.locked, false);
    assert.equal(moveA(again.data).status, "ok");
    const decision = Object.values(again.data.calendar.semanticDecisions)[0];
    assert.equal(typeof decision.evidenceFingerprint, "string");
    assert.equal(decision.scope, "purpose");
  });
  test("Etag, time, ordinary note and format changes do not ask again, and an explicit user purpose is not overwritten", () => {
    const before = confirmedPractice();
    const changed = shortEvent("b", "  Assessment  ", "2026-10-18", "Please bring a pen. Note: relax.", {
      etag: "metadata-time-only", start: { dateTime: "2026-10-18T12:00:00-07:00" }, end: { dateTime: "2026-10-18T12:30:00-07:00" },
    });
    const again = read(before, [changed]);
    assert.equal(again.ambiguousDecisions.length, 0);
    assert.equal(find(again.data, "b").task.purpose, "assessment-practice");
    const life = applySemanticDecision(before, find(before, "a").task.id, "life").data;
    const lifeAgain = read(life, [shortEvent("a", "SQL practice", "2026-10-17", "Memo: remember to bring water.", { etag: "ordinary-notes" })]);
    assert.equal(find(lifeAgain.data, "a").task.purpose, "life");
    assert.equal(lifeAgain.ambiguousDecisions.length, 0);
  });

  test("Choosing the new real interview keeps the original ID, package and time, cancelling changes nothing, and after undo the new evidence is still pending confirmation", () => {
    const original = confirmedPractice();
    const changed = shortEvent("b", "Real hiring interview", "2026-10-18", "Latest arrangement: formal interview with the interviewer, keep the fixed time, not practice.", { etag: "new-real" });
    const before = read(original, [changed]).data;
    const unchanged = structuredClone(before);
    const after = answer(before, interpretCalendar(before).ambiguousDecisions[0], "interview");
    assert.deepEqual(before, unchanged, "not saving the preview is a cancellation and changes no data");
    assert.equal(find(after, "b").date, "2026-10-18");
    assert.equal(find(after, "b").task.start, 660);
    assert.equal(find(after, "b").task.purpose, "interview");
    assert.equal(find(after, "b").task.locked, true);
    assert.deepEqual(stable(find(after, "b")), stable(find(original, "b")));
    assert.equal(read(after, [changed]).ambiguousDecisions.length, 0);
    after.undo = adjustmentRecord(before.days, after.days, {}, {}, "Confirm new purpose", before.settings);
    after.undo.globalSettings = { before: structuredClone(before.settings), after: structuredClone(after.settings) };
    after.undo.semanticMetadata = Object.fromEntries(["semanticDecisions", "semanticCorrections"].map((key) => [key,
      { before: structuredClone(before.calendar?.[key] || {}), after: structuredClone(after.calendar?.[key] || {}) }]));
    const undone = undoAdjustment(after);
    assert.equal(undone.ok, true, undone.message);
    const again = read(undone.data, [changed]);
    assert.equal(again.ambiguousDecisions.length, 1);
    assert.equal(moveA(again.data).status, "conflict");
  });

  test("A formal assessment or a medical appointment is rechecked, and an ordinary note does not undo an explicit rest purpose", () => {
    for (const [title, description, expected] of [
      ["Formal hiring assessment", "My own formal timed hiring assessment with a hard deadline.", "hard-assessment"],
      ["Medical appointment", "Appointment to fill a tooth.", "medical"],
    ]) {
      const branch = confirmedPractice();
      const changed = shortEvent("b", title, "2026-10-18", description, { etag: "new-meaning" });
      const pending = read(branch, [changed]);
      assert.equal(pending.ambiguousDecisions.length, 1, expected);
      assert.ok(pending.ambiguousDecisions[0].choices.some((c) => c.id === expected));
      assert.equal(find(pending.data, "b").task.locked, true);
      assert.equal(moveA(pending.data).status, "conflict");
    }
    const branch = confirmedPractice();
    const rest = applySemanticDecision(branch, find(branch, "a").task.id, { id: "rest", closedDate: "2026-10-17" }).data;
    const again = read(rest, [shortEvent("a", "SQL practice", "2026-10-17", "Memo: remember to bring water.", { etag: "notes" })]);
    assert.equal(find(again.data, "a").task.purpose, "rest");
    assert.equal(again.ambiguousDecisions.length, 0);
    assert.equal(again.data.settings.learningDates["2026-10-17"].closed, true);
  });

  test("The latest answer for the 17th overrides the old open exception for the 17th, without overriding the old open exception for the 18th", () => {
    const source = blank();
    for (const date of ["2026-10-17", "2026-10-18"]) source.settings.learningDates[date] = { closed: false, source: "user-confirmed" };
    const events = [shortEvent("rest", "Personal arrangement", "2026-10-17", "2026-10-17, maybe no Job Prepare study; 2026-10-18, no Job Prepare study.")];
    const before = read(source, events).data;
    const after = answer(before, restQuestion(before, "rest"), "rest");
    assert.equal(after.settings.learningDates["2026-10-17"].closed, true);
    assert.deepEqual(after.settings.learningDates["2026-10-18"], source.settings.learningDates["2026-10-18"]);
  });

  test("A date answer is still remembered after a note or time refresh, and moving study does not reinterpret the old relative date", () => {
    const events = [shortEvent("a", "SQL practice", "2026-10-17", "2026-10-17, maybe no Job Prepare study.")];
    const before = read(blank(), events).data;
    const clarified = answer(before, restQuestion(before, "a"), "life");
    const managed = adoptLearning(clarified);
    const result = moveIntent(managed.days, managed.settings,
      { taskId: find(managed, "a").task.id, targetDate: "2026-10-19", targetStart: 660 });
    assert.equal(result.status, "ok");
    const again = interpretCalendar({ ...managed, days: result.days });
    assert.equal(again.ambiguousDecisions.length, 0);
    assert.equal(find(again.data, "a").date, "2026-10-19");
    const reread = read(clarified, [shortEvent("a", "SQL practice", "2026-10-17", "2026-10-17, maybe no Job Prepare study. Note: remember to bring water.", {
      etag: "notes-time", start: { dateTime: "2026-10-17T12:00:00-07:00" }, end: { dateTime: "2026-10-17T12:30:00-07:00" },
    })]);
    assert.equal(reread.ambiguousDecisions.length, 0);
  });

  test("An event that already contained a real interview and Mock, confirmed as practice, is rechecked when the practice evidence is later withdrawn", () => {
    const events = [shortEvent("a", "SQL practice", "2026-10-17"),
      shortEvent("b", "Real hiring interview | Mock", "2026-10-18", "Mock interview practice.")];
    const imported = read(blank(), events);
    const branch = adoptLearning(applySemanticDecision(imported.data, find(imported.data, "b").task.id, "assessment-practice").data);
    const changed = shortEvent("b", "Real hiring interview", "2026-10-18", "Latest arrangement: formal interview, not practice.", { etag: "practice-retracted" });
    const pending = read(branch, [changed]);
    assert.equal(pending.ambiguousDecisions.length, 1, "keeping the hard marker but withdrawing practice is also a substantive evidence change");
    assert.equal(find(pending.data, "b").task.locked, true);
    assert.equal(moveA(pending.data).status, "conflict");
    const acknowledged = answer(pending.data, pending.ambiguousDecisions[0], "assessment-practice");
    assert.equal(read(acknowledged, [changed]).ambiguousDecisions.length, 0);
  });

  test("A mixed interview confirmed as practice is not asked again for ordinary notes, but a new denial of practice while Mock remains is rechecked once", () => {
    const title = "Real hiring interview | Mock";
    const events = [shortEvent("a", "SQL practice", "2026-10-17"),
      shortEvent("b", title, "2026-10-18", "Mock interview practice.")];
    const imported = read(blank(), events).data;
    const branch = adoptLearning(applySemanticDecision(imported, find(imported, "b").task.id, "assessment-practice").data);
    const ordinary = shortEvent("b", `  ${title}  `, "2026-10-18", "Mock interview practice. Note: remember to bring water and a practice notebook.", { etag: "same-purpose-notes" });
    assert.equal(read(branch, [ordinary]).ambiguousDecisions.length, 0);
    const changed = shortEvent("b", title, "2026-10-18", "Latest arrangement: formal interview, not practice.", { etag: "explicit-not-practice" });
    const pending = read(branch, [changed]);
    assert.equal(pending.ambiguousDecisions.length, 1, "an old Mock title cannot swallow new evidence denying practice");
    assert.equal(find(pending.data, "b").task.locked, true);
    assert.equal(moveA(pending.data).status, "conflict");
    assert.deepEqual(stable(find(pending.data, "b")), stable(find(branch, "b")));
    const acknowledged = answer(pending.data, pending.ambiguousDecisions[0], "interview");
    assert.equal(read(acknowledged, [changed]).ambiguousDecisions.length, 0);
    assert.equal(find(acknowledged, "b").task.purpose, "interview");
  });

  test("New non-mock interview evidence is not swallowed by a confirmed practice choice or an old Mock title", () => {
    const title = "Real hiring interview | Mock";
    const events = [shortEvent("a", "SQL practice", "2026-10-17"), shortEvent("b", title, "2026-10-18", "Mock interview practice.")];
    const imported = read(blank(), events).data;
    const branch = adoptLearning(applySemanticDecision(imported, find(imported, "b").task.id, "assessment-practice").data);
    const changed = shortEvent("b", title, "2026-10-18", "Not a mock interview; keep the time as a real interview.", { etag: "not-simulated" });
    const pending = read(branch, [changed]);
    assert.equal(pending.ambiguousDecisions.length, 1, "a non-mock interview is new evidence against practice");
    assert.equal(find(pending.data, "b").task.locked, true);
    assert.equal(moveA(pending.data).status, "conflict");
    assert.deepEqual(stable(find(pending.data, "b")), stable(find(branch, "b")));
    const acknowledged = answer(pending.data, pending.ambiguousDecisions[0], "assessment-practice");
    assert.equal(read(acknowledged, [changed]).ambiguousDecisions.length, 0);
    assert.equal(moveA(read(acknowledged, [changed]).data).status, "ok");
  });

  test("Quoted and historical text and ordinary notes that deny stationery or tools are not new purpose evidence", () => {
    const title = "Real hiring interview | Mock";
    const imported = read(blank(), [shortEvent("a", "SQL practice", "2026-10-17"),
      shortEvent("b", title, "2026-10-18", "Mock interview practice.")]).data;
    const branch = adoptLearning(applySemanticDecision(imported, find(imported, "b").task.id, "assessment-practice").data);
    for (const description of [
      "Quote: “Not a mock interview; keep the original time as a real interview.” Note: remember to bring water.",
      "Note: this tool is not a simulator, please bring an ordinary pen.",
      "Note: read the words ‘not practice’, no extra arrangement is needed.", "Note: bring a pen and a bottle of water."]) {
      const unchanged = shortEvent("b", title, "2026-10-18", description, { etag: `ordinary-${description}` });
      const reread = read(branch, [unchanged]);
      assert.equal(reread.ambiguousDecisions.length, 0, description);
      assert.equal(find(reread.data, "b").task.purpose, "assessment-practice", description);
      assert.equal(moveA(reread.data).status, "ok", description);
    }
  });

  test("Adjacent phrasings that clearly deny a mock are rechecked once, and after confirmation the same evidence is not asked again", () => {
    const title = "Real hiring interview | Mock";
    const imported = read(blank(), [shortEvent("a", "SQL practice", "2026-10-17"),
      shortEvent("b", title, "2026-10-18", "Mock interview practice.")]).data;
    const branch = adoptLearning(applySemanticDecision(imported, find(imported, "b").task.id, "assessment-practice").data);
    for (const description of ["Not a mock interview; keep the original time as a real interview.", "This is not a mock interview; keep the original time as a real interview.",
      "Not a practice interview; keep the original time as a real interview.", "No longer a mock interview; keep the original time as a real interview.",
      "Not a mock, but a formal interview.", "Not a mock interview. Please keep the real interview time."]) {
      const changed = shortEvent("b", title, "2026-10-18", description, { etag: `negation-${description}` });
      const pending = read(branch, [changed]);
      assert.equal(pending.ambiguousDecisions.length, 1, description);
      assert.equal(find(pending.data, "b").task.locked, true, description);
      assert.equal(moveA(pending.data).status, "conflict", description);
      const acknowledged = answer(pending.data, pending.ambiguousDecisions[0], "interview");
      assert.equal(read(acknowledged, [changed]).ambiguousDecisions.length, 0, description);
      assert.deepEqual(stable(find(acknowledged, "b")), stable(find(branch, "b")), description);
    }
  });

  test("An old Mock title cannot hide a new note that clearly states a formal interview and a fixed time", () => {
    const title = "Real hiring interview | Mock";
    const imported = read(blank(), [shortEvent("a", "SQL practice", "2026-10-17"),
      shortEvent("b", title, "2026-10-18", "Mock interview practice.")]).data;
    const branch = adoptLearning(applySemanticDecision(imported, find(imported, "b").task.id, "assessment-practice").data);
    const changed = shortEvent("b", title, "2026-10-18", "Latest arrangement: formal interview with the interviewer, keep the fixed time.", { etag: "affirmative" });
    const pending = read(branch, [changed]);
    assert.equal(pending.ambiguousDecisions.length, 1, "formal interview evidence in the new current note needs its own source fingerprint");
    assert.equal(find(pending.data, "b").task.locked, true);
    assert.equal(moveA(pending.data).status, "conflict");
    assert.deepEqual(stable(find(pending.data, "b")), stable(find(branch, "b")));
    const q = pending.ambiguousDecisions[0];
    assert.equal(q.choices[0].id, "assessment-practice");
    assert.equal(q.choices[1].id, "interview");
    assert.match(q.prompt, /real interview/);
    const acknowledged = answer(pending.data, q, "assessment-practice");
    const again = read(acknowledged, [changed]);
    assert.equal(again.ambiguousDecisions.length, 0);
    assert.equal(moveA(again.data).status, "ok");
  });

  test("Preparation courses, materials, generic interviewer notes and historical quotations are not a formal declaration for this activity", () => {
    const title = "Real hiring interview | Mock";
    const imported = read(blank(), [shortEvent("a", "SQL practice", "2026-10-17"),
      shortEvent("b", title, "2026-10-18", "Mock interview practice.")]).data;
    const branch = adoptLearning(applySemanticDecision(imported, find(imported, "b").task.id, "assessment-practice").data);
    for (const description of ["Preparation practice for a real interview.", "A course about the formal interview.",
      "Note: remember to greet the interviewer and bring water.", "Note: please bring formal interview materials.",
      "Preparation for a real interview. Keep the original time.", "A formal interview preparation course. Keep the original time.",
      "Quote: “Latest arrangement: formal interview with the interviewer, keep the fixed time.” Mock interview practice."]) {
      const reread = read(branch, [shortEvent("b", title, "2026-10-18", description, { etag: `mention-${description}` })]);
      assert.equal(reread.ambiguousDecisions.length, 0, description);
      assert.equal(find(reread.data, "b").task.purpose, "assessment-practice", description);
      assert.equal(moveA(reread.data).status, "ok", description);
    }
  });

  test("Practice confirmed deliberately after seeing a formal note is not asked again and records the formal source", () => {
    const title = "Real hiring interview | Mock";
    const description = "Latest arrangement: formal interview with the interviewer, keep the fixed time.";
    const imported = read(blank(), [shortEvent("a", "SQL practice", "2026-10-17"), shortEvent("b", title, "2026-10-18", description)]).data;
    const branch = adoptLearning(applySemanticDecision(imported, find(imported, "b").task.id, "assessment-practice").data);
    const refreshedEvent = shortEvent("b", ` ${title} `, "2026-10-18", `${description}Note: remember to bring water.`, { etag: "time-and-note",
      start: { dateTime: "2026-10-18T12:00:00-07:00" }, end: { dateTime: "2026-10-18T12:30:00-07:00" } });
    assert.equal(read(branch, [refreshedEvent]).ambiguousDecisions.length, 0);
    const decision = Object.values(branch.calendar.semanticDecisions)[0];
    const fingerprint = JSON.parse(decision.evidenceFingerprint);
    assert.ok(fingerprint.sources.description.purposes.includes("interview"));
    assert.equal(fingerprint.sources.description.fixedTime, true);
  });

  test("A formal fixed declaration is not tied to one prefix template, and reordered or reworded forms are also rechecked", () => {
    const title = "Real hiring interview | Mock";
    const imported = read(blank(), [shortEvent("a", "SQL practice", "2026-10-17"),
      shortEvent("b", title, "2026-10-18", "Mock interview practice.")]).data;
    const branch = adoptLearning(applySemanticDecision(imported, find(imported, "b").task.id, "assessment-practice").data);
    for (const description of ["Latest note: changed to a formal interview, keep the fixed time.", "Keep the fixed time for this formal interview.",
      "This is a formal interview and cannot be moved.",
      "Latest update: this is a formal interview. Keep the original time."]) {
      const changed = shortEvent("b", title, "2026-10-18", description, { etag: `declared-${description}` });
      const pending = read(branch, [changed]);
      assert.equal(pending.ambiguousDecisions.length, 1, description);
      assert.equal(moveA(pending.data).status, "conflict", description);
      const acknowledged = answer(pending.data, pending.ambiguousDecisions[0], "assessment-practice");
      assert.equal(read(acknowledged, [changed]).ambiguousDecisions.length, 0, description);
    }
  });

  test("A long non-declaring note prefix is processed quickly without regex backtracking", () => {
    const title = "Real hiring interview | Mock";
    const imported = read(blank(), [shortEvent("a", "SQL practice", "2026-10-17"),
      shortEvent("b", title, "2026-10-18", "Mock interview practice.")]).data;
    const branch = adoptLearning(applySemanticDecision(imported, find(imported, "b").task.id, "assessment-practice").data);
    const description = `${"a".repeat(12000)}Equipment memo: formal interview materials.`;
    const started = performance.now();
    const reread = read(branch, [shortEvent("b", title, "2026-10-18", description, { etag: "long-object-note" })]);
    assert.ok(performance.now() - started < 1000, "a 12000-character non-declaring prefix should be rejected quickly without truncating input");
    assert.equal(reread.ambiguousDecisions.length, 0);
    assert.equal(find(reread.data, "b").task.purpose, "assessment-practice");
  });
});
