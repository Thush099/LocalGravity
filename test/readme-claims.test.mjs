import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { TOOL_DEFINITIONS } from '../backend/tools/registry.mjs';
import { getStarterSkillsDir } from '../backend/state/paths.mjs';

const readmeUrl = new URL('../README.md', import.meta.url);

function numbersFor(readme, patterns) {
  return patterns.flatMap((pattern) => [...readme.matchAll(pattern)].map((m) => Number(m[1])));
}

test('README tool-count claims match backend/tools/registry.mjs', async () => {
  const readme = await fs.readFile(readmeUrl, 'utf8');
  const claims = numbersFor(readme, [
    /(\d+) native Mac and web tools/g,
    /Native Mac control \((\d+) tools\)/g,
    /(\d+) Built-In Mac & Web Tools/g,
    /\((\d+) tools \+ safety policies\)/g,
  ]);
  assert.ok(claims.length >= 4, `expected the tool-count claims to be present, matched ${claims.length}`);
  for (const claim of claims) {
    assert.equal(
      claim,
      TOOL_DEFINITIONS.length,
      'README tool-count claim drifted from the registered catalog; update README.md alongside the tool change',
    );
  }
});

test('README starter-skill count claims match the bundled starter skills', async () => {
  const readme = await fs.readFile(readmeUrl, 'utf8');
  const entries = await fs.readdir(getStarterSkillsDir(), { withFileTypes: true });
  const starterCount = entries.filter((entry) => entry.isDirectory()).length;
  assert.ok(starterCount > 0, 'starter skills directory should not be empty');
  const claims = numbersFor(readme, [
    /(\d+) starter skills/g,
    /(\d+) starter <code>SKILL\.md<\/code> playbooks/g,
  ]);
  assert.ok(claims.length >= 2, `expected the starter-skill count claims to be present, matched ${claims.length}`);
  for (const claim of claims) {
    assert.equal(
      claim,
      starterCount,
      'README starter-skill count claim drifted from the bundled starter skills; update README.md alongside the skill change',
    );
  }
});
