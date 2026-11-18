import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { readSkill } from '../backend/skills-engine.mjs';
import { getSkillSources, importSkillsFromSource, listSkillSources } from '../backend/skill-sources.mjs';

test('local skill libraries are discovered, flagged as installed, and importable', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-sources-'));
  const runtimePaths = getRuntimePaths(path.join(tmpHome, 'runtime'));

  const writeSkill = async (relativeDir, slug, description) => {
    const dir = path.join(tmpHome, relativeDir, slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: ${description}\ntriggers: ["${slug}"]\n---\n\n# ${slug}\n\nSteps.\n`,
      'utf8'
    );
  };

  await writeSkill('.agents/skills', 'web-helper', 'Helpers for web work');
  await writeSkill('.claude/skills', 'doc-writer', 'Documentation workflow');

  const sources = getSkillSources({ homeDir: tmpHome });
  assert.equal(sources.length, 3);
  assert.equal(sources.find((source) => source.id === 'agents').dir, path.join(tmpHome, '.agents', 'skills'));

  const listed = await listSkillSources({ homeDir: tmpHome, installedSlugs: ['web-helper'] });
  const agents = listed.find((source) => source.id === 'agents');
  const claude = listed.find((source) => source.id === 'claude');
  const antigravity = listed.find((source) => source.id === 'antigravity');

  assert.equal(agents.exists, true);
  assert.equal(agents.skills[0].slug, 'web-helper');
  assert.equal(agents.skills[0].installed, true);
  assert.equal(claude.skills[0].installed, false);
  assert.equal(antigravity.exists, false);
  assert.deepEqual(antigravity.skills, []);

  const imported = await importSkillsFromSource('agents', ['web-helper'], {
    homeDir: tmpHome,
    paths: runtimePaths,
  });
  assert.deepEqual(imported, ['web-helper']);
  const installed = await readSkill('web-helper', runtimePaths);
  assert.equal(installed.meta.description, 'Helpers for web work');
  assert.match(installed.content, /Steps/);

  await assert.rejects(
    () => importSkillsFromSource('missing', ['web-helper'], { homeDir: tmpHome, paths: runtimePaths }),
    (err) => err.statusCode === 400 && /Unknown skill library/.test(err.message)
  );

  await fs.rm(tmpHome, { recursive: true, force: true });
});
