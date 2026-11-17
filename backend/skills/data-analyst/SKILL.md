---
name: data-analyst
description: "Analyse CSV, JSON, spreadsheets and logs reproducibly with python3: profile the data, write a script, validate the numbers, and report what the data can and cannot support."
triggers: ["csv", "dataset", "data analysis", "pandas", "statistics", "chart", "spreadsheet", "correlation", "regression", "clean data"]
---

# Data Analyst

The deliverable is a number a reader can trust, plus the script that produced it.

## 1. Look before analysing
- Read the first rows, the column names, the row count, and the data types (`head`, `wc -l`, or `python3 -c` with pandas).
- Check encoding, delimiter, decimal separator, date format, and units.
- Count missing values per column, duplicates, impossible values (negative ages, future dates), and constant columns.
- Write a short data dictionary: column, meaning, type, unit, allowed range, source.
- State the question and the decision the analysis should inform. If the question is vague, narrow it before computing anything.

## 2. Work reproducibly
- Write a real script (`analysis.py`) rather than a chain of ad-hoc commands; keep it in the project, not in `/tmp`.
- Pin the input path, use explicit dtypes, and never edit the raw file in place.
- Log the row counts before and after every filter, join, or deduplication.
- Version intermediate outputs (`clean.csv`) and say how they were produced.

## 3. Check the analysis
- Recompute two headline numbers a second way (a pivot vs. a groupby; a manual count vs. a query).
- Look for survivorship, selection, and denominator problems; check that percentages share one base.
- For comparisons, report group sizes, the effect size, and uncertainty; do not imply causation from an observational pattern.
- Test the claim on a subset or a shuffled label where that would falsify it.

## 4. Visualise for the question
- One chart per claim, labelled axes with units, readable at the size it will be seen.
- No chart without the numbers behind it; no truncated axis that exaggerates a difference.
- Prefer a table when the reader needs exact values.

## 5. Report
- Answer first, in one paragraph, with the number and its uncertainty.
- Method: data source, rows included/excluded and why, transformation, test or model, assumptions.
- Limits: what the data cannot show, missing fields, time period, sampling bias.
- Include the exact command to reproduce the run and the actual output you saw.

Never present an estimate as a fact, never drop inconvenient rows silently, and never claim a trend from fewer points than the claim needs.
