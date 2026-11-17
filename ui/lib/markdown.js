export function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInline(text) {
  let out = escapeHtml(text);
  // Inline code first
  const codeSlots = [];
  out = out.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeSlots.length;
    codeSlots.push(`<code class="inline-code">${code}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" class="md-link" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  return out.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => codeSlots[Number(idx)]);
}

/**
 * Render Markdown safely to HTML with copyable fenced code blocks.
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
        const rawCode = codeLines.join('\n');
        html.push(
          `<div class="code-block"><div class="code-header"><span>${escapeHtml(codeLang)}</span><button type="button" class="copy-code-btn" data-code="${escapeHtml(rawCode)}">Copy</button></div><pre><code>${escapeHtml(rawCode)}</code></pre></div>`
        );
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
      html.push(`<blockquote class="md-quote">${renderInline(bqMatch[1])}</blockquote>`);
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
    const rawCode = codeLines.join('\n');
    html.push(
      `<div class="code-block"><div class="code-header"><span>${escapeHtml(codeLang)}</span><button type="button" class="copy-code-btn" data-code="${escapeHtml(rawCode)}">Copy</button></div><pre><code>${escapeHtml(rawCode)}</code></pre></div>`
    );
  }
  return html.join('');
}
