---
name: skill-creator
description: "Teach yourself and persist new reusable SKILL.md workflows and knowledge docs whenever the user shows a pattern, preference, or correction."
triggers: ["learn skill", "save skill", "remember", "teach", "workflow", "create skill", "always do", "preference"]
---

# Self-Teaching Skill & Knowledge Creator

Use this workflow whenever:
- The user explicitly asks you to learn, save, or remember a workflow, rule, or brand guide.
- You figure out a tricky multi-step Mac/ffmpeg/editing task that worked cleanly and is worth reusing.
- The user corrects your approach (*"always export to X folder"*, *"use preset Y"*).

## Skill vs. Knowledge: Where Should It Go?
- **Use `save_skill(...)`** for repeatable **procedures, CLI recipes, and step-by-step tasks** (e.g., `instagram-reel-export`, `weekly-downloads-cleanup`).
- **Use `save_knowledge(...)`** for **facts, personal preferences, brand specs, folder layouts, and reference docs** (or update `MEMORY` for cross-task user defaults).

## Writing High-Signal Skills (`save_skill`)
1. Choose a concise lowercase hyphenated slug (`my-workflow`).
2. Write a sharp one-line `description` stating **when** to trigger the skill and **what** it accomplishes, plus 4–8 `triggers` keywords.
3. Keep the body under ~150 lines so small local models load it cleanly without wasting context:
   - Exact verified commands/paths that worked.
   - Common pitfalls or edge cases you encountered.
   - Verification checks to confirm success.
4. Always verify any helper script you include actually runs cleanly before saving the skill.
