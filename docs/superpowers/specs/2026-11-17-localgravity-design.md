# LocalGravity — Local & Free-Model Mac Agent Desktop App

**Date:** 2026-11-17  
**Target Machine:** Apple MacBook Air (`Mac16,12`), Apple M4, 16 GB Unified Memory, ~25 GiB available SSD  
**Project Repo:** `/Users/thushanthmahendran/Documents/Code & Projects/Software Repositories/LocalGravity`  
**Installed App Bundle:** `/Applications/LocalGravity.app` (appears in macOS Launchpad & Spotlight)  
**Runtime Data Directory:** `~/.localgravity/`  

---

## 1. Intent & Why

Build a standalone macOS desktop application (**LocalGravity**) that behaves like an autonomous Antigravity-style agentic assistant, powered primarily by free local models on Apple Silicon and optional free cloud API endpoints—so the user can save Google/Antigravity model quotas for important work.

The user wants to launch the app daily from Launchpad to handle:
1. **Mac Organization** — inspecting storage, sorting folders, finding large/duplicate files, and executing safe cleanup commands.
2. **Photo & Video Editing** — driving `ffmpeg`, `sips`, `ImageMagick` (`magick`), visual frame inspection, programmatic motion graphics, and generating Final Cut Pro (`FCPXML`) or Pixelmator Pro automations.
3. **Humanizing & Writing** — rewriting AI-sounding text into natural, direct prose.
4. **General Tasks & Automation** — multi-step tool execution, learning/writing reusable `SKILL.md` skills on its own, and turning workflows into one-click or scheduled automations.
5. **Clean Removability** — everything lives in clearly bounded locations with a single uninstall script so the user can wipe the app, data, and models cleanly if they decide not to keep it.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- Launch cleanly from macOS Launchpad (`/Applications/LocalGravity.app`) with zero terminal setup required on daily launch.
- Run fast and reliably inside **16 GB Unified Memory** and **25 GiB free SSD**.
- Provide an Antigravity-like agentic UX: streaming responses, collapsible thinking/reasoning, real-time tool execution cards, diff/command previews, interactive approval for destructive/shell actions, and file/media drag-and-drop.
- Support native **vision/multimodal inspection** so the agent can view photos and extracted video frames before and after editing.
- Implement a **Skill Engine** (`SKILL.md` format) that loads relevant skills dynamically, teaches itself new skills from successful workflows or user corrections, and ships with starter skills (`mac-organizer`, `video-editor`, `photo-editor`, `humanizer`, `skill-creator`).
- Support a **Hybrid Model Switcher**: local Ollama (`qwen3.5:9b` as primary default, plus optional `gemma4:12b` or other user-pulled models) and optional Free Cloud Boost endpoints (OpenRouter `:free`, Groq, or custom OpenAI-compatible URLs).
- Provide a one-click / single-script uninstaller (`uninstall.sh`) plus in-app cleanup guide.

### Non-Goals
- Modifying Antigravity itself or routing into Google Antigravity quotas.
- Bundling Electron/Chromium (~500–800 MB disk, ~400–600 MB RAM overhead).
- Running 27B+ parameter models locally on 16 GB RAM (e.g., `qwen3.8:27b` at ~18 GB download requires 24–32 GB RAM and would heavily swap/stall; 27B–70B+ models are accessed via Free Cloud Boost if desired).
- Running local generative image/video diffusion models (e.g., Photoshop Generative Fill or AI video generation).
- Building full Xcode project tooling or cross-platform Windows/Linux support.

### Anti-Goals
- Never execute unconfirmed destructive filesystem commands (`rm`, moving files outside safe targets, overwriting existing files blindly) without explicit user approval (unless the user switches a session to Auto-Run mode).
- Never bloat the 9B model's system prompt with every skill body at once (load only the lightweight skill index initially, then read full `SKILL.md` on demand).
- Never leave orphaned Node/agent background processes running after quitting `LocalGravity.app`.

---

## 3. Hardware & Environment Constraints

