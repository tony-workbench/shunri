import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dayMarkup, fixedBadge, bufferNote, isFixedTask, plannerSpacingNote, FIXED_LABEL, BUFFER_EXPLANATION } from "../workbench.js";
import { scheduleContext, proposeReschedule, proposeMoveToDay } from "../schedule-context.js";
import { plan } from "../planner.js";
import { wallInstant } from "../time.js";
import { defaults } from "../storage.js";
import { item, tick, uiRig, proposalItem, proposalFixture, PROPOSAL_TODAY, PROPOSAL_TOMORROW,
  LOCK_DATE, lockSettings, lockTask, lockHome } from "./helpers.mjs";

// Fixed events (activities and locked tasks) carry a "Will not move" badge, a distinct style and
// explained buffers on every screen, and no rule or button moves them.
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const css = read("style.css");

const event = { id: "e", title: "Board", type: "activity", locked: true, start: 840, duration: 60, bufferBefore: 60, bufferAfter: 60 };
const plain = { id: "t", title: "Write", type: "task", start: 600, duration: 45 };

describe("the Will not move label", () => {
  test("fixed events, system time locks and user locks are fixed; other tasks are not", () => {
    assert.equal(isFixedTask(event), true);
    assert.equal(isFixedTask({ ...plain, timeLocked: true }), true);
    assert.equal(isFixedTask({ ...plain, locked: true, lockSource: "user" }), true);
    assert.equal(isFixedTask(plain), false);
    assert.equal(isFixedTask({ ...plain, lockSource: "user" }), false, "a lock source alone does not fix a task");
  });

  test("the badge text tells a user lock, a system time lock and a fixed event apart", () => {
    const text = (t) => fixedBadge(t).replace(/<[^>]*>/g, "");
    const user = text({ ...plain, locked: true, lockSource: "user" });
    const system = text({ ...plain, timeLocked: true });
    const fixedEvent = text(event);
    assert.equal(user, "Locked by you · will not move");
    assert.equal(system, "Locked · will not move");
    assert.equal(fixedEvent, "Will not move");
    assert.equal(new Set([user, system, fixedEvent]).size, 3);
    assert.equal(FIXED_LABEL, "Will not move");
    assert.equal(fixedBadge(event), `<span class="fixed-badge">${FIXED_LABEL}</span>`);
    assert.equal(fixedBadge(event), fixedBadge());
  });

  test("buffers around fixed events are explained in words, and ordinary tasks get no note", () => {
    assert.match(bufferNote(event, defaults()), /60 min before \/ 60 min after are kept free/);
    assert.equal(bufferNote(plain, defaults()), "");
    assert.match(BUFFER_EXPLANATION, /kept free before and after fixed events/);
  });

  test("every fixedBadge call in the workbench passes the task", () => {
    // Without the task, a locked task would be labelled like a fixed event.
    const src = read("workbench.js");
    const calls = [...src.matchAll(/(?<!const )fixedBadge\(([^)]*)\)/g)].filter((m) => !src.slice(m.index - 20, m.index).includes("export"));
    assert.ok(calls.length >= 3);
    for (const [, arg] of calls) assert.ok(arg.trim(), "fixedBadge() called without the task");
  });
});

