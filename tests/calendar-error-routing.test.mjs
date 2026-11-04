import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const workbench = fs.readFileSync(new URL('../workbench.js', import.meta.url), 'utf8');
const lines = (source, pattern) => source.split('\n').filter(line => pattern.test(line));

// Every message from the Calendar server that app.js keeps must go through presentError (English fallback, no help line).
test('app.js presents Calendar adoption and sync errors through presentError', () => {
  for (const pattern of [/\(r\.message/, /actionError\(presentError/]) {
    const shown = lines(app, pattern);
    assert.ok(shown.length > 0, String(pattern));
    for (const line of shown) assert.match(line, /presentError\(/, line.trim());
  }
});

test('workbench.js shows read errors, status and error text through presentError', () => {
  assert.match(workbench, /import \{[^}]*presentError[^}]*\} from "\.\/ui-messages\.js"/);
  for (const pattern of [/c\.readError/, /custom\.failure/, /^\s+message = present/]) {
    const shown = lines(workbench, pattern).filter(line => /present\w+\(/.test(line));
    assert.ok(shown.length > 0, String(pattern));
    for (const line of shown) assert.match(line, /presentError\(/, line.trim().slice(0, 120));
  }
});
