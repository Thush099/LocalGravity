import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { saveSession, searchSessions } from '../backend/state/storage.mjs';

test('searchSessions finds conversations by message content and returns a matching snippet', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-search-'));
  const paths = getRuntimePaths(tmpHome);

  await saveSession(
    {
      id: 'video-task',
      title: 'Reel export',
      updatedAt: '2026-11-17T10:00:00Z',
      messages: [
        { role: 'user', content: 'How do I trim a video with ffmpeg and keep the audio?' },
        { role: 'assistant', content: 'Use ffmpeg -ss and -to with -c copy.' },
      ],
    },
    paths
  );
  await saveSession(
    {
      id: 'tax-task',
      title: 'Tax documents',
      updatedAt: '2026-11-16T10:00:00Z',
      messages: [
        { role: 'user', content: 'Sort the tax documents in Downloads by year.' },
        { role: 'assistant', content: 'Grouped PDFs by tax year.' },
      ],
    },
    paths
  );

  const ffmpegHits = await searchSessions('ffmpeg', paths);
  assert.equal(ffmpegHits.length, 1);
  assert.equal(ffmpegHits[0].id, 'video-task');
  assert.match(ffmpegHits[0].snippet, /ffmpeg/i);
  assert.equal(ffmpegHits[0].matchRole, 'user');

  const taxHits = await searchSessions('tax documents', paths);
  assert.equal(taxHits[0].id, 'tax-task');
  assert.equal(taxHits[0].title, 'Tax documents');

  assert.deepEqual(await searchSessions('', paths), []);
  assert.deepEqual(await searchSessions('nonexistent-term', paths), []);

  await fs.rm(tmpHome, { recursive: true, force: true });
});