describe("the day view", () => {
  const day = "2026-10-13";
  const settings = defaults();
  const at = (minute) => wallInstant(day, minute, settings.timeZone);
  const block = (t, before = 0, after = 0) => ({ entry: { date: day, task: t },
    start: at(t.start - before), actualStart: at(t.start), actualEnd: at(t.start + t.duration),
    end: at(t.start + t.duration + after), nonBlocking: false });
  const practice = item("Practice", 600, 45);
  const mine = item("MyLock", 780, 30, { locked: true, lockSource: "user" });
  const meeting = item("Meeting", 960, 60, { type: "activity", locked: true, bufferBefore: 60, bufferAfter: 60 });
  const model = { nowInstant: null, day: { date: day, axisStart: at(540), axisEnd: at(1380), known: true, closed: false,
    learning: 45, capacity: 240, completed: 0, conflicts: [], source: "local",
    items: [block(practice, 0, 10), block(mine, 0, 10), block(meeting, 60, 60)] } };
  const html = dayMarkup(model, settings, null);
  const agenda = html.match(/<li class="agenda-item[^"]*">.*?<\/li>/g);
  const intervals = html.match(/<i class="axis-interval [^"]*"/g).map((s) => s.slice(10, -1).trim().split(/\s+/));
  const badge = (li) => li.match(/<span class="fixed-badge">([^<]*)<\/span>/)?.[1];

  test("the agenda badges a fixed event and a locked task differently and leaves a movable task bare", () => {
    assert.equal(agenda.length, 3);
    const [movable, locked, fixed] = agenda;
    assert.doesNotMatch(movable, /fixed-badge|agenda-fixed/);
    assert.match(locked, /agenda-fixed/);
    assert.match(fixed, /agenda-fixed/);
    assert.equal(badge(fixed), FIXED_LABEL);
    assert.equal(badge(locked), "Locked by you · will not move");
    assert.notEqual(badge(locked), badge(fixed), "a user lock is not labelled like a fixed event");
  });

  test("the timeline paints fixed blocks differently from movable ones", () => {
    const tasks = intervals.filter((c) => c.includes("task"));
    assert.equal(tasks.length, 3);
    assert.deepEqual(tasks.map((c) => c.includes("fixed")), [false, true, true]);
  });

  test("the legend names the fixed style and explains buffers", () => {
    assert.match(html, /<span class="legend-fixed">Fixed · will not move<\/span>/);
    assert.match(html, /<span class="legend-movable">Movable<\/span>/);
    assert.ok(html.includes(`<span class="legend-protection">${BUFFER_EXPLANATION}</span>`));
  });

  test("a fixed event lists and draws its buffers as buffers, not as movable items", () => {
    const [movable, , fixed] = agenda;
    assert.ok(html.includes(`<p class="protection-note">${bufferNote(meeting, settings)}</p>`));
    assert.match(fixed, /protection-note">[^<]*Before event buffer/);
    assert.match(fixed, /protection-note">[^<]*After-event buffer/);
    assert.doesNotMatch(movable, /protection-note/);
    const buffers = intervals.filter((c) => c.includes("protection"));
    assert.equal(buffers.length, 2, "one buffer before and one after the fixed event");
    for (const b of buffers) assert.ok(!b.includes("task") && !b.includes("fixed"));
  });

  test("a selected fixed block keeps its fixed class and a selected movable block does not get it", () => {
    const tags = dayMarkup(model, settings, "Meeting").match(/<i class="axis-interval [^"]*"[^>]*>/g);
    const chosen = tags.filter((t) => /\baxis-selected\b/.test(t) && /axis-interval task\b/.test(t));
    assert.equal(chosen.length, 1);
    assert.match(chosen[0], /\bfixed\b/);
    const movableSelected = dayMarkup(model, settings, "Practice").match(/<i class="axis-interval task [^"]*axis-selected[^"]*"/)[0];
    assert.doesNotMatch(movableSelected, /\bfixed\b/);
  });
});

describe("the stylesheet", () => {
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = css.match(new RegExp("(?:^|[\\s,}])" + escaped + "\\s*\\{([^}]*)\\}", "m"));
    assert.ok(found, `missing CSS rule ${selector}`);
    return found[1];
  };
  const prop = (body, name) => body.match(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`))?.[1].trim();

  test("fixed items differ from movable items by colour, edge and pattern, not only by text", () => {
    assert.match(prop(rule(".fixed-badge"), "background"), /#2f3e57/i, "the badge is a filled dark pill, not plain text");
    // Timeline: the fixed block is solid slate, buffers are hatched and dashed, the movable block is neither.
    const fixedBlock = rule(".axis-interval.fixed"), buffer = rule(".axis-interval.protection");
    assert.match(prop(fixedBlock, "background"), /#2f3e57/i);
    assert.notEqual(prop(rule(".axis-interval"), "background"), prop(fixedBlock, "background"), "fixed blocks need their own fill");
    assert.match(prop(buffer, "background"), /repeating-linear-gradient/);
    assert.match(prop(buffer, "border"), /dashed/);
    assert.notEqual(prop(fixedBlock, "background"), prop(buffer, "background"));
    assert.match(css, /\.axis-interval\.axis-selected\.task\.fixed\s*\{[^}]*background:\s*#2f3e57/, "a selected fixed block keeps its dark fill");
    assert.match(rule(".agenda-item.agenda-fixed"), /border-left: 4px solid #2f3e57/);
    assert.match(rule(".next-fixed .next-content"), /border-left:\s*4px solid/);
    assert.match(prop(rule(".legend-fixed::before, .legend-movable::before"), "background"), /#2f3e57/i);
  });
});

describe("one meaning on every screen", () => {
  const date = LOCK_DATE, settings = lockSettings();
  const kinds = {
    ordinary: { fixed: false, extra: {} },
    purposeOnly: { fixed: false, extra: { purpose: "interview" } },
    activity: { fixed: true, extra: { type: "activity", locked: true, bufferBefore: 60, bufferAfter: 60 } },
    timeLocked: { fixed: true, extra: { timeLocked: true } },
    manuallyLocked: { fixed: true, extra: { locked: true, lockSource: "user" } },
  };
  const demoContext = (tasks) => ({ mode: "demo", date, branch: { days: { [date]: tasks }, settings, calendar: {}, exampleOrigin: date },
    calendarStatus: { state: "disconnected" } });
  const badges = (html) => [...html.matchAll(/<span class="fixed-badge">([^<]*)<\/span>/g)].map((m) => m[1]);

  for (const [name, { fixed, extra }] of Object.entries(kinds)) {
    const task = lockTask(name, extra);
    test(`${name}: every screen agrees it ${fixed ? "will not move" : "is movable"}`, () => {
      assert.equal(isFixedTask(task), fixed, "shared rule");

      const timeline = dayMarkup(scheduleContext(demoContext([structuredClone(task)]), date, { date, minute: 690 }), settings, null);
      assert.equal(/agenda-item[^"]*agenda-fixed/.test(timeline), fixed, "day timeline agenda");
      assert.equal(/axis-interval task\s+fixed/.test(timeline), fixed, "day timeline block");

      const current = lockHome([structuredClone(task)]).html();
      assert.equal(/current-arrangement current-fixed/.test(current), fixed, "home current plan");
      // The home screen shows the very label of the shared badge.
      const shown = badges(current);
      if (fixed) assert.ok(shown.length > 0 && shown.every((b) => b === badges(fixedBadge(task))[0]), "home badge text");
      else assert.deepEqual(shown, []);
      const upNext = lockHome([lockTask("first", { start: 700, duration: 15 }), structuredClone({ ...task, start: 800 })]).html();
      assert.equal(/next-row next-fixed/.test(upNext), fixed, "home up next");

      // The badge keeps its promise: a cascade of the default rules moves the item only if it is movable.
      const days = { [date]: [lockTask("first", { start: 600, duration: 60 }), structuredClone(task)] };
      const ruled = proposeReschedule(days, { date, taskId: "first", start: 690 });
      assert.equal(ruled.proposal.changes.some((c) => c.id === name), !fixed, "default rules");
    });
  }
});

describe("the home screen of a fixed event or locked task", () => {
  const meeting = lockTask("Meeting", { type: "activity", locked: true, bufferBefore: 60, bufferAfter: 60 });
  const locked = lockTask("MyLock", { locked: true, lockSource: "user" });

  test("it names the kind, says it will not move, and offers no time change", () => {
    for (const [task, state, other, note] of [
      [meeting, /<span class="task-state">Fixed event<\/span>/, /<span class="task-state">Locked task<\/span>/, /This is a fixed event\. Its original time is preserved/],
      [locked, /<span class="task-state">Locked task<\/span>/, /<span class="task-state">Fixed event<\/span>/, /This time is locked\. It will not move/],
    ]) {
      const out = lockHome([task]).html();
      assert.match(out, state);
      assert.doesNotMatch(out, other, "a locked task is not named like a fixed event");
      assert.match(out, note);
      assert.match(out, /will not move/i);
      // The three-step guide legitimately says "Choose a time"; only the button must be absent.
      assert.doesNotMatch(out, /<button[^>]*>\s*Choose a time\s*<\/button>/);
      assert.match(out, /<button[^>]*>\s*Task details \/ Add\s*<\/button>/);
      assert.doesNotMatch(out, /id="wb-from-now"/);
    }
  });

  test("trying to move one says it will not move and changes nothing", () => {
    for (const [task, kind] of [[meeting, /Fixed event/], [lockTask("Mine", { locked: true }), /Locked task/]]) {
      let moved = false;
      const home = lockHome([task], { api: { move: async () => { moved = true; return null; }, cancel() {} } });
      const before = JSON.stringify(home.branch.days);
      home.bench.adjust({ date: LOCK_DATE, task });
      assert.match(home.html(), kind);
      assert.match(home.html(), /will not move/);
      assert.match(home.html(), /Nothing was changed/);
      assert.equal(moved, false);
      assert.equal(JSON.stringify(home.branch.days), before);
    }
  });
});

describe("the default rules keep the badge's promise", () => {
  const date = "2026-10-13";
  const day = () => ({ [date]: [item("Essay", 600, 60), item("Call", 700, 30, { timeLocked: true }), item("Review", 760, 60)] });

  test("a time-locked item shows the badge and the default rules keep it in place", () => {
    const days = day();
    assert.equal(isFixedTask(days[date][1]), true);
    const ruled = proposeReschedule(days, { date, taskId: "Essay", start: 690 });
    assert.notEqual(ruled.status, "error");
    assert.ok(!ruled.proposal.changes.some((c) => c.id === "Call"), "Call is not moved");
    assert.ok(ruled.proposal.unchanged.includes("Call"));
    assert.equal(ruled.proposal.days[date].find((t) => t.id === "Call").start, 700);
    // The moved task does not land on top of it either.
    const essay = ruled.proposal.days[date].find((t) => t.id === "Essay");
    assert.ok(essay.start >= 730 || essay.start + essay.duration <= 700);
    assert.ok(ruled.proposal.timeline.some((e) => e.id === "Call" && e.type === "fixed"));
  });

  test("the older planner cascade does not move a time-locked item", () => {
    const result = plan(day(), {}, { anchorId: "Essay", start: 690 });
    assert.ok(!(result.changes || []).some((c) => c.id === "Call"), "Call is not moved");
  });

  test("a time-locked item cannot be chosen as the task to move", () => {
    assert.equal(proposeReschedule(day(), { date, taskId: "Call", start: 800 }).status, "error");
  });

  test("moving a fixed event or a user-locked task is refused with a plain message and nothing changes", () => {
    const days = { [date]: [item("Practice", 600, 45), item("MyLock", 780, 30, { locked: true, lockSource: "user" }),
      item("Meeting", 960, 60, { type: "activity", locked: true, bufferBefore: 60, bufferAfter: 60 })] };
    const before = JSON.stringify(days);
    for (const id of ["Meeting", "MyLock"]) {
      const r = proposeReschedule(days, { date, taskId: id, start: 700 });
      assert.equal(r.status, "error");
      assert.equal(r.proposal, null);
      assert.match(r.message, /will not move/);
      assert.match(r.message, /Nothing was changed/);
      if (id === "MyLock") assert.doesNotMatch(r.message, /fixed event/i);
      else assert.match(r.message, /^Fixed event/);
    }
    assert.equal(JSON.stringify(days), before);
  });
});

describe("buffers on the question", () => {
  const today = PROPOSAL_TODAY, tomorrow = PROPOSAL_TOMORROW;
  const standup = (start = 570) => proposalItem("standup", start, 30, { locked: true, type: "activity" });
  const questionDays = () => ({ ...proposalFixture(), [tomorrow]: [standup(), proposalItem("x", 900, 60)] });
  const askQuestion = async (text) => {
    const r = uiRig({ days: questionDays(), date: today, selected: "t2", now: "2026-10-27T15:00:00Z" });
    r.click("task-actions");
    r.type(text);
    await tick();
    return r;
  };

  test("a move to another day keeps the 60-minute fixed-event buffer and carries no spacing note", async () => {
    const r = await askQuestion("tomorrow at 11 am");
    try {
      assert.match(r.output(), /<h2>Change it like this\?<\/h2>/);
      assert.doesNotMatch(r.lines().join(" "), /is spaced without the same-day/);
    } finally { r.close(); }
  });

  test("a same-day default-rules proposal carries no other-day spacing note", async () => {
    const r = await askQuestion("today at 10:50 am");
    try { assert.doesNotMatch(r.lines().join(" "), /is spaced without the same-day/); } finally { r.close(); }
  });

  test("a task moved to tomorrow next to a fixed event keeps 60 minutes on each side", () => {
    const days = questionDays(); // standup 09:30-10:00 tomorrow
    const ok = proposeMoveToDay(days, { date: today, taskId: "t2", targetDate: tomorrow, start: 660 });
    assert.equal(ok.status, "ok");
    assert.equal(ok.proposal.changes.length, 1);
    assert.equal(ok.proposal.days[today].some((t) => t.id === "t2"), false);
    const at = (d, start) => proposeMoveToDay(d, { date: today, taskId: "t2", targetDate: tomorrow, start }).status;
    assert.equal(at(days, 659), "conflict"); // standup ends 10:00; after-buffer runs to 11:00
    days[tomorrow] = [standup(780)];
    assert.equal(at(days, 600), "ok"); // 120-minute task ends 12:00, exactly 60 before the event
    assert.equal(at(days, 601), "conflict");
  });

  test("the spacing note names a study task and steps aside for a user who keeps a 60-minute buffer or moves to another day", () => {
    const study = { title: "Study", learning: { planId: "p" } };
    const same = { from: { date: today, start: 600 }, to: { date: today, start: 660 } };
    assert.match(plannerSpacingNote(same, study, defaults()), /^(A study task|This move) is spaced/);
    assert.equal(plannerSpacingNote(same, {}, { bufferBefore: 60, bufferAfter: 60 }), "");
    assert.equal(plannerSpacingNote(null, {}, {}), "");
    assert.equal(plannerSpacingNote({ from: { date: today, start: 600 }, to: { date: tomorrow, start: 660 } }, study, defaults()), "");
  });

  test("a warning that the day cannot finish before 23:00 is styled apart from the plain question", async () => {
    assert.equal(proposeReschedule(questionDays(), { date: today, taskId: "t2", delay: 40 }).status, "warning");
    const warned = await askQuestion("today at 10:50 am");
    try {
      assert.match(warned.output(), /<div class="question question-warning"><p class="question-line">/);
      assert.match(warned.lines()[2], /does not fit before 23:00 today/);
    } finally { warned.close(); }
    const calm = await askQuestion("today at 10:20 am");
    try {
      assert.match(calm.output(), /<h2>Change it like this\?<\/h2>/);
      assert.match(calm.output(), /<div class="question"><p class="question-line">/);
    } finally { calm.close(); }
    assert.match(css, /\.question-warning \.question-line:last-child\s*\{[^}]*border-left/);
  });
});
