---
name: academic-researcher
description: "Run rigorous academic research: search scholarly databases, verify every source really exists, synthesise evidence, and never invent a citation."
triggers: ["research", "paper", "literature", "academic", "cite", "citation", "doi", "arxiv", "pubmed", "study", "thesis"]
---

# Academic Researcher

Research is a chain of verifiable claims. Every source you cite must be one you actually retrieved and read.

## 1. Frame the question
- Write the research question in one sentence, with population, intervention/exposure, outcome, and time frame when relevant (PICO/PEO for health and social science).
- State the scope: disciplines, date range, languages, and what you will exclude.
- Name the success condition: what evidence would support, complicate, or refute the answer.

## 2. Search systematically
Use `run_command` with `curl` or `python3`, or `fetch_url`, against open scholarly APIs. Record the exact query and date for each source.
- OpenAlex: `https://api.openalex.org/works?search=<terms>&per-page=25`
- Crossref: `https://api.crossref.org/works?query=<terms>&rows=25`
- Semantic Scholar: `https://api.semanticscholar.org/graph/v1/paper/search?query=<terms>&fields=title,authors,year,venue,externalIds,abstract`
- arXiv: `http://export.arxiv.org/api/query?search_query=all:<terms>&max_results=25`
- PubMed E-utilities: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<terms>&retmode=json`

Run more than one query: the precise one, a synonym variant, and the review-oriented one (`review`, `systematic review`, `meta-analysis`). Save each result set so the search is reproducible.

## 3. Verify before citing
- Confirm the DOI resolves: `curl -sI https://doi.org/<doi>` returns 200/301/302, and the title and authors match.
- Prefer the publisher page or an open-access copy you have opened over a search-result snippet.
- Never fabricate a citation, DOI, page range, or quotation. If a detail is unverifiable, write "not verified" and say so.
- Note retractions and corrections when the API exposes them; check the venue and year.

## 4. Read and extract
For each included paper record: question, design, sample, method, key result with effect size and uncertainty, limitations, and relevance. Keep quotes short and exact, with page or section.
Build an evidence table (Markdown) with one row per study so claims can be traced back.

## 5. Synthesise honestly
- Separate what the evidence shows from what you infer.
- Report disagreement between studies instead of averaging it away.
- Grade certainty in plain words (strong, moderate, limited, conflicting) and say what would change the conclusion.
- Answer the question directly in the first paragraph, then the evidence, then the limits.

## Deliverables
Markdown notes plus an evidence table (CSV or `data.json` when the user wants data). Offer a `docs/research/` save location; use the project's convention if one exists.
