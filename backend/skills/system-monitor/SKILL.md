---
name: system-monitor
description: Check this Mac's CPU, memory, GPU, storage, and top processes with system_stats, explain what is slow, find resource-heavy apps, and give capacity advice.
triggers: ["cpu", "memory usage", "ram", "gpu", "storage", "disk space", "task manager", "system monitor", "slow mac", "fans", "top processes", "how is my mac", "activity monitor"]
---

# System Monitor

Use this skill when the user asks how the Mac is doing, what is slowing it down, or why memory, storage, or the GPU is running hot.

## Workflow

1. Call `system_stats` first. Never guess load numbers.
2. Interpret before advising: say what is high, what is normal, and what it means.
3. Only when asked, dig deeper with read-only commands (`top -l 1`, `ps`, `df -h`, `du -sh`).
4. Propose fixes as a short list, cheapest first. Ask before quitting apps or deleting files.

## Reading the numbers

- **CPU %** is total busy across all cores. Sustained above 80% means something is saturating the machine.
- **Memory**: "used" includes cache that macOS reclaims on demand. Wired and compressed are the numbers that matter when the user reports swapping.
- **GPU utilization** is render load; high numbers during idle desktop use suggest a runaway window or animation.
- **Storage**: warn at 85% full on the Data volume; macOS needs headroom for caches and updates.
- **Power**: `100% charged on AC Power` is normal; a laptop suddenly discharging on AC suggests a weak adapter. Report remaining time only when the estimate is non-zero.
- Compare against the **top processes list** before blaming the system; it is usually one app.

## Output format

Give a verdict line first ("Your Mac is healthy" / "Memory is the bottleneck"), then 2-4 supporting lines with the actual numbers, then advice. No wall of metrics.
