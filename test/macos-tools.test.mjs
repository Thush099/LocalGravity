import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyToClipboardTool,
  pasteFromClipboardTool,
  openAppTool,
  runShortcutTool,
  setReminderTool,
  showNotificationTool,
  buildReminderInvocation,
  appendBoundedOutput,
} from '../backend/tools/macos-tool.mjs';
import { evaluateToolSafety } from '../backend/tools/registry.mjs';

test('clipboard tools round-trip text through pbcopy/pbpaste', async () => {
  const marker = `localgravity-clip-${Date.now()}-${Math.random()}`;
  const copy = await copyToClipboardTool({ text: marker });
  assert.equal(copy.ok, true);

  const paste = await pasteFromClipboardTool();
  assert.equal(paste.ok, true);
  assert.equal(paste.clipboard, marker);
});

test('clipboard and notification tools validate empty input', async () => {
  assert.equal((await copyToClipboardTool({ text: '' })).ok, false);
  assert.equal((await showNotificationTool({ message: '   ' })).ok, false);
  assert.equal((await openAppTool({ name: '' })).ok, false);
  assert.equal((await runShortcutTool({ name: '' })).ok, false);
});

test('set_reminder rejects invalid delays', async () => {
  const bad = await setReminderTool({ seconds: -5, message: 'x' });
  assert.equal(bad.ok, false);
});

test('subprocess output capture is bounded per stream', () => {
  const existing = 'x'.repeat(60 * 1024);
  const next = appendBoundedOutput(existing, 'y'.repeat(20 * 1024));

  assert.equal(next.length, 64 * 1024);
  assert.ok(next.startsWith(existing));
  assert.equal(appendBoundedOutput(next, 'ignored').length, 64 * 1024);
});

test('reminder messages are passed as positional arguments, never interpolated into shell source', () => {
  const attack = 'hello $(touch /tmp/pwned) `whoami`; echo $HOME';
  const invocation = buildReminderInvocation(60, attack);

  assert.equal(invocation.bin, '/bin/zsh');
  assert.equal(invocation.args[0], '-c');
  assert.equal(invocation.args[1], 'sleep "$1"; exec /usr/bin/osascript -e "$2"');
  assert.equal(invocation.args[2], 'localgravity-reminder');
  assert.equal(invocation.args[3], '60');
  assert.equal(invocation.args[4], attack);
  assert.ok(!invocation.args[1].includes('/tmp/pwned'));
});

test('harmless macOS actions are allowed interactively but gated in headless audit mode', () => {
  const interactive = { safetyMode: 'ask', isHeadless: false, allowAutoRun: false };
  for (const name of ['copy_to_clipboard', 'show_notification', 'open_app', 'set_reminder']) {
    assert.equal(evaluateToolSafety({ name, args: {} }, interactive).decision, 'allow', `${name} allowed interactively`);
  }
  assert.equal(evaluateToolSafety({ name: 'paste_from_clipboard', args: {} }, interactive).decision, 'allow');

  const headlessAudit = { safetyMode: 'ask', isHeadless: true, allowAutoRun: false };
  for (const name of ['copy_to_clipboard', 'show_notification', 'open_app', 'set_reminder']) {
    assert.equal(evaluateToolSafety({ name, args: {} }, headlessAudit).decision, 'block', `${name} blocked headless`);
  }
  // Reading the clipboard is read-only and always fine
  assert.equal(evaluateToolSafety({ name: 'paste_from_clipboard', args: {} }, headlessAudit).decision, 'allow');
});

test('run_shortcut is gated as a mutating action', () => {
  const ask = { safetyMode: 'ask', isHeadless: false, allowAutoRun: false };
  assert.equal(evaluateToolSafety({ name: 'run_shortcut', args: { name: 'Do Thing' } }, ask).decision, 'ask');

  const auto = { safetyMode: 'auto', isHeadless: false, allowAutoRun: true };
  assert.equal(evaluateToolSafety({ name: 'run_shortcut', args: { name: 'Do Thing' } }, auto).decision, 'allow');

  const headlessAudit = { safetyMode: 'ask', isHeadless: true, allowAutoRun: false };
  assert.equal(evaluateToolSafety({ name: 'run_shortcut', args: { name: 'Do Thing' } }, headlessAudit).decision, 'block');
});