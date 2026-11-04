import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import vm from "node:vm";
import { freshWorkspace } from "../storage.js";
import { createWorkbench } from "../workbench.js";
import { createPreviewServer, previewScenarios } from "../scripts/ui-preview.mjs";

// ---- Origin and host guards of the production server

// Run the production entrypoint from a disposable copy, with no original .env,
// credentials or authorization storage. Only loopback HTTP requests are made.
async function isolatedServer(t, { logicalPort } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "shunri-server-test-"));
  for (const name of ["server.mjs", "calendar-service.mjs", "calendar-semantics.js", "learning.js", "time.js", "ip-recovery.html"])
    await copyFile(new URL(`../${name}`, import.meta.url), join(dir, name));
  await writeFile(join(dir, "package.json"), '{"type":"module"}');
  await writeFile(join(dir, "index.html"), "<p>Synthetic local entrypoint</p>");
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const transportPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const port = logicalPort ?? transportPort, args = [];
  if (logicalPort != null) {
    // Only replace the listener's physical port. All production routing,
    // configuration, Host and Origin checks still see the logical port.
    const adapter = join(dir, "listen-adapter.mjs");
    await writeFile(adapter, `import { Server } from "node:http";
      const listen = Server.prototype.listen;
      Server.prototype.listen = function(...args) {
        if (args[0] !== ${logicalPort} || args[1] !== "127.0.0.1") throw new Error("Unexpected bind");
        args[0] = ${transportPort}; return listen.apply(this, args);
      };`);
    args.push("--import", adapter);
  }
  const child = spawn(process.execPath, [...args, join(dir, "server.mjs")], {
    cwd: dir, env: { PORT: String(port), CALENDAR_WRITES_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => { throw new Error("Synthetic server exited before listening"); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Synthetic server start timeout")), 5000); timer.unref(); }),
  ]);
  const origin = new URL(`http://localhost:${port}`).origin;
  async function request({ host = new URL(origin).host, path = "/", method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: transportPort, path, method, agent: false,
        headers: { Host: host, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  return { request, origin, port, transportPort };
}

test("the IP recovery page is served only for exact GET and HEAD requests, with no session and no API exemptions", async (t) => {
  for (const logicalPort of [undefined, 80]) {
    const h = await isolatedServer(t, { logicalPort });
    const hosts = logicalPort === 80 ? ["127.0.0.1", "127.0.0.1:80"] : [`127.0.0.1:${h.port}`];
    for (const host of hosts) {
      for (const method of ["GET", "HEAD"]) {
        const result = await h.request({ host, method, path: "/ip-recovery?return=https://evil.invalid" });
        assert.equal(result.status, 200);
        assert.equal(result.headers.location, undefined);
        assert.equal(result.headers["set-cookie"], undefined);
        assert.equal(result.headers["cache-control"], "no-store");
        assert.equal(result.headers["referrer-policy"], "no-referrer");
        assert.equal(result.headers["x-content-type-options"], "nosniff");
        for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'"])
          assert.ok(result.headers["content-security-policy"].includes(directive));
        if (method === "HEAD") assert.equal(result.text, "");
        else { assert.match(result.text, /id="download-original"/); assert.ok(!result.text.includes("evil.invalid")); }
      }
      for (const path of ["/api/calendar/status", "/storage.js", "/ip-recovery/", "/ip%2drecovery", "/other/../ip-recovery"]) {
        const result = await h.request({ host, path });
        assert.equal(result.status, 302, path);
        assert.equal(new URL(result.headers.location).origin, h.origin);
        assert.equal(result.headers["set-cookie"], undefined);
      }
      for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
        const result = await h.request({ host, method, path: "/ip-recovery", body: "{}" });
        assert.equal(result.status, 403);
        assert.equal(result.headers.location, undefined);
        assert.equal(result.headers["set-cookie"], undefined);
      }
      assert.equal((await h.request({ host, path: "/api/calendar/preview", method: "POST", body: "{}" })).status, 403);
    }
    assert.equal((await h.request({ path: "/ip-recovery" })).status, 404);
    for (const host of ["evil.invalid", "127.0.0.1.evil.invalid", `127.0.0.1:${h.port + 1}`])
      assert.equal((await h.request({ host, path: "/ip-recovery" })).status, 403);
  }
});

test("IP-address GET and HEAD requests are redirected to localhost keeping path and query", async (t) => {
  const h = await isolatedServer(t);
  for (const method of ["GET", "HEAD"]) {
    const result = await h.request({ host: `127.0.0.1:${h.port}`, path: "/api/calendar/status?probe=synthetic%20value", method });
    assert.equal(result.status, 302);
    assert.equal(result.headers.location, `${h.origin}/api/calendar/status?probe=synthetic%20value`);
    assert.equal(result.headers["cache-control"], "no-store");
    for (const path of ["/", "/?probe=synthetic%20value&shunriOrigin=old"]) {
      const page = await h.request({ host: `127.0.0.1:${h.port}`, path, method });
      assert.equal(page.status, 302);
      const target = new URL(page.headers.location);
      assert.equal(target.origin, h.origin);
      assert.equal(target.pathname, "/");
      assert.deepEqual(target.searchParams.getAll("shunriOrigin"), ["ip"]);
      assert.equal(target.searchParams.get("probe"), path.includes("probe") ? "synthetic value" : null);
    }
  }
  const home = await h.request();
  assert.equal(home.status, 200);
  assert.match(home.text, /Synthetic local entrypoint/);
  const status = await h.request({ path: "/api/calendar/status" });
  const data = JSON.parse(status.text);
  assert.equal(status.status, 200);
  assert.equal(data.state, "unconfigured");
  assert.equal(data.writesEnabled, false);
  // A same-origin POST with the issued session/CSRF passes security validation
  // and stops at the intentionally unconfigured provider boundary.
  const accepted = await h.request({ path: "/api/calendar/preview", method: "POST", headers: {
    Origin: h.origin, Cookie: status.headers["set-cookie"][0].split(";")[0],
    "X-Shunri-CSRF": data.csrfToken, "Content-Type": "application/json",
  }, body: "{}" });
  assert.equal(accepted.status, 503);
});

test("unsafe methods, malicious hosts and origins and invalid CSRF tokens are rejected without redirects", async (t) => {
  const h = await isolatedServer(t);
  for (const host of [`evil.invalid:${h.port}`, `localhost.evil.invalid:${h.port}`, `127.0.0.1:${h.port + 1}`, `localhost:${h.port + 1}`,
    "localhost", "localhost:80", "127.0.0.1", "127.0.0.1:80"]) {
    const result = await h.request({ host, path: "/api/calendar/status" });
    assert.equal(result.status, 403);
    assert.equal(result.headers.location, undefined);
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    const result = await h.request({ host: `127.0.0.1:${h.port}`, method, path: "/api/calendar/preview", body: "{}" });
    assert.equal(result.status, 403);
    assert.equal(result.headers.location, undefined);
  }
  const status = await h.request({ path: "/api/calendar/status" });
  const csrf = JSON.parse(status.text).csrfToken;
  const cookie = status.headers["set-cookie"][0].split(";")[0];
  for (const origin of ["https://evil.invalid", `http://127.0.0.1:${h.port}`, `${h.origin}.evil.invalid`, "null"]) {
    const result = await h.request({ method: "POST", path: "/api/calendar/preview", headers: { Origin: origin, Cookie: cookie, "X-Shunri-CSRF": csrf }, body: "{}" });
    assert.equal(result.status, 403);
    assert.equal(result.headers.location, undefined);
  }
  const badCsrf = await h.request({ method: "POST", path: "/api/calendar/preview", headers: { Origin: h.origin, Cookie: cookie, "X-Shunri-CSRF": "wrong" }, body: "{}" });
  assert.equal(badCsrf.status, 403);
});

test("on logical port 80 the default Host forms are accepted with a canonical Origin and every request guard still applies", async (t) => {
  const h = await isolatedServer(t, { logicalPort: 80 });
  assert.notEqual(h.transportPort, 80);
  assert.equal(h.origin, "http://localhost");
  let cookie, csrf;
  for (const host of ["localhost", "localhost:80"]) {
    assert.equal((await h.request({ host })).status, 200);
    const status = await h.request({ host, path: "/api/calendar/status" });
    assert.equal(status.status, 200);
    const data = JSON.parse(status.text);
    assert.equal(data.state, "unconfigured");
    cookie = status.headers["set-cookie"][0].split(";")[0]; csrf = data.csrfToken;
    const post = await h.request({ host, path: "/api/calendar/preview", method: "POST", headers: {
      Origin: h.origin, Cookie: cookie, "X-Shunri-CSRF": csrf, "Content-Type": "application/json",
    }, body: "{}" });
    assert.equal(post.status, 503); // Security passed; no provider is configured.
  }
  for (const host of ["127.0.0.1", "127.0.0.1:80"]) {
    for (const method of ["GET", "HEAD"]) {
      const redirect = await h.request({ host, method, path: "/api/calendar/status?probe=default%20port" });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.location, "http://localhost/api/calendar/status?probe=default%20port");
    }
    const post = await h.request({ host, method: "POST", path: "/api/calendar/preview", headers: {
      Origin: h.origin, Cookie: cookie, "X-Shunri-CSRF": csrf,
    }, body: "{}" });
    assert.equal(post.status, 403); assert.equal(post.headers.location, undefined);
  }
  for (const host of ["localhost:81", "127.0.0.1:81", "localhost.evil.invalid", "localhost@evil.invalid", "localhost:080", "localhost."]) {
    assert.equal((await h.request({ host, path: "/api/calendar/status" })).status, 403);
  }
  for (const origin of ["http://localhost:80", "http://localhost/", "http://localhost@evil.invalid", "http://127.0.0.1", "http://localhost:81", "null", "https://localhost"]) {
    const post = await h.request({ method: "POST", path: "/api/calendar/preview", headers: {
      Origin: origin, Cookie: cookie, "X-Shunri-CSRF": csrf,
    }, body: "{}" });
    assert.equal(post.status, 403); assert.equal(post.headers.location, undefined);
  }
  const badCsrf = await h.request({ method: "POST", path: "/api/calendar/preview", headers: {
    Origin: h.origin, Cookie: cookie, "X-Shunri-CSRF": "wrong",
  }, body: "{}" });
  assert.equal(badCsrf.status, 403);
});

// ---- Old IP-address recovery page and the backup screen link to it

const html = await readFile(new URL("../ip-recovery.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const keys = ["shunri.workspace.v2", "shunri.days.v1"];

async function backupWorkbench(candidates = []) {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("  ipRecoveryUrl: () => {"), end = source.indexOf("  restoreRecovery: (id) => {", start);
  assert.ok(start >= 0 && end > start);
  const callback = vm.runInNewContext(`({${source.slice(start, end)}}).ipRecoveryUrl`, {
    URL, location: { origin: "http://localhost:40567", search: "", hash: "" },
  });
  const nodes = new Map(), actions = [], state = freshWorkspace();
  const node = id => ({ id, hidden: false, innerHTML: "", getClientRects: () => [{}], focus() { document.activeElement = this; } });
  const heading = node("heading");
  let markup = "";
  const root = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      for (const id of [...nodes.keys()]) if (!["workbench", "wb-calendar", "wb-calendar-label"].includes(id)) nodes.delete(id);
      for (const match of value.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const element = node(match[2]);
        element.tagName = match[1].toUpperCase();
        element.href = match[0].match(/\bhref="([^"]+)"/)?.[1];
        nodes.set(match[2], element);
      }
    },
    querySelector: selector => selector === "h1" ? heading : selector === "[data-stage]" && markup ? { dataset: { stage: markup.match(/data-stage="([^"]+)"/)?.[1] } } : null,
  };
  nodes.set("workbench", root); nodes.set("wb-calendar", node("wb-calendar")); nodes.set("wb-calendar-label", node("wb-calendar-label"));
  globalThis.document = { activeElement: null, getElementById: id => nodes.get(id) || null };
  const bench = createWorkbench({
    context: () => ({ mode: "personal", branch: state.personal, ui: state.ui }),
    recoveries: () => candidates, ipRecoveryUrl: callback,
    export: () => actions.push({ kind: "export" }), import: file => actions.push({ kind: "import", file }),
    restoreRecovery: id => { actions.push({ kind: "restore", id }); return { ok: true }; },
  });
  return { bench, root, nodes, actions, state };
}

test("the backup screen shows a plain link to the old IP-address export page without starting any action", async () => {
  const r = await backupWorkbench(), before = structuredClone(r.state);
  r.bench.backup();
  const link = r.nodes.get("wb-ip-recovery");
  assert.equal(link.tagName, "A");
  assert.equal(link.href, "http://127.0.0.1:40567/ip-recovery");
  assert.equal(link.onclick, undefined, "ordinary link navigation, not a new application action");
  assert.match(r.root.innerHTML, /Open the old IP-address export page/);
  assert.match(r.root.innerHTML, /If you previously used Shunri at 127\.0\.0\.1, open the export page in the original browser and port\. Data is not moved automatically\. Import still requires review and confirmation of whole-workspace replacement\./);
  assert.deepEqual([...r.nodes.values()].filter(n => n.tagName === "BUTTON").map(n => n.id), ["wb-export", "wb-import", "wb-back"]);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.state, before);
});

test("the backup screen keeps its recovery confirmation and explicit export and import controls", async () => {
  const r = await backupWorkbench([{ id: "synthetic-recovery", savedAt: "2026-10-19", taskCount: 2 }]);
  const before = structuredClone(r.state);
  r.bench.backup();
  assert.deepEqual([...r.nodes.values()].filter(n => n.tagName === "BUTTON").map(n => n.id), ["wb-export", "wb-import", "wb-restore", "wb-back"]);
  r.nodes.get("wb-restore").onclick();
  assert.equal(r.bench.phase(), "confirmation");
  assert.match(r.root.innerHTML, /Replace the current local schedule and rules/);
  assert.ok(r.nodes.get("wb-yes"));
  assert.deepEqual(r.actions, [], "opening the recovery confirmation neither restores nor follows the link");
  r.bench.backup();
  r.nodes.get("wb-export").onclick();
  assert.deepEqual(r.actions, [{ kind: "export" }]);
  r.nodes.get("wb-import").onclick();
  assert.equal(r.bench.phase(), "import");
  assert.match(r.root.innerHTML, /Review first, then confirm replacement/);
  r.nodes.get("wb-file").onchange({ target: { files: [] } });
  assert.equal(r.actions.length, 1);
  const file = { name: "synthetic-backup.json" };
  r.nodes.get("wb-file").onchange({ target: { files: [file] } });
  assert.deepEqual(r.actions, [{ kind: "export" }, { kind: "import", file }]);
  r.nodes.get("wb-back").onclick();
  assert.equal(r.bench.phase(), "backup");
  assert.equal(r.nodes.get("wb-ip-recovery").href, "http://127.0.0.1:40567/ip-recovery");
  assert.equal(r.actions.length, 2);
  assert.deepEqual(r.state, before);
});

function recoveryPage(values, { denied = false, origin = "http://127.0.0.1:3000" } = {}) {
  const data = new Map(Object.entries(values)), reads = [], writes = [], downloads = [], blobs = new Map(), revoked = [], timers = [];
  const elements = new Map();
  const element = () => ({ textContent: "", addEventListener(type, fn) { this[type] = fn; },
    click() { downloads.push({ href: this.href, download: this.download, blob: blobs.get(this.href) }); }, remove() {} });
  for (const id of ["download-original", "return-localhost", "recovery-status"]) elements.set(id, element());
  class PageURL extends URL {
    static createObjectURL(blob) { const url = `blob:synthetic-${blobs.size}`; blobs.set(url, blob); return url; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const localStorage = {
    getItem(key) { reads.push(key); if (denied === true || denied === key) throw new Error("synthetic storage denial"); return data.has(key) ? data.get(key) : null; },
    setItem(...args) { writes.push(args); throw new Error("Unexpected write"); },
    removeItem(...args) { writes.push(args); throw new Error("Unexpected removal"); },
    clear() { writes.push("clear"); throw new Error("Unexpected clear"); },
  };
  vm.runInNewContext(script, {
    document: { getElementById: (id) => elements.get(id), createElement: element, body: { append() {} } },
    location: { origin, search: "?return=https://evil.invalid&next=//evil.invalid" }, localStorage,
    Blob, URL: PageURL, setTimeout: (fn) => timers.push(fn),
    fetch() { throw new Error("Unexpected network request"); },
  });
  return { data, reads, writes, downloads, revoked, timers, elements,
    click: () => elements.get("download-original").click() };
}

test("the export page downloads the two stored values exactly as they are, and only after a click", async () => {
  const values = {
    [keys[0]]: '  {"version":2,"synthetic":"text 🌤️ <script>"}\n',
    [keys[1]]: '{"2026-10-19":[{"title":"Synthetic legacy"}]}',
    unrelated: "do not read",
  };
  const h = recoveryPage(values);
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.downloads, []);
  assert.equal(h.elements.get("return-localhost").href, "http://localhost:3000/");
  h.click();
  assert.deepEqual(h.reads, keys);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(Object.fromEntries(h.data), values);
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].download, "shunri-ip-original.json");
  const exported = JSON.parse(await h.downloads[0].blob.text());
  assert.deepEqual(exported, { format: "shunri-raw-recovery", original: { [keys[0]]: values[keys[0]], [keys[1]]: values[keys[1]] } });
  assert.equal(h.elements.get("recovery-status").textContent, "Download requested. Check the browser download list or notification.");
  assert.ok(!h.elements.get("recovery-status").textContent.includes("Synthetic legacy"));
  h.timers.forEach((fn) => fn());
  assert.deepEqual(h.revoked, [h.downloads[0].href]);
});

