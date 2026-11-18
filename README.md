# LocalGravity

[![CI](https://github.com/Thush099/LocalGravity/actions/workflows/ci.yml/badge.svg)](https://github.com/Thush099/LocalGravity/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![macOS 14+](https://img.shields.io/badge/macOS-14%2B-black?logo=apple&logoColor=white)](#requirements-macos-apple-silicon)

**A lightweight, native macOS Launchpad AI agent desktop app** powered by local [Ollama](https://ollama.com) models on Apple Silicon (`qwen3.5:9b`, `gemma4:12b`) and optional Cloud Boost providers (OpenRouter, Groq, Google Gemini, Anthropic Claude, OpenAI / ChatGPT)—with autonomous tools, vision inspection, self-teaching `SKILL.md` skills, a persistent Knowledge Base, and scheduled `launchd` automations.

Built to run fast inside **16 GB Unified Memory** (~**1.1 MB** installed Swift `WKWebView` bundle vs. 600+ MB Electron apps) so you can run daily Mac organization, photo/video editing, writing rewrites, and automation tasks offline or with free endpoints while reserving cloud quotas for heavy work.

---

## Key Features

- **Native macOS Launchpad App (`/Applications/LocalGravity.app`):** Compiled `arm64` Swift `WKWebView` host that manages an isolated, token-authenticated Node.js v26 agent server on `127.0.0.1` and shuts it down cleanly on quit.
- **Hybrid Model Switcher:**
  - **Local Ollama (Recommended: `qwen3.5:9b`; optional `qwen3.5:4b` fast preset):** Native vision, native tool calling, toggleable **Deep Think** mode, and M4-tuned context budgets (`8K` / `16K` / `32K` with automatic context compaction at 70% capacity).
  - **Multi-Provider Support:** Connect **OpenRouter (`:free` & Pro)**, **Groq**, **Google Gemini**, **Anthropic Claude**, **OpenAI / ChatGPT**, or any **Custom OpenAI-Compatible Endpoint**. Keys stay strictly local in `~/.localgravity/config.json` (`0600`).
- **Antigravity-Style Tool Loop & Safety Gate:**
  - Built-in tools: `list_dir`, `read_file`, `write_file`, `edit_file`, `search_files`, `run_command`, `inspect_media`, `fetch_url`, `list_skills`/`read_skill`/`save_skill` (with `extra_files` scripts), and `list_knowledge`/`search_knowledge`/`read_knowledge`/`save_knowledge`.
  - **Visual Media Inspection (`inspect_media`):** Extracts video keyframes via `ffmpeg` or scales photos via `sips` and passes them directly to the vision model so the agent can visually verify edits before and after running commands.
  - **Safety Policies:** Interactive **Ask** mode pauses mutating commands and external file edits with an editable command preview and **Approve / Deny** controls. Catastrophic commands (`rm -rf /`, `rm -rf ~`, disk erasure, fork bombs) are permanently blocked even in **Auto** mode.
- **Self-Teaching Skills & Knowledge Base:**
  - Uses modular `SKILL.md` skills (`~/.localgravity/skills/`) with lightweight index loading so local models stay fast and sharp.
  - Includes **28 Starter Skills** across engineering, macOS automation, media production, research, writing, data, DevOps, accessibility, and study coaching: `coding-engineer`, `systematic-debugger`, `test-driven-developer`, `project-planner`, `frontend-architect`, `api-designer`, `security-reviewer`, `devops-engineer`, `macos-automator`, `mac-organizer`, `image-batch-processor`, `video-producer`, `photo-editor`, `video-editor`, `data-analyst`, `data-visualizer`, `presentation-builder`, `technical-writer`, `humanizer`, `academic-researcher`, `literature-reviewer`, `citation-manager`, `research-assistant`, `study-coach`, `accessibility-auditor`, `skill-scout`, `self-upgrade`, and `skill-creator`.
  - **Skill Library browser:** scan the skills already installed on this Mac (`~/.agents/skills`, `~/.claude/skills`, and `~/.gemini/config/skills`), see which are already installed, and copy selected workflows into LocalGravity in one click.
  - One-click **Teach as skill**, **Import from GitHub** (paste any raw `SKILL.md` or `github.com/.../blob/...` link, with a **Refresh** button that re-downloads from the stored source URL), persistent **`MEMORY.md`**, and `.md`/`.txt`/`.json`/`.csv` Knowledge Document uploads (`~/.localgravity/knowledge/`).
  - **Hash-tracked starter upgrades:** untouched starter skills receive improved instructions when the app updates, while user edits and deletions are preserved.
  - **Turn-aware skill hints:** each message is scored against skill triggers, and the two best matches are surfaced in the system prompt so small local models load the right playbook.
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

## Requirements (macOS Apple Silicon)

- **macOS 14+** (Apple Silicon `arm64`, tested on M4 16 GB)
- **Xcode Command Line Tools** (`swiftc`)
- **Node.js >= 22** (tested on `v26.13.1`)
- **Homebrew packages:**
  ```bash
  brew install ollama ffmpeg imagemagick
  ```
- **Recommended local model:**
  ```bash
  ollama serve
  ollama pull qwen3.5:9b
  ```

---

## Build & Install to Launchpad

```bash
git clone https://github.com/Thush099/LocalGravity.git
cd LocalGravity
npm run check
npm run build:app
```

This builds **`/Applications/LocalGravity.app`**, signs it ad-hoc, and registers it with macOS LaunchServices so you can launch **LocalGravity** immediately from **Launchpad** or **Spotlight** (`Cmd + Space`).

---

## Checks & CI

Run the full local check suite (tests plus JavaScript and shell syntax):

```bash
npm run check
```

GitHub Actions runs the same checks on every push and pull request via [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

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
