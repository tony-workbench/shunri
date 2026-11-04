# Shunri

A local scheduling app. Choose a task, give it a new time ("tomorrow at 2pm"), review one proposal for how the rest of the plan shifts, and confirm. Saved changes can be undone.

## What you need

- Node.js 22 or newer ([download](https://nodejs.org/)). There is nothing to install with `npm`.

## Run it

1. Get the code:

   ```sh
   git clone https://github.com/tony-workbench/shunri.git
   cd shunri
   ```

2. Start the app:

   ```sh
   npm start
   ```

3. Open <http://localhost:3000>. Set `PORT` to use another port.
4. Choose a date and task, enter a new time, read the proposal ("Change it like this?") and click **Yes**. **Undo the latest change** takes it back.
5. Press `Ctrl+C` in the terminal to stop.

The schedule is stored in this browser only. Export and import a backup from the app to move it elsewhere.

## Try it with example data

`npm run preview` serves a separate copy with made-up data and a simulated Google Calendar at <http://localhost:55010>. Set `PORT` to change the port (not 3000).

## Connect Google Calendar (optional)

1. In [Google Cloud Console](https://console.cloud.google.com/), enable the Google Calendar API and create an OAuth client of type Web application.
2. Add `http://localhost:3000/api/calendar/callback` as a redirect URI and add your own Google account as a test user.
3. Copy the settings template and fill in the client ID and secret:

   ```sh
   cp .env.example .env
   ```

4. Restart the app and connect from the Calendar panel.

The app creates or changes Google events only if `.env` sets `CALENDAR_WRITES_ENABLED=true`, and it never deletes Google events.

## Test

```sh
npm test
```

## More

- The tool that reviews this app's changes is a separate project: [shunri-roundtable](https://github.com/tony-workbench/shunri-roundtable)
- [Product direction](docs/PRODUCT-DIRECTION.md)
- [Acceptance checks](docs/integration-acceptance.md)
- [Artwork credits](assets/SOURCES.md)
