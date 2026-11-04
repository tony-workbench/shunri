import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { createCalendarService } from "./calendar-service.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  loadEnvFile(path.join(root, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/workbench.js", ["workbench.js", "text/javascript; charset=utf-8"]],
  ["/ui-messages.js", ["ui-messages.js", "text/javascript; charset=utf-8"]],
  ["/schedule-context.js", ["schedule-context.js", "text/javascript; charset=utf-8"]],
  [
    "/calendar-semantics.js",
    ["calendar-semantics.js", "text/javascript; charset=utf-8"],
  ],
  ["/scheduler.js", ["scheduler.js", "text/javascript; charset=utf-8"]],
  ["/planner.js", ["planner.js", "text/javascript; charset=utf-8"]],
  ["/time.js", ["time.js", "text/javascript; charset=utf-8"]],
  ["/storage.js", ["storage.js", "text/javascript; charset=utf-8"]],
  ["/workflow.js", ["workflow.js", "text/javascript; charset=utf-8"]],
  ["/learning.js", ["learning.js", "text/javascript; charset=utf-8"]],
  [
    "/intent-planner.js",
    ["intent-planner.js", "text/javascript; charset=utf-8"],
  ],
  ["/calendar-data.js", ["calendar-data.js", "text/javascript; charset=utf-8"]],
  ["/sync-queue.js", ["sync-queue.js", "text/javascript; charset=utf-8"]],
  ["/task-attributes.js", ["task-attributes.js", "text/javascript; charset=utf-8"]],
  ["/assets/shunri.svg", ["assets/shunri.svg", "image/svg+xml"]],
  ["/assets/google-calendar.png", ["assets/google-calendar.png", "image/png"]],
  ["/assets/sunny-path.webp", ["assets/sunny-path.webp", "image/webp"]],
  ["/assets/encouragement.mp3", ["assets/encouragement.mp3", "audio/mpeg"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const port = Number(process.env.PORT || 3000);
const origin = new URL(`http://localhost:${port}`).origin;
const localhostHosts = new Set([new URL(origin).host, `localhost:${port}`]);
const ipHosts = new Set([new URL(`http://127.0.0.1:${port}`).host, `127.0.0.1:${port}`]);
const calendar = createCalendarService({
  origin,
  dataDir: path.join(root, ".local-data/calendar"),
});
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (
      !localhostHosts.has(req.headers.host) &&
      !ipHosts.has(req.headers.host)
    ) {
      res.writeHead(403);
      res.end("Invalid host");
      return;
    }
    // Keep the page, OAuth callback, host-only session cookie and browser
    // storage on one origin. Never forward a mutation across origins.
    if (ipHosts.has(req.headers.host)) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(403);
        res.end("Use the localhost origin");
        return;
      }
      // This standalone, read-only page needs the old origin to export its
      // browser storage. Do not expose modules, APIs or sessions on that origin.
      if (req.url.split("?")[0] === "/ip-recovery") {
        try {
          const content = await readFile(path.join(root, "ip-recovery.html"));
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(req.method === "HEAD" ? undefined : content);
        } catch {
          res.writeHead(500);
          res.end("Unable to load recovery page");
        }
        return;
      }
      // The page explains origin-local storage; API and OAuth URLs stay exact.
      if (url.pathname === "/") url.searchParams.set("shunriOrigin", "ip");
      res.writeHead(302, {
        Location: `${origin}${url.pathname}${url.search}`,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }
    try {
      if (await calendar.handle(req, res, url)) return;
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "The Calendar service is temporarily unavailable. The local schedule was not changed." }),
      );
      return;
    }
    const entry = files.get(url.pathname);
    if (!entry) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    try {
      const content = await readFile(path.join(root, entry[0]));
      res.writeHead(200, {
        "Content-Type": entry[1],
        "Cache-Control": "no-store",
      });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end("Unable to load app");
    }
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`Shunri: ${origin}`),
  );