Verified on the target Mac:
- **CPU/GPU:** Apple M4 (10 cores), `arm64-apple-macosx`
- **Memory:** 16 GB Unified Memory
- **Storage:** 228 GiB SSD, ~25 GiB currently free (must keep >=12–15 GiB free for macOS swap and video/media temp files)
- **Pre-installed tools:** `brew`, `node` (`v26.13.1`), `npm`, `python3` (`3.10.11` & `3.13`), `swift` (`6.2.3` via CommandLineTools), `ffmpeg`
- **Dependencies to install:**
  - `ollama` (local LLM inference engine)
  - `qwen3.5:9b` (~6.6–7.6 GB on disk, native multimodal vision + native tool calling + toggleable thinking)
  - `imagemagick` (`brew install imagemagick` for `magick` photo editing)

---

## 4. Approaches Considered & Selected

1. **Selected — Native Swift `WKWebView` Desktop Window + Node.js Agent Engine:**  
   Compile a minimal native arm64 macOS `.app` using `swiftc` + WebKit (`WKWebView`) that auto-manages a local Node.js (`v26`) agent backend. Saves ~400–500 MB RAM and ~500–700 MB disk compared to Electron, leaving maximum unified memory for `qwen3.5:9b`.
2. **Rejected — Electron Desktop App:**  
   Bundles Chromium (~500–800 MB disk, ~400–600 MB RAM overhead), competing directly with the 9B model for 16 GB unified memory.
3. **Rejected — Local Web Server + Browser Shortcut:**  
   Feels like a browser tab rather than a standalone Launchpad desktop app and does not cleanly tie server lifecycle to window open/close.

---

## 5. System Architecture

### 5.1 Directory & Packaging Layout

```text
/Users/thushanthmahendran/Documents/Code & Projects/Software Repositories/LocalGravity/
├── docs/superpowers/specs/          # Design specifications & plans
├── native/                          # Swift WKWebView host app source (AppDelegate, MainWindow, ProcessManager)
├── backend/                         # Node.js v26 agent backend (ESM, zero or minimal dependencies)
│   ├── server.mjs                   # HTTP + SSE server bound to 127.0.0.1:<ephemeral-port>
│   ├── cli-run.mjs                  # Headless one-shot CLI runner invoked by launchd schedules
│   ├── agent/                       # ReAct tool-calling loop, context compaction, system prompt builder
│   ├── providers/                   # Ollama adapter + OpenAI-compatible Cloud Boost adapter (OpenRouter/Groq)
│   ├── tools/                       # Built-in tool implementations & safety classifier
│   └── skills/                      # Starter skills shipped with app (copied/synced to ~/.localgravity/skills on first run)
├── ui/                              # Frontend HTML/CSS/JS SPA served by backend (dark/light macOS-native aesthetic)
├── scripts/
│   ├── build-app.sh                 # Compiles Swift host + bundles backend/ui into /Applications/LocalGravity.app
│   └── uninstall.sh                 # Cleanly removes /Applications/LocalGravity.app, ~/.localgravity/, optional Ollama/model cleanup
├── .gitignore                       # Excludes build outputs, .DS_Store, secrets, and runtime data
├── README.md                        # Architecture, M4 setup, usage, and uninstall documentation
└── package.json

/Applications/LocalGravity.app/      # Self-contained Launchpad app bundle
~/.localgravity/                     # User runtime state
├── config.json                      # Active model, provider, safety mode, optional free cloud API keys
├── sessions/                        # JSON chat & tool execution history per session
├── automations.json                 # Saved one-click workflows & optional launchd schedule metadata
└── skills/                          # Active user + agent-learned SKILL.md directories
```

### 5.2 Process Lifecycle & Security
- When `/Applications/LocalGravity.app` launches:
  1. Swift host spawns the bundled Node backend (`node server.mjs`) using a random per-launch 32-byte `AUTH_TOKEN` passed via environment variable and binds strictly to `127.0.0.1:0` (OS-assigned free port).
  2. Node prints its chosen port on stdout (`READY:<port>`); Swift loads `http://127.0.0.1:<port>/?token=<AUTH_TOKEN>` into `WKWebView` (or passes token in header/first handshake; all `/api/*` endpoints require `X-Auth-Token` verification).
  3. On startup, backend checks `http://127.0.0.1:11434/api/tags`. If Ollama is installed but not running, backend offers one-click start (`ollama serve` background daemon or launch Ollama.app) or auto-starts it cleanly.
  4. When the user quits `LocalGravity.app` (`Cmd+Q` or closing app), `applicationWillTerminate` sends `SIGTERM` (then `SIGKILL` fallback) to the Node child process and any active tool subprocesses.

