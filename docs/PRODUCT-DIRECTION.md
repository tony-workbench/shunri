# Product direction

What Shunri should do and the order of the work.

## Goal

When a schedule is disrupted, the user picks a task and gives it a new time. The app applies one fixed set of rules, shows one proposal and asks "Change it like this?". Yes saves; "Try another" shows the next proposal. Fixed events and completed records never move. Every saved change can be undone. A first-time user needs no instructions.

## Requirements and status

The tests in `tests/` show the current state.

| Requirement | Status | Evidence |
| --- | --- | --- |
| A first-time user knows what to do | Met | `tests/first-use.test.mjs` walks through the on-screen guide |
| Fixed events are recognisable at a glance | Met | `tests/fixed-events.test.mjs` |
| One proposal at a time, answered yes or no | Met | Buttons are "Yes", "Try another", "Cancel"; `tests/one-question-proposal.test.mjs` |
| The five default rules applied together | Met | `tests/default-rules.test.mjs` |
| English interface, explanations and errors | Met | `tests/ui-messages.test.mjs`, `tests/server-assets.test.mjs` |
| Task, preview, confirm, Undo; fixed events kept; Calendar writes off by default; 320/390/1280 px; offline tests | Met | `docs/integration-acceptance.md` |

## Default rescheduling behaviour

The five rules are ONE default, applied together, not alternatives.

| # | Rule | Detail |
| --- | --- | --- |
| 1 | Same-day shift | Later unfinished tasks move back in their original order with unchanged durations. Completed work and breaks stay. Fixed events keep a 60-minute buffer on each side. Past 23:00, warn first; never move to another day silently. |
| 2 | Cross-day shift | Only when the day cannot hold the work. Respect each day's available windows, capacity and task dependencies. Save and Undo are atomic; stale previews expire. |
| 3 | Next-day gap | The one task that does not fit goes into tomorrow's first gap that holds it, without moving anything else. |
| 4 | Habit buffers | Ten minutes of rest before and after every task, counted when scheduling. |
| 5 | Scheduled rest | Every break is placed on the timeline, not only the tasks. |

"Try another" offers these in order: reorder the rest of the day by deadline and priority; split the task across today and tomorrow; place it in the slot where this kind of task is usually done; say plainly that it does not fit and leave it unscheduled; after N consecutive postponements, ask whether to drop or archive it; replan the whole day once each morning.

## Work queue

Take items in order. The Who column names who builds and who verifies each item.

| # | Goal | Acceptance | Who |
| --- | --- | --- | --- |
| S1 | The five default rules combined | A day with 4 tasks and 1 fixed event: postponing task 2 by 40 minutes yields one proposal satisfying all five rules, covered by tests in `tests/` | Coding seats; Kylon verifies |
| S2 | One question, one answer | One proposal stating what moved, what did not and why; buttons are only "Yes", "Try another", "Cancel"; at most 3 clicks from new time to saved; at most 3 lines of text | Coding seats; AdaL and Masky verify |
| S3 | Usable on first open | Three-step guide on the first screen; the example button says its data is fictional; a scripted first-time walkthrough that follows only the on-screen guide saves one reschedule in at most 3 clicks and one typed time, which counts as under 90 seconds (20 s to read, 15 s per click, 20 s to type) | Coding seats; AdaL, Masky and AskTheW verify |
| S4 | Fixed events stand out | A distinct style or label meaning "will not move", and buffers explained; fixed and movable items can be told apart in a screenshot without reading | Coding seats; AdaL verifies |
| S5 | Fixed task attributes | Tags with fixed rules, no AI: commute (travel time before and after, moving with the event), tiring (longer recovery, never two in a row), priority and deadline, estimate buffer (25–30%), habits (a window and an ideal time), manually moved (locked) | Coding seats; Kylon verifies |
| S6 | Alternatives behind "Try another" | Each alternative listed above has a test | Coding seats |
| S7 | Copy clean-up | No leaked Chinese; `ip-recovery.html` in English | Coding seats; AdaL verifies |
| S8 | Continuous roundtable | One unattended run completes two of S1–S4 | Claude coordinator |

Later, each needing its own decision: real Google Calendar writes, cross-device sync, merging and public deployment.
