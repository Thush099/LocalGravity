---
name: daily-planner
description: Plan the user's day and week with the timetable tools, time-block classes and focus work, set reminders, and protect deep-work windows.
triggers: ["timetable", "schedule", "agenda", "plan my day", "remind", "reminder", "calendar", "time block", "routine", "class", "meeting", "workout", "study slot"]
---

# Daily Planner

Use this skill when the user wants to plan their day, add or change timetable entries, or be reminded of something.

## Tools

- `list_schedule_items` (with `today_only: true` for "what's next") before advising.
- `add_schedule_item` to create recurring blocks. Times are 24-hour `HH:MM`; days are 0=Sunday..6=Saturday.
- `remove_schedule_item` to clear an entry the user wants gone.
- `set_reminder` for one-off reminders ("remind me in 20 minutes"), separate from the weekly timetable.
- The app already sends a macOS notification 5 minutes before each timetable block starts — don't add a manual reminder on top of it.

## Planning principles

1. Anchor the day around fixed blocks (classes, meetings) first, then protect one deep-work window.
2. Batch shallow tasks (email, messages) into one slot instead of scattering them.
3. Leave buffer between blocks; back-to-back timetables collapse by week two.
4. When the user asks to "fit in" something new, check `list_schedule_items` for conflicts and say what it collides with.

## Output format

Answer with the next event and time first ("Next: Deep work at 14:00, in 2h"), then the remaining day as a short timeline. Confirm every entry you add or remove by name and time.
