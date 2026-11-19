import { safePublicFetch } from '../net-guard.mjs';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
};

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveResultUrl(rawHref) {
  const decoded = decodeHtmlEntities(rawHref).trim();
  if (!decoded) return '';
  let candidate = decoded;
  if (decoded.startsWith('//')) candidate = `https:${decoded}`;
  else if (decoded.startsWith('/')) candidate = `https://duckduckgo.com${decoded}`;

  try {
    const parsed = new URL(candidate);
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) {
      const target = new URL(uddg);
      if (target.protocol === 'http:' || target.protocol === 'https:') return target.href;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return '';
  }
  return '';
}

export function parseDuckDuckGoHtml(html, maxResults = 6) {
  const src = String(html || '');
  const limit = Math.min(10, Math.max(1, Number(maxResults) || 6));
  const results = [];
  const anchorRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [];
  let match;
  while ((match = anchorRe.exec(src)) !== null) {
    matches.push({ href: match[1], titleHtml: match[2], endIndex: anchorRe.lastIndex });
  }

  for (let i = 0; i < matches.length && results.length < limit; i++) {
    const current = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].endIndex : Math.min(src.length, current.endIndex + 2500);
    const slice = src.slice(current.endIndex, nextStart);
    const snippetMatch = slice.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    const url = resolveResultUrl(current.href);
    const title = stripTags(current.titleHtml);
    if (!url || !title) continue;
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : '';
    results.push({ title, url, snippet });
  }
  return results;
}

/**
 * Search the public web via DuckDuckGo HTML without an API key, guarded by safePublicFetch.
 */
export async function searchWebTool({ query, max_results = 6 } = {}, { fetchFn = globalThis.fetch } = {}) {
  const q = String(query ?? '').trim();
  if (!q) {
    return { ok: false, results: [], output: 'Search query is required.' };
  }
  if (q.length > 300) {
    return { ok: false, results: [], output: 'Search query must be 300 characters or fewer.' };
  }

  const limit = Math.min(10, Math.max(1, Number(max_results) || 6));
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;

  try {
    const res = await safePublicFetch(searchUrl, {
      fetchFn,
      timeoutMs: 12000,
      headers: DEFAULT_HEADERS,
    });
    if (!res.ok) {
      return { ok: false, results: [], output: `Web search failed with HTTP ${res.status}.` };
    }
    const html = await res.text();
    const results = parseDuckDuckGoHtml(html, limit);
    if (results.length === 0) {
      return { ok: true, results: [], output: `No web results found for "${q}".` };
    }
    const formatted = results
      .map((r, idx) => `${idx + 1}. **${r.title}** — ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
      .join('\n\n');
    return {
      ok: true,
      results,
      output: formatted.slice(0, 12000),
    };
  } catch (err) {
    return { ok: false, results: [], output: `Web search failed: ${err.message}` };
  }
}
