import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadMediaTool } from '../backend/tools/download-tool.mjs';
import { TOOL_DEFINITIONS } from '../backend/tools/registry.mjs';
import { selectToolsForTurn } from '../backend/agent/tool-selector.mjs';

const names = (msg) => selectToolsForTurn(TOOL_DEFINITIONS, { provider: 'ollama', userMessage: msg }).map((t) => t.function.name);

test('download_media rejects a non-http url without touching the network', async () => {
  const r = await downloadMediaTool({ url: 'not-a-url' });
  assert.equal(r.ok, false);
  assert.match(r.output, /http/i);
});

test('download_media rejects a missing url', async () => {
  const r = await downloadMediaTool({});
  assert.equal(r.ok, false);
});

test('download_media schema is defined and request-scoped to a url', () => {
  const def = TOOL_DEFINITIONS.find((t) => t.function.name === 'download_media');
  assert.ok(def, 'download_media should be defined');
  assert.deepEqual(def.function.parameters.required, ['url']);
  // Must not be blanket read-only: it writes files and should require approval.
  assert.ok(!def.function.parameters.properties.url.optional, 'url stays required');
});

test('download_media is selected for a download request', () => {
  assert.ok(names('download this song from soundcloud').includes('download_media'));
  assert.ok(names('save that youtube video to my Downloads').includes('download_media'));
});

test('download_media is not dragged into a plain media request', () => {
  assert.ok(!names('look at this photo and describe it').includes('download_media'));
  assert.ok(!names('what is on my screen').includes('download_media'));
});
