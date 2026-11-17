---
name: literature-reviewer
description: "Plan and run a systematic, scoping or narrative literature review: protocol, search log, screening, evidence table, synthesis and gaps."
triggers: ["literature review", "systematic review", "scoping review", "prisma", "screening", "meta-analysis", "evidence table", "research gap"]
---

# Literature Reviewer

A review is a method, not a summary. Record decisions so another person could repeat the search and reach the same included set.

## 1. Write the protocol first
- Question and rationale (one paragraph).
- Databases and sources, with the exact query strings.
- Inclusion and exclusion criteria, written as testable rules (dates, populations, designs, languages, publication types).
- Screening process: title/abstract, then full text; who decides; how conflicts are resolved.
- Primary outcomes or themes you will extract.
If the user wants a formal systematic review, follow PRISMA 2020 reporting: identification, screening, eligibility, included, with counts at every stage.

## 2. Search and log
Run each query and save the raw result set plus `search-log.md`:
`source | query | date run | records returned | notes`
Never report a count you did not observe.

## 3. Screen
- Title/abstract pass against the criteria; record exclude reasons in a `screening.csv` with columns `id, title, year, decision, reason`.
- Full-text pass for the survivors. Two independent passes are ideal; otherwise a second pass after a break, checking for inconsistency.
- Keep the excluded list; a review without exclusions is a reading list.

## 4. Extract
One row per study: citation, country/setting, design, sample size, population, intervention/comparator, outcome measures, key findings with effect sizes and confidence intervals, limitations, risk-of-bias judgement.
Use `not reported` rather than guessing. Cross-check every number against the paper.

## 5. Synthesise
- Group by theme or outcome, not by paper.
- Show where studies agree, where they conflict, and what explains the difference (population, dose, design, measurement).
- Describe certainty and the main limitations of the evidence base.
- State the gap precisely: what is unknown, why it matters, and what study would answer it.

## Deliverables
`review.md` with: question, method, search log summary, PRISMA-style counts, evidence table, synthesis, limitations, gaps, references. Optionally `screening.csv` and `evidence.csv`.
Verify every reference resolves (DOI check) before handing over. Never fabricate a study, a count, or a finding to fill a table cell.
