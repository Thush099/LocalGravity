const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Single pass over the string. This runs on every token of every streamed markdown
// render, so one scan beats five sequential replaceAll calls (measured ~1.4x faster).
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const KEYWORDS_RE =
  /^(?:const|let|var|function|return|async|await|import|export|from|default|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|true|false|null|undefined|def|elif|pass|with|as|in|not|and|or|None|True|False|func|struct|enum|guard|private|public|final|do|then|fi|done|esac|echo|cd|sudo)$/;

const TOKENIZER_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?<![\w$])#[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;

/**
 * Highlight fenced code safely in a single pass on raw source before escaping every fragment.
 */
export function highlightCode(rawCode, lang = '') {
  const src = String(rawCode ?? '');
  const normalizedLang = String(lang || '').toLowerCase();
  const isJson = normalizedLang === 'json' || normalizedLang === 'jsonc';
  const supportsHashComment = new Set(['py', 'python', 'sh', 'bash', 'zsh', 'shell', 'yaml', 'yml', 'toml', '']).has(
    normalizedLang
  );

  let out = '';
  let lastIdx = 0;
  TOKENIZER_RE.lastIndex = 0;
  let match;
  while ((match = TOKENIZER_RE.exec(src)) !== null) {
    if (match.index > lastIdx) {
      out += escapeHtml(src.slice(lastIdx, match.index));
    }
    const token = match[0];
    lastIdx = match.index + token.length;

    if (token.startsWith('//') || token.startsWith('/*')) {
      out += `<span class="tok-comment">${escapeHtml(token)}</span>`;
    } else if (token.startsWith('#')) {
      if (supportsHashComment) {
        out += `<span class="tok-comment">${escapeHtml(token)}</span>`;
      } else {
        out += escapeHtml(token);
      }
    } else if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) {
      const rest = src.slice(lastIdx);
      if (isJson && token.startsWith('"') && /^\s*:/.test(rest)) {
        out += `<span class="tok-key">${escapeHtml(token)}</span>`;
      } else {
        out += `<span class="tok-string">${escapeHtml(token)}</span>`;
      }
    } else if (/^\d/.test(token)) {
      out += `<span class="tok-number">${escapeHtml(token)}</span>`;
    } else if (KEYWORDS_RE.test(token)) {
      out += `<span class="tok-keyword">${escapeHtml(token)}</span>`;
    } else {
      out += escapeHtml(token);
    }
  }
  if (lastIdx < src.length) {
    out += escapeHtml(src.slice(lastIdx));
  }
  return out;
}

const MATH_SYMBOLS = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  phi: 'φ',
  omega: 'ω',
  Delta: 'Δ',
  Sigma: 'Σ',
  Omega: 'Ω',
  Pi: 'Π',
  infty: '∞',
  pm: '±',
  times: '×',
  cdot: '·',
  div: '÷',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  Rightarrow: '⇒',
  sum: '∑',
  prod: '∏',
  int: '∫',
  partial: '∂',
  nabla: '∇',
  forall: '∀',
  exists: '∃',
  in: '∈',
  notin: '∉',
};

/**
 * Render basic LaTeX math expressions cleanly and XSS-safely with zero external dependencies.
 */
export function renderMathHtml(expr, display = false) {
  let s = escapeHtml(String(expr || '').trim());
  s = s.replace(/\\text\{([^{}]+)\}/g, '<span class="math-text">$1</span>');
  s = s.replace(
    /\\frac\{([^{}]+)\}\{([^{}]+)\}/g,
    '<span class="math-frac"><span class="math-num">$1</span><span class="math-den">$2</span></span>'
  );
  s = s.replace(/\\sqrt\{([^{}]+)\}/g, '<span class="math-sqrt">&radic;<span class="math-radicand">$1</span></span>');
  s = s.replace(/\\([A-Za-z]+)\b/g, (full, cmd) => MATH_SYMBOLS[cmd] || full);
  s = s.replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>').replace(/\^([A-Za-z0-9+-]+)/g, '<sup>$1</sup>');
  s = s.replace(/_\{([^{}]+)\}/g, '<sub>$1</sub>').replace(/_([A-Za-z0-9+-]+)/g, '<sub>$1</sub>');

  return display
    ? `<div class="math-block">${s}</div>`
    : `<span class="math-inline">${s}</span>`;
}

