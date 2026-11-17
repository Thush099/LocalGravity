import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { classifyCommand, classifyFileWrite } from '../backend/tools/safety.mjs';
import { evaluateToolSafety } from '../backend/tools/registry.mjs';

test('safety classifier blocks catastrophic commands and rejects shell-chaining bypasses', () => {
  assert.equal(classifyCommand('rm -rf /').level, 'catastrophic');
  assert.equal(classifyCommand('rm -rf ~').level, 'catastrophic');
  assert.equal(classifyCommand('sudo rm -rf /Users/alice').level, 'catastrophic');
  assert.equal(classifyCommand('diskutil eraseDisk APFS Test disk0').level, 'catastrophic');
  assert.equal(classifyCommand(':(){ :|:& };:').level, 'catastrophic');
  assert.equal(classifyCommand('ls ~/Downloads && rm -rf ~').level, 'catastrophic');

  assert.equal(classifyCommand('ls ~/Downloads && touch pwned').level, 'risky');
  assert.equal(classifyCommand('du -sh ~ | xargs rm').level, 'risky');
  assert.equal(classifyCommand('ls $(whoami)').level, 'risky');
  assert.equal(classifyCommand('cat file.txt > out.txt').level, 'risky');
  assert.equal(classifyCommand('ls `pwd`').level, 'risky');

  assert.equal(classifyCommand('ls -la ~/Downloads').level, 'readonly');
  assert.equal(classifyCommand('df -h ~').level, 'readonly');
  assert.equal(classifyCommand('ffprobe "clip name.mp4"').level, 'readonly');
  assert.equal(classifyCommand('git status').level, 'readonly');
  assert.equal(classifyCommand('git branch --show-current').level, 'readonly');

  // Zsh process substitution, sips 4+ token mutations, git branch mutations, quoted/prefixed rm
  assert.equal(classifyCommand('cat =(mv ~/a ~/b)').level, 'risky');
  assert.equal(classifyCommand('ls =(touch /tmp/pwned)').level, 'risky');
  assert.equal(classifyCommand('sips -g pixelWidth -Z 100 photo.jpg').level, 'risky');
  assert.equal(classifyCommand('sips -g pixelWidth a.png b.png -o out.png').level, 'risky');
  assert.equal(classifyCommand('sips -g pixelWidth -g pixelHeight photo.jpg').level, 'readonly');
  assert.equal(classifyCommand('git branch -D main').level, 'risky');
  assert.equal(classifyCommand('git branch feature-new').level, 'risky');
  assert.equal(classifyCommand('rm -rf "/"').level, 'catastrophic');
  assert.equal(classifyCommand('rm -rf "$HOME"').level, 'catastrophic');
  assert.equal(classifyCommand('rm -rf ~/*').level, 'catastrophic');
  assert.equal(classifyCommand('/bin/rm -rf /').level, 'catastrophic');
  assert.equal(classifyCommand('find ~ -delete').level, 'catastrophic');
});

test('evaluateToolSafety enforces ask, auto, and headless allowAutoRun policies', () => {
  const skillsDir = path.join(os.tmpdir(), 'lg-skills');
  const knowledgeDir = path.join(os.tmpdir(), 'lg-knowledge');

  assert.equal(classifyFileWrite(path.join(skillsDir, 'my-skill/SKILL.md'), skillsDir, knowledgeDir).autoAllowInAskMode, true);
  assert.equal(classifyFileWrite(path.join(knowledgeDir, 'notes.md'), skillsDir, knowledgeDir).autoAllowInAskMode, true);
  assert.equal(classifyFileWrite('/Users/someone/notes.txt', skillsDir, knowledgeDir).autoAllowInAskMode, false);

  const askCtx = { safetyMode: 'ask', isHeadless: false, allowAutoRun: false, skillsDir, knowledgeDir };
  assert.equal(evaluateToolSafety({ name: 'read_file', args: { path: '/tmp/a' } }, askCtx).decision, 'allow');
  assert.equal(evaluateToolSafety({ name: 'run_command', args: { command: 'df -h ~' } }, askCtx).decision, 'allow');
  assert.equal(evaluateToolSafety({ name: 'run_command', args: { command: 'mv a b' } }, askCtx).decision, 'ask');
  assert.equal(evaluateToolSafety({ name: 'run_command', args: { command: 'rm -rf ~' } }, askCtx).decision, 'block');
  assert.equal(evaluateToolSafety({ name: 'write_file', args: { path: '/tmp/x.txt', content: 'hi' } }, askCtx).decision, 'ask');

  const autoCtx = { safetyMode: 'auto', isHeadless: false, allowAutoRun: true, skillsDir, knowledgeDir };
  assert.equal(evaluateToolSafety({ name: 'run_command', args: { command: 'mv a b' } }, autoCtx).decision, 'allow');
  assert.equal(evaluateToolSafety({ name: 'run_command', args: { command: 'rm -rf /' } }, autoCtx).decision, 'block');

  const headlessAuditCtx = { safetyMode: 'ask', isHeadless: true, allowAutoRun: false, skillsDir, knowledgeDir };
  assert.equal(evaluateToolSafety({ name: 'run_command', args: { command: 'ls -la' } }, headlessAuditCtx).decision, 'allow');
  assert.equal(evaluateToolSafety({ name: 'run_command', args: { command: 'mv a b' } }, headlessAuditCtx).decision, 'block');
  assert.equal(evaluateToolSafety({ name: 'write_file', args: { path: '/tmp/x.txt', content: 'hi' } }, headlessAuditCtx).decision, 'block');
});
