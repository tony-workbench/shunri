import test from "node:test";
import assert from "node:assert/strict";
import { moveIntent, validateIntentDays } from "../intent-planner.js";
import { normalizeLearningDays } from "../learning.js";
import { rulesForDate, necessaryRest } from "../planner.js";
import { planningFind as find } from "./helpers.mjs";

const MON = "2026-10-12", TUE = "2026-10-13", WED = "2026-10-14";
const task = (id, extra = {}) => ({ id, uid: id, title: id, start: 660, duration: 30, rest: 0,
  done: false, deferred: false, locked: false, counted: false, type: "task", dependencies: [], ...extra });
const study = (id, extra = {}) => task(id, { tags: ["study"], planId: "job-prepare", ...extra });
const move = (days, start = 660, configured = {}, date = TUE, id = "a") => moveIntent(days, configured, { taskId:id,targetDate:date,targetStart:start });

test("default hard window is 09:00 to 23:00: a target of 08:59 is rejected and 09:00 is accepted", () => {
  const input = { [MON]: [study("a")] };
  const invalid = move(input,539);
  assert.equal(invalid.status,"conflict");
  assert.equal(find(invalid,"a").date,MON);
  assert.equal(move(input,540).status,"ok");
  assert.equal(find(move(input,540),"a").start,540);
  assert.deepEqual(rulesForDate({},TUE).windows,[[540,1380]]);
});

test("date overrides and wide weekly windows cannot enlarge the global hard window", () => {
  const configured = { dayStart:540,dayEnd:1380,weekly:{2:[[0,1440]]},dates:{[TUE]:{dayStart:0,dayEnd:1440,windows:[[0,1440]]}} };
  assert.deepEqual(rulesForDate(configured,TUE).windows,[[540,1380]]);
  assert.equal(move({[MON]:[task("a")]},539,configured).status,"conflict");
});

test("a study block plus max(rest, 20) minutes ending exactly at 23:00 fits, and one minute later conflicts", () => {
  const input = { [MON]: [study("a",{duration:40,rest:15})] };
  assert.equal(move(input,1320).status,"ok");
  const invalid = move(input,1321);
  assert.equal(invalid.status,"conflict");
  assert.equal(find(invalid,"a").date,MON);
  assert.equal(find(invalid,"a").duration,40);
  assert.equal(necessaryRest(input[MON][0],{}),20);
});

test("an imported Google event outside the hard window stays unchanged and is not treated as a moved task", () => {
  const fixed = task("early",{start:480,duration:30,type:"activity",externalReadOnly:true,locked:true});
  const result = move({[MON]:[study("a")],[TUE]:[fixed]},540);
  assert.equal(result.status,"ok");
  assert.deepEqual(find(result,"early"),{date:TUE,...fixed});
  assert.equal(validateIntentDays({[TUE]:[fixed]},{}).status,"ok");
});

test("automatic learning prefers 11:00 while an explicitly requested 09:00 anchor stays exact", () => {
  const input = { [MON]: [task("a",{duration:5})], [TUE]:[study("lesson",{dependencies:[{id:"a",gap:0}]})] };
  const result = move(input,540);
  assert.equal(result.status,"ok");
  assert.equal(find(result,"a").start,540);
  assert.equal(find(result,"lesson").start,660);
  const direct = move({[MON]:[study("a")]},540);
  assert.equal(direct.status,"ok");
  assert.equal(find(direct,"a").start,540);
});

test("automatic learning skips a morning-only window, but an explicit morning target still fits", () => {
  const input = { [MON]: [task("a",{duration:5})], [TUE]:[study("lesson",{start:540,duration:15,dependencies:[{id:"a",gap:0}]})] };
  const configured = { learningWeekly:{2:[[540,600]]} };
  const result = move(input,540,configured);
  assert.equal(result.status,"ok");
  assert.equal(find(result,"lesson").date,WED);
  assert.equal(find(result,"lesson").start,660);
  assert.match(result.summary.skippedDates.find(day=>day.date===TUE).reason,/after 11:00/);
  const direct = move({[MON]:[study("a",{duration:15})]},540,configured);
  assert.equal(direct.status,"ok");
  assert.equal(find(direct,"a").date,TUE);
  assert.equal(find(direct,"a").start,540);
  assert.deepEqual(configured.learningWeekly[2],[[540,600]]);
});

test("the 150-minute learning limit adds up across course and plan names even without counted flags", () => {
  const input = { [MON]:[study("a",{planId:"sql",duration:80})],
    [TUE]:[study("other",{planId:"interface",duration:80,start:900,locked:true})] };
  const result = move(input);
  assert.equal(result.status,"conflict");
  assert.match(result.conflicts[0].message,/160.*150/);
  assert.equal(find(result,"other").start,900);
});