function renderInline(text) {
  let out = escapeHtml(text);
  // Protect inline code spans, links, and valid inline LaTeX math first
  const slots = [];
  const stash = (html) => {
    const idx = slots.length;
    slots.push(html);
    return `\u0000SLOT${idx}\u0000`;
  };

  out = out.replace(/`([^`]+)`/g, (_m, code) => stash(`<code class="inline-code">${code}</code>`));

  // Inline LaTeX $...$ (excludes plain currency prices like $100 or $4.99)
  out = out.replace(
    /(^|[\s(])\$([^\s$][^$\n]*?[^\s$]|[^\s$\d])\$(?=$|[\s.,;:!?)\]])/g,
    (full, prefix, inner) => {
      if (/^\d[\d,.\s]*(?:k|m|b|to|-)?$/i.test(inner)) return full;
      const decodedInner = inner
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'");
      return `${prefix}${stash(renderMathHtml(decodedInner, false))}`;
    }
  );

  out = out.replace(
    /\[([^\]]+)\]\(((?:https?:\/\/|file:\/\/)[^\s)]+)\)/g,
    (_m, label, url) => stash(`<a href="${url}" class="md-link" target="_blank" rel="noopener noreferrer">${label}</a>`)
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Auto-link bare http(s) URLs not inside stashed markdown links
  out = out.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_m, prefix, url) => `${prefix}${stash(`<a href="${url}" class="md-link" target="_blank" rel="noopener noreferrer">${url}</a>`)}`
  );
  return out.replace(/\u0000SLOT(\d+)\u0000/g, (_m, idx) => slots[Number(idx)]);
}

function splitTableCells(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((c) => c.trim());
}

function isTableSeparatorLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.includes('|') && !trimmed.includes('-')) return false;
  const cells = splitTableCells(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function parseTableAlignments(line) {
  return splitTableCells(line).map((c) => {
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    return 'left';
  });
}

function renderCodeBlock(rawCode, codeLang) {
  const lang = String(codeLang || 'text').toLowerCase();
  const highlighted = highlightCode(rawCode, lang);
  const lineCount = String(rawCode || '').split('\n').length;
  const isPreviewable = lang === 'html' || lang === 'htm' || lang === 'svg';
  const isArtifact = isPreviewable || lineCount >= 4;
  const canvasBtn = isArtifact
    ? `<button type="button" class="open-artifact-btn" data-lang="${escapeHtml(lang)}" data-code="${escapeHtml(rawCode)}">${isPreviewable ? 'Preview in Canvas' : 'Open in Canvas'}</button>`
    : '';
  const artifactPill = isPreviewable
    ? `<button type="button" class="artifact-card-trigger open-artifact-btn" data-lang="${escapeHtml(lang)}" data-code="${escapeHtml(rawCode)}"><span><strong>${lang === 'svg' ? 'SVG Vector Graphic' : 'Interactive HTML Artifact'}</strong> · Isolated Sandbox</span><span>Open Canvas ↗</span></button>`
    : '';
  return `<div class="code-block"><div class="code-header"><span>${escapeHtml(lang)}</span><span class="code-header-actions">${canvasBtn}<button type="button" class="copy-code-btn" data-code="${escapeHtml(rawCode)}">Copy</button></span></div><pre><code>${highlighted}</code></pre>${artifactPill}</div>`;
}

function renderQuoteOrCallout(bqLines) {
  if (!bqLines || bqLines.length === 0) return '';
  const calloutMatch = bqLines[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
  if (calloutMatch) {
    const kind = calloutMatch[1].toLowerCase();
    const label = calloutMatch[1].toUpperCase();
    const bodyLines = [];
    if (calloutMatch[2]) bodyLines.push(calloutMatch[2]);
    for (let k = 1; k < bqLines.length; k++) {
      if (bqLines[k]) bodyLines.push(bqLines[k]);
    }
    const bodyHtml = bodyLines.map((l) => `<p class="md-p">${renderInline(l)}</p>`).join('');
    return `<div class="md-callout md-callout-${kind}"><div class="md-callout-title">${label}</div><div class="md-callout-body">${bodyHtml}</div></div>`;
  }
  return `<blockquote class="md-quote">${bqLines.map((l) => renderInline(l)).join('<br />')}</blockquote>`;
}

/**
 * Render Markdown safely to HTML with syntax-highlighted code blocks, artifacts, math, callouts, GFM tables, and task lists.
 */
export function renderMarkdown(markdown) {
  const src = String(markdown || '');
  if (!src.trim()) return '';

  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      html.push(listType === 'ol' ? '</ol>' : '</ul>');
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fenceMatch = line.match(/^```([a-zA-Z0-9_+-]*)\s*$/);
    if (fenceMatch) {
      closeList();
      if (!inCode) {
        inCode = true;
        codeLang = fenceMatch[1] || 'text';
        codeLines = [];
      } else {
        html.push(renderCodeBlock(codeLines.join('\n'), codeLang));
        inCode = false;
        codeLang = '';
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeList();
      continue;
    }

    // Display math blocks $$ ... $$ (single-line or multi-line)
    if (line.trim().startsWith('$$')) {
      closeList();
      const singleLine = line.trim().match(/^\$\$(.+)\$\$$/);
      if (singleLine) {
        html.push(renderMathHtml(singleLine[1], true));
        continue;
      }
      const mathLines = [];
      const firstRest = line.trim().slice(2).trim();
      if (firstRest) mathLines.push(firstRest);
      i++;
      while (i < lines.length && !lines[i].trim().endsWith('$$')) {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        const lastPart = lines[i].trim().slice(0, -2).trim();
        if (lastPart) mathLines.push(lastPart);
      }
      html.push(renderMathHtml(mathLines.join(' '), true));
      continue;
    }

    // GFM pipe tables: header line with pipes followed by alignment separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      closeList();
      const headers = splitTableCells(line);
      const alignments = parseTableAlignments(lines[i + 1]);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !/^```/.test(lines[i])) {
        bodyRows.push(splitTableCells(lines[i]));
        i++;
      }
      i--; // Step back so outer loop advances cleanly

      const thHtml = headers
        .map((cell, idx) => {
          const align = alignments[idx] || 'left';
          const alignAttr = align !== 'left' ? ` style="text-align:${align}"` : '';
          return `<th${alignAttr}>${renderInline(cell)}</th>`;
        })
        .join('');
      const tbodyHtml = bodyRows
        .map(
          (row) =>
            `<tr>${headers
              .map((_, idx) => {
                const align = alignments[idx] || 'left';
                const alignAttr = align !== 'left' ? ` style="text-align:${align}"` : '';
                return `<td${alignAttr}>${renderInline(row[idx] ?? '')}</td>`;
              })
              .join('')}</tr>`
        )
        .join('');
      html.push(
        `<div class="md-table-wrap"><table class="md-table"><thead><tr>${thHtml}</tr></thead><tbody>${tbodyHtml}</tbody></table></div>`
      );
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      html.push(`<h${level} class="md-h${level}">${renderInline(headingMatch[2])}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      closeList();
      html.push('<hr class="md-hr" />');
      continue;
    }

    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      closeList();
      const bqLines = [bqMatch[1]];
      while (i + 1 < lines.length) {
        const nextBq = lines[i + 1].match(/^>\s?(.*)$/);
        if (!nextBq) break;
        bqLines.push(nextBq[1]);
        i++;
      }
      html.push(renderQuoteOrCallout(bqLines));
      continue;
    }

    const taskMatch = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        html.push('<ul class="md-list">');
      }
      const checked = taskMatch[1].toLowerCase() === 'x';
      html.push(
        `<li class="md-task-item"><input type="checkbox" class="md-task-cb" disabled${checked ? ' checked' : ''} /><span>${renderInline(taskMatch[2])}</span></li>`
      );
      continue;
    }

    const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (ulMatch) {
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        html.push('<ul class="md-list">');
      }
      html.push(`<li>${renderInline(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        html.push('<ol class="md-list">');
      }
      html.push(`<li>${renderInline(olMatch[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p class="md-p">${renderInline(line)}</p>`);
  }

  closeList();
  if (inCode && codeLines.length > 0) {
    html.push(renderCodeBlock(codeLines.join('\n'), codeLang));
  }
  return html.join('');
}
