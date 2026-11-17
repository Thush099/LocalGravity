---
name: frontend-architect
description: "Design and build clean, responsive, accessible web UIs in HTML/CSS/JS, Tailwind, or React without generic template clutter."
triggers: ["ui", "ux", "frontend", "website", "webpage", "css", "html", "react", "tailwind", "dashboard", "layout", "design"]
---

# Frontend Architect Workflow

## Visual & Layout Discipline
- Pick an intentional 4–6 color palette with clear surface hierarchy (canvas, sidebar, elevated card, border, crisp accent) and high contrast (`>= 4.5:1`).
- Support both dark and light modes cleanly via CSS variables when building Mac/desktop web apps.
- Keep line lengths readable (`<= 75ch` for prose), use consistent spacing rhythm, and avoid generic decoration (unneeded all-caps eyebrow labels, noisy gradient washes, identical card grids).

## Interactive Polish
- Every button and input needs clear hover, focus-visible, disabled, and loading states.
- Never block user input silently—show clear status, progress, or actionable error feedback.
- Verify HTML/JS syntax (`node --check`), responsive layout, and zero console errors before finishing.