test("null or wider learning capacities cannot bypass the shared learning limit", () => {
  const input = { [MON]: [study("a", { duration: 151 })] };
  for (const configured of [
    { learningCapacity: null },
    { learningCapacity: 300 },
    { learningDates: { [TUE]: { capacity: null } } },
    { learningDates: { [TUE]: { capacity: 300 } } },
  ]) {
    const result = move(input, 660, configured);
    assert.equal(result.status, "conflict");
    assert.match(result.conflicts[0].message, /151.*150/);
    assert.deepEqual(result.alternatives, []);
  }
  const stricter = move({ [MON]: [study("a", { duration: 101 })] }, 660,
    { learningCapacity: 100, learningDates: { [TUE]: { capacity: 300 } } });
  assert.equal(stricter.status, "conflict");
  assert.match(stricter.conflicts[0].message, /101.*100/);
});

test("completed learning counts on its actual completion day, not its old planned date", () => {
  const done = study("done",{duration:80,done:true,start:900,completedDate:TUE,doneAt:"2026-10-13T23:00:00Z"});
  const input = { [MON]:[study("a",{duration:80}),done] };
  const conflict = move(input);
  assert.equal(conflict.status,"conflict");
  assert.match(conflict.conflicts[0].message,/160.*150/);
  const moved = move(input,660,{},WED);
  assert.equal(moved.status,"ok");
  assert.equal(moved.daily.find(day=>day.date===MON).learningFocus,0);
  assert.equal(moved.daily.find(day=>day.date===TUE).learningFocus,80);
  assert.deepEqual(find(moved,"done"),{date:MON,...normalizeLearningDays(input)[MON][1]});
});

test("a completion known only by timestamp is assigned to the local completion date", () => {
  const input = { [MON]:[study("a",{duration:80}),study("done",{duration:80,done:true,start:900,completedAt:"2026-10-14T01:00:00Z"})] };
  assert.equal(move(input).status,"conflict"); // 18:00 on Oct 13 in Los Angeles, not Oct 14 UTC.
  assert.equal(move(input,660,{},WED).daily.find(day=>day.date===TUE).learningFocus,80);
});

test("a hard personal assessment counts toward learning capacity but stays an immutable non-package", () => {
  const assessment = task("assessment",{type:"activity",locked:true,start:900,duration:100,learningWorkload:true,purpose:"hard-assessment"});
  const input = { [MON]:[study("a",{duration:60})],[TUE]:[assessment] };
  const result = move(input);
  assert.equal(result.status,"conflict");
  assert.match(result.conflicts[0].message,/160.*150/);
  assert.deepEqual(find(result,"assessment"),{date:TUE,...assessment});
});

test("learning keeps 20 minutes before and after every neighboring activity, not 40", () => {
  const fixed = task("phone",{start:720,duration:30,rest:0,locked:true,type:"activity"});
  const input = {[MON]:[study("a",{duration:30,rest:15})],[TUE]:[fixed]};
  assert.equal(move(input,670).status,"ok"); // Ends 11:40; appointment at 12:00.
  assert.equal(move(input,671).status,"conflict");
  assert.equal(move(input,769).status,"conflict"); // 12:49, only 19 minutes after.
  assert.equal(move(input,770).status,"ok");
  const together = move({[MON]:[study("a",{duration:30,rest:15}),study("b",{start:720,duration:30,rest:15})]});
  assert.equal(together.status,"ok");
  assert.equal(find(together,"b").start,710); // 30 + max(15,20), not 30+15+20.
  assert.equal(find(together,"b").rest,15); // The configured rest is kept; only the gap is raised.
});

test("a medical appointment keeps a full hour before and only 20 minutes after, not a generic hour", () => {
  const medical = task("dentist",{start:720,duration:60,type:"activity",locked:true,purpose:"medical"});
  const input = {[MON]:[study("a",{duration:30})],[TUE]:[medical]};
  assert.equal(move(input,630).status,"ok"); // Actual task ends 11:00: full hour before 12:00.
  assert.equal(move(input,631).status,"conflict");
  assert.equal(move(input,799).status,"conflict");
  assert.equal(move(input,800).status,"ok"); // 13:20, no extra hour silently added.
  assert.deepEqual(find(move(input,800),"dentist"),{date:TUE,...medical});
  assert.equal(move({[MON]:[task("a",{duration:30})],[TUE]:[task("generic",{start:720,duration:30,type:"activity",locked:true})]},660).status,"ok");
});

