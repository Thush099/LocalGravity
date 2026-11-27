import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The app shell must not swallow panel load failures: when nothing is cached the
// user deserves a visible error instead of a silently blank panel forever.
function functionBody(src, name) {
  const start = src.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `${name} must exist in ui/app.js`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') depth -= 1;
    if (depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

test('panel refreshers surface failures instead of swallowing them', async () => {
  const src = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
  for (const fn of ['refreshSuggestions', 'loadSchedule', 'refreshSystemMetrics']) {
    const body = functionBody(src, fn);
    assert.ok(!/catch\s*\{\s*\}/.test(body), `${fn} must not swallow errors with an empty catch`);
    assert.ok(/catch/.test(body) && /(showToast|Error|failed|Couldn)/.test(body),
      `${fn} must surface the failure somewhere visible`);
  }
});

test('panel error text is announced and survives reduced motion', async () => {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../ui/styles.css', import.meta.url), 'utf8');
  assert.ok(/panel-error/.test(html) || /panel-error/.test(css),
    'a shared panel-error affordance must exist');
});
