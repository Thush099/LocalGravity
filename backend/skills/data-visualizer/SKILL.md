---
name: data-visualizer
description: Profile CSV/JSON data, compute honest statistics, and produce clear charts or SVG visuals with accessible colors and labels.
triggers: ["chart", "graph", "plot", "visualize", "csv", "spreadsheet", "statistics", "histogram", "dashboard"]
---

# Data Visualizer

Use this skill when the user wants to understand a dataset or communicate numbers visually.

## Workflow

1. **Inspect before plotting**: row count, column types, missing values, duplicates, units, and date ranges.
2. **Ask what decision the chart supports.** Choose the chart type from the question, not from preference.
3. **Compute summary statistics** and sanity-check totals against the raw file.
4. **Render to a real file** (`.svg` or `.png`) and verify it exists and is non-empty.
5. **State the takeaway in one sentence** and note data limitations.

## Profiling recipes

```zsh
wc -l data.csv
head -5 data.csv
python3 - <<'PY'
import csv, statistics
with open('data.csv', newline='') as f:
    rows = list(csv.DictReader(f))
print('rows', len(rows), 'cols', list(rows[0].keys()) if rows else [])
for key in (rows[0] if rows else {}):
    vals = [r[key] for r in rows if r[key] != '']
    print(key, 'non-empty', len(vals), 'unique', len(set(vals)))
PY
```

## Chart selection

- Change over time → line chart with a shared time axis.
- Comparison across categories → horizontal bar chart sorted by value.
- Distribution → histogram or box plot; show the sample size.
- Relationship → scatter plot; add a trend line only when justified.
- Composition → stacked bar; avoid pie charts with more than four slices.
- Geography → map only when location is the point.

## Design rules

- Start bar axes at zero; do not truncate to exaggerate differences.
- Label units on the axis, not in every tick.
- Use a colorblind-safe palette (Okabe-Ito or viridis) and redundant encoding (labels or patterns).
- Direct-label lines instead of relying on a legend when possible.
- Annotate the key event or outlier instead of adding decoration.
- Keep gridlines light; remove chartjunk and 3D effects.

## Python rendering

```python
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import pandas as pd

df = pd.read_csv('data.csv')
fig, ax = plt.subplots(figsize=(8, 4.5), dpi=160)
df.groupby('month')['revenue'].sum().plot(kind='bar', ax=ax, color='#2a6f97')
ax.set_ylabel('Revenue (USD)')
ax.set_xlabel('')
ax.spines[['top', 'right']].set_visible(False)
fig.tight_layout()
fig.savefig('revenue-by-month.png')
```

If matplotlib is unavailable, write a hand-authored SVG with explicit viewBox, labels, and values.

## Guardrails

- Never fabricate missing data or silently drop rows; report exclusions.
- Do not imply causation from an observational chart.
- Show uncertainty (confidence bands, error bars, or n) when making comparisons.
- Do not use dual y-axes to imply a relationship.
- Keep raw data untouched; write outputs to a new file.