### 5.3 Model Provider Layer (Hybrid Switcher)
- **Local Provider (Ollama `/api/chat`):**
  - Default model: `qwen3.5:9b` (supports native vision images, native tool calling, and toggleable `think` / reasoning mode).
  - Context window budget tuned for 16 GB RAM: default `num_ctx = 16384` (user-adjustable in Settings between `8192`, `16384`, `32768`) with automatic sliding-window/summary compaction when conversation tokens exceed ~70% of `num_ctx`.
  - Model Manager in Settings lists installed Ollama models, shows disk size, and lets user pull/delete models (e.g., `gemma4:12b`, `qwen3.5:9b`, `qwen3:4b`) right from the UI.
- **Cloud & Boost Providers (Optional User Keys):**
  - Presets for **OpenRouter** (`https://openrouter.ai/api/v1`, e.g., `:free` models), **Groq** (`https://api.groq.com/openai/v1`), **Google Gemini** (`https://generativelanguage.googleapis.com/v1beta/openai/`), **Anthropic Claude** (`https://api.anthropic.com/v1/messages` native adapter), **OpenAI / ChatGPT** (`https://api.openai.com/v1`), and **Custom OpenAI-Compatible URL**.
  - API keys stored locally in `~/.localgravity/config.json` (mode `0600`)—never auto-read from Antigravity/external apps and never sent anywhere except the active provider.
  - Users can switch models per-session or mid-conversation via a single selector pill in the UI.

### 5.4 Agent Loop & Tool System
The backend runs an iterative tool-calling loop (up to a configurable max step limit, default `25` steps per turn with stop/cancel button in UI), streaming structured events over Server-Sent Events (SSE):
- Event types: `thinking_delta`, `text_delta`, `tool_call`, `approval_required`, `tool_result`, `done`, `error`.

**Built-in Tools:**
1. `list_dir(path, recursive?, max_entries?)` — Lists files with sizes, types, and timestamps.
2. `read_file(path, start_line?, end_line?)` — Line-numbered file reads (capped per call to keep 9B context clean).
3. `write_file(path, content, overwrite?)` — Creates/overwrites files (shows preview/diff; asks approval if overwriting outside `~/.localgravity/` unless Auto-Run is on).
4. `edit_file(path, target, replacement)` — Exact targeted replacement with unified diff preview.
5. `search_files(root, query, glob?)` — Fast text/filename search across folders.
6. `run_command(command, cwd?, timeout_ms?)` — Executes `zsh` commands (`ffmpeg`, `magick`, `sips`, `osascript`, `find`, Python scripts, etc.), streaming stdout/stderr to the tool card.
7. `inspect_media(path, timestamp_sec?)` — For images: resizes/encodes image if huge and attaches it as multimodal vision input to the active vision model (`qwen3.5:9b` or vision-capable Cloud Boost model). For videos: extracts a keyframe PNG via `ffmpeg` at `timestamp_sec` (or thumbnail grid) and feeds it to the vision model so the agent can visually verify edits!
8. `list_skills()`, `read_skill(name)`, `save_skill(name, description, content, files?)` — Manages the local skill library.
9. `list_knowledge()`, `search_knowledge(query)`, `read_knowledge(name)`, `save_knowledge(name, title, content, tags?)` — Searches, reads, and updates user-provided knowledge docs & persistent `MEMORY.md` inside `~/.localgravity/knowledge/`.

**Safety & Approval Policy:**
- **Ask Before Risky Actions (Default):**
  - Read tools (`list_dir`, `read_file`, `search_files`, `inspect_media`, `list_skills`, `read_skill`) run automatically.
  - `run_command` and file writes/edits outside `~/.localgravity/skills` pause and emit `approval_required` to the UI, rendering an inline **Approve / Edit Command / Deny** card.
  - Known read-only commands (`ls`, `df`, `du`, `which`, `ffprobe`, `mdls`, `git status`) can optionally be allowlisted by user ("Always allow read commands" or "Approve for this session").
