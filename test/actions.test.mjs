import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInstantAction, getInstantAction, INSTANT_ACTION_IDS, storageAudit, organizePreview } from '../backend/actions.mjs';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { evaluateToolSafety } from '../backend/tools/registry.mjs';
import { runAgentTurn } from '../backend/agent/loop.mjs';

test('instant action ids are exposed and resolve to titled actions', () => {
  assert.ok(INSTANT_ACTION_IDS.includes('system_health'));
  assert.ok(INSTANT_ACTION_IDS.includes('storage_audit'));
  for (const id of INSTANT_ACTION_IDS) {
    const action = getInstantAction(id);
    assert.equal(typeof action.run, 'function');
    assert.ok(action.title && action.title.length > 0);
  }
  assert.equal(getInstantAction('does_not_exist'), null);
});

test('unknown instant action fails cleanly and lists the available ids', async () => {
  const result = await runInstantAction('rm_rf_everything');
  assert.equal(result.ok, false);
  assert.match(result.output, /No instant action/);
  assert.match(result.output, /system_health/);
});

test('storage_audit measures each folder independently even when one is capped', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-actions-indep-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  // Downloads has enough entries to exhaust a tiny per-folder budget.
  const downloads = path.join(home, 'Downloads');
  await fs.mkdir(downloads, { recursive: true });
  for (let i = 0; i < 6; i += 1) await fs.writeFile(path.join(downloads, `d${i}.bin`), 'x'.repeat(100));
  // Documents has one large file that must be measured regardless of Downloads' cap.
  const documents = path.join(home, 'Documents');
  await fs.mkdir(documents, { recursive: true });
  await fs.writeFile(path.join(documents, 'report.pdf'), 'x'.repeat(4096));
  await fs.mkdir(path.join(home, 'Desktop'), { recursive: true });

  const origHome = os.homedir;
  os.homedir = () => home;
  try {
    // maxEntries=2 forces Downloads to truncate, but Documents must still report fully.
    const output = await storageAudit({ maxEntries: 2 });
    assert.match(output, /Downloads: .*partial/);
    const documentsLine = output.split('\n').find((l) => l.startsWith('Documents:'));
    assert.ok(documentsLine, 'Documents is reported');
    assert.match(documentsLine, /across 1 file/);
    assert.doesNotMatch(documentsLine, /partial/, 'Documents is measured independently of Downloads');
  } finally {
    os.homedir = origHome;
  }
});

test('storage_audit reports folder sizes and largest Downloads items without mutating', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-actions-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const downloads = path.join(home, 'Downloads');
  await fs.mkdir(downloads, { recursive: true });
  await fs.writeFile(path.join(downloads, 'big-video.mp4'), 'x'.repeat(4096));
  await fs.writeFile(path.join(downloads, 'tiny.txt'), 'hi');
  await fs.mkdir(path.join(home, 'Desktop'), { recursive: true });

  const origHome = os.homedir;
  os.homedir = () => home;
  try {
    const result = await runInstantAction('storage_audit', { paths: getRuntimePaths(home) });
    assert.equal(result.ok, true);
    assert.match(result.output, /Downloads: /);
    assert.match(result.output, /big-video\.mp4/);
    assert.match(result.output, /Largest items in Downloads/);
  } finally {
    os.homedir = origHome;
  }
});

test('schedule_today returns a readable schedule snapshot', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-actions-sched-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmp);
  const result = await runInstantAction('schedule_today', { paths });
  assert.equal(result.ok, true);
  assert.match(result.output, /schedule|Scheduled|Nothing/i);
});

test('organizePreview groups loose files by type and never moves anything', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-org-plan-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of ['a.jpg', 'b.png', 'c.pdf', 'notes.md', 'd.zip', 'e.mp3', 'stray.unknown']) {
    await fs.writeFile(path.join(dir, name), 'x');
  }
  await fs.mkdir(path.join(dir, 'existing-folder'));
  const preview = await organizePreview(dir);
  assert.match(preview, /7 loose files/);
  assert.match(preview, /2 → Images\//);
  assert.match(preview, /2 → Documents\//);
  assert.match(preview, /1 → Archives\//);
  assert.match(preview, /1 → Audio\//);
  assert.match(preview, /1 → Other\//);
  // Read-only: nothing was moved or removed — the folder still has all 7 files plus the folder.
  const after = await fs.readdir(dir);
  assert.equal(after.length, 8);
  assert.ok(after.includes('a.jpg') && after.includes('existing-folder'));
});

test('organize_plan is a registered read-only instant action', () => {
  assert.ok(INSTANT_ACTION_IDS.includes('organize_plan'));
  const action = getInstantAction('organize_plan');
  assert.ok(action);
  assert.match(action.title, /read-only/i);
});

test('instant actions are read-only: their tools never require approval in Ask mode', () => {
  const askCtx = { safetyMode: 'ask', isHeadless: false, allowAutoRun: false };
  // The tools an instant action may invoke are all read-only lookups.
  for (const tool of ['system_stats', 'paste_from_clipboard', 'list_schedule_items']) {
    assert.equal(evaluateToolSafety({ name: tool, args: {} }, askCtx).decision, 'allow', `${tool} should be read-only`);
  }
});

test('runAgentTurn short-circuits instant actions without any model round-trip', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-actions-loop-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmp);
  const session = { id: 'sess-instant', messages: [] };
  const events = [];
  let modelCalls = 0;

  const result = await runAgentTurn({
    session,
    userMessage: 'Today’s schedule',
    paths,
    instantAction: 'schedule_today',
    providerConfig: { provider: 'ollama' },
    chatFn: async () => {
      modelCalls += 1;
      throw new Error('model must not be called for instant actions');
    },
    onEvent: (e) => events.push(e),
    persistSession: true,
  });

  assert.equal(modelCalls, 0, 'instant action must not invoke the model');
  assert.equal(result.status, 'completed');
  const assistant = session.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant, 'an assistant message is recorded');
  assert.match(assistant.content, /ran on your Mac/);
  assert.ok(events.some((e) => e.type === 'done'), 'a done event is emitted');
  assert.ok(events.some((e) => e.type === 'text_delta'), 'the result streams to the client');
});