import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { TOOL_DEFINITIONS } from '../backend/tools/registry.mjs';
import { INSTANT_ACTION_IDS } from '../backend/actions.mjs';

/**
 * Guards against UI ↔ backend drift: the welcome-screen chips must match the
 * server's instant-action whitelist, and every registered tool must have a
 * human-readable label so the chat UI never shows a raw snake_case tool name.
 */
function extractBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `ui/app.js is missing ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `ui/app.js block starting at ${startMarker} never closes with ${endMarker}`);
  return source.slice(start, end);
}

async function readAppSource() {
  return fs.readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
}

test('UI instant-action chips match the backend whitelist exactly', async () => {
  const app = await readAppSource();
  const block = extractBlock(app, 'const INSTANT_ACTIONS = [', '];');
  const uiIds = [...block.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(uiIds.length > 0, 'no instant-action ids parsed from ui/app.js');
  assert.deepEqual(uiIds.sort(), [...INSTANT_ACTION_IDS].sort());
});

test('every registry tool has a human-readable UI label', async () => {
  const app = await readAppSource();
  const block = extractBlock(app, 'const HUMAN_TOOL_META = {', '\n};');
  const labeled = new Set([...block.matchAll(/^ {2}([a-z0-9_]+): \{/gm)].map((m) => m[1]));
  assert.ok(labeled.size >= TOOL_DEFINITIONS.length, 'fewer labels parsed than registered tools');
  const missing = TOOL_DEFINITIONS.map((t) => t.function.name).filter((name) => !labeled.has(name));
  assert.deepEqual(missing, [], `tools missing HUMAN_TOOL_META labels: ${missing.join(', ')}`);
});