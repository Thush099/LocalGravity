---
name: citation-manager
description: "Manage references cleanly: generate and repair BibTeX, verify DOIs and metadata, deduplicate entries, and keep the in-text citations and reference list consistent."
triggers: ["bibtex", "reference", "references", "zotero", "endnote", "doi", "bibliography", ".bib", "apa", "mla", "citation style"]
---

# Citation Manager

A reference list is data. Broken keys, duplicate entries and hallucinated DOIs are defects, not formatting quirks.

## 1. Establish the source of truth
- Find the `.bib` file, the reference manager export, or the manuscript's reference list. Read it before editing.
- Ask or detect the required style (APA 7, MLA 9, Chicago, IEEE, Vancouver) and apply it consistently.
- Keep one canonical entry per work. Do not create a second key for a preprint and its published version without saying which one is cited.

## 2. Audit the file
For every entry check:
- required fields for the type (`article`: author, title, journal, year, volume, pages, doi; `inproceedings`: booktitle, pages, publisher).
- author formatting (`Last, First and Last, First`) and no all-caps or "et al." in the field.
- braces protecting acronyms and capitals (`{BERT}`, `{DNA}`), escaped special characters, and a balanced brace count.
- duplicate keys and duplicate works (same DOI or same title+year).
- stray `file`, `abstract`, `keywords` fields bloat; keep them only if the workflow needs them.

## 3. Verify metadata
- Resolve each DOI (`curl -sI https://doi.org/<doi>` or the Crossref API `https://api.crossref.org/works/<doi>`) and compare title, authors, year, venue, volume and pages.
- If the DOI is missing, search Crossref by title and authors and add the verified DOI.
- Never invent a DOI to satisfy a style checker. Mark unverifiable entries and tell the user.

## 4. Reconcile with the manuscript
- Extract every `\cite{...}` (or author-date mention) and check each key exists; check every entry is cited at least once.
- Check the order of the reference list matches the style (alphabetical or citation order).
- Flag inconsistent author spellings and year mismatches between text and reference.

## 5. Report
Give the fixed `.bib` (or a patch), a short list of changes (added DOIs, merged duplicates, renamed keys, removed uncited entries), and the remaining unverifiable items. Never silently drop a reference the user might still need.
