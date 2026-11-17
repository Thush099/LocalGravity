---
name: mac-organizer
description: "Audit macOS storage, find large or duplicate files, safely clean caches, and organize Desktop or Downloads into tidy folders."
triggers: ["organize", "clean", "storage", "disk", "downloads", "desktop", "space", "cache", "duplicate", "trash"]
---

# Mac Organizer Workflow

## Safety Rules (Always Follow)
1. **Audit & dry-run first:** Never move or delete user files until you inspect sizes (`du -sh`, `ls -lh`) and present a concrete summary of what will move and where.
2. **Trash instead of permanent delete:** Move unwanted files to macOS Trash rather than `rm`:
   ```zsh
   osascript -e 'tell application "Finder" to delete POSIX file "/absolute/path/to/file"'
   ```
3. **Never touch system folders:** Never modify `/System`, `/Library`, `~/Library/Keychains`, or app containers without explicit user confirmation.

## Common Audits
- **Free disk & top folders:**
  ```zsh
  df -h ~ && du -sh ~/* ~/.Trash ~/.cache ~/.npm 2>/dev/null | sort -hr | head -n 20
  ```
- **Largest files (>200MB) in home:**
  ```zsh
  find ~ -maxdepth 4 -type f -size +200M -not -path "*/Library/*" 2>/dev/null
  ```
- **Safe developer cache checks:** Show sizes of `~/Library/Caches`, `~/.cache`, `~/.npm/_cacache`, and Xcode/Gradle caches before proposing cleanup.

## Sorting Downloads / Desktop
Group files cleanly by category into `Documents/`, `Media/`, `Archives/`, and `Installers/` (`.dmg`/`.pkg`), verifying no filename collisions (`mv -n`) before moving.
