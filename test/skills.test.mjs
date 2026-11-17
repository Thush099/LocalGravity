import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import {
  parseFrontmatter,
  syncStarterSkills,
  listSkills,
  readSkill,
  saveSkill,
  deleteSkill,
  importExternalSkills,
} from '../backend/skills-engine.mjs';

test('skills engine syncs starters without clobbering edits, rejects path traversal, and imports skills', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-skills-'));
  const paths = getRuntimePaths(tmpHome);

  const synced = await syncStarterSkills(paths);
  assert.ok(synced.includes('mac-organizer'));
  assert.ok(synced.includes('video-editor'));
  assert.ok(synced.includes('photo-editor'));
  assert.ok(synced.includes('humanizer'));
  assert.ok(synced.includes('skill-creator'));

  await saveSkill(
    {
      name: 'mac-organizer',
      description: 'Custom user override',
      triggers: ['clean'],
      content: '# Custom rules',
    },
    paths
  );
  await syncStarterSkills(paths);
  const reloaded = await readSkill('mac-organizer', paths);
  assert.equal(reloaded.meta.description, 'Custom user override');

  await assert.rejects(() => saveSkill({ name: '../evil', description: 'x', content: 'y' }, paths));
  await assert.rejects(() =>
    saveSkill(
      {
        name: 'valid-skill',
        description: 'ok',
        content: 'body',
        extraFiles: { '../../etc/passwd': 'nope' },
      },
      paths
    )
  );

  const parsed = parseFrontmatter(
    '---\nname: demo\ndescription: A demo\ntriggers: ["a", "b"]\n---\nBody'
  );
  assert.deepEqual(parsed.triggers, ['a', 'b']);

  const extDir = path.join(tmpHome, 'ext-skills');
  await fs.mkdir(path.join(extDir, 'custom-ext'), { recursive: true });
  await fs.writeFile(
    path.join(extDir, 'custom-ext', 'SKILL.md'),
    '---\nname: custom-ext\ndescription: Imported\n---\nSteps'
  );
  const imported = await importExternalSkills(extDir, ['custom-ext'], paths);
  assert.deepEqual(imported, ['custom-ext']);
  assert.ok((await listSkills(paths)).some((s) => s.name === 'custom-ext'));
  assert.equal(await deleteSkill('custom-ext', paths), true);

  await fs.rm(tmpHome, { recursive: true, force: true });
});
