import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// The browser loads app.js and every module it imports. The server only serves
// files it lists, so a module missing from that list leaves the page blank.
test("the server serves every module the browser loads", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const routed = new Set([...server.matchAll(/"\/([\w./-]+\.js)"/g)].map((m) => m[1]));
  const seen = new Set();
  const pending = ["app.js"];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const path = new URL(`../${file}`, import.meta.url);
    assert.ok(existsSync(path), `${file} is imported but does not exist`);
    for (const m of readFileSync(path, "utf8").matchAll(/from\s+"\.\/([^"]+)"/g)) pending.push(m[1]);
  }
  const missing = [...seen].filter((file) => !routed.has(file));
  assert.deepEqual(missing, [], `server.mjs does not serve: ${missing.join(", ")}`);
});
