# LocalGravity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and ship **LocalGravity**, a native arm64 macOS Launchpad app (`Swift WKWebView` + `Node.js v26` agent runtime) powered locally by `qwen3.5:9b` via Ollama with optional Free Cloud Boost, Antigravity-style tools/vision/skill-learning, background `launchd` automations, a clean uninstaller, and a public GitHub repository (`Thush099/LocalGravity`).

**Architecture:** A minimal Swift `WKWebView` host spawns an authenticated local Node.js v26 HTTP+SSE backend (`127.0.0.1:<ephemeral-port>`), keeping total app bundle size under ~20 MB and freeing maximum 16 GB unified memory for `qwen3.5:9b`. The Node agent runtime exposes filesystem/shell/media-vision/skill tools behind an interactive approval gate, while scheduled `launchd` jobs invoke a headless CLI runner (`cli-run.mjs`) defaulting to read-only audit mode unless explicitly opted into auto-run.

**Tech Stack:** Swift 6.2 (`Cocoa`, `WebKit`), Node.js v26 (ESM, `node:http`, `node:test`, native `fetch`, SSE), Vanilla HTML/CSS/ES Modules UI, Ollama (`qwen3.5:9b`), `ffmpeg`, `imagemagick`, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-11-17-localgravity-design.md`

## Global Constraints

- Target machine: Apple MacBook Air (`Mac16,12`), Apple M4, 16 GB Unified Memory, ~25 GiB available SSD (must preserve >=12–15 GiB free).
- Primary repo path: `/Users/thushanthmahendran/Documents/Code & Projects/Software Repositories/LocalGravity`.
- Installed app bundle path: `/Applications/LocalGravity.app` (macOS arm64 Launchpad integration).
- Runtime state path: `~/.localgravity/` (`config.json`, `sessions/`, `automations.json`, `skills/`).
- Zero Electron/Chromium dependencies; zero heavy npm runtime framework bloat (use Node v26 built-in modules).
- Default local model: `qwen3.5:9b` (`num_ctx = 16384` default, adjustable `8192` / `16384` / `32768`, auto-compaction at 70% capacity).
- Zero Google/Antigravity model quotas consumed; optional Free Cloud Boost uses OpenRouter (`:free`), Groq, or custom OpenAI-compatible URLs with keys stored locally in `~/.localgravity/config.json` (`0600`).
- Catastrophic commands (`rm -rf /`, `rm -rf ~`, disk formatting, fork bombs) are permanently blocked even in Auto-Run mode.
- Scheduled `launchd` jobs (`com.localgravity.<id>.plist`) execute silently via `backend/cli-run.mjs`, default to `allowAutoRun: false`, and clean up via `scripts/uninstall.sh`.
- Never commit `~/.localgravity/`, API keys/secrets, build outputs, or `.DS_Store` to GitHub.

## Review Focus

1. **Shell-chaining bypasses in `classifyCommand`:** A command beginning with a safe verb (`ls ~/Downloads && rm -rf ~`, `du -sh | xargs rm`, or `echo $(rm -rf /)`) must never be classified as `readonly`; it must resolve to `risky` or `catastrophic`. (Pinned in Task 3: `test/safety.test.mjs`)
2. **Malformed or fenced tool calls from 9B models:** If a model emits `<tool_call>{...}</tool_call>` blocks or invalid JSON tool arguments instead of clean native `tool_calls`, `tool-parser.mjs` must parse valid calls cleanly and convert malformed JSON into a recoverable tool error message rather than crashing the turn. (Pinned in Task 4: `test/providers.test.mjs`)
3. **Skill slug path traversal & user-edit preservation:** `saveSkill` must reject names outside `[a-z0-9-]` (e.g., `../etc`), and `syncStarterSkills` must never overwrite existing customized `SKILL.md` files in `~/.localgravity/skills/`. (Pinned in Task 2: `test/skills.test.mjs`)
4. **Concurrent JSON state safety between GUI and headless `launchd` runs:** Atomic writes (`tmp` + `rename`) and isolated session files must keep `automations.json` and `sessions/` valid even under concurrent writes. (Pinned in Task 1: `test/storage.test.mjs`)
5. **Unauthorized local access to HTTP/SSE endpoints:** Any request to `/api/*` missing or mismatched on `X-Auth-Token` must return `401 Unauthorized` without running tools or leaking config/keys. (Pinned in Task 6: `test/server-api.test.mjs`)

---

### Task 1: System Prerequisites, Repo Scaffold & Atomic Storage Layer

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `backend/state/paths.mjs`
- Create: `backend/state/storage.mjs`
- Test: `test/storage.test.mjs`

**Interfaces:**
- Produces in `backend/state/paths.mjs`:
  - `getRuntimePaths(homeOverride?: string) -> { root, configFile, sessionsDir, automationsFile, skillsDir, knowledgeDir, launchAgentsDir }`
  - `getStarterSkillsDir() -> string`
- Produces in `backend/state/storage.mjs`:
  - `atomicWriteJson(filePath: string, data: unknown, mode?: number) -> Promise<void>`
  - `readJsonSafe<T>(filePath: string, fallback: T) -> Promise<T>`
  - `loadConfig(paths?) -> Promise<AppConfig>`
  - `saveConfig(patch: Partial<AppConfig>, paths?) -> Promise<AppConfig>`
  - `listSessions(paths?) -> Promise<SessionSummary[]>`
  - `loadSession(id: string, paths?) -> Promise<Session | null>`
  - `saveSession(session: Session, paths?) -> Promise<void>`
  - `deleteSession(id: string, paths?) -> Promise<boolean>`
  - `loadAutomations(paths?) -> Promise<Automation[]>`
  - `saveAutomations(list: Automation[], paths?) -> Promise<void>`

- [ ] **Step 1: Verify & install system prerequisites (`ollama`, `imagemagick`, `qwen3.5:9b`) and initialize Git repo**

Run:
```bash
cd "/Users/thushanthmahendran/Documents/Code & Projects/Software Repositories/LocalGravity" && git init
brew list ollama >/dev/null 2>&1 || brew install ollama
brew list imagemagick >/dev/null 2>&1 || brew install imagemagick
```
Start Ollama briefly if needed (`ollama list` check; if daemon not running, start `nohup ollama serve >/tmp/ollama-setup.log 2>&1 &` and wait until `/api/tags` responds), then pull `qwen3.5:9b` (`ollama pull qwen3.5:9b`) and verify `df -h ~` still shows >=15 GiB free.

- [ ] **Step 2: Create `.gitignore` and `package.json`**

Include `.DS_Store`, `node_modules/`, `build/`, `dist/`, `*.app/`, `.env`, `*.log`, and `.localgravity/` in `.gitignore`. Configure `package.json` with `"type": "module"`, `"test": "node --test test/*.test.mjs"`, `"start": "node backend/server.mjs"`, `"build:app": "bash scripts/build-app.sh"`.

- [ ] **Step 3: Write the failing test `test/storage.test.mjs`**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import {
  atomicWriteJson,
  readJsonSafe,
  loadConfig,
  saveConfig,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  saveAutomations,
  loadAutomations,
} from '../backend/state/storage.mjs';

test('storage persists config with 0600 mode, isolates sessions, and handles concurrent atomic writes', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-store-'));
  const paths = getRuntimePaths(tmpHome);

  const cfg = await loadConfig(paths);
  assert.equal(cfg.provider, 'ollama');
  assert.equal(cfg.model, 'qwen3.5:9b');
  assert.equal(cfg.numCtx, 16384);

  const updated = await saveConfig({ openRouterKey: 'sk-test-123', thinking: false }, paths);
  assert.equal(updated.openRouterKey, 'sk-test-123');
  const stat = await fs.stat(paths.configFile);
  assert.equal(stat.mode & 0o777, 0o600);

  await saveSession({ id: 'sess-1', title: 'Test', updatedAt: '2026-11-17T10:00:00Z', messages: [] }, paths);
  const loaded = await loadSession('sess-1', paths);
  assert.equal(loaded.title, 'Test');
  assert.equal((await listSessions(paths)).length, 1);

  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      saveAutomations([{ id: `auto-${i}`, name: `Job ${i}`, prompt: 'audit', allowAutoRun: false }], paths)
    )
  );
  const autos = await loadAutomations(paths);
  assert.equal(autos.length, 1);
  assert.match(autos[0].id, /^auto-\d+$/);

  await fs.writeFile(paths.automationsFile, '{broken json');
  assert.deepEqual(await readJsonSafe(paths.automationsFile, []), []);
  assert.equal(await deleteSession('sess-1', paths), true);
  await fs.rm(tmpHome, { recursive: true, force: true });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test test/storage.test.mjs`
Expected: FAIL (`Cannot find module '../backend/state/paths.mjs'`)

- [ ] **Step 5: Implement `backend/state/paths.mjs` and `backend/state/storage.mjs`**

Implement `LOCALGRAVITY_HOME` resolution defaulting to `~/.localgravity/`, serialized per-path write queue + temp-file + `fs.rename` atomic commits in `atomicWriteJson` (enforcing `0600` on `config.json`), safe session ID sanitization (`[a-zA-Z0-9_-]`), and default `AppConfig` (`provider: 'ollama'`, `model: 'qwen3.5:9b'`, `numCtx: 16384`, `thinking: true`, `safetyMode: 'ask'`).

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/storage.test.mjs`
Expected: PASS (1/1)

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json backend/state/paths.mjs backend/state/storage.mjs test/storage.test.mjs
git commit -m "feat: add runtime paths and atomic JSON state storage"
```

---

### Task 2: Self-Teaching Skill & Knowledge Engine + Starter Skills

**Files:**
- Create: `backend/skills-engine.mjs`
- Create: `backend/knowledge-engine.mjs`
- Create: `backend/skills/mac-organizer/SKILL.md`
- Create: `backend/skills/video-editor/SKILL.md`
- Create: `backend/skills/photo-editor/SKILL.md`
- Create: `backend/skills/humanizer/SKILL.md`
- Create: `backend/skills/skill-creator/SKILL.md`
- Test: `test/skills.test.mjs`
- Test: `test/knowledge.test.mjs`

**Interfaces:**
- Consumes: `getRuntimePaths`, `getStarterSkillsDir` from `backend/state/paths.mjs`
- Produces in `backend/skills-engine.mjs`:
  - `parseFrontmatter(markdown: string) -> { name: string, description: string, triggers: string[], body: string }`
  - `sanitizeSkillSlug(name: string) -> string` (throws on traversal/invalid slugs)
  - `syncStarterSkills(paths?) -> Promise<string[]>`
  - `listSkills(paths?) -> Promise<Array<{ name, description, triggers, sourcePath, isStarter }>>`
  - `readSkill(name: string, paths?) -> Promise<{ meta, content, files: string[] } | null>`
  - `saveSkill(input: { name, description, triggers?, content, extraFiles?: Record<string, string> }, paths?) -> Promise<{ path: string }>`
  - `deleteSkill(name: string, paths?) -> Promise<boolean>`
  - `importExternalSkills(sourceDir: string, names?: string[], paths?) -> Promise<string[]>`
- Produces in `backend/knowledge-engine.mjs`:
  - `ensureKnowledgeSeeded(paths?) -> Promise<void>` (seeds empty `MEMORY.md` if missing)
  - `listKnowledge(paths?) -> Promise<Array<{ name, title, tags, sizeBytes, updatedAt }>>`
  - `readKnowledge(name: string, paths?) -> Promise<{ name, title, tags, content } | null>`
  - `saveKnowledge({ name, title, tags?, content }, paths?) -> Promise<{ name, path }>`
  - `searchKnowledge(query: string, paths?) -> Promise<Array<{ name, title, snippet, score }>>`
  - `deleteKnowledge(name: string, paths?) -> Promise<boolean>`

- [ ] **Step 1: Write the failing test `test/skills.test.mjs`**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import {
  parseFrontmatter,
  syncStarterSkills,
  listSkills,
  readSkill,
  saveSkill,
  deleteSkill,
  importExternalSkills,
} from '../backend/skills-engine.mjs';

test('skills engine syncs starters without clobbering edits, rejects path traversal, and imports skills', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-skills-'));
  const paths = getRuntimePaths(tmpHome);

  const synced = await syncStarterSkills(paths);
  assert.ok(synced.includes('mac-organizer'));
  assert.ok(synced.includes('video-editor'));
  assert.ok(synced.includes('photo-editor'));
  assert.ok(synced.includes('humanizer'));
  assert.ok(synced.includes('skill-creator'));

  await saveSkill({
    name: 'mac-organizer',
    description: 'Custom user override',
    triggers: ['clean'],
    content: '# Custom rules',
  }, paths);
  await syncStarterSkills(paths);
  const reloaded = await readSkill('mac-organizer', paths);
  assert.equal(reloaded.meta.description, 'Custom user override');

  await assert.rejects(() => saveSkill({ name: '../evil', description: 'x', content: 'y' }, paths));

  const parsed = parseFrontmatter('---\nname: demo\ndescription: A demo\ntriggers: ["a", "b"]\n---\nBody');
  assert.deepEqual(parsed.triggers, ['a', 'b']);

  const extDir = path.join(tmpHome, 'ext-skills');
  await fs.mkdir(path.join(extDir, 'custom-ext'), { recursive: true });
  await fs.writeFile(path.join(extDir, 'custom-ext', 'SKILL.md'), '---\nname: custom-ext\ndescription: Imported\n---\nSteps');
  const imported = await importExternalSkills(extDir, ['custom-ext'], paths);
  assert.deepEqual(imported, ['custom-ext']);
  assert.ok((await listSkills(paths)).some((s) => s.name === 'custom-ext'));
  assert.equal(await deleteSkill('custom-ext', paths), true);

  await fs.rm(tmpHome, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skills.test.mjs`
Expected: FAIL (`Cannot find module '../backend/skills-engine.mjs'`)

- [ ] **Step 3: Implement `backend/skills-engine.mjs` and author the 5 starter `SKILL.md` files**

Ensure strict slug validation (`/^[a-z0-9][a-z0-9-]{0,62}$/`), YAML frontmatter parsing/serialization, starter sync that copies directories only when missing in `~/.localgravity/skills/`, and `extraFiles` path confinement inside the skill folder. Author high-signal starter skills:
- `mac-organizer`: safe Trash via `osascript`, dry-run preview before moving, `du`/`mdfind` large-file audits.
- `video-editor`: `ffmpeg` stream-copy cuts, 9:16 social reframing, audio normalization/ducking, subtitle burn-in, frame contact-sheet inspection via `inspect_media`, FCPXML generation for Final Cut Pro.
- `photo-editor`: `magick` (`ImageMagick`) & `sips` batch conversion/resize/exposure/sharpening/watermarks, before/after `inspect_media` checks, Pixelmator Pro AppleScript tips.
- `humanizer`: banned AI clichés, sentence cadence variation, active voice, tone preservation.
- `skill-creator`: rules instructing the agent how to capture verified workflows into new or updated `SKILL.md` files via `save_skill`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/skills.test.mjs`
Expected: PASS (1/1)

- [ ] **Step 5: Commit**

```bash
git add backend/skills-engine.mjs backend/skills test/skills.test.mjs
git commit -m "feat: add self-teaching SKILL.md engine and starter skills"
```

---

### Task 3: Built-in Tools, Safety Classifier & Media Vision Inspector

**Files:**
- Create: `backend/tools/safety.mjs`
- Create: `backend/tools/fs-tools.mjs`
- Create: `backend/tools/exec-tool.mjs`
- Create: `backend/tools/media-tool.mjs`
- Create: `backend/tools/registry.mjs`
- Test: `test/safety.test.mjs`
- Test: `test/tools.test.mjs`

**Interfaces:**
- Consumes: `listSkills`, `readSkill`, `saveSkill` from `backend/skills-engine.mjs`
- Produces in `backend/tools/safety.mjs`:
  - `classifyCommand(command: string) -> { level: 'catastrophic' | 'risky' | 'readonly', reason: string }`
  - `classifyFileWrite(targetPath: string, skillsDir: string) -> { autoAllowInAskMode: boolean }`
- Produces in `backend/tools/registry.mjs`:
  - `TOOL_DEFINITIONS` (OpenAI/Ollama function-calling JSON schema array for `list_dir`, `read_file`, `write_file`, `edit_file`, `search_files`, `run_command`, `inspect_media`, `list_skills`, `read_skill`, `save_skill`)
  - `evaluateToolSafety({ name, args }, context) -> { decision: 'allow' | 'ask' | 'block', reason?: string, preview?: string }`
  - `executeToolCall({ name, args }, context) -> Promise<{ ok: boolean, output: string, images?: string[], diff?: string, meta?: object }>`

- [ ] **Step 1: Write failing tests `test/safety.test.mjs` and `test/tools.test.mjs`**

Test in `test/safety.test.mjs`:
- Catastrophic blocking: `rm -rf /`, `rm -rf ~`, `sudo rm -rf /Users`, `diskutil eraseDisk`, `:(){ :|:& };:`, `ls && rm -rf ~` -> `catastrophic`.
- Shell-chaining bypass protection: `ls ~/Downloads && touch x`, `du -sh ~ | xargs rm`, `ls $(whoami)`, `cat a > b` -> `risky` (never `readonly`).
- True read-only allowlist: `ls -la ~/Downloads`, `df -h ~`, `ffprobe clip.mp4`, `git status` -> `readonly`.
- Headless scheduled run gating (`allowAutoRun: false` rejects `risky` commands & external writes while allowing `readonly` and skill reads).

Test in `test/tools.test.mjs`:
- `list_dir`, `read_file` (line bounds), `write_file`, `edit_file` (exact replacement + unified diff), `search_files` in temp dir.
- `run_command` stdout/stderr capture and timeout enforcement.
- `inspect_media` against a generated 320x240 PNG (via `ffmpeg -f lavfi -i color=c=blue:s=320x240 -frames:v 1`) returning base64 image + metadata and cleaning temp files.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/safety.test.mjs test/tools.test.mjs`
Expected: FAIL (`Cannot find module`)

- [ ] **Step 3: Implement `safety.mjs`, `fs-tools.mjs`, `exec-tool.mjs`, `media-tool.mjs`, and `registry.mjs`**

In `safety.mjs`, reject any command containing unquoted chaining/redirection/subshell operators (`;`, `&&`, `||`, `|`, `` ` ``, `$(`, `>`, `>>`) from the `readonly` bucket, and enforce regex checks against catastrophic paths. In `media-tool.mjs`, scale large images via `sips` (max 1280px edge) and extract video keyframes or 2x2 contact sheets via `ffmpeg`, deleting temporary files in a `finally` block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/safety.test.mjs test/tools.test.mjs`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add backend/tools test/safety.test.mjs test/tools.test.mjs
git commit -m "feat: add agent tools, shell safety classifier, and media vision inspector"
```

---

### Task 4: Multi-Provider Adapters (Ollama, OpenAI/ChatGPT, Gemini, Claude, OpenRouter, Groq)

**Files:**
- Create: `backend/providers/tool-parser.mjs`
- Create: `backend/providers/ollama.mjs`
- Create: `backend/providers/openai-compat.mjs`
- Create: `backend/providers/anthropic.mjs`
- Test: `test/providers.test.mjs`

**Interfaces:**
- Produces in `backend/providers/tool-parser.mjs`:
  - `extractFallbackToolCalls(text: string) -> { cleanedText: string, toolCalls: Array<{ id: string, name: string, arguments: object, parseError?: string }> }`
- Produces in `backend/providers/ollama.mjs`:
  - `checkOllamaHealth(baseUrl?) -> Promise<{ running: boolean, models: Array<{ name, size }> }>`
  - `ensureOllamaRunning() -> Promise<{ startedByUs: boolean, stop: () => Promise<void> }>`
  - `pullOllamaModel(name, onProgress) -> Promise<void>`
  - `deleteOllamaModel(name) -> Promise<void>`
  - `streamOllamaChat({ model, messages, tools, thinking, numCtx, signal, onEvent }) -> Promise<NormalizedResponse>`
- Produces in `backend/providers/openai-compat.mjs`:
  - `CLOUD_PRESETS` (`openrouter`, `groq`, `gemini`, `openai`, `anthropic`, `custom`)
  - `streamOpenAIChat({ baseUrl, apiKey, model, messages, tools, signal, onEvent }) -> Promise<NormalizedResponse>`
- Produces in `backend/providers/anthropic.mjs`:
  - `streamAnthropicChat({ apiKey, model, messages, tools, signal, onEvent }) -> Promise<NormalizedResponse>`

- [ ] **Step 1: Write the failing test `test/providers.test.mjs`**

Test with a local `node:http` mock server:
1. Ollama streaming NDJSON parsing: `message.thinking` -> `thinking_delta`, `message.content` -> `text_delta`, native `message.tool_calls` -> normalized `{ id, name, arguments }`.
2. OpenAI SSE streaming parsing (`data: {"choices":[{"delta":{"reasoning_content":...,"content":...,"tool_calls":...}}]}` + `data: [DONE]`).
3. `extractFallbackToolCalls`: parses `<tool_call>{"name":"list_dir","arguments":{"path":"~"}}</tool_call>` and recovers malformed JSON into a `parseError` entry without throwing.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/providers.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement `tool-parser.mjs`, `ollama.mjs`, and `openai-compat.mjs`**

Normalize both adapters to emit the exact same `{ content, thinking, toolCalls, usage }` contract and handle vision attachments cleanly (`images: [base64]` for Ollama; `image_url` data URIs for OpenAI-compatible).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/providers.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/providers test/providers.test.mjs
git commit -m "feat: add Ollama and OpenAI-compatible streaming providers"
```

---

### Task 5: Agent ReAct Loop & Context Compaction

**Files:**
- Create: `backend/agent/prompt.mjs`
- Create: `backend/agent/compactor.mjs`
- Create: `backend/agent/loop.mjs`
- Test: `test/agent-loop.test.mjs`

**Interfaces:**
- Consumes: `listSkills`, `evaluateToolSafety`, `executeToolCall`, `TOOL_DEFINITIONS`, provider stream functions.
- Produces in `backend/agent/prompt.mjs`:
  - `buildSystemPrompt({ skills, safetyMode, isHeadless, allowAutoRun }) -> string`
- Produces in `backend/agent/compactor.mjs`:
  - `estimateMessagesTokens(messages) -> number`
  - `compactConversation(messages, { numCtx, summarizeFn }) -> Promise<{ messages, compacted: boolean, summary?: string }>`
- Produces in `backend/agent/loop.mjs`:
  - `runAgentTurn(options) -> Promise<{ session, status: 'completed' | 'cancelled' | 'error' }>`

- [ ] **Step 1: Write the failing test `test/agent-loop.test.mjs`**

Using an injected mock chat provider:
1. Executes multi-step tool loop (`read_skill` -> `inspect_media` -> final text) and injects returned `images` into the next model turn.
2. Emits `approval_required` for risky `run_command` in `ask` mode, waits on approval callback, executes on Approve, returns denial message on Deny, and skips approval on `auto` mode while still blocking catastrophic commands.
3. Enforces read-only behavior when `isHeadless: true` and `allowAutoRun: false`.
4. Triggers `compactConversation` when estimated token count exceeds 70% of `numCtx`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/agent-loop.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement `prompt.mjs`, `compactor.mjs`, and `loop.mjs`**

Keep system prompt compact (Apple M4 16GB context, skill-first protocol, tool discipline, only skill `name` + `description` index). Cap max steps per turn at 25, handle `AbortSignal` cleanly, and persist tool calls/results inside the session JSON.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/agent-loop.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/agent test/agent-loop.test.mjs
git commit -m "feat: add multi-step ReAct agent loop and context compaction"
```

---

### Task 6: Automations (`launchd`), Headless Runner & HTTP/SSE Server

**Files:**
- Create: `backend/automations.mjs`
- Create: `backend/cli-run.mjs`
- Create: `backend/server.mjs`
- Test: `test/server-api.test.mjs`

**Interfaces:**
- Consumes: `storage.mjs`, `skills-engine.mjs`, `registry.mjs`, `ollama.mjs`, `openai-compat.mjs`, `loop.mjs`
- Produces in `backend/automations.mjs`:
  - `buildLaunchAgentPlist({ id, label, scriptPath, nodePath, intervalSeconds?, calendarInterval? }) -> string`
  - `setAutomationSchedule(id, scheduleConfig, paths?) -> Promise<Automation>`
  - `removeAllLaunchAgents(paths?) -> Promise<void>`
- Produces in `backend/server.mjs`:
  - `createAgentServer({ authToken, paths }) -> { server, start: () => Promise<{ port }>, stop: () => Promise<void> }`
- Produces in `backend/cli-run.mjs`:
  - CLI accepting `--automation <id>`, running headless turn, updating `lastRun` atomically, tearing down transient Ollama if spawned, and posting macOS notification (`osascript`).

- [ ] **Step 1: Write the failing test `test/server-api.test.mjs`**

Test against `createAgentServer` bound on `127.0.0.1:0`:
1. Requests to `/api/health`, `/api/sessions`, `/api/skills`, `/api/automations`, `/api/models/config` return `401` without `X-Auth-Token`, and `200` with valid token.
2. Session create/load/delete, Skill create/read/delete, Automation create/schedule plist generation (`buildLaunchAgentPlist` XML validation without running global `launchctl` in unit test), and Model config save (masking stored API keys on GET).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-api.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement `automations.mjs`, `cli-run.mjs`, and `server.mjs`**

Bind `server.mjs` strictly to `127.0.0.1:0`, print `READY:<port>` on stdout for Swift host discovery, verify `X-Auth-Token` (or `?token=` session cookie for static UI assets), serve `ui/` static files, and wire all REST + SSE endpoints (`/api/sessions/:id/run`, `/api/sessions/:id/approve`, `/api/sessions/:id/cancel`, `/api/sessions/:id/compact`, `/api/skills/import-antigravity`, `/api/models/ollama/*`, `/api/media/thumbnail`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-api.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/automations.mjs backend/cli-run.mjs backend/server.mjs test/server-api.test.mjs
git commit -m "feat: add authenticated HTTP/SSE server, launchd scheduler, and headless runner"
```

---

### Task 7: Antigravity-Inspired Desktop UI

**Files:**
- Create: `ui/index.html`
- Create: `ui/styles.css`
- Create: `ui/lib/markdown.js`
- Create: `ui/lib/api.js`
- Create: `ui/app.js`

**Interfaces:**
- Consumes HTTP + SSE APIs from `backend/server.mjs` and optional `window.webkit.messageHandlers.localgravity` bridge from Swift host (with graceful HTML `<input type="file">` fallback when tested in browser).

- [ ] **Step 1: Build `ui/lib/markdown.js` and `ui/lib/api.js`**

Write a clean XSS-safe Markdown renderer (headings, lists, tables, inline code, fenced code blocks with language badge + 1-click Copy button, bold/italic, links) and typed API/SSE client (`X-Auth-Token` extracted from bootstrap cookie/query or injected by Swift).

- [ ] **Step 2: Build `ui/index.html` and `ui/styles.css`**

Craft a high-craft macOS-native adaptive dark/light UI inspired by Antigravity:
- Frosted/vibrant sidebar (`+ New Task`, searchable session history with scheduled badges, nav tabs: **Agent**, **Skills**, **Automations**, **Models & Settings**, live Ollama & disk status footer).
- Agent workspace: header bar (Model Switcher pill with `Local · qwen3.5:9b` + Cloud Boost models, Thinking toggle, Ask/Auto Safety toggle, context usage meter + `Compact` button), streaming message stream (collapsible Thinking accordions, rich Tool cards with diff/stdout/Approve-Edit-Deny actions, inline media thumbnails, **Teach as Skill** & **Save Automation** buttons), bottom composer with drag-and-drop file/folder/media chips, quick-start workflow pills, file picker button, and Stop button.
- Skills view: searchable cards, inline `SKILL.md` viewer/editor, `+ New Skill`, **Import from Antigravity** picker.
- Automations view: quick-run cards, `+ New Automation`, schedule selector (hourly/daily/interval) with explicit **"Allow auto-run"** opt-in checkbox + safety warning.
- Models & Settings view: live Apple M4 RAM & SSD free-space bars, Ollama Start/Pull/Delete UI, Cloud Boost API setup (`OpenRouter :free`, `Groq`, `Custom`), and **Clean Uninstall** guide + copyable command.

- [ ] **Step 3: Implement `ui/app.js`**

Wire SSE streaming state, interactive tool approval forms (including editable command before approving), session persistence/switching, drag-and-drop path resolution (handling both Swift native file-drop events and HTML5 files), live skill/automation CRUD, and Ollama pull progress bar.

- [ ] **Step 4: Run headless UI/API smoke verification**

Start `node backend/server.mjs` with `AUTH_TOKEN=testtoken` in a short verification script, fetch `/`, `/styles.css`, `/app.js`, and `/api/health`, verify `200 OK` and clean JS syntax (`node --check ui/app.js ui/lib/api.js ui/lib/markdown.js`).

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat: build Antigravity-inspired desktop UI for agent, skills, automations, and models"
```

---

### Task 8: Native Swift `WKWebView` Host, App Icon, Bundle Build & Uninstaller

**Files:**
- Create: `native/LocalGravityHost.swift`
- Create: `scripts/generate-icon.mjs`
- Create: `scripts/build-app.sh`
- Create: `scripts/uninstall.sh`

**Interfaces:**
- Consumes `backend/server.mjs` (`READY:<port>` stdout handshake, `AUTH_TOKEN` env var, `SIGTERM` shutdown).
- Produces `/Applications/LocalGravity.app` (valid `CFBundleIdentifier: com.localgravity.app`, `AppIcon.icns`, arm64 binary, bundled `backend/` & `ui/`) and `scripts/uninstall.sh`.

- [ ] **Step 1: Implement `native/LocalGravityHost.swift`**

Build AppKit + `WKWebView` desktop wrapper:
- Resolves bundled `Resources/backend/server.mjs` and locates `node` binary (`/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/env node`).
- Generates 32-byte hex `AUTH_TOKEN`, launches `node`, parses `READY:<port>`, loads `http://127.0.0.1:<port>/?token=<AUTH_TOKEN>`.
- Configures standard macOS Edit menu (`Cmd+C`, `Cmd+V`, `Cmd+X`, `Cmd+A`, `Cmd+Z`, `Cmd+Q`, `Cmd+R`) so keyboard shortcuts work inside `WKWebView`.
- Bridges `webkit.messageHandlers.localgravity` for `pickFiles` (`NSOpenPanel` supporting files + directories!) and `openExternal` (`NSWorkspace.shared.open`), and supports dropping Finder files/folders onto the window (injecting absolute file paths straight into the UI composer).
- Terminates Node child process cleanly on `applicationWillTerminate`.

- [ ] **Step 2: Create `scripts/generate-icon.mjs`, `scripts/build-app.sh`, and `scripts/uninstall.sh`**

Generate a crisp high-res PNG iconset (using SVG/HTML rasterized cleanly via `qlmanage`/`sips` or CoreGraphics in Swift/Python) -> `iconutil -c icns` -> `AppIcon.icns`. `build-app.sh` compiles `LocalGravityHost.swift` with `swiftc -O -target arm64-apple-macosx14.0 -framework Cocoa -framework WebKit`, copies `backend/` & `ui/` into `/Applications/LocalGravity.app/Contents/Resources/`, writes `Info.plist`, codesigns ad-hoc (`codesign --force --deep --sign -`), and refreshes LaunchServices (`lsregister`). `uninstall.sh` cleanly kills app, removes LaunchAgents, moves `.app` & `~/.localgravity/` to Trash, and offers optional Ollama/model/ImageMagick removal.

- [ ] **Step 3: Build `/Applications/LocalGravity.app` and verify Launchpad bundle**

Run:
```bash
bash scripts/build-app.sh
codesign --verify --deep --strict /Applications/LocalGravity.app
ls -lh /Applications/LocalGravity.app/Contents/MacOS/LocalGravity
```
Expected: Ad-hoc signature valid, arm64 binary built, total `.app` size < 20 MB, launches cleanly when tested (`open /Applications/LocalGravity.app` or smoke-launching binary for handshake verification).

- [ ] **Step 4: Commit**

```bash
git add native scripts
git commit -m "feat: add native Swift WKWebView host, icon generator, app builder, and uninstaller"
```

---

### Task 9: README, Full Verification & Public GitHub Release (`Thush099/LocalGravity`)

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write comprehensive `README.md`**

Include project overview, visual architecture summary, M4 / 16 GB RAM optimization details, Hybrid Model Switcher (`qwen3.5:9b` + Free Cloud Boost), built-in tools & self-teaching `SKILL.md` workflow, starter skills (`mac-organizer`, `video-editor`, `photo-editor`, `humanizer`, `skill-creator`), Launchpad installation instructions, scheduled background automations, and clean uninstallation instructions.

- [ ] **Step 2: Run full test suite & end-to-end live verification with Ollama `qwen3.5:9b`**

Run:
```bash
npm test
node --test test/*.test.mjs
```
Also run an end-to-end smoke test calling `cli-run.mjs` / `server.mjs` against live `qwen3.5:9b` on Ollama (read-only Mac storage check + media/skill check) and verify `/Applications/LocalGravity.app` launches cleanly without orphaned processes on quit. Check `df -h ~` to confirm healthy disk space remains.

- [ ] **Step 3: Audit repo cleanliness & push public GitHub repository**

Verify `git status` and `git log` contain zero personal keys, `.DS_Store`, or `~/.localgravity/` state:
```bash
git add README.md docs/
git commit -m "docs: add comprehensive README and finalize specs"
gh repo create LocalGravity --public --source=. --remote=origin --push --description "Native macOS Launchpad AI agent desktop app powered by local Ollama (Qwen3.5-9B) & Free Cloud Boost with self-teaching SKILL.md workflows"
```
Verify `gh repo view Thush099/LocalGravity --web` or `gh repo view Thush099/LocalGravity` succeeds and report the live GitHub URL and verification outputs to the user.
