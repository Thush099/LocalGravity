import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { createAgentServer } from '../backend/server.mjs';

test('media preview endpoint blocks system paths and non-files (trust boundary)', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-mpreview-'));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'preview-token-123';
  const srv = createAgentServer({ authToken, paths, skillHomeDir: tmpHome });
  const { port } = await srv.start(0);
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'X-Auth-Token': authToken };

  try {
    // A system path outside the allowed user-content roots -> 400 (no probe of /etc, /System).
    let res = await fetch(`${base}/api/media/preview?path=${encodeURIComponent('/etc/passwd')}`, { headers });
    assert.equal(res.status, 400);
    const blocked = await res.json();
    assert.equal(blocked.ok, false);

    // Missing path -> 400.
    res = await fetch(`${base}/api/media/preview`, { headers });
    assert.equal(res.status, 400);

    // A regular non-media file inside an allowed root -> 404 (unsupported media), never leaks content.
    const tmpFile = path.join(os.tmpdir(), `lg-prev-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, 'secret contents that must not leak', 'utf8');
    res = await fetch(`${base}/api/media/preview?path=${encodeURIComponent(tmpFile)}`, { headers });
    assert.equal(res.status, 404);
    const notMedia = await res.text();
    assert.ok(!notMedia.includes('secret contents'), 'file contents must not be returned');
    await fs.rm(tmpFile, { force: true });

    // Unauthorized request is rejected before any path handling.
    res = await fetch(`${base}/api/media/preview?path=${encodeURIComponent('/etc/passwd')}`);
    assert.equal(res.status, 401);
  } finally {
    await srv.stop();
  }
});
