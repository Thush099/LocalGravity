import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { executeToolCall, evaluateToolSafety, TOOL_DEFINITIONS } from '../backend/tools/registry.mjs';

const toolNames = TOOL_DEFINITIONS.map((t) => t.function.name);

test('new monitor and timetable tools are declared and classified correctly', () => {
  for (const name of ['system_stats', 'add_schedule_item', 'list_schedule_items', 'remove_schedule_item']) {
    assert.ok(toolNames.includes(name), `${name} must be declared`);
    assert.equal(evaluateToolSafety({ name }).decision, 'allow', `${name} must not require approval`);
  }
});

test('system_stats tool returns a readable snapshot', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-tool-stats-'));
  const paths = getRuntimePaths(home);
  try {
    const result = await executeToolCall({ name: 'system_stats', args: { include_processes: false } }, { paths });
    assert.equal(result.ok, true);
    assert.match(result.output, /CPU:/);
    assert.match(result.output, /Memory:/);
    assert.ok(!result.output.includes('Top processes'), 'process list suppressed on request');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('schedule tools manage the timetable end to end', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-tool-sched-'));
  const paths = getRuntimePaths(home);
  try {
    const added = await executeToolCall(
      { name: 'add_schedule_item', args: { title: 'Deep work', time: '14:00', days: [1, 2, 3], duration_min: 90 } },
      { paths }
    );
    assert.equal(added.ok, true);
    assert.match(added.output, /Added "Deep work" at 14:00 \(id ([^)]+)\)/);
    const id = added.output.match(/id ([^)]+)\)/)[1];

    const once = await executeToolCall(
      { name: 'add_schedule_item', args: { title: 'Dentist', time: '15:00', date: '2030-01-03', duration_min: 45 } },
      { paths }
    );
    assert.equal(once.ok, true);

    const listed = await executeToolCall({ name: 'list_schedule_items', args: {} }, { paths });
    assert.equal(listed.ok, true);
    assert.match(listed.output, /Deep work/);
    assert.match(listed.output, /on 2030-01-03/);

    const bad = await executeToolCall({ name: 'add_schedule_item', args: { title: 'X', time: '99:99' } }, { paths });
    assert.equal(bad.ok, false);

    const removed = await executeToolCall({ name: 'remove_schedule_item', args: { id } }, { paths });
    assert.equal(removed.ok, true);
    assert.match(removed.output, new RegExp(`Removed schedule entry ${id}`));

    const gone = await executeToolCall({ name: 'remove_schedule_item', args: { id } }, { paths });
    assert.equal(gone.ok, false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
