import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TOOL_DEFINITIONS, evaluateToolSafety, executeToolCall } from '../backend/tools/registry.mjs';
import { searchWebTool, parseDuckDuckGoHtml } from '../backend/tools/web-tool.mjs';
import { openUrlTool, manageNotesTool, spotlightSearchTool } from '../backend/tools/macos-tool.mjs';
import { selectToolsForTurn } from '../backend/agent/tool-selector.mjs';

test('searchWebTool parses DuckDuckGo HTML results, decodes uddg links & entities, and validates empty queries', async () => {
  const empty = await searchWebTool({ query: '   ' });
  assert.equal(empty.ok, false);

  const sampleHtml = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen&amp;rut=123">Node.js &mdash; Run JavaScript Everywhere</a>
      <a class="result__snippet" href="#">Node.js&reg; is a free &amp; open-source JavaScript runtime &quot;built on V8&quot;.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://ollama.com/library/qwen3.5">Ollama Qwen 3.5</a>
      <span class="result__snippet">Run local models on Apple Silicon.</span>
    </div>
  `;

  const parsed = parseDuckDuckGoHtml(sampleHtml, 5);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].url, 'https://nodejs.org/en');
  assert.match(parsed[0].snippet, /"built on V8"/);
  assert.equal(parsed[1].url, 'https://ollama.com/library/qwen3.5');

  const res = await searchWebTool(
    { query: 'nodejs runtime', max_results: 2 },
    { fetchFn: async () => new Response(sampleHtml, { status: 200 }) }
  );
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 2);
  assert.match(res.output, /1\. \*\*Node\.js/);
  assert.match(res.output, /https:\/\/nodejs\.org\/en/);
});

test('openUrlTool permits only http/https URLs and blocks dangerous schemes', async () => {
  const empty = await openUrlTool({ url: '' });
  assert.equal(empty.ok, false);

  const badFile = await openUrlTool({ url: 'file:///etc/passwd' });
  assert.equal(badFile.ok, false);
  assert.match(badFile.output, /Blocked URL scheme/i);

  const badJs = await openUrlTool({ url: 'javascript:alert(1)' });
  assert.equal(badJs.ok, false);
  assert.match(badJs.output, /Blocked URL scheme/i);

  const invalid = await openUrlTool({ url: 'not a valid url' });
  assert.equal(invalid.ok, false);
});

test('manageNotesTool and registry safety enforce read-only allow vs create approval', async () => {
  const missingTitle = await manageNotesTool({ action: 'create', title: '   ', body: 'hello' });
  assert.equal(missingTitle.ok, false);

  const badAction = await manageNotesTool({ action: 'drop_database' });
  assert.equal(badAction.ok, false);

  assert.equal(evaluateToolSafety({ name: 'manage_notes', args: { action: 'list' } }).decision, 'allow');
  assert.equal(evaluateToolSafety({ name: 'manage_notes', args: { action: 'read', title: 'Test' } }).decision, 'allow');
  assert.equal(
    evaluateToolSafety({ name: 'manage_notes', args: { action: 'create', title: 'Plan', body: 'hi' } }, { safetyMode: 'ask' }).decision,
    'ask'
  );
  assert.equal(
    evaluateToolSafety(
      { name: 'manage_notes', args: { action: 'create', title: 'Plan', body: 'hi' } },
      { isHeadless: true, allowAutoRun: false }
    ).decision,
    'block'
  );

  assert.equal(evaluateToolSafety({ name: 'search_web', args: { query: 'test' } }).decision, 'allow');
  assert.equal(evaluateToolSafety({ name: 'spotlight_search', args: { query: 'test' } }).decision, 'allow');
  assert.equal(evaluateToolSafety({ name: 'take_screenshot', args: {} }, { isHeadless: true, allowAutoRun: false }).decision, 'block');
});

test('spotlightSearchTool validates empty query and executes safely via registry', async () => {
  const resEmpty = await spotlightSearchTool({ query: '' });
  assert.equal(resEmpty.ok, false);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-mdfind-'));
  try {
    const out = await executeToolCall(
      { name: 'spotlight_search', args: { query: 'localgravity_nonexistent_token_xyz_987', folder: tmpDir } },
      {}
    );
    assert.equal(out.ok, true);
    assert.match(out.output, /No Spotlight matches|Spotlight matches/i);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('new domain tools route cleanly via tool-selector without inflating baseline coding prompts', () => {
  assert.equal(TOOL_DEFINITIONS.length, 41);

  const webTools = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Search the web for latest Apple M4 benchmarks',
  }).map((t) => t.function.name);
  assert.ok(webTools.includes('search_web'));
  assert.ok(webTools.includes('open_url'));

  const screenTools = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Take a screenshot of my display and inspect what error is shown',
  }).map((t) => t.function.name);
  assert.ok(screenTools.includes('take_screenshot'));

  const spotlightTools = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Find my resume PDF on this Mac using Spotlight',
  }).map((t) => t.function.name);
  assert.ok(spotlightTools.includes('spotlight_search'));

  const notesTools = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Check Apple Notes for my grocery list',
  }).map((t) => t.function.name);
  assert.ok(notesTools.includes('manage_notes'));

  // A new domain tool must stay out of lean coding prompts so it never slows them.
  const codingTools = selectToolsForTurn(TOOL_DEFINITIONS, {
    provider: 'ollama',
    userMessage: 'Fix the bug in the login form validation and run the tests',
  }).map((t) => t.function.name);
  assert.ok(!codingTools.includes('large_files'), 'large_files stays out of coding prompts');
});