- **Auto-Run Mode:** Per-session toggle allowing autonomous multi-step execution without pausing on every command, while always blocking catastrophic patterns (`rm -rf /`, `rm -rf ~`, disk formatting) unless explicitly forced.

### 5.5 Self-Teaching Skill & Knowledge Engine
- **Skills (`~/.localgravity/skills/<slug>/SKILL.md`)** with YAML frontmatter:
  ```yaml
  ---
  name: video-editor
  description: Trim, reframe, compress, caption, and visually inspect video edits via ffmpeg and Final Cut Pro FCPXML.
  triggers: ["video", "ffmpeg", "clip", "reel", "mp4", "fcpxml", "cut"]
  ---
  ```
- **Context-Efficient Discovery:** Only `name` + `description` (~20–30 tokens per skill) are injected into the system prompt. When a task matches, the agent calls `read_skill(name)` to load full instructions/recipes on demand.
- **Knowledge Base & Persistent Memory (`~/.localgravity/knowledge/`):**
  - Users can drop, upload, or create reference knowledge documents (`.md`, `.txt`, `.json`, `.csv`, style guides, Mac notes, project docs) plus a dedicated `MEMORY.md` file of persistent user preferences and facts.
  - A compact excerpt of `MEMORY.md` + the list of knowledge titles is exposed to the agent so it proactively runs `search_knowledge` / `read_knowledge` to ground responses like a domain expert.
- **Self-Learning Loop:**
  1. **Learn from Task / User Correction:** Built-in `skill-creator` skill instructs the agent: when the user teaches a new workflow, corrects a mistake, or clicks **"Learn Skill from Chat"**, synthesize the verified steps, exact working commands, and gotchas into a new or updated `SKILL.md` (via `save_skill`) or save persistent facts/preferences via `save_knowledge`.
  2. **Import Compatible Skills:** UI button in Skills & Knowledge tab to import selected `SKILL.md` folders from `~/.gemini/config/skills/` if the user wants to reuse existing skills.

### 5.6 Starter Skills Included
1. **`mac-organizer`** — Safe Mac disk auditing, Downloads/Desktop sorting rules, finding large files/caches, using macOS Trash (`osascript` move to Trash) instead of `rm`, always doing dry-run previews first.
2. **`video-editor`** — `ffmpeg` recipes (cut/trim without re-encoding, concat, 9:16 Reels reframe, audio normalization/ducking, subtitle burn-in, compression presets, frame extraction + `inspect_media` visual verification, FCPXML rough-cut generation for Final Cut Pro).
3. **`photo-editor`** — `magick` (`ImageMagick`), `sips`, and Python/Pillow recipes (HEIC/RAW conversion, batch resize, exposure/contrast/sharpness/LUT filters, watermarking, `inspect_media` before/after comparison, AppleScript automation hooks for Pixelmator Pro).
4. **`humanizer`** — Strict anti-AI-slop writing rules (eliminating clichés like *delve, tapestry, crucial, testament, seamlessly*, varying sentence cadence, active voice, matching requested casual/direct tone).
5. **`skill-creator`** — Standard format and verification rules for the agent to teach itself new skills and update existing ones cleanly.

### 5.7 Automations & Saved Workflows
- **One-Click Automations:** Users can save any prompt + optional target folder/skill as a named button card in the **Automations** view (e.g., *"Audit Storage & Clean Safe Caches"*, *"Compress Video for WhatsApp"*, *"Humanize Clipboard"*).
- **Scheduled Tasks (Background `launchd` Runner):**
  - Users can attach a recurring schedule to an automation, stored in `~/.localgravity/automations.json` and registered as `~/Library/LaunchAgents/com.localgravity.<id>.plist`.
  - **Headless Background Execution:** Triggered schedules run `node backend/cli-run.mjs --automation <id>` silently without popping open `LocalGravity.app`. It checks/wakes Ollama if needed (shutting down its own transient `ollama serve` child on exit if it started one), records the full run into a new isolated session JSON file in `~/.localgravity/sessions/` (tagged `source: "scheduled"`), updates `automations.json` using atomic write-and-rename (`write tmp -> rename`), and sends a macOS desktop notification (`osascript display notification`) summarizing completion or errors.
  - **Per-Schedule Safety Opt-In:** Scheduled automations default to `allowAutoRun: false` (**Audit / Read-Only mode**), where `run_command` and file-modifying tools outside `~/.localgravity/skills` are rejected and the agent reports proposed changes in the session log. Users may explicitly enable **"Allow auto-run"** per schedule in the UI (with a clear confirmation warning); even when enabled, catastrophic command patterns (`rm -rf /`, `rm -rf ~`, disk formatting) remain hard-blocked.
  - All managed LaunchAgents are unloaded and removed automatically by `scripts/uninstall.sh`.

