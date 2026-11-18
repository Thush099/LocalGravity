---
name: macos-automator
description: Automate Finder, Notes, Reminders, Calendar, Mail, Safari, Shortcuts, and launchd on macOS with safe osascript and shell recipes.
triggers: ["automate", "automation", "applescript", "osascript", "shortcut", "finder", "reminders", "calendar", "notes", "launchd", "mac"]
---

# macOS Automation

Use this skill when the user wants a Mac action repeated, scheduled, or connected across apps.

## Workflow

1. Clarify the trigger (manual, schedule, folder change) and the exact apps involved.
2. Prefer the least fragile layer that works:
   - `open -a "App"` or `open <file>` for simple launches.
   - `shortcuts run "Name"` when a Shortcut already exists (`shortcuts list`).
   - `osascript` for app-specific scripting.
   - `launchd` only when the job must run on a schedule without the app open.
3. Dry-run first: print the target objects instead of mutating them.
4. Run the real action, then verify with a read-only AppleScript query.

## osascript recipes

Finder selection:

```zsh
osascript -e 'tell application "Finder" to get POSIX path of (target of front window as alias)'
```

Create a note:

```zsh
osascript <<'APPLESCRIPT'
tell application "Notes"
  tell account "iCloud"
    make new note at folder "Notes" with properties {name:"Weekly review", body:"<h1>Weekly review</h1><p>Draft</p>"}
  end tell
end tell
APPLESCRIPT
```

Add a reminder with a due date:

```zsh
osascript <<'APPLESCRIPT'
set dueDate to (current date) + 1 * days
tell application "Reminders"
  make new reminder with properties {name:"Follow up", due date:dueDate}
end tell
APPLESCRIPT
```

List today's calendar events:

```zsh
osascript <<'APPLESCRIPT'
set today to current date
set tomorrow to today + 1 * days
tell application "Calendar"
  repeat with c in calendars
    repeat with e in (every event of c whose start date is greater than or equal to today and start date is less than tomorrow)
      log (summary of e) & " — " & (start date of e as string)
    end repeat
  end repeat
end tell
APPLESCRIPT
```

Safari tabs:

```zsh
osascript -e 'tell application "Safari" to get URL of every tab of front window'
```

## Shortcuts

```zsh
shortcuts list
shortcuts run "Resize Images" -i ~/Desktop/input.png -o ~/Desktop/output.png
```

## launchd (only with explicit approval)

- Write the plist to `~/Library/LaunchAgents/com.<user>.<job>.plist`.
- Use absolute paths for the binary, script, logs, and working directory.
- Load with `launchctl bootstrap gui/$(id -u) <plist>` (or `launchctl load -w` on older macOS).
- Verify with `launchctl print gui/$(id -u)/com.<user>.<job>`.
- Always include `StandardOutPath` and `StandardErrorPath`.
- Provide an unload command (`launchctl bootout gui/$(id -u)/com.<user>.<job>`) in the final answer.

## Guardrails

- Never run AppleScript that deletes mail, events, notes, or files without showing the exact target and getting approval.
- TCC permissions (Automation, Full Disk Access, Accessibility) cannot be granted from a script; report the exact System Settings path when a command fails with `-1743`.
- Quote user data with `quoted form of` inside AppleScript to avoid injection.
- Prefer moving files to Trash (`osascript -e 'tell application "Finder" to delete ...'`) over `rm`.
- Test scripts with `osascript -e 'return ...'` first, then add mutations.
