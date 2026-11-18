---
name: presentation-builder
description: Turn notes or research into a clean slide deck with a strong narrative, readable slides, and a shareable PDF.
triggers: ["slides", "presentation", "deck", "pitch", "keynote", "powerpoint", "talk", "pdf slides"]
---

# Presentation Builder

Use this skill when the user needs slides for a talk, pitch, class, or report.

## Narrative first

1. Write the one-sentence takeaway the audience should remember.
2. Choose 3-5 supporting points; each becomes a section.
3. For each slide write the headline as a full claim, not a topic label ("Churn fell after onboarding changed" beats "Churn").
4. Add evidence per slide: one chart, one quote, or one number.
5. Close with the decision or next action you want.

## Slide rules

- 16:9, one idea per slide, headline under ~12 words.
- Body text: at most 5 bullets, at most 12 words each. Prefer a visual.
- Minimum 24 pt body text and 32 pt headlines.
- High contrast; never place text on a busy photo without a scrim.
- Consistent margins and one accent color.
- Slide numbers and a short footer for sources.

## Build as HTML

Create a single self-contained `deck.html` with one `<section>` per slide and print CSS:

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Deck</title>
<style>
  @page { size: 1280px 720px; margin: 0; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  section { width: 1280px; height: 720px; box-sizing: border-box; padding: 72px;
            page-break-after: always; display: flex; flex-direction: column; justify-content: center; }
  h1 { font-size: 56px; margin: 0 0 24px; letter-spacing: -0.02em; }
  p, li { font-size: 30px; line-height: 1.45; color: #24313d; }
  .accent { color: #0b6e99; }
</style></head>
<body>
  <section><h1>...</h1><p>...</p></section>
</body></html>
```

Export to PDF with headless Chrome when installed:

```zsh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf=deck.pdf "file://$PWD/deck.html"
```

Verify the PDF page count with `mdls -name kMDItemNumberOfPages deck.pdf`.

## Speaker notes

Keep a `notes.md` with one block per slide: the claim, the evidence, the transition, and the likely question. Do not put speaker notes on the slide itself.

## Optional Keynote path

Only when the user asks for Keynote: generate an outline first, then use AppleScript to create slides. Keynote scripting is brittle across versions; verify the result by opening the document and reporting what was created.

## Guardrails

- Do not invent statistics, quotes, logos, or customer names.
- Cite data sources in the footer of the slide that uses them.
- Do not exceed the requested slide count; cut content rather than shrink type.
- Check the deck in the exported PDF, not only in the HTML preview.
- Keep brand colors and fonts if the user provides them; otherwise use a restrained neutral palette.
