import { test, describe, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, utimes, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execCalls = [];
mock.module('node:child_process', {
  namedExports: {
    execFile: (cmd, args, cb) => {
      execCalls.push({ cmd, args });
      process.nextTick(() => cb(null, { stdout: '', stderr: '' }));
    },
  },
});

const { buildLaunchAgentPlist, getCliRunnerPath, setAutomationSchedule, updateAutomationRecord, removeAllLaunchAgents } =
  await import('../backend/automations.mjs');
const { loadAutomations, saveAutomations } = await import('../backend/state/storage.mjs');

let root;
let paths;

function makePaths() {
  return {
    root,
    automationsFile: path.join(root, 'automations.json'),
    launchAgentsDir: path.join(root, 'LaunchAgents'),
  };
}

beforeEach(async () => {
  execCalls.length = 0;
  if (!root) {
    root = await mkdtemp(path.join(tmpdir(), 'lg-automations-'));
  }
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  paths = makePaths();
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildLaunchAgentPlist', () => {
  test('interval schedules default to 24h and clamp to a 5 minute floor', () => {
    const def = buildLaunchAgentPlist({ id: 'a' });
    assert.match(def, /<key>StartInterval<\/key>\s*<integer>86400<\/integer>/);
    const clamped = buildLaunchAgentPlist({ id: 'a', intervalSeconds: 60 });
    assert.match(clamped, /<integer>300<\/integer>/, 'intervals below five minutes are clamped');
    const custom = buildLaunchAgentPlist({ id: 'a', intervalSeconds: 1800 });
    assert.match(custom, /<integer>1800<\/integer>/);
  });

  test('calendar schedules carry only the provided keys', () => {
    const full = buildLaunchAgentPlist({ id: 'a', calendarInterval: { Hour: 7, Minute: 30, Weekday: 2 } });
    assert.match(full, /<key>StartCalendarInterval<\/key>/);
    assert.match(full, /<key>Hour<\/key>\s*<integer>7<\/integer>/);
    assert.match(full, /<key>Minute<\/key>\s*<integer>30<\/integer>/);
    assert.match(full, /<key>Weekday<\/key>\s*<integer>2<\/integer>/);
    assert.doesNotMatch(full, /StartInterval/);

    const hourOnly = buildLaunchAgentPlist({ id: 'a', calendarInterval: { Hour: 7 } });
    assert.match(hourOnly, /<key>Hour<\/key>/);
    assert.doesNotMatch(hourOnly, /<key>Minute<\/key>/);
    assert.doesNotMatch(hourOnly, /<key>Weekday<\/key>/);
  });

  test('labels are XML-escaped and the default script path points at cli-run', () => {
    const doc = buildLaunchAgentPlist({ id: 'a', label: 'com.x.<&>"\'' });
    assert.match(doc, /&lt;&amp;&gt;&quot;&apos;/);
    assert.match(doc, /cli-run\.mjs/);
    assert.equal(getCliRunnerPath().endsWith('cli-run.mjs'), true);
  });
});

describe('updateAutomationRecord and its lock', () => {
  test('patches and persists a matching record, or returns null for unknown ids', async () => {
    await saveAutomations([{ id: 'a', allowAutoRun: false }], paths);
    const patched = await updateAutomationRecord('a', (cur) => ({ ...cur, allowAutoRun: true }), paths);
    assert.equal(patched.allowAutoRun, true);
    const reloaded = await loadAutomations(paths);
    assert.equal(reloaded[0].allowAutoRun, true, 'the patch is persisted');

    const missing = await updateAutomationRecord('nope', (cur) => cur, paths);
    assert.equal(missing, null);
  });

  test('a stale lock is stolen and concurrent updates serialize without loss', async () => {
    await saveAutomations([{ id: 'a', allowAutoRun: false }, { id: 'b', allowAutoRun: false }], paths);
    const stale = `${paths.automationsFile}.lock`;
    await writeFile(stale, '');
    const old = new Date(Date.now() - 60_000);
    await utimes(stale, old, old);

    const [ra, rb] = await Promise.all([
      updateAutomationRecord('a', (cur) => ({ ...cur, allowAutoRun: true }), paths),
      updateAutomationRecord('b', (cur) => ({ ...cur, allowAutoRun: true }), paths),
    ]);
    assert.equal(ra.allowAutoRun, true);
    assert.equal(rb.allowAutoRun, true);
    const reloaded = await loadAutomations(paths);
    assert.deepEqual(reloaded.map((x) => x.allowAutoRun), [true, true], 'neither update is lost');
  });
});

describe('setAutomationSchedule', () => {
  beforeEach(async () => {
    await saveAutomations([{ id: 'a', allowAutoRun: true }], paths);
  });

  test('an unknown automation is rejected by name', async () => {
    await assert.rejects(
      () => setAutomationSchedule('ghost', { enabled: true }, paths),
      /Automation "ghost" not found\./,
    );
  });

  test('disabling removes the plist and preserves allowAutoRun when omitted', async () => {
    const plistPath = path.join(paths.launchAgentsDir, 'com.localgravity.a.plist');
    await mkdir(paths.launchAgentsDir, { recursive: true });
    await writeFile(plistPath, '<plist/>');

    const rec = await setAutomationSchedule('a', { enabled: false }, paths);
    assert.equal(rec.schedule.enabled, false);
    assert.equal(rec.allowAutoRun, true, 'omitted allowAutoRun keeps its current value');
    await assert.rejects(() => readFile(plistPath), /ENOENT/, 'the plist is removed');
  });

  test('enabling writes a plist, loads it, and records the clamped schedule', async () => {
    const rec = await setAutomationSchedule(
      'a',
      { enabled: true, frequency: 'daily', hour: 99, minute: -5, allowAutoRun: true },
      paths,
    );
    assert.equal(rec.schedule.enabled, true);
    assert.equal(rec.schedule.hour, 23, 'hour is clamped to 23');
    assert.equal(rec.schedule.minute, 0, 'minute is clamped to 0');
    assert.equal(rec.schedule.frequency, 'daily');
    assert.ok(rec.plistPath.endsWith('com.localgravity.a.plist'));

    const plist = await readFile(rec.plistPath, 'utf8');
    assert.match(plist, /StartCalendarInterval/);
    assert.match(plist, /<integer>23<\/integer>/);
    const load = execCalls.find((c) => c.cmd === 'launchctl' && c.args[0] === 'load');
    assert.ok(load, 'the agent is loaded through launchctl');
    assert.equal(load.args[2], rec.plistPath);
  });

  test('hourly and custom frequencies select the interval form', async () => {
    const hourly = await setAutomationSchedule('a', { enabled: true, frequency: 'hourly' }, paths);
    assert.equal(hourly.schedule.frequency, 'hourly');
    assert.match(await readFile(hourly.plistPath, 'utf8'), /<integer>3600<\/integer>/);

    const custom = await setAutomationSchedule(
      'a',
      { enabled: true, frequency: 'custom', intervalSeconds: 2700 },
      paths,
    );
    assert.equal(custom.schedule.intervalSeconds, 2700);
    assert.match(await readFile(custom.plistPath, 'utf8'), /<integer>2700<\/integer>/);
  });
});

describe('removeAllLaunchAgents', () => {
  test('removes only LocalGravity plists and survives a missing directory', async () => {
    await mkdir(paths.launchAgentsDir, { recursive: true });
    const mine = path.join(paths.launchAgentsDir, 'com.localgravity.a.plist');
    const other = path.join(paths.launchAgentsDir, 'com.apple.something.plist');
    await writeFile(mine, '<plist/>');
    await writeFile(other, '<plist/>');

    await removeAllLaunchAgents(paths);
    await assert.rejects(() => readFile(mine), /ENOENT/);
    assert.ok(await readFile(other, 'utf8'), 'foreign plists are untouched');

    await rm(paths.launchAgentsDir, { recursive: true, force: true });
    await removeAllLaunchAgents(paths); // missing dir must not throw
  });
});
