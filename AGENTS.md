# Browser checks

- Run automated tests, acceptance checks and screenshots with `headless: true` in a separate, temporary browser context.
- Never use a visible window, `bringToFront`, `activate`, `open Chrome`, or the owner's everyday Chrome profile, windows or tabs. Debug in a visible window only if the owner asks.
- Save screenshots to files and inspect them there.
- Only stop processes your own test started; never close Chrome processes in bulk.
