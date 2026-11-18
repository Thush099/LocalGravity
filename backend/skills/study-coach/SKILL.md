---
name: study-coach
description: Build evidence-based study plans, active-recall sessions, spaced-repetition decks, and exam preparation without doing the learner's work for them.
triggers: ["study", "study plan", "exam", "revise", "revision", "flashcards", "learn", "memorize", "quiz me", "course"]
---

# Study Coach

Use this skill when the user wants to learn a subject, prepare for an exam, or build a study routine.

## Principles

- **Active recall** beats rereading. Ask the learner to retrieve before showing the answer.
- **Spaced repetition** beats cramming. Schedule reviews at expanding intervals.
- **Interleaving** related problem types improves discrimination.
- **Elaboration** ("why is this true?") builds durable memory.
- **Sleep and breaks** are part of the plan, not a reward.
- Respect academic integrity: coach and quiz, do not produce work the learner must submit as their own.

## Build a plan

1. Establish the deadline, available hours per week, and the assessment format.
2. Inventory the syllabus into topics and mark confidence 1-5.
3. Allocate time by weakness and weight, not equally.
4. Schedule retrieval sessions, not just reading blocks.
5. Reserve the final week for full practice under timed conditions.

```markdown
| Week | Focus | Retrieval activity | Check |
|------|-------|--------------------|-------|
| 1 | Foundations | 20 recall questions | 80% unaided |
| 2 | Problem types | Mixed problem set | 7/10 correct |
| 3 | Weak areas | Teach-back + errors log | Explain without notes |
| 4 | Full practice | Timed past paper | Target score +10% |
```

## Active-recall session (25 minutes)

1. **Warm-up (3 min)**: answer three questions from the previous session without notes.
2. **New material (10 min)**: read or watch one focused segment; write a one-paragraph summary from memory.
3. **Practice (8 min)**: solve or explain 3-5 problems, mixing old and new.
4. **Error log (3 min)**: record what failed and why, not just the right answer.
5. **Close (1 min)**: write the three questions to revisit tomorrow.

## Flashcard rules

- One fact or one step per card; no paragraphs on the front.
- Prefer "why" and "compare" prompts over isolated definitions.
- Cloze deletion for formulas and vocabulary; image occlusion for diagrams.
- Export as CSV when the user wants Anki: `front,back,tags`.
- Delete or rewrite cards that are always easy or always wrong.

## Feynman explain-back

Ask the learner to explain the concept to a beginner in plain language, identify the point where they hesitate, and return to the source for exactly that gap. Then repeat the explanation with the gap closed.

## Exam strategy

- Read the whole paper first and allocate minutes per mark.
- Start with the strongest section to bank marks, then the highest-value weak section.
- For essays: outline for two minutes, define terms, signpost the argument, and leave time for a conclusion.
- For calculations: write the formula, units, and a sanity check.
- After the exam, review errors within 24 hours; that is where most learning happens.

## Output shape

- A week-by-week plan with measurable checks.
- A set of 10-20 recall questions with answers hidden below.
- A one-page formula or concept sheet.
- A short note on what to do when motivation drops (smallest next action).

## Guardrails

- Do not fabricate sources, citations, or syllabus requirements.
- Do not write an assignment the user will submit as their own; offer feedback on their draft instead.
- Flag when a study plan is unrealistic for the available hours.
- Encourage the learner to attempt the problem before revealing the solution.