test("the export page creates no download and writes nothing when keys are missing or reads are denied", () => {
  for (const denied of [false, true, keys[1]]) {
    const h = recoveryPage(denied ? { [keys[0]]: "original remains" } : {}, { denied });
    h.click();
    assert.equal(h.downloads.length, 0);
    assert.equal(h.timers.length, 0);
    assert.deepEqual(h.writes, []);
    assert.equal(h.elements.get("recovery-status").textContent, denied
      ? "The browser did not allow reading local data. Nothing was exported."
      : "No saved data was found at this address. Check the original browser and port.");
  }
});

test("the export page keeps empty, malformed, legacy, zero-task and oversized raw values without any fallback", async () => {
  const emptyWorkspace = JSON.stringify(freshWorkspace());
  const cases = [
    { [keys[0]]: emptyWorkspace },
    { [keys[0]]: "" },
    { [keys[0]]: "<script>not valid JSON</script>" },
    { [keys[1]]: '{"synthetic-legacy":[]}' },
    { [keys[1]]: "" },
    { [keys[0]]: "broken v2", [keys[1]]: '{"synthetic-legacy":[]}' },
    { [keys[0]]: "x".repeat(5_000_001) },
  ];
  for (const values of cases) {
    const h = recoveryPage(values);
    h.click();
    assert.equal(h.downloads.length, 1);
    assert.deepEqual(h.reads, keys);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(Object.fromEntries(h.data), values);
    const downloaded = JSON.parse(await h.downloads[0].blob.text());
    assert.deepEqual(downloaded, { format: "shunri-raw-recovery", original: Object.fromEntries(keys.map((key) => [key, values[key] ?? null])) });
    assert.match(h.elements.get("recovery-status").textContent, /^Download requested/);
  }
});

