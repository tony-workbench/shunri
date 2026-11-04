// UI preview. Does not import the real server/Calendar
// service, load .env, inspect tokens, or make any outbound network requests.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const previewScenarios = Object.freeze([
  "disconnected", "writes-off", "expired", "syncing", "partial-failure", "offline",
]);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const calendarId = "ui-preview-synthetic";
const csrfToken = "ui-preview-only-no-real-credentials";
const calendar = {
  id: calendarId, summary: "Preview Calendar · Synthetic data", accessRole: "owner",
  timeZone: "America/Los_Angeles", primary: true,
};
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ...["app", "workbench", "ui-messages", "schedule-context", "calendar-semantics", "scheduler", "planner", "time",
    "storage", "workflow", "learning", "intent-planner", "calendar-data", "sync-queue"]
    .map((name) => [`/${name}.js`, [`${name}.js`, "text/javascript; charset=utf-8"]]),
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/assets/shunri.svg", ["assets/shunri.svg", "image/svg+xml"]],
  ["/assets/google-calendar.png", ["assets/google-calendar.png", "image/png"]],
  ["/assets/sunny-path.webp", ["assets/sunny-path.webp", "image/webp"]],
  ["/assets/encouragement.mp3", ["assets/encouragement.mp3", "audio/mpeg"]],
]);
const scenarioFrom = (value) => previewScenarios.includes(value) ? value : "disconnected";
const cookieScenario = (req) => {
  const match = String(req.headers.cookie || "").match(/(?:^|;\s*)shunri_ui_mock=([^;]*)/);
  return scenarioFrom(match?.[1]);
};
const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'none'; form-action 'self'; base-uri 'none'",
};
const json = (res, status, value) => {
  res.writeHead(status, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ...value, mock: true, preview: true }));
};
async function body(req) {
  let content = "";
  for await (const chunk of req) {
    content += chunk;
    if (content.length > 1_000_000) throw Error("Preview request is too large");
  }
  return content ? JSON.parse(content) : {};
}
function mockStatus(mockState) {
  const state = {
    disconnected: "disconnected", "writes-off": "connected", expired: "expired",
    syncing: "connected", "partial-failure": "connected", offline: "network",
  }[mockState];
  const messages = {
    disconnected: "Preview Calendar is disconnected. Connect only changes the local preview state.",
    "writes-off": "Preview Calendar is connected with writes off. No Google data is read or sent.",
    expired: "Preview authorization expired. Reconnect only changes the local preview state.",
    syncing: "Preview sync in progress (sample state). Writes are off; no Google requests are sent.",
    "partial-failure": "Some preview calendars could not be read. Local plans are kept and writes are off.",
    offline: "Preview connection is unavailable. Local plans are kept; Google is not accessed.",
  };
  return { state, configured: false, writesEnabled: false, csrfToken,
    busy: mockState === "syncing", mockState, message: messages[mockState] };
}

