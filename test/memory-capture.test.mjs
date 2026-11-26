import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  matchExplicitMemory,
  rememberFact,
  captureExplicitMemory,
  boundedMemoryContent,
  memoryKeywords,
  MEMORY_TRIMMED_NOTICE,
} from '../backend/agent/memory-capture.mjs';
import { buildSystemPrompt } from '../backend/agent/prompt.mjs';
import { readKnowledge } from '../backend/knowledge-engine.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-memcap-'));
  process.env.LOCALGRAVITY_HOME = dir;
  return getRuntimePaths();
}

test('matchExplicitMemory captures explicit requests verbatim', () => {
  assert.equal(matchExplicitMemory('remember that I prefer tabs over spaces'), 'I prefer tabs over spaces');
  assert.equal(matchExplicitMemory('Please remember: my project runs on pnpm'), 'my project runs on pnpm');
  assert.equal(matchExplicitMemory('can you remember that my dog is named R2D2'), 'my dog is named R2D2');
  assert.equal(matchExplicitMemory('Note that I work at SLT-MOBITEL'), 'I work at SLT-MOBITEL');
  // Trailing punctuation is trimmed from the stored fact.
  assert.equal(matchExplicitMemory('remember that my editor is Neovim.'), 'my editor is Neovim');
});

test('matchExplicitMemory refuses questions, reminders, and non-requests', () => {
  assert.equal(matchExplicitMemory('do you remember what I told you?'), null);
  assert.equal(matchExplicitMemory('what is my favorite editor? do you remember'), null);
  assert.equal(matchExplicitMemory('remember to buy milk'), null, 'reminders are the agenda tools job');
  assert.equal(matchExplicitMemory('remember'), null);
  assert.equal(matchExplicitMemory('remember that hi'), null, 'too short to be a real fact');
  assert.equal(matchExplicitMemory(`remember that ${'x'.repeat(400)}`), null, 'over-long facts are refused');
  assert.equal(matchExplicitMemory('remember that   '), null);
  assert.equal(matchExplicitMemory(''), null);
  assert.equal(matchExplicitMemory(null), null);
});

test('rememberFact appends one bullet to MEMORY.md, preserving frontmatter, idempotently', async () => {
  const paths = tempPaths();
  const fact = 'I prefer tabs over spaces';

  const first = await rememberFact(fact, paths);
  assert.equal(first.appended, true);
  const doc = await readKnowledge('MEMORY', paths);
  assert.ok(doc.content.includes(`- ${fact}`), 'the fact is a bullet in MEMORY.md');
  assert.ok(Array.isArray(doc.tags) && doc.tags.includes('memory'), 'frontmatter tags survive');

  const again = await rememberFact(fact, paths);
  assert.equal(again.appended, false, 'the same fact is never stored twice');
  const after = await readKnowledge('MEMORY', paths);
  assert.equal(after.content.split(fact).length - 1, 1, 'exactly one occurrence in MEMORY.md');
});

test('captureExplicitMemory persists only real memory requests and never throws', async () => {
  const paths = tempPaths();

  const notMemory = await captureExplicitMemory('do you remember my editor?', paths);
  assert.equal(notMemory, null);
  assert.equal(await readKnowledge('MEMORY', paths), null, 'a question writes nothing');

  const captured = await captureExplicitMemory('remember that I work at SLT-MOBITEL', paths);
  assert.equal(captured, 'I work at SLT-MOBITEL');
  const doc = await readKnowledge('MEMORY', paths);
  assert.ok(doc.content.includes('I work at SLT-MOBITEL'));

  // Multi-line messages must never capture: MEMORY.md is injected into future
  // prompts, so only single-line facts are safe to persist deterministically.
  assert.equal(matchExplicitMemory('remember that I like green tea\n\n[Attached files]\nnote.md'), null);
});

test('boundedMemoryContent keeps small memory docs untouched', () => {
  const doc = '# Memory\n- **Preferred editor**: Neovim';
  assert.equal(boundedMemoryContent(doc, { maxChars: 1200 }), doc);
  assert.equal(boundedMemoryContent('', { maxChars: 1200 }), '');
  assert.equal(boundedMemoryContent(undefined, { maxChars: 1200 }), '');
});

