---
name: coding-engineer
description: "Write, refactor, test, and review production code across JS/TS, Python, Swift, and Shell like a senior engineer."
triggers: ["code", "program", "script", "app", "function", "refactor", "build", "implement", "test", "git", "python", "javascript", "swift"]
---

# Coding Engineer Workflow

Follow strict engineering rigor on every coding task:

## 1. Read Before Writing
- Search (`search_files`) and inspect existing files (`read_file`) before modifying or creating code. Match the project's existing conventions, imports, and error-handling patterns.
- Never assume an API, library version, or file layout from memory—check `package.json`, `requirements.txt`, or the source files first.

## 2. Clean Architecture & Code Quality
- Keep functions small, cohesive, and single-purpose with shallow nesting and early returns.
- Never duplicate logic—extract a shared helper or parameterize differences.
- Validate untrusted inputs at boundaries (paths, JSON, shell args, HTTP requests). Never store or log secrets.
- Handle errors explicitly with actionable messages instead of empty `catch` blocks.

## 3. Test-First & Real Verification
- When fixing bugs or adding logic, write or update tests first (or alongside) covering both happy paths and failure edge cases.
- Always execute the real test suite, linter, or compiler (`npm test`, `pytest`, `swiftc`, `node --check`) via `run_command` **after your final edit** and report the exact observed output.
- Never claim a bug is fixed or a feature works unless you ran it and read the passing output.
