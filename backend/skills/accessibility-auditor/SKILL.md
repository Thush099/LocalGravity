---
name: accessibility-auditor
description: Audit web and app interfaces against WCAG 2.2 AA with concrete code-level fixes for semantics, keyboard, contrast, and motion.
triggers: ["accessibility", "a11y", "wcag", "screen reader", "keyboard", "contrast", "aria", "alt text", "focus"]
---

# Accessibility Auditor

Use this skill when reviewing or building UI that people must be able to use with a keyboard, screen reader, or low vision.

## Audit workflow

1. **Scope** the page or component and the target level (default WCAG 2.2 AA).
2. **Automated pass**: run axe-core or Lighthouse if available; treat results as leads, not proof.
3. **Manual pass**: keyboard only, then screen reader, then zoom to 200% and 400%.
4. **Report** findings as `file:line — issue — user impact — fix`, ordered by severity.
5. **Fix** the smallest correct thing; re-test the same path.

## Manual checks

- Tab through the page: every interactive control is reachable, has a visible focus ring, and follows a logical order.
- No keyboard trap; `Escape` closes dialogs and focus returns to the trigger.
- Buttons are `<button>`, links are `<a href>`, and clickable `div`s are removed or given full semantics.
- Headings are hierarchical (`h1` once, no skipped levels) and describe the content.
- Images have meaningful `alt`, decorative images use `alt=""`, and icons inside buttons have an accessible name.
- Form inputs have a real `<label>`; errors are announced and tied with `aria-describedby`.
- Color is never the only signal; links are distinguishable without color.
- Text contrast is at least 4.5:1 (3:1 for large text and UI boundaries).
- Focused elements are not hidden behind sticky headers or overlays.
- `prefers-reduced-motion` is respected for large or looping animation.
- Zoom to 200% does not clip content or require horizontal scrolling for text.
- Video has captions; audio has a transcript.

## Code patterns

```html
<!-- Icon-only button -->
<button type="button" aria-label="Close dialog" aria-keyshortcuts="Escape">
  <svg aria-hidden="true" focusable="false">...</svg>
</button>

<!-- Error message -->
<label for="email">Email</label>
<input id="email" name="email" type="email" aria-invalid="true" aria-describedby="email-error" />
<p id="email-error" role="alert">Enter a valid email address.</p>

<!-- Skip link -->
<a class="skip-link" href="#main">Skip to content</a>
```

```css
:focus-visible { outline: 3px solid #0b6e99; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
```

## Screen reader smoke test

On macOS: enable VoiceOver with `Cmd + F5`, navigate with `Ctrl + Option + arrow keys`, and confirm name, role, state, and value for each control. Rotor (`Ctrl + Option + U`) should list meaningful headings, links, and form controls.

## Severity guide

- **Blocker**: task impossible with a keyboard or screen reader.
- **High**: important control unlabeled, contrast failure on body text, focus lost after an action.
- **Medium**: confusing order, missing landmark, zoom clipping.
- **Low**: cosmetic inconsistency with no access impact.

## Guardrails

- Do not claim a page is accessible from an automated score alone.
- Do not add ARIA when native HTML already provides the semantics.
- Do not remove focus outlines without replacing them.
- Do not use `aria-hidden` on focusable content.
- Report what was not tested (real screen reader versions, mobile, specific browsers).