test("narrow windows and closed learning dates are respected and the configuration is left unchanged", () => {
  const configured = { weekly:{2:[[780,1000]]},learningDates:{[WED]:{closed:true}} }, before=structuredClone(configured);
  const input = {[MON]:[study("a")],[TUE]:[study("b")]};
  const result = move(input,780,configured);
  assert.equal(result.status,"ok");
  assert.equal(find(result,"a").start,780);
  assert.equal(find(result,"b").date,"2026-10-15");
  assert.deepEqual(configured,before);
  const invalid=move(input,660,configured);
  assert.equal(invalid.status,"conflict");
  for(const option of invalid.alternatives) assert.notEqual(option.targetDate,WED);
});

test("work from different courses on one original day forms one stable package", () => {
  const input = {[MON]:[study("a",{courseId:"sql",duration:30}),study("interface",{courseId:"interface",start:720,duration:40,dependencies:[{id:"a",gap:20}]})],
    [TUE]:[study("next",{courseId:"sql",duration:30})]};
  const normalized=normalizeLearningDays(input),result=move(normalized);
  assert.equal(result.status,"ok");
  assert.equal(find(result,"a").date,TUE);
  assert.equal(find(result,"interface").date,TUE);
  assert.equal(find(result,"next").date,WED);
  assert.equal(find(result,"a").packageId,find(result,"interface").packageId);
  assert.equal(find(result,"interface").packageId,normalized[MON][1].packageId);
  assert.deepEqual(find(result,"interface").dependencies,[{id:"a",gap:20}]);
});

test("when earlier blocks do not fit, at most two feasible alternatives are offered and the requested anchor is kept", () => {
  const input = {[MON]:[study("before",{duration:45,rest:15}),study("a",{start:720,dependencies:[{id:"before",gap:15}]})]};
  const before=structuredClone(input),result=move(input,540);
  assert.equal(result.status,"conflict");
  assert.equal(result.exactTarget.start,540);
  assert.ok(result.alternatives.length>0&&result.alternatives.length<=2);
  assert.equal(result.alternatives[0].targetStart,605);
  for(const choice of result.alternatives){
    const verified=move(input,choice.targetStart,{},choice.targetDate);
    assert.equal(verified.status,"ok",choice.label);
    assert.equal(find(verified,"a").start,choice.targetStart);
    assert.equal(find(verified,"before").date,choice.targetDate);
  }
  assert.deepEqual(input,before);
});

test("a clash with a fixed appointment proposes a verified time after it, not an infeasible default", () => {
  const input = {[MON]:[study("a")],[TUE]:[task("medical",{start:660,duration:60,type:"activity",locked:true,purpose:"medical"})]};
  const result=move(input);
  assert.equal(result.status,"conflict");
  assert.ok(result.alternatives.some(choice=>choice.targetDate===TUE&&choice.targetStart===740));
  for(const choice of result.alternatives) assert.equal(move(input,choice.targetStart,{},choice.targetDate).status,"ok");
});

test("a package that cannot fit anywhere has no alternatives and loses no content", () => {
  const input={[MON]:[study("a",{duration:151})]},before=structuredClone(input),result=move(input);
  assert.equal(result.status,"conflict");
  assert.deepEqual(result.alternatives,[]);
  assert.deepEqual(input,before);
  assert.equal(find(result,"a").duration,151);
});

test("moving to the same date and time is a no-op and does not tighten earlier study blocks", () => {
  const input = normalizeLearningDays({ [MON]: [
    study("before", { start: 540, duration: 30 }),
    study("a", { start: 720, dependencies: [{ id: "before", gap: 20 }] }),
  ], [TUE]: [study("next")] });
  const result = move(input, 720, {}, MON);
  assert.equal(result.status, "ok");
  assert.equal(result.noEffect, true);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.days, input);
  assert.equal(find(result, "before").start, 540);
  assert.deepEqual(result.alternatives, []);
});

test("a confirmed course-order conflict is reported explicitly but does not freeze unrelated plans", () => {
  const issue = { source: "user-confirmed-course-order", kind: "deferred-prerequisite",
    ids: ["missing-lesson"], message: "The UNION lesson that precedes SQL subqueries is deferred and cannot be skipped." };
  const input = { [MON]: [study("a", { semanticConflict: issue }), task("ordinary", { start: 900 })] };
  const result = move(input);
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts[0].message, issue.message);
  assert.deepEqual(result.conflicts[0].ids, ["a", "missing-lesson"]);
  assert.deepEqual(result.alternatives, []);
  assert.ok(validateIntentDays(input).conflicts.some(conflict => conflict.message === issue.message));
  assert.equal(move(input, 900, {}, TUE, "ordinary").status, "ok");
});
