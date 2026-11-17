import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { executeToolCall, TOOL_DEFINITIONS } from '../backend/tools/registry.mjs';

const execFileAsync = promisify(execFile);

test('registry tools perform fs ops, shell execution, skill/knowledge management, and media inspection cleanly', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-tools-'));
  const workDir = path.join(tmpRoot, 'work');
  const runtimeHome = path.join(tmpRoot, 'home');
  await fs.mkdir(workDir, { recursive: true });
  const paths = getRuntimePaths(runtimeHome);
  const ctx = { paths, cwd: workDir };

  assert.ok(TOOL_DEFINITIONS.some((t) => t.function.name === 'inspect_media'));
  assert.ok(TOOL_DEFINITIONS.some((t) => t.function.name === 'save_knowledge'));

  const written = await executeToolCall(
    { name: 'write_file', args: { path: path.join(workDir, 'hello.txt'), content: 'line1\nline2\nline3\n' } },
    ctx
  );
  assert.equal(written.ok, true);

  const edited = await executeToolCall(
    { name: 'edit_file', args: { path: path.join(workDir, 'hello.txt'), target: 'line2', replacement: 'line-$&-two-$$-$1' } },
    ctx
  );
  assert.equal(edited.ok, true);
  assert.match(edited.diff, /-line2/);
  assert.match(edited.diff, /\+line-\$&-two-\$\$-\$1/);

  const readRes = await executeToolCall(
    { name: 'read_file', args: { path: path.join(workDir, 'hello.txt'), start_line: 2, end_line: 3 } },
    ctx
  );
  assert.match(readRes.output, /2: line-\$&-two-\$\$-\$1/);

  const listed = await executeToolCall({ name: 'list_dir', args: { path: workDir } }, ctx);
  assert.match(listed.output, /hello\.txt/);

  const searched = await executeToolCall({ name: 'search_files', args: { root: workDir, query: 'line-$&-two' } }, ctx);
  assert.match(searched.output, /hello\.txt:2:/);

  const cmdRes = await executeToolCall(
    { name: 'run_command', args: { command: 'echo "ok-tool"', cwd: workDir } },
    ctx
  );
  assert.equal(cmdRes.ok, true);
  assert.match(cmdRes.output, /ok-tool/);

  await executeToolCall(
    {
      name: 'save_skill',
      args: {
        name: 'sample-skill',
        description: 'Sample workflow',
        triggers: ['sample'],
        content: '# Steps',
        extra_files: { 'scripts/helper.py': 'print("skill-script-ok")' },
      },
    },
    ctx
  );
  const skillRead = await executeToolCall({ name: 'read_skill', args: { name: 'sample-skill' } }, ctx);
  assert.match(skillRead.output, /# Steps/);
  const helperBody = await fs.readFile(path.join(runtimeHome, 'skills/sample-skill/scripts/helper.py'), 'utf8');
  assert.match(helperBody, /skill-script-ok/);

  const http = await import('node:http');
  const docSrv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Docs Title</h1><p>Use concise scripts.</p></body></html>');
  });
  await new Promise((r) => docSrv.listen(0, '127.0.0.1', r));
  try {
    const fetched = await executeToolCall(
      { name: 'fetch_url', args: { url: `http://127.0.0.1:${docSrv.address().port}/` } },
      ctx
    );
    assert.equal(fetched.ok, true);
    assert.match(fetched.output, /Docs Title/);
    assert.match(fetched.output, /Use concise scripts/);
  } finally {
    await new Promise((r) => docSrv.close(r));
  }

  await executeToolCall(
    {
      name: 'save_knowledge',
      args: { name: 'my-doc', title: 'Project Notes', tags: ['notes'], content: 'Use 60fps for reels.' },
    },
    ctx
  );
  const knowSearch = await executeToolCall({ name: 'search_knowledge', args: { query: '60fps' } }, ctx);
  assert.match(knowSearch.output, /Project Notes/);

  const imgPath = path.join(workDir, 'sample.png');
  await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240', '-frames:v', '1', imgPath]);
  const mediaImg = await executeToolCall({ name: 'inspect_media', args: { path: imgPath } }, ctx);
  assert.equal(mediaImg.ok, true);
  assert.equal(mediaImg.images.length, 1);
  assert.ok(mediaImg.images[0].length > 50);

  const vidPath = path.join(workDir, 'clip.mp4');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=320x240:d=1',
    '-pix_fmt',
    'yuv420p',
    vidPath,
  ]);
  const mediaVid = await executeToolCall({ name: 'inspect_media', args: { path: vidPath, timestamp_sec: 0.2 } }, ctx);
  assert.equal(mediaVid.ok, true);
  assert.equal(mediaVid.images.length, 1);
  assert.match(mediaVid.output, /320x240/);

  await fs.rm(tmpRoot, { recursive: true, force: true });
});
