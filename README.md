# LocalGravity

[![CI](https://github.com/Thush099/LocalGravity/actions/workflows/ci.yml/badge.svg)](https://github.com/Thush099/LocalGravity/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![macOS 14+](https://img.shields.io/badge/macOS-14%2B-black?logo=apple&logoColor=white)](#requirements)

LocalGravity is a native macOS desktop app for running an AI agent against files and tools on your Mac. Use a local [Ollama](https://ollama.com) model, or configure a supported cloud provider. The app includes a Swift and WebKit shell, a dependency-free Node.js runtime, a tool approval flow, reusable skills, a local knowledge base, and scheduled `launchd` automations.

This guide explains how to build and run the app, choose a model provider, and understand what its tools can access. Local models keep prompts on your Mac; cloud providers receive the data you send them, subject to their own policies.

---

## Quick start

Build LocalGravity on a supported Apple Silicon Mac with macOS 14 or later, Node.js 22 or later, and Xcode Command Line Tools. The app has no npm dependencies to install.

```bash
git clone https://github.com/Thush099/LocalGravity.git
cd LocalGravity
npm run check
npm run build:app
```

The build script installs `/Applications/LocalGravity.app` when it can write to `/Applications`; otherwise, it creates `build/LocalGravity.app` in the repository. See [Build and install](#build-and-install) for details.

To use a local model, install Ollama, start its service, and download a model supported by your machine. `ffmpeg` and ImageMagick enable optional video and image workflows; the core app can run without them.

## Key features

- **Native macOS Launchpad App (`/Applications/LocalGravity.app`):** Compiled `arm64` Swift `WKWebView` host that manages an isolated, token-authenticated Node.js v26 agent server on `127.0.0.1` and shuts it down cleanly on quit.
- **Hybrid Model Switcher:**
  - **Local Ollama (Recommended: `qwen3.5:9b`; optional `qwen3.5:4b` fast preset):** Native vision, native tool calling, toggleable **Deep Think** mode, and M4-tuned context budgets (`8K` / `16K` / `32K` with automatic context compaction at 70% capacity).
  - **Multi-Provider Support:** Connect **OpenRouter (`:free` & Pro)**, **Groq**, **Google Gemini**, **Anthropic Claude**, **OpenAI / ChatGPT**, or any **Custom OpenAI-Compatible Endpoint**. Keys stay strictly local in `~/.localgravity/config.json` (`0600`).
- **Antigravity-Style Tool Loop & Safety Gate:**
  - Built-in tools: `list_dir`, `read_file`, `write_file`, `edit_file`, `search_files`, `run_command`, `run_applescript`, `run_shortcut`, `calculate`, `update_plan`, `inspect_media`, `fetch_url`, `copy_to_clipboard`/`paste_from_clipboard`, `show_notification`, `open_app`, `set_reminder`, `system_stats`, `add_schedule_item`/`list_schedule_items`/`remove_schedule_item`, `list_skills`/`read_skill`/`save_skill` (with `extra_files` scripts), and `list_knowledge`/`search_knowledge`/`read_knowledge`/`save_knowledge`.
  - **macOS Quick Actions:** Everyday Mac actions without shelling out — copy/paste the clipboard, show a notification banner, open any app, run any **Apple Shortcut** by name (turning all your Shortcuts into agent superpowers), and set background **timers/reminders**. Deep `run_applescript` automation is available when a single command is not enough.
  - **Live Task Plan (`update_plan`):** The agent publishes an interactive multi-step checklist that streams to the UI in real time so you can watch it tick off each step — plan, active, and done states render as a live progress panel.
  - **Safe Calculator (`calculate`):** Exact arithmetic (`+ - * / % ^`, parentheses, `sqrt`/`abs`/`log`, `pi`/`e`) via an injection-safe parser — no `eval`, no shell.
  - **AppleScript Automation (`run_applescript`):** Deep macOS automation via `osascript` (Finder, Notes, Safari, System Events) run from a temp file through `execFile` (never a shell), always gated as a mutating action.
  - **Visual Media Inspection (`inspect_media`):** Extracts video keyframes via `ffmpeg` or scales photos via `sips` and passes them directly to the vision model so the agent can visually verify edits before and after running commands.
  - **Safety policies:** **Ask** mode pauses supported mutating tools for approval. The safety checks block known catastrophic shell-command patterns, but they are not a sandbox. Review commands and file changes before approving them.
- **Self-Teaching Skills & Knowledge Base:**
  - Uses modular `SKILL.md` skills (`~/.localgravity/skills/`) with lightweight index loading so local models stay fast and sharp.
  - Includes **30 Starter Skills** across engineering, macOS automation, media production, research, writing, data, DevOps, accessibility, everyday planning, and study coaching: `coding-engineer`, `systematic-debugger`, `test-driven-developer`, `project-planner`, `frontend-architect`, `api-designer`, `security-reviewer`, `devops-engineer`, `macos-automator`, `mac-organizer`, `image-batch-processor`, `video-producer`, `photo-editor`, `video-editor`, `data-analyst`, `data-visualizer`, `presentation-builder`, `technical-writer`, `humanizer`, `academic-researcher`, `literature-reviewer`, `citation-manager`, `research-assistant`, `study-coach`, `system-monitor`, `daily-planner`, `accessibility-auditor`, `skill-scout`, `self-upgrade`, and `skill-creator`.
  - **Skill Library browser:** scan the skills already installed on this Mac (`~/.agents/skills`, `~/.claude/skills`, and `~/.gemini/config/skills`), see which are already installed, and copy selected workflows into LocalGravity in one click.
  - One-click **Teach as skill**, **Import from GitHub** (paste any raw `SKILL.md` or `github.com/.../blob/...` link, with a **Refresh** button that re-downloads from the stored source URL), persistent **`MEMORY.md`**, and `.md`/`.txt`/`.json`/`.csv` Knowledge Document uploads (`~/.localgravity/knowledge/`).
  - **Hash-tracked starter upgrades:** untouched starter skills receive improved instructions when the app updates, while user edits and deletions are preserved.
  - **Turn-aware skill hints:** each message is scored against skill triggers, and the two best matches are surfaced in the system prompt so small local models load the right playbook.
- **Everyday Dashboard & System Monitor:** The app opens on a live clock with greeting, today's agenda, and four usage tiles (CPU, memory, GPU, storage). Quick actions start a task, add timetable entries, and set **notification reminders** (minutes + message) without leaving the dashboard. The **System Monitor** view is a Task Manager-style panel with usage bars, wired/compressed memory, battery and power status, volume tables, and the top processes sorted by CPU (auto-refreshes every 4 s while visible). The **Timetable** view holds recurring weekly blocks with a week-at-a-glance grid plus one-off reminders, and the agent can add or remove entries through `add_schedule_item` / `remove_schedule_item`. Press `⌘1`-`⌘4` to jump between Dashboard, Agent, Monitor, and Timetable.
- **Responsive Multi-Turn Chat:** Supports live status timers, **Deep Think: Off / On** speed toggle, follow-up message queueing / instant interrupt while a turn is running, full-text search across past conversations with matched-message snippets, and one-click **Markdown export** of the current session.
- **Focus-First Interface:** A collapsible sidebar (`⌘\`) with persisted state, an orbital local-first welcome screen, relative task timestamps, composer shortcut hints, reduced-motion support, and responsive header controls that stay usable down to the 920 px minimum window size.
- **Command Palette & Keyboard Control:** `⌘K` searches tasks, skills, knowledge docs, and actions; `⌘↵` sends, `⌘⇧E` exports, `⌘/` shows every shortcut, `⌘\` collapses the sidebar, and `Esc` closes overlays. The header has a live context-window meter that turns amber at 70% and red at 90%, tool cards show durations and collapsible output, file edits render as colored diffs, failed turns get a **Retry** action, and a scroll-to-latest pill appears when you read back.
- **Local API Hardening:** Every `/api/*` route requires the per-launch token, mutating requests from a foreign `Origin` are rejected so a browser page cannot ride the app's cookie, the UI is served with a strict `script-src 'self'` CSP plus `nosniff`/`DENY` headers, malformed JSON returns `400`, oversized bodies return `413`, and cloud providers retry once on `429`/`5xx` with `Retry-After` support.
- **Scheduled Background Automations (`launchd`):**
  - Save any workflow as a one-click Automation card or attach an hourly/daily `launchd` schedule (`~/Library/LaunchAgents/com.localgravity.<id>.plist`).
  - Headless background runs execute via `backend/cli-run.mjs`, write isolated session logs, default to **Read-Only Audit mode** (`allowAutoRun: false` unless explicitly opted in), and post macOS notifications when done.

---

## Architecture

```text
┌──────────────────────────────────────────────────────────┐
│  /Applications/LocalGravity.app (Swift 6 / WKWebView)    │
│  • Native Finder drag-and-drop & NSOpenPanel picker      │
│  • Generates 32-byte per-launch AUTH_TOKEN               │
│  • Sets PATH (/opt/homebrew/bin) & terminates cleanly    │
└──────────────────────────┬───────────────────────────────┘
                           │ http://127.0.0.1:<ephemeral> (X-Auth-Token + SSE)
┌──────────────────────────▼───────────────────────────────┐
│  Node.js v26 Agent Runtime (Zero external npm deps)      │
│  ├── backend/server.mjs      (HTTP/SSE API + UI static)  │
│  ├── backend/cli-run.mjs     (Headless launchd runner)   │
│  ├── backend/agent/          (ReAct loop + compaction)   │
│  ├── backend/providers/      (Ollama, OpenAI, Claude)    │
│  ├── backend/tools/          (FS, zsh, safety, vision)   │
│  ├── backend/skills-engine.mjs                           │
│  └── backend/knowledge-engine.mjs                        │
└──────────────────────────┬───────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
  Ollama (Local)     macOS CLI Tools     Cloud Providers
  qwen3.5:9b         ffmpeg, magick      OpenRouter, Groq,
  gemma4:12b         sips, osascript     Gemini, Claude, OpenAI
```

---

## What can it do?

Point LocalGravity at anything and it plans, acts, and shows its work:

- *“What's next on my timetable, and how is my Mac handling this build?”*
- *“Audit my Mac storage and tell me what's eating space, then clean only the safe caches.”*
- *“Reframe this clip to 9:16 for Shorts, compress it under 50 MB, and verify the result visually.”*
- *“Rewrite this paragraph so it sounds human, then copy the result to my clipboard.”*
- *“Teach yourself my Git release workflow as a reusable skill and remind me in 20 minutes.”*
- *“Run my 'Daily Backup' Shortcut and summarize what it changed.”*

Every turn is a live, steerable run: watch the task plan tick off step-by-step, see each tool call with diffs and output, approve or edit risky commands in **Ask** mode, and interrupt anytime.

---

## Requirements

- macOS 14 or later on Apple Silicon (`arm64`)
- Node.js 22 or later
- Xcode Command Line Tools, including `swiftc`, to build the native app
- Ollama, if you want local model inference
- `ffmpeg` and ImageMagick, if you want the optional media workflows

Install optional tools with Homebrew:

```bash
brew install ollama ffmpeg imagemagick
```

Start Ollama and download a model that fits your Mac:

```bash
ollama serve
ollama pull qwen3.5:9b
```

You can also configure a supported cloud provider in **Models & Settings**. Provider API keys are stored locally in `~/.localgravity/config.json` with owner-only file permissions.

---

## Build and install

```bash
git clone https://github.com/Thush099/LocalGravity.git
cd LocalGravity
npm run check
npm run build:app
```

The script compiles the Swift host, copies the backend and UI into the app bundle, applies ad-hoc signing, and registers the bundle with LaunchServices. It installs to `/Applications/LocalGravity.app` when that directory is writable. Otherwise, it builds `build/LocalGravity.app` inside the repository. Launch the installed app from Launchpad or Spotlight.

---

## Data access and safety

LocalGravity starts its authenticated Node.js server on the loopback interface (`127.0.0.1`). The server requires a per-launch token for API requests. Local model requests go to Ollama; when you choose a cloud provider, prompts and attached content are sent to that provider for processing.

The agent can read and modify files, run commands, and invoke macOS automation tools. Approval controls reduce accidental changes, but they do not isolate the agent from your account or replace a backup. Use **Ask** mode when reviewing a new workflow, inspect proposed commands, and only approve actions you trust. Choose cloud providers only when their handling of your data meets your needs.

## Checks and CI

Run the full local check suite (tests plus JavaScript and shell syntax):

```bash
npm run check
```

GitHub Actions runs the same checks on every push and pull request through [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

Unit and integration tests cover atomic JSON state & concurrency, `SKILL.md` & Knowledge Base traversal safety, starter-skill upgrade tracking, local skill-library discovery and import, shell-chaining bypass detection, `inspect_media` frame/image extraction, SSE/NDJSON provider normalization, transient provider retry, ReAct loop tool execution & compaction, and authenticated HTTP APIs.

---

## Clean Uninstall

Everything created at runtime lives strictly inside `/Applications/LocalGravity.app`, `~/.localgravity/`, and `~/Library/LaunchAgents/com.localgravity.*.plist`.

Run the included uninstaller to stop the app, unload any scheduled LaunchAgents, and remove app data cleanly:

```bash
bash scripts/uninstall.sh
```

Pass `--purge-models` (or answer `y` at the prompt) to also remove `qwen3.5:9b`, `ollama`, and `imagemagick`.

---

## Contributing

Issues and pull requests are welcome. Run `npm run check` before opening a PR, and keep each change focused on a clear user-visible improvement.

---

## License

[MIT](LICENSE)
