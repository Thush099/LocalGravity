# LocalGravity

**A lightweight, native macOS Launchpad AI agent desktop app** powered by local [Ollama](https://ollama.com) models on Apple Silicon (`qwen3.5:9b`, `gemma4:12b`) and optional Cloud Boost providers (OpenRouter, Groq, Google Gemini, Anthropic Claude, OpenAI / ChatGPT)—with autonomous tools, vision inspection, self-teaching `SKILL.md` skills, a persistent Knowledge Base, and scheduled `launchd` automations.

Built to run fast inside **16 GB Unified Memory** (~**848 KB** native Swift `WKWebView` bundle vs. 600+ MB Electron apps) so you can run daily Mac organization, photo/video editing, writing rewrites, and automation tasks offline or with free endpoints while reserving cloud quotas for heavy work.

---

## Key Features

- **Native macOS Launchpad App (`/Applications/LocalGravity.app`):** Compiled `arm64` Swift `WKWebView` host that manages an isolated, token-authenticated Node.js v26 agent server on `127.0.0.1` and shuts it down cleanly on quit.
- **Hybrid Model Switcher:**
  - **Local Ollama (Default: `qwen3.5:9b`):** Native vision, native tool calling, toggleable thinking mode, and M4-tuned context budgets (`8K` / `16K` / `32K` with automatic context compaction at 70% capacity).
  - **Multi-Provider Support:** Connect **OpenRouter (`:free` & Pro)**, **Groq**, **Google Gemini**, **Anthropic Claude**, **OpenAI / ChatGPT**, or any **Custom OpenAI-Compatible Endpoint**. Keys stay strictly local in `~/.localgravity/config.json` (`0600`).
- **Antigravity-Style Tool Loop & Safety Gate:**
  - Built-in tools: `list_dir`, `read_file`, `write_file`, `edit_file`, `search_files`, `run_command`, `inspect_media`, `list_skills`/`read_skill`/`save_skill`, and `list_knowledge`/`search_knowledge`/`read_knowledge`/`save_knowledge`.
  - **Visual Media Inspection (`inspect_media`):** Extracts video keyframes via `ffmpeg` or scales photos via `sips` and passes them directly to the vision model so the agent can visually verify edits before and after running commands.
  - **Safety Policies:** Interactive **Ask** mode pauses mutating commands and external file edits with an editable command preview and **Approve / Deny** controls. Catastrophic commands (`rm -rf /`, `rm -rf ~`, disk erasure, fork bombs) are permanently blocked even in **Auto** mode.
- **Self-Teaching Skills & Knowledge Base:**
  - Uses modular `SKILL.md` skills (`~/.localgravity/skills/`) with lightweight index loading so small local models stay sharp.
  - Includes **5 Starter Skills**: `mac-organizer`, `video-editor`, `photo-editor`, `humanizer`, and `skill-creator`.
  - One-click **Teach as skill**, **Import from Antigravity** (`~/.gemini/config/skills`), persistent **`MEMORY.md`**, and `.md`/`.txt`/`.json`/`.csv` Knowledge Document uploads (`~/.localgravity/knowledge/`).
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
npm test
npm run build:app
```

This builds **`/Applications/LocalGravity.app`**, signs it ad-hoc, and registers it with macOS LaunchServices so you can launch **LocalGravity** immediately from **Launchpad** or **Spotlight** (`Cmd + Space`).

---

## Running Tests

```bash
npm test
```

Unit and integration tests cover atomic JSON state & concurrency, `SKILL.md` & Knowledge Base traversal safety, shell-chaining bypass detection, `inspect_media` frame/image extraction, SSE/NDJSON provider normalization, ReAct loop tool execution & compaction, and authenticated HTTP APIs.

---

## Clean Uninstall

Everything created at runtime lives strictly inside `/Applications/LocalGravity.app`, `~/.localgravity/`, and `~/Library/LaunchAgents/com.localgravity.*.plist`.

Run the included uninstaller to stop the app, unload any scheduled LaunchAgents, and remove app data cleanly:

```bash
bash scripts/uninstall.sh
```

Pass `--purge-models` (or answer `y` at the prompt) to also remove `qwen3.5:9b`, `ollama`, and `imagemagick`.

---

## License

MIT
