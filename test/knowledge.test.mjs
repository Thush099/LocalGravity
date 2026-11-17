import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import {
  ensureKnowledgeSeeded,
  listKnowledge,
  readKnowledge,
  saveKnowledge,
  searchKnowledge,
  deleteKnowledge,
} from '../backend/knowledge-engine.mjs';

test('knowledge engine seeds MEMORY.md, stores docs safely, and searches matching content', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-know-'));
  const paths = getRuntimePaths(tmpHome);

  await ensureKnowledgeSeeded(paths);
  const initial = await listKnowledge(paths);
  assert.ok(initial.some((k) => k.name === 'MEMORY'));
  assert.ok(initial.some((k) => k.name === 'LEARNED_FIXES'));
  assert.equal(initial[0].name, 'LEARNED_FIXES');

  await saveKnowledge(
    {
      name: 'brand-style',
      title: 'RAS Jewels Brand Guide',
      tags: ['video', 'branding'],
      content: 'Always export 9:16 Reels at 1080x1920 60fps with warm gold LUT and sans-serif captions.',
    },
    paths
  );

  const loaded = await readKnowledge('brand-style', paths);
  assert.equal(loaded.title, 'RAS Jewels Brand Guide');
  assert.deepEqual(loaded.tags, ['video', 'branding']);

  const hits = await searchKnowledge('warm gold LUT reels', paths);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].name, 'brand-style');

  await assert.rejects(() =>
    saveKnowledge({ name: '../outside', title: 'Bad', content: 'x' }, paths)
  );

  assert.equal(await deleteKnowledge('brand-style', paths), true);
  assert.equal(await readKnowledge('brand-style', paths), null);

  await fs.rm(tmpHome, { recursive: true, force: true });
});
