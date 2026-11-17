---
name: systematic-debugger
description: "Diagnose bugs, crashes, test failures, and performance bottlenecks from root causes before applying targeted fixes."
triggers: ["bug", "fix", "error", "crash", "fail", "debug", "broken", "hang", "slow", "traceback", "stack trace"]
---

# Systematic Debugging Workflow

Never guess at fixes or patch symptoms. Follow these four steps:

## 1. Reproduce & Capture Evidence
- Run the exact failing command or inspect logs to observe the real error message, exit code, and stack trace.
- Check environment state (`which`, versions, running processes `ps`, disk space `df -h`, permissions).

## 2. Trace Root Cause
- Read the failing file and its callers end-to-end (`read_file`).
- Form one concrete hypothesis for *why* the failure occurs (e.g., race condition, wrong path encoding, memory swap, unhandled stream error).

## 3. Minimal Targeted Fix + Regression Test
- Write a minimal test reproducing the exact failure and watch it fail.
- Fix the underlying root cause cleanly without breaking neighboring callers.

## 4. Full Verification
- Re-run the failing reproduction AND the project's full test suite to ensure zero regressions.
