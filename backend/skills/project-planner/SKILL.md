---
name: project-planner
description: "Turn an approved design or spec into a bite-sized, test-first implementation plan, then execute it task by task with a progress ledger and recorded rulings."
triggers: ["plan", "planning", "roadmap", "break down", "tasks", "milestones", "spec", "implementation plan", "project"]
---

# Project Planner

A plan is the set of decisions the implementer cannot make alone: files, names, signatures, values, and the test that proves each step.

## 1. Check the inputs
- You need a goal, the constraints, and what already exists. If the design is missing or ambiguous, use `read_skill("brainstorming")`-style discovery first: one question at a time, then a short design.
- Read the relevant code before planning. Never plan a file layout you have not checked.

## 2. Write the plan
Save to `docs/plans/YYYY-MM-DD-<feature>.md`, containing:
- Goal in one sentence, the approach in two or three, and the stack.
- Global constraints: versions, dependency limits, naming, platform, performance budget.
- File map: files created or modified and the single responsibility of each.
- Review focus: the five inputs or failure modes the design implies but no test covers.
- Tasks.

Each task has **Files** (exact paths), **Interfaces** (consumes/produces with names and types), and steps that each end in a checkable result:
1. Write the failing test.
2. Run it; expected: FAIL for a specific reason.
3. Implement the minimum.
4. Run it; expected: PASS.
5. Commit.

Reject vague steps ("handle edge cases", "add validation", "write tests"): they decide nothing. A plan longer than the code it describes is a transcript, not a plan.

## 3. Self-review the plan
Walk the design section by section and point to the task that implements it; add the missing tasks. Check that names and types used later match definitions earlier. Check each review-focus line has a test somewhere. Fix inline.

## 4. Execute task by task
- Read the plan and spec once; create a todo per task.
- Keep `docs/plans/<feature>-progress.md` and append per task: what shipped, the exact test command and result, and any ruling. The ledger survives context compaction.
- Work the steps in order. If output does not match, either the code is wrong (debug the cause, never edit the test to pass) or the plan is wrong (rule on it, record it, continue).
- Do not pause between tasks to ask whether to continue. Stop only for destructive or irreversible operations, security-sensitive actions, side effects outside scope (push, deploy, publish), or a plan so broken every path is a guess.
- Record deviations as `Ruling: <decision> — <why> — <cost if wrong>`.

## 5. Finish
Run the project's real full test suite, review the whole diff, and report what changed, the commands and results, the rulings you made, and what you deferred.