test("the export page and the app origin hint only link between the two fixed hosts on the same port", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const hintScript = source.slice(source.indexOf("const entryParams ="), source.indexOf("const store = new WorkspaceStore"));
  for (const port of ["", ":40567"]) {
    const h = recoveryPage({}, { origin: `http://127.0.0.1${port}` });
    assert.equal(h.elements.get("return-localhost").href, `http://localhost${port}/`);
    for (const search of ["?shunriOrigin=ip&return=https://evil.invalid&next=//evil.invalid", "?return=https://evil.invalid"]) {
      const inserted = [];
      vm.runInNewContext(hintScript, {
        URL, URLSearchParams, location: { origin: `http://localhost${port}`, search },
        document: { createElement: () => ({ append(...children) { this.children = children; } }) },
        $: () => ({ before: (element) => inserted.push(element) }),
      });
      assert.equal(inserted.length, search.includes("shunriOrigin=ip") ? 1 : 0);
      if (inserted.length) assert.equal(inserted[0].children[1].href, `http://127.0.0.1${port}/ip-recovery`);
    }
  }
});

test("the export page keeps an English download button, complete English status text and an English document", () => {
  assert.match(html, /<html[^>]*lang="en"/);
  assert.match(html, /<button id="download-original"[^>]*>Download original data copy<\/button>/);
  assert.match(html, /id="recovery-status"[^>]*role="status"/);
  for (const text of [
    "Nothing was exported.",
    "Check the original browser and port.",
    "Check the browser download list or notification.",
    "The original data is unchanged.",
  ]) assert.ok(html.includes(text), text);
});