test('boundedMemoryContent keeps the curated head and the most recent captures', () => {
  const lines = ['# Memory', '## Preferences'];
  for (let i = 0; i < 40; i += 1) lines.push(`- standing preference number ${i}`);
  lines.push('## 2026-11-24 \u00b7 preferences');
  lines.push('- I prefer tabs over spaces');
  const bounded = boundedMemoryContent(lines.join('\n'), { maxChars: 400 });
  assert.ok(bounded.length <= 400, `expected <= 400 chars, got ${bounded.length}`);
  assert.ok(bounded.startsWith('# Memory'), 'curated head should survive');
  assert.ok(
    bounded.includes('- I prefer tabs over spaces'),
    'the newest captured fact must stay visible in the prompt, not drop off the tail',
  );
  assert.ok(bounded.includes(MEMORY_TRIMMED_NOTICE), 'the gap must be marked so the model knows to read_knowledge');
});

test('boundedMemoryContent never shows a line twice and never splits a line', () => {
  const lines = [];
  for (let i = 0; i < 30; i += 1) lines.push(`- bullet ${i}`);
  const bounded = boundedMemoryContent(lines.join('\n'), { maxChars: 300 });
  for (const line of lines) {
    const count = bounded.split('\n').filter((l) => l === line).length;
    assert.ok(count <= 1, `line "${line}" appeared ${count} times`);
    if (count === 1) assert.ok(lines.includes(line), 'output lines must be whole original lines');
  }
});

test('boundedMemoryContent falls back to a hard cut when no line fits', () => {
  const oneLine = 'x'.repeat(500);
  const bounded = boundedMemoryContent(oneLine, { maxChars: 50 });
  assert.ok(bounded.length <= 50, `expected <= 50 chars, got ${bounded.length}`);
  assert.ok(bounded.startsWith('x'.repeat(40)), 'hard-cut fallback should keep the head of the line');
});

test('memoryKeywords keeps domain words and drops filler', () => {
  assert.deepEqual(memoryKeywords('What is the staging box IP?').sort(), ['box', 'ip', 'staging']);
  assert.deepEqual(memoryKeywords('   '), []);
});

test('boundedMemoryContent surfaces query-relevant facts from an oversized memory', () => {
  const lines = ['# Memory', '## Preferences'];
  for (let i = 0; i < 30; i += 1) lines.push(`- standing preference number ${i}`);
  lines.push('## Gennext');
  lines.push('- **Staging box**: 10.0.0.5 runs the staging deploy');
  for (let i = 0; i < 8; i += 1) lines.push(`- recent note ${i}`);
  const content = lines.join('\n');
  const bounded = boundedMemoryContent(content, { maxChars: 500, query: 'what is the staging box IP?' });
  assert.ok(bounded.length <= 500, `expected <= 500 chars, got ${bounded.length}`);
  assert.ok(
    bounded.includes('10.0.0.5'),
    'a fact matching the question must be recalled even when it sits outside the head/tail window',
  );
});

test('boundedMemoryContent falls back to the standing head for queries with no memory hit', () => {
  const lines = ['# Memory', '## Preferences'];
  for (let i = 0; i < 30; i += 1) lines.push(`- standing preference number ${i}`);
  lines.push('## Gennext');
  lines.push('- **Staging box**: 10.0.0.5 runs the staging deploy');
  for (let i = 0; i < 8; i += 1) lines.push(`- recent note ${i}`);
  const bounded = boundedMemoryContent(lines.join('\n'), {
    maxChars: 400,
    query: 'what is the weather like today?',
  });
  assert.ok(bounded.startsWith('# Memory'), 'unrelated questions keep the curated head');
  assert.ok(!bounded.includes('10.0.0.5'), 'irrelevant mid-doc facts stay out of the fallback');
});

test('boundedMemoryContent never duplicates a relevant line that already sits in the tail', () => {
  const lines = ['# Memory'];
  for (let i = 0; i < 20; i += 1) lines.push(`- standing preference number ${i}`);
  lines.push('- **VPN**: use the split tunnel for staging traffic');
  const target = '- **VPN**: use the split tunnel for staging traffic';
  const bounded = boundedMemoryContent(lines.join('\n'), { maxChars: 300, query: 'staging vpn setup?' });
  assert.equal(bounded.split('\n').filter((line) => line === target).length, 1);
});

test('buildSystemPrompt surfaces query-relevant memory in the system prompt', () => {
  const lines = ['# Memory', '## Preferences'];
  for (let i = 0; i < 60; i += 1) lines.push(`- standing preference number ${i}`);
  lines.push('- **Staging box**: 10.0.0.5 runs the staging deploy');
  for (let i = 0; i < 30; i += 1) lines.push(`- recent note ${i}`);
  const prompt = buildSystemPrompt({
    memoryContent: lines.join('\n'),
    memoryQuery: 'where does the staging deploy run?',
    hasTools: false,
  });
  assert.ok(prompt.includes('10.0.0.5'), 'the wiring must pass the question through to memory recall');
});
