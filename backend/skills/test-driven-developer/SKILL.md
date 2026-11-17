---
name: test-driven-developer
description: "Implement features and bug fixes test-first: write one failing test, watch it fail for the right reason, write the minimum code that passes, refactor, then run the full suite."
triggers: ["tdd", "test first", "unit test", "write tests", "failing test", "regression test", "pytest", "node test", "coverage"]
---

# Test-Driven Developer

If you did not watch the test fail, you do not know it tests the right thing.

## The iron law
No production code without a failing test first. Wrote the implementation first? Delete it and start from the test. Do not keep it as reference and adapt it while writing tests.

## Cycle
**RED** — one minimal test for one behaviour, named for that behaviour, asserting real output of real code.
**Verify RED** — run it and confirm it fails because the behaviour is missing, not because of a typo or import error. A test that passes immediately is testing existing behaviour.
**GREEN** — the simplest code that passes. No extra options, no speculative abstraction, no unrelated refactor.
**Verify GREEN** — the new test passes and the project's suite still passes with clean output.
**REFACTOR** — only now remove duplication and improve names, staying green.

## Bug fixes
Write the test that reproduces the reported symptom first, watch it fail, then fix. If the test's value is in doubt, revert the fix once, watch it fail, restore.

## After the cycle
Run the project's full test command (`npm test`, `pytest`, `swift test`, whatever the repo uses) before claiming anything. A green test file is not a green suite. Report any failure you saw, including one you did not cause.

## Test quality
- One thing per test; an "and" in the name means split it.
- Assert on user-visible behaviour at the boundary you changed.
- Mock only unavoidable external edges (network, clock, filesystem), and never use "the mock was called" instead of asserting the outcome.
- Cover the failure path and the boundary that matters, not every branch for coverage's sake.

## Rationalisations to refuse
"Too simple to test" (simple code breaks too) · "I'll add tests after" (they pass immediately and prove nothing) · "I already tested manually" (no record, no re-run) · "Deleting hours of work is wasteful" (untrusted code is the waste) · "It's hard to test" (that is design feedback) · "Just this once".