### 5.8 UI Layout & UX
Single-window macOS app styled to feel crisp, dark/light system-adaptive, and fast:
- **Left Sidebar:**
  - `+ New Task` button
  - Recent task sessions (searchable, deletable)
  - Navigation tabs: **Agent**, **Skills**, **Automations**, **Models & Settings**
- **Agent View:**
  - Header bar: Model Switcher pill (`qwen3.5:9b · Local` / Cloud Boost), Thinking toggle (`On`/`Off`), Safety Mode toggle (`Ask`/`Auto`), and **Compact Context** button.
  - Main stream: User bubbles, collapsible Thinking accordions, live Tool Execution cards (with Approve/Edit/Deny buttons and output previews), inline image/frame thumbnails, and per-reply actions (**Copy**, **Teach as Skill**, **Save Automation**).
  - Bottom composer: Multi-line prompt input, drag-and-drop file/folder/media bar (shows file chips with image previews), and Stop/Cancel button during generation.
- **Skills View:**
  - Grid/list of installed `SKILL.md` skills with inline Markdown viewer/editor, `+ New Skill` / `Teach Skill via Chat`, and `Import from Antigravity` option.
- **Automations View:**
  - Saved quick-run cards, Run button (opens live output in Agent view), and optional macOS schedule toggles.
- **Models & Settings View:**
  - Live Ollama status + local RAM/disk gauge, installed models list + pull/delete controls, Free Cloud Boost provider setup (OpenRouter/Groq/Custom), and **Clean Uninstall** section.

---

## 6. Clean Removal / Uninstall Guarantee

Running `scripts/uninstall.sh` (or clicking the copyable uninstall command in Settings):
1. Quits `LocalGravity.app` if running.
2. Unloads and deletes any `com.localgravity.*` LaunchAgents.
3. Moves `/Applications/LocalGravity.app` and `~/.localgravity/` to Trash (or deletes cleanly).
4. Optionally offers to remove `qwen3.5:9b`, `ollama`, and `imagemagick` if the user wants to reclaim all ~7–8 GB of model storage.
5. Leaves the source folder in `Software Repositories/LocalGravity` (or removes it too if chosen).

---

## 7. Engineering Calls & Builder-Resolved Details
- **Zero-bloat Node v26 backend (Our call):** Built purely on Node `v26` built-in APIs (`node:http`, `node:fs`, `node:child_process`, native `fetch`, SSE streaming) rather than pulling heavy npm frameworks—keeps total app size under ~20 MB and speeds up builds/uninstalls.
- **Concurrency-safe local state (Our call):** Each conversation writes to its own `~/.localgravity/sessions/<id>.json` file and `automations.json` / `config.json` use atomic temp-file + `rename` writes so scheduled background runs never collide with an open UI window.
- **Transient Ollama handling (Our call):** Both GUI launch and headless scheduled runs detect an already-running Ollama instance first; if a scheduled run spawns `ollama serve` itself, it tears down its transient process when done.
- **Left to implementation plan:** Exact CSS design system tokens, `AppIcon.icns` generation, native `tool_calls` vs fallback JSON tool-block normalization, and the automated test suite (`node --test`).

---

## 8. GitHub Repository Deliverable
- Initialize Git inside `/Users/thushanthmahendran/Documents/Code & Projects/Software Repositories/LocalGravity` with `.gitignore` and `README.md`.
- Strictly exclude local runtime state (`~/.localgravity/`), user API keys/secrets, build outputs, and macOS `.DS_Store` files from version control.
- Once implementation, tests, and `/Applications/LocalGravity.app` build verification pass, create and push the repository to GitHub (`Thush099/LocalGravity`) via the authenticated `gh` CLI (`private` or `public` per user preference).
