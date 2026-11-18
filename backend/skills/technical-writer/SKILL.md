---
name: technical-writer
description: Write and revise READMEs, API docs, changelogs, runbooks, and tutorials that are accurate, scannable, and tested.
triggers: ["readme", "documentation", "docs", "changelog", "tutorial", "runbook", "api docs", "write docs"]
---

# Technical Writer

Use this skill when producing or revising documentation for code, tools, or processes.

## Workflow

1. **Identify the reader and the job.** A new contributor installing the project needs different content from an operator debugging production.
2. **Read the code first.** Verify every command, flag, path, default, and env var against the repository. Never document an API from memory.
3. **Outline before prose.** Use short sections with descriptive headings.
4. **Write the shortest version that is complete.** Prefer examples over adjectives.
5. **Run every command you document** in a clean shell or explain why you could not.
6. **Check links and paths** with `search_files` or `ls`.

## README skeleton

```markdown
# Project

One sentence: what it is and who it is for.

## Why it exists
The problem and the one differentiator.

## Quick start
Prerequisites, install, first run. Copy-pasteable.

## Features
Bullets that describe behaviour, not marketing.

## Configuration
Table of option, default, and effect.

## Troubleshooting
The three failures users actually hit.

## Development
Test, build, and release commands.

## License
```

## API documentation

For each endpoint or function document:

- Method and path / signature
- Auth requirements
- Parameters: name, type, required, default, constraints
- Response shape and status codes
- One request and one response example
- Failure modes and rate limits

## Changelog

Use `Added`, `Changed`, `Fixed`, `Removed`, `Security`. Write for users: what changed and what they must do. Link issues when available.

## Style rules

- Active voice, present tense: "The server returns 401", not "401 will be returned".
- Second person for instructions: "Run `npm test`".
- One idea per paragraph; one action per numbered step.
- Code fences with a language tag and no shell prompt characters.
- Define acronyms on first use.
- Avoid "simply", "just", "obviously", and "easy".
- Keep line lengths readable; do not hard-wrap inside code blocks.

## Guardrails

- Do not claim performance, compatibility, or security properties that were not measured or verified.
- Do not include secrets, real tokens, personal paths, or customer data in examples.
- Mark unfinished sections explicitly instead of filling them with placeholders that look real.
- If documentation and code disagree, fix the code or the docs in the same change and say which.
