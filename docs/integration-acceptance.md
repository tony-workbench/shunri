# Acceptance checks

Checks a person can repeat to confirm the app works end to end. Nothing here needs a real Google account.

## Automated tests

```sh
npm test
```

All tests must pass with none failed, skipped or cancelled. They use made-up accounts, events and temporary storage, and cover:

- Rescheduling rules, the "Try another" alternatives, fixed events, buffers and task attributes.
- Saving, Undo, backup import and restore, and upgrade of stored data.
- Google Calendar token handling, event ownership checks, the sync queue and its history cap.
- English interface text, error messages and English time input, including ambiguous times.

## Browser check

`scripts/result-flow-browser-check.mjs` drives the preview server in a headless Chromium at 320, 390 and 1280 px wide. It needs `playwright-core` (or a module named in `UI_PLAYWRIGHT_MODULE`) and optionally `CHROME_EXECUTABLE`; screenshots and `report.json` go to `RESULT_FLOW_OUTPUT` (default `.context/result-flow`). It checks that:

- Confirming a change saves exactly once, even on a double click, and fixed events stay unchanged.
- The result details, reload and Undo work, and a change made in a second tab marks the earlier result as outdated.
- No page has horizontal scrolling, browser errors or requests to outside hosts.

## Calendar states

`npm run preview` serves made-up Calendar data. Pick a state with `UI_CALENDAR_MOCK=<state>` or the `scenario` query parameter: `disconnected`, `writes-off`, `expired`, `syncing`, `partial-failure`, `offline`. Each state should show an English explanation and read-only controls, and saved events stay unchanged.

## Optional audio

The "Play encouragement" button plays `assets/encouragement.mp3` only after a click. Without the file it shows a message that the audio is unavailable and planning continues.

## Not covered

- Real Google sign-in tokens and events.
- Text from Google or the user that is not recognised is shown as typed, not translated.