export function createPreviewServer({ root = sourceRoot, scenario = "disconnected" } = {}) {
  const fallback = scenarioFrom(scenario);
  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "";
      const boundPort = res.socket.localPort;
      if (host !== `localhost:${boundPort}` && host !== `127.0.0.1:${boundPort}`) {
        json(res, 403, { error: "Only loopback preview addresses are allowed" });
        return;
      }
      const origin = `http://${host}`;
      const url = new URL(req.url, origin);
      const queryScenario = url.searchParams.get("calendarMock");
      if (queryScenario !== null && !previewScenarios.includes(queryScenario)) {
        json(res, 400, { error: "Unknown preview state", available: previewScenarios });
        return;
      }
      const mockState = queryScenario ??
        (req.headers.cookie?.includes("shunri_ui_mock=") ? cookieScenario(req) : fallback);
      if (queryScenario !== null) res.setHeader("Set-Cookie", `shunri_ui_mock=${mockState}; Path=/; HttpOnly; SameSite=Strict`);
      if (url.pathname === "/api/ui-preview") {
        json(res, 200, { mockState, available: previewScenarios, realCalendarAccess: false, writesEnabled: false });
        return;
      }
      if (url.pathname === "/ui-preview.js") {
        res.writeHead(200, { ...securityHeaders, "Content-Type": "text/javascript; charset=utf-8" });
        res.end(`window.SHUNRI_PREVIEW = Object.freeze(${JSON.stringify({ mock: true, mockState, realCalendarAccess: false })});`);
        return;
      }
      if (url.pathname.startsWith("/api/calendar/")) {
        const route = url.pathname.slice("/api/calendar/".length);
        if (req.method === "POST" && (req.headers.origin !== origin || req.headers["x-shunri-csrf"] !== csrfToken)) {
          json(res, 403, { error: "Preview request could not be verified. Refresh and try again." });
          return;
        }
        if (route === "status" && req.method === "GET") {
          json(res, 200, mockStatus(mockState));
          return;
        }
        if (route === "connect" && req.method === "GET") {
          // Never redirect to accounts.google.com: no OAuth credentials exist here.
          res.writeHead(303, { ...securityHeaders, Location: "/?calendarMock=writes-off" });
          res.end();
          return;
        }
        if (route === "callback") {
          json(res, 403, { error: "The UI preview does not accept real OAuth callbacks" });
          return;
        }
        if (mockStatus(mockState).state !== "connected") {
          json(res, 503, { error: mockStatus(mockState).message, state: mockStatus(mockState).state });
          return;
        }
        if (route === "calendars" && req.method === "GET") {
          json(res, 200, { calendars: [calendar] });
          return;
        }
        if (route === "events" && req.method === "GET") {
          if (mockState === "syncing") await new Promise((resolve) => setTimeout(resolve, 1600));
          const partial = mockState === "partial-failure";
          const catalog = url.searchParams.get("purpose") === "job-prepare-catalog";
          json(res, 200, {
            // The user's synthetic local schedule stays the only task fixture.
            events: [], calendars: [calendar], completedCalendarIds: [calendarId],
            complete: !partial, partial, readScope: catalog ? "job-prepare-catalog" : "all-events",
            range: { from: url.searchParams.get("from"), to: url.searchParams.get("to"),
              timeZone: "America/Los_Angeles", catalog, fullOccupationCoverage: !partial && !catalog },
            ...(catalog ? { catalog: { planId: "job-prepare", scannedEventCount: 0, filteredEventCount: 0 } } : {}),
            errors: partial ? [{ calendarId: "ui-preview-shared", calendarName: "Preview shared calendar", message: "Some preview data could not be read. No real calendars were accessed." }] : [],
          });
          return;
        }
        if (route === "preview" && req.method === "POST") {
          const payload = await body(req);
          const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
          json(res, 200, { planId: "ui-preview-not-executable", expiresAt: Date.now() + 600000,
            calendarId, calendarName: calendar.summary, writesEnabled: false, canExecute: false,
            items: tasks.map((task) => ({ uid: task.uid, id: task.id, title: task.title,
              date: task.date, start: task.start, duration: task.duration, calendarId,
              action: task.calendarLink ? "update" : "create", reason: "Local preview only; nothing has been sent" })),
            dateRange: tasks.length ? [tasks.map((t) => t.date).sort()[0], tasks.map((t) => t.date).sort().at(-1)] : [],
          });
          return;
        }
        if (["execute", "adopt", "disconnect"].includes(route)) {
          json(res, 403, { error: "Real writes and account changes are disabled in the UI preview. No Google requests were sent.", writesEnabled: false });
          return;
        }
        json(res, 404, { error: "This Calendar operation is unavailable in the UI preview" });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        json(res, 405, { error: "Preview resources are read-only" });
        return;
      }
      const entry = staticFiles.get(url.pathname);
      if (!entry) {
        res.writeHead(404, securityHeaders);
        res.end("Not found");
        return;
      }
      let content = await readFile(path.join(root, entry[0]));
      if (entry[0] === "index.html") content = content.toString().replace("</head>", '<script src="/ui-preview.js"></script></head>');
      res.writeHead(200, { ...securityHeaders, "Content-Type": entry[1] });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch {
      if (!res.headersSent) json(res, 500, { error: "The isolated UI preview resource is temporarily unavailable" });
      else res.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || process.env.CONDUCTOR_PORT || 55010);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3000) {
    throw Error("UI preview requires a valid separate port; port 3000 is reserved");
  }
  const server = createPreviewServer({ scenario: process.env.UI_CALENDAR_MOCK });
  server.on("error", (error) => { console.error(`Isolated preview could not start: ${error.message}`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Shunri isolated UI preview: http://localhost:${port}/ (synthetic Calendar data only; real writes off)`);
  });
}