test("every text element and the download button of the export page wrap inside narrow screens", () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const rule = (selector) => css.split("}").map((r) => r.trim()).find((r) => r.startsWith(selector + " {")) || "";
  assert.match(rule("h1, p, button, a"), /overflow-wrap:\s*anywhere/, "headline, text, button and link wrap");
  assert.match(rule("button"), /max-width:\s*100%/, "button never exceeds the screen width");
  assert.match(rule("button"), /white-space:\s*normal/, "button label may wrap to a second line");
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
});

// ---- UI preview server

async function withPreview(run) {
  const server = createPreviewServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await run(origin); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("the preview server starts disconnected with mock data and never exposes private files", () => withPreview(async (origin) => {
  const response = await fetch(`${origin}/api/calendar/status`);
  const status = await response.json();
  assert.equal(status.mock, true);
  assert.equal(status.state, "disconnected");
  assert.equal(status.writesEnabled, false);
  for (const route of ["/.env", "/.local-data/calendar/token.json", "/server.mjs", "/calendar-service.mjs"]) {
    assert.equal((await fetch(origin + route)).status, 404);
  }
  const home = await fetch(origin);
  assert.match(home.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.match(await home.text(), /src="\/ui-preview.js"/);
}));

test("every mock Calendar state keeps writes closed and the connection stays local", () => withPreview(async (origin) => {
  for (const scenario of previewScenarios) {
    const response = await fetch(`${origin}/api/calendar/status?calendarMock=${scenario}`);
    const status = await response.json();
    assert.equal(status.mockState, scenario);
    assert.equal(status.writesEnabled, false);
    assert.match(response.headers.get("set-cookie"), new RegExp(`shunri_ui_mock=${scenario}`));
  }
  const connection = await fetch(`${origin}/api/calendar/connect`, { redirect: "manual" });
  assert.equal(connection.status, 303);
  assert.equal(connection.headers.get("location"), "/?calendarMock=writes-off");
  assert.equal((await fetch(`${origin}/api/calendar/callback?code=fake`)).status, 403);
}));

test("the mock scenario is kept per origin and requests cannot bypass the loopback or CSRF checks", () => withPreview(async (origin) => {
  const selected = await fetch(`${origin}/?calendarMock=expired`);
  const cookie = selected.headers.get("set-cookie").split(";")[0];
  const persisted = await fetch(`${origin}/api/calendar/status`, { headers: { Cookie: cookie } });
  assert.equal((await persisted.json()).state, "expired");
  assert.equal((await fetch(`${origin}/?calendarMock=unknown`)).status, 400);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    get(`${origin}/api/calendar/status`, { headers: { Host: "external.invalid" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(invalidHostStatus, 403);
  const blocked = await fetch(`${origin}/api/calendar/preview?calendarMock=writes-off`, {
    method: "POST", headers: { Origin: "https://external.invalid", "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(blocked.status, 403);
}));

test("a partial read is reported as partial, and the preview can neither execute nor adopt events", () => withPreview(async (origin) => {
  const response = await fetch(`${origin}/api/calendar/events?calendarMock=partial-failure&from=2026-10-10&to=2026-10-12`);
  const partial = await response.json();
  assert.equal(partial.partial, true);
  assert.equal(partial.complete, false);
  assert.equal(partial.errors.length, 1);
  assert.deepEqual(partial.events, []);
  const headers = { "Content-Type": "application/json", Origin: origin, "X-Shunri-CSRF": "ui-preview-only-no-real-credentials" };
  const planResponse = await fetch(`${origin}/api/calendar/preview?calendarMock=writes-off`, {
    method: "POST", headers, body: JSON.stringify({ tasks: [{ uid: "synthetic-sql", id: "synthetic-sql", title: "SQL practice", date: "2026-10-11", start: 840, duration: 60 }] }),
  });
  const plan = await planResponse.json();
  assert.equal(plan.writesEnabled, false);
  assert.equal(plan.canExecute, false);
  assert.equal(plan.items[0].title, "SQL practice");
  for (const route of ["execute", "adopt", "disconnect"]) {
    const result = await fetch(`${origin}/api/calendar/${route}?calendarMock=writes-off`, { method: "POST", headers, body: "{}" });
    assert.equal(result.status, 403);
    assert.equal((await result.json()).mock, true);
  }
}));
