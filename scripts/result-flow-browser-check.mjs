// Isolated production UI check. Requires an installed Playwright module and
// browser; no account credentials, personal profile or real Calendar service.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { freshWorkspace, normalizeWorkspace } from "../storage.js";
import { createPreviewServer } from "./ui-preview.mjs";

const { chromium } = await import(process.env.UI_PLAYWRIGHT_MODULE || "playwright-core");
const output = path.resolve(process.env.RESULT_FLOW_OUTPUT || ".context/result-flow");
await mkdir(output, { recursive: true });
const server = createPreviewServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = [], screenshots = [], pageErrors = [], externalRequests = [];
const state = page => page.evaluate(() => JSON.parse(localStorage.getItem("shunri.workspace.v2")));
const click = (page, id) => page.locator("#wb-" + id).click();
const task = (id, date, order) => ({ id, uid: id, title: id === "sql" ? "SQL practice" : "Python practice", start: 660,
  duration: 45, rest: 20, type: "task", tags: ["study"], planId: "synthetic-course", packageId: date,
  packageOriginDate: date, packageOrder: order, packageTaskOrder: 0, dependencies: [], done: false });
async function rig(width) {
  const seed = freshWorkspace();
  seed.demo.exampleOrigin = "2026-10-12";
  seed.demo.days = { "2026-10-12": [task("sql", "2026-10-12", 0),
    { id: "fixed", uid: "fixed", title: "Fixed activity", start: 1080, duration: 30, rest: 0, type: "activity", locked: true }],
    "2026-10-13": [task("python", "2026-10-13", 1)] };
  seed.ui = { mode: "demo", date: "2026-10-12", selection: { mode: "demo", id: "sql" } };
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: "en-US", reducedMotion: "reduce" });
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await context.addInitScript(seed => {
    if (!localStorage.getItem("shunri.workspace.v2")) localStorage.setItem("shunri.workspace.v2", JSON.stringify(seed));
    window.__demoWrites = 0;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "shunri.workspace.v2") {
        const before = JSON.parse(this.getItem(key) || "null");
        if (JSON.stringify(before?.demo) !== JSON.stringify(JSON.parse(value).demo)) window.__demoWrites++;
      }
      return set.call(this, key, value);
    };
  }, normalizeWorkspace(seed));
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(origin);
  try { await page.locator("#wb-task-actions").waitFor(); }
  catch (error) {
    await writeFile(path.join(output, "startup-failure.json"), JSON.stringify({ pageErrors, body: await page.locator("body").innerText() }, null, 2));
    await page.screenshot({ path: path.join(output, "startup-failure.png"), fullPage: true });
    throw error;
  }
  return { page, context, seed };
}
async function save(page, text = "tomorrow at 2:30pm") {
  await click(page, "task-actions"); await page.locator("#wb-expression").fill(text);
  await page.locator("#wb-confirm:not([disabled])").waitFor();
  await page.evaluate(() => { window.__demoWrites = 0; });
  await page.locator("#wb-confirm").evaluate(button => { button.click(); button.click(); });
  await page.locator('[data-stage="home"] .saved-result').waitFor();
  assert.equal(await page.evaluate(() => window.__demoWrites), 1);
}
try {
  browser = await chromium.launch({ headless: true, args: ["--enable-automation"], ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const cdp = await browser.newBrowserCDPSession();
  const launch = await cdp.send("Browser.getBrowserCommandLine");
  assert.ok(launch.arguments.some(arg => arg.startsWith("--headless"))); await cdp.detach();
  for (const width of [320, 390, 1280]) {
    const { page, context } = await rig(width);
    try {
      const before = await state(page); await save(page); const saved = await state(page);
      assert.equal(saved.ui.date, "2026-10-13"); assert.equal(saved.ui.selection.id, "sql");
      assert.equal(saved.demo.days["2026-10-13"].find(task => task.id === "sql").start, 870);
      assert.deepEqual(saved.demo.days["2026-10-12"].find(task => task.id === "fixed"), before.demo.days["2026-10-12"].find(task => task.id === "fixed"));
      assert.equal(await page.getByRole("button", { name: "View new plan", exact: true }).count(), 0);
      const metrics = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
        controls: [...document.querySelectorAll("button,input,select,a,summary")].filter(el => !el.disabled && !el.closest("[inert]") && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden").length }));
      assert.equal(metrics.overflow, false); assert.ok(metrics.controls <= 5, JSON.stringify(metrics));
      const screenshot = path.join(output, `saved-home-${width}.png`); await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
      await click(page, "saved-details"); assert.equal(await page.locator("#wb-confirm").count(), 0);
      assert.match(await page.locator("#workbench").innerText(), /14:30/); await click(page, "result-back");
      assert.deepEqual((await state(page)).demo, saved.demo);
      await click(page, "undo"); assert.deepEqual((await state(page)).demo.days, before.demo.days);
      await save(page); await page.reload(); await page.locator("#wb-select").waitFor();
      assert.equal((await state(page)).ui.date, "2026-10-13"); assert.equal((await state(page)).ui.selection.id, "sql");
      await click(page, "select"); await click(page, "task-details"); await click(page, "undo");
      assert.deepEqual((await state(page)).demo.days, before.demo.days);
      checks.push({ width, status: "passed", metrics, coverage: "final save -> new date/task timeline -> read-only details -> direct undo; save -> refresh -> task details undo; fixed activity unchanged; double confirmation saves schedule once" });
    } finally { await context.close(); }
  }
  const { page, context } = await rig(390);
  try {
    await save(page); const second = await context.newPage(); second.on("pageerror", error => pageErrors.push(error.message));
    await second.goto(origin); await second.locator("#wb-select").waitFor();
    await click(second, "select"); await second.locator("#wb-picker-date").fill("2026-10-14"); await click(second, "view-date");
    await page.waitForTimeout(100); assert.doesNotMatch(await page.locator(".saved-result").innerText(), /The schedule changed later./);
    await click(second, "select"); await second.locator("#wb-search").fill("SQL"); await second.locator("#wb-search").press("Enter");
    await save(second, "2026-10-15 15:00");
    await page.waitForFunction(() => document.querySelector(".saved-result")?.textContent.includes("The schedule changed later."));
    assert.equal(await page.locator("#wb-undo").count(), 0);
    const latest = await state(page); await click(page, "saved-details"); assert.match(await page.locator("#workbench").innerText(), /14:30/);
    await click(page, "result-back"); assert.deepEqual(await state(page), latest);
    checks.push({ status: "passed", coverage: "other-tab browsing preserves result; other-tab save marks historical record and removes obsolete undo; details return does not overwrite latest selection or data" });
  } finally { await context.close(); }
  assert.deepEqual(pageErrors, []); assert.deepEqual(externalRequests, []);
  const report = { status: "passed", headless: true, realCalendarAccess: false, checks, screenshots, pageErrors, externalRequests };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
