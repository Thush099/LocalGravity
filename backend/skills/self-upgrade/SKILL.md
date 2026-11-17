---
name: self-upgrade
description: "Expand LocalGravity's own skills, helper scripts, knowledge base, and Mac CLI tools whenever asked to learn, install, or improve capabilities."
triggers: ["install skill", "self install", "upgrade", "teach yourself", "add skills", "coding skills", "learn how", "program yourself", "capabilities"]
---

# Self-Upgrade & Skill Installation Workflow

You CAN install new skills, write executable helper scripts, save persistent knowledge, and install CLI tools directly on this Mac. When the user asks you to upgrade yourself, add coding/domain skills, or program yourself to handle a new workflow:

## 1. Install New Skills Immediately (`save_skill`)
- Use `save_skill` to create well-structured `SKILL.md` modules inside `~/.localgravity/skills/<slug>/` for the requested capabilities (e.g., `python-data-science`, `react-nextjs`, `git-workflow`, `api-testing`, `ffmpeg-reels`).
- Use `extra_files` inside `save_skill` to write reusable Python, Node, or `zsh` helper scripts (e.g., `scripts/helper.py`) right inside the skill directory so future tasks run faster and deterministically.

## 2. Import External or Community Skills
- You can read compatible `SKILL.md` directories from `~/.gemini/config/skills/` or fetch open-source `SKILL.md` / documentation specs via `fetch_url(url)` and persist tailored versions via `save_skill`.

## 3. Persist Standards & Architecture Knowledge (`save_knowledge`)
- Save reference notes, preferred libraries, coding style guides, or Mac environment details using `save_knowledge` (or update `MEMORY`).

## 4. Install Missing Local CLI Tools (`run_command`)
- When a task needs real system tools (e.g., `brew install ripgrep yt-dlp`, `pip3 install pillow rembg`), propose and run the installation via `run_command` cleanly (Ask mode lets the user approve with one click).

## 5. Self-Reprogramming LocalGravity's Own Codebase
When the user asks you to upgrade, reprogram, or add new features/tools/UI directly into LocalGravity itself:
1. Inspect your source repository path shown in your system prompt (`repoPath`). Key modules:
   - `backend/tools/registry.mjs` & `backend/tools/safety.mjs` (new agent tools & safety rules)
   - `backend/agent/prompt.mjs` & `backend/agent/loop.mjs` (agent reasoning & loop)
   - `backend/providers/` (Ollama, OpenAI-compat, Anthropic adapters)
   - `backend/server.mjs` (HTTP/SSE API routes)
   - `ui/index.html`, `ui/styles.css`, `ui/app.js` (desktop interface)
   - `native/LocalGravityHost.swift` (macOS Swift `WKWebView` wrapper)
2. Read the target files first (`read_file`/`search_files`), write/update tests in `test/*.test.mjs`, and make clean modular edits.
3. Run `npm test` inside the repo directory via `run_command` and verify **all tests pass** before finishing.
4. Rebuild the Launchpad app bundle via `npm run build:app` (`bash scripts/build-app.sh`) so `/Applications/LocalGravity.app` picks up your changes, and remind the user to relaunch `LocalGravity.app`.
5. Never edit `/Applications/LocalGravity.app/Contents/Resources/` directly—always edit the source repo and run `npm run build:app`.

## 6. Never Say "I Can't Learn, Self-Install, or Upgrade Myself"
- Always take concrete action with `save_skill`, `save_knowledge`, `fetch_url`, `run_command`, or source repo edits + `npm test && npm run build:app`, and report exact files changed and test results.
